//! All human-readable logging here goes to **stderr**, never stdout. The agent
//! bridge (`bin/agent.rs`) embeds this module to serve a read-only spectator view
//! while owning stdout as an NDJSON protocol stream — a single stray `println!`
//! corrupts that stream and the brain drops the body with "malformed NDJSON".
//!
//! Library form of the `play` bin: a human-controlled UO client served over
//! HTTP. Holds one live [`Session`], serves the web renderer + `/scene.json`,
//! and accepts `POST /input` commands (walk/say/use/attack/pickup/war) which
//! it executes on the live session. Browser login pauses at the server-provided
//! character list and resumes through `POST /character`.
//!
//! Split in two so a caller can learn the bound HTTP port before blocking:
//! [`bind`] loads assets, starts the HTTP server (workers included) and
//! returns a [`PlayServer`]; [`PlayServer::run`] then does the (blocking)
//! login + game loop. The `play` bin is a thin wrapper over these two calls;
//! `anima-desktop` uses the same pair with an ephemeral port and embedded
//! web assets so it needs no `web/` directory on disk.
//!
//! Usage (bin): `play [host] [port] [user] [pass] [http_port] [web_dir] [data_dir]`

use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use anima_assets::{
    Anim, AnimData, Art, Cliloc, CustomHouseCatalog, Fonts, Gumps, Hues, Lights, MapData, MultiMap,
    Multis, Professions, RadarCol, Skills, Sounds, Speeches, Texmaps, TileArt, TileData,
};
use anima_core::agent::{HouseDesignAction, SpeechMode};
use anima_core::net::{
    walk_pacing, CharacterAppearance, CharacterChoice, CharacterPrompt, LoginConfig,
};
use anima_core::path::{find_path, find_path_near};
use anima_core::Action;
use include_dir::{include_dir, Dir};
use tiny_http::{Header, Method, Response, Server};

use crate::launcher::{CachedCharacter, LauncherStore};
use crate::regions::GuardRect;
use crate::scene::{
    build_scene, calculate_new_z, can_step_to, can_walk, decide_blocked_step, door_blocking_at,
    render_worldmap, BlockedStepAction, DoorUseAttempt, MapTerrain, StepDeny, WORLDMAP_STEP,
};
use crate::{connection::LoginControl, DriverError, Endpoint, Session};

type ActiveLogin = Arc<Mutex<Option<LoginControl>>>;

// The pieces this module coordinates, grouped by what they do. `mod.rs` keeps
// the server itself — `bind`, the [`PlayServer`] game loop, and the shared
// types the pieces exchange. Each submodule opens with `use super::*`, so it
// reaches those types and its siblings alike.
mod assets;
mod autowalk;
mod commands;
mod http;
mod input;
mod login;
#[cfg(test)]
mod session_tests;
mod worldmap_cache;
use assets::*;
use autowalk::*;
use commands::*;
use http::*;
use input::*;
use login::*;

/// Bundled copy of `web/` (renderer + PixiJS vendor lib), embedded at compile
/// time so this crate can serve the client with no `web/` directory on disk —
/// needed by `anima-desktop`, which runs outside the repo checkout. `web/` is
/// plain JS plus one vendored PixiJS build (~1MB total): small enough to embed
/// with no build step (`include_dir` is pure Rust, no `build.rs`, no bundler).
/// [`serve_static`] prefers a real disk `web_dir` when one is configured and
/// has the file; this is only the fallback.
static EMBEDDED_WEB: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../web");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GameSessionEnd {
    ConnectionLost,
    LoggedOut,
}

/// Startup configuration for the play server.
pub struct PlayConfig {
    /// UO game-server host to log into.
    pub host: String,
    /// UO game-server port.
    pub port: u16,
    pub user: String,
    pub pass: String,
    /// Shard to enter from the login server's `0xA8` list, by the shard's own
    /// index. 0 on a single-shard server (the usual case). Only consulted for
    /// the auto-login path — the browser login form carries its own.
    pub shard: u16,
    /// HTTP port to serve the renderer on. `0` = OS-assigned (ephemeral) —
    /// read the real port back from [`PlayServer::port`] after [`bind`].
    pub http_port: u16,
    /// Disk directory holding `web/` (index.html, js/*, vendor/…). `None`
    /// (or a path that doesn't exist / is missing a file) falls back to the
    /// copy embedded in this binary at compile time.
    pub web_dir: Option<PathBuf>,
    /// UO client data directory (`.mul`/`.uop` files).
    pub data_dir: PathBuf,
    /// Serve the browser login page and wait for `POST /login`, then expose the
    /// server-provided character list and wait for `POST /character`, instead
    /// of auto-logging in with `host`/`port`/`user`/`pass`.
    pub login_page: bool,
    /// Address to bind the HTTP server to. Should be `"127.0.0.1"` (loopback
    /// only) for any caller that doesn't have a specific reason to allow LAN
    /// access — the `play` bin's `ANIMA_BIND` env var is the one sanctioned
    /// escape hatch (see `bin/play.rs`); `anima-desktop` always hardcodes
    /// `"127.0.0.1"` regardless of environment, since it must never expose
    /// this process to the network.
    pub bind_addr: String,
    /// Serve the renderer as a READ-ONLY spectator view: every request that would
    /// change the world or the session (`POST /input`, `/login`, `/character`) is
    /// refused with 403 instead of reaching the session at all.
    ///
    /// This is what makes watching an agent possible. A UO shard allows exactly one
    /// session per character — ServUO's character-select handler disposes the previous
    /// `NetState` — so a spectator canNOT be a second login of the same character
    /// without kicking the agent off. Instead the agent keeps its one session and
    /// publishes frames from it (see [`PlayServer::into_monitor`]).
    pub read_only: bool,
}

/// Map files shared with the HTTP thread in asset-only mode so
/// `GET /terrain.json` (the replay viewer's map) can emit the same window
/// [`crate::scene::build_scene`] would. The multi/animdata readers are this
/// state's own, opened on the first request: taking the server's would leave a
/// read-only spectator ([`PlayServer::into_monitor`]) drawing without houses,
/// boats or animated statics.
pub(super) struct TerrainState {
    data_dir: PathBuf,
    maps: HashMap<u8, MapData>,
    readers: Option<(Option<Multis>, Option<AnimData>)>,
}

impl TerrainState {
    /// Load `facet` on first use, then hand `&mut MapData` plus the shared
    /// multi/animdata readers to `f`. Split-borrows the struct fields so the
    /// callback can hold all three at once (a `&mut self` helper cannot).
    pub(super) fn with_facet<R>(
        &mut self,
        facet: u8,
        f: impl FnOnce(&mut MapData, Option<&Multis>, Option<&AnimData>) -> R,
    ) -> Option<R> {
        let TerrainState {
            data_dir,
            maps,
            readers,
        } = self;
        let data_dir: &PathBuf = data_dir;
        let (multis, animdata) = readers
            .get_or_insert_with(|| (Multis::open(data_dir).ok(), AnimData::open(data_dir).ok()));
        // `Entry::Vacant` rather than `or_insert_with`: the fallible open
        // carries a `?`, which cannot cross a closure boundary.
        if let std::collections::hash_map::Entry::Vacant(e) = maps.entry(facet) {
            e.insert(MapData::open_facet(data_dir, facet).ok()?);
        }
        let map = maps.get_mut(&facet)?;
        Some(f(map, multis.as_ref(), animdata.as_ref()))
    }
}

/// A bound-but-not-yet-running play server: the HTTP side (and its worker
/// threads) are already listening; [`run`](PlayServer::run) does the
/// (blocking) game-server login + loop.
pub struct PlayServer {
    launcher: Arc<LauncherStore>,
    active_login: ActiveLogin,
    cfg: PlayConfig,
    port: u16,
    map: Option<MapData>,
    // Multi (house/boat) component reader — a placed multi's component list
    // (dx/dy/dz + graphic) never varies per facet, unlike `map`, so this is
    // loaded once at `bind()` and never reloaded on a facet switch.
    multis: Option<Multis>,
    art: Option<Arc<Mutex<Art>>>,
    anim: Option<Arc<Anim>>,
    cliloc: Option<Arc<Cliloc>>,
    animdata: Option<AnimData>,
    tiledata: Option<Arc<TileData>>,
    scene: Arc<Mutex<String>>,
    input: InputSender,
    rx: mpsc::Receiver<SessionInput>,
    login_rx: mpsc::Receiver<(LoginAttempt, LoginControl)>,
    character_rx: mpsc::Receiver<PromptDecision>,
    sse_hub: SseHub,
    /// Current session facet (`World::map_index`), kept in step with the game
    /// loop so the `/regions.json` HTTP thread can filter guard-zone rects to
    /// the facet the player is actually on without touching `scene`'s JSON.
    facet: Arc<AtomicU8>,
    /// Epoch-millis of the last `/scene.json` fetch — see [`Monitor::watching`].
    watch: Arc<AtomicU64>,
    /// `speech.mul` — attached to each new [`Session`] so Say encodes keywords.
    speech: Option<Speeches>,
    tileart: Option<Arc<TileArt>>,
}

/// Load assets, bind the HTTP server (workers included), and return a
/// [`PlayServer`] with the real bound port available via
/// [`PlayServer::port`] — before any game-server connection is attempted, so
/// a caller (e.g. `anima-desktop`) can open a browser/webview at the right
/// URL right away. The login page (if `cfg.login_page`) or the auto-login
/// connect loop, and the game loop itself, only run once [`PlayServer::run`]
/// is called.
pub fn bind(cfg: PlayConfig) -> io::Result<PlayServer> {
    bind_with_launcher(cfg, Arc::new(LauncherStore::memory()))
}

/// Use an explicitly chosen profile store (desktop vaults remain optional).
pub fn bind_with_launcher(cfg: PlayConfig, launcher: Arc<LauncherStore>) -> io::Result<PlayServer> {
    let data_dir = cfg.data_dir.clone();
    let mut map = MapData::open(&data_dir).ok();
    // Multi (house/boat) component reader — `multi.idx`/`multi.mul`. Same
    // dataset regardless of facet, so loaded once here (unlike `map`, which
    // reloads per facet in the game loop).
    let multis: Option<Multis> = Multis::open(&data_dir).ok();
    eprintln!(
        "play: multis {}",
        if multis.is_some() {
            "loaded"
        } else {
            "not loaded"
        }
    );
    // Art is shared: the game loop reads avg colors, the HTTP thread encodes PNGs.
    let art: Option<Arc<Mutex<Art>>> = Art::open(&data_dir).ok().map(|a| Arc::new(Mutex::new(a)));
    let anim: Option<Arc<Anim>> = Anim::open(&data_dir).ok().map(Arc::new);
    // Gump art (gumpartLegacyMUL.uop) for the paperdoll (doll body + worn pieces).
    let gumps: Option<Arc<Gumps>> = Gumps::open(&data_dir).ok().map(Arc::new);
    // Hue table (hues.mul) for recoloring sprites (skin/clothes/hair); standalone
    // TileData for the /iteminfo route (item graphic → equipment AnimID).
    let hues: Option<Arc<Hues>> = Hues::open(&data_dir).ok().map(Arc::new);
    let tiledata: Option<Arc<TileData>> = TileData::open(&data_dir.join("tiledata.mul"))
        .ok()
        .map(Arc::new);
    let texmaps: Option<Arc<Texmaps>> = Texmaps::open(&data_dir).ok().map(Arc::new);
    // Cliloc table (Cliloc.enu): localized text for context-menu labels (and reusable
    // for gump/system-message clilocs). Resolved into the scene when present.
    let lang = std::env::var("ANIMA_LANG").unwrap_or_else(|_| "enu".into());
    let cliloc: Option<Arc<Cliloc>> = Cliloc::open_lang(&data_dir, &lang).ok().map(Arc::new);
    let speech: Option<Speeches> = Speeches::open(&data_dir).ok();
    eprintln!(
        "play: speech {}",
        speech.as_ref().map_or("not loaded".into(), |s| format!(
            "loaded ({} keywords)",
            s.len()
        ))
    );
    let skillinfo: Arc<String> = Arc::new(
        Skills::open(&data_dir)
            .map(|s| {
                eprintln!("play: skills loaded ({} names)", s.entries.len());
                s.to_json()
            })
            .unwrap_or_else(|_| "[]".into()),
    );
    let professions: Arc<String> = Arc::new({
        let skills = Skills::open(&data_dir).ok();
        match Professions::open(&data_dir, skills.as_ref()) {
            Ok(p) => {
                eprintln!("play: Prof.txt loaded ({} professions)", p.entries.len());
                p.to_json()
            }
            Err(_) => "[]".into(),
        }
    });
    let fonts: Option<Arc<Fonts>> = Fonts::open(&data_dir).ok().map(Arc::new);
    eprintln!(
        "play: fonts {}",
        if fonts.is_some() {
            "loaded"
        } else {
            "not loaded"
        }
    );
    let tileart: Option<Arc<TileArt>> = Some(Arc::new(TileArt::open(&data_dir)));
    let multimap: Option<Arc<Vec<u8>>> =
        MultiMap::open(&data_dir).map(|m| Arc::new(m.to_image().to_png()));
    // light.mul/lightidx.mul — the per-light glow shapes. Optional like every
    // other art file: without it the renderer keeps its plain radial falloff.
    let lights: Option<Arc<Lights>> = Lights::open(&data_dir).ok().map(Arc::new);
    eprintln!(
        "play: cliloc {}",
        cliloc.as_ref().map_or("not loaded".into(), |c| format!(
            "loaded ({} entries)",
            c.len()
        ))
    );
    // animdata.mul: resolves a graphical effect's ART tile-id animation sequence +
    // frame interval (used by build_scene to bake `effects[].frames`/`interval`).
    // Read in the game-loop thread only, so a plain Option (no Arc) is enough.
    let animdata: Option<AnimData> = AnimData::open(&data_dir).ok();
    eprintln!(
        "play: animdata {}",
        if animdata.is_some() {
            "loaded"
        } else {
            "not loaded"
        }
    );
    // Sound effects (soundLegacyMUL.uop → WAV) and the music id → mp3 path map.
    let sounds: Option<Arc<Sounds>> = Sounds::open(&data_dir).ok().map(Arc::new);
    let music: Arc<HashMap<u16, PathBuf>> = Arc::new(load_music_map(&data_dir));
    eprintln!(
        "play: {} sound assets, {} music tracks",
        if sounds.is_some() { "loaded" } else { "no" },
        music.len()
    );

    // Full-world map PNG, rendered once in a background thread with its *own*
    // MapData+Art so it never contends with the game loop. Served at /worldmap.png.
    let worldmap: Arc<Mutex<Option<Vec<u8>>>> = Arc::new(Mutex::new(None));
    {
        let (slot, ddir) = (worldmap.clone(), data_dir.clone());
        thread::spawn(move || {
            let cache = worldmap_cache::WorldmapCache::for_resources(&ddir, WORLDMAP_STEP).ok();
            if let Some(bytes) = cache.as_ref().and_then(worldmap_cache::WorldmapCache::read) {
                eprintln!("play: worldmap from cache ({} KB)", bytes.len() / 1024);
                *slot.lock().unwrap() = Some(bytes);
                return;
            }
            if let (Ok(mut m), Ok(rc)) = (MapData::open(&ddir), RadarCol::open(&ddir)) {
                let png = render_worldmap(&mut m, &rc, WORLDMAP_STEP);
                eprintln!("play: worldmap ready ({} KB)", png.len() / 1024);
                if let Some(cache) = cache {
                    // Cache failure never prevents displaying the freshly rendered map.
                    let _ = cache.write_if_current(&ddir, WORLDMAP_STEP, &png);
                }
                *slot.lock().unwrap() = Some(png);
            }
        });
    }

    // Shared scene JSON (HTTP thread reads, game loop writes) + input channel.
    let scene = Arc::new(Mutex::new(String::from(if cfg.login_page {
        r#"{"auth":"login"}"#
    } else {
        "{}"
    })));
    // Last `/scene.json` fetch, epoch-millis. Only consulted by spectators (see
    // `Monitor::watching`); the human `play` path builds every frame as before.
    let watch = Arc::new(AtomicU64::new(0));
    // `Some(action)` = do it; `None` = stop walking now (key released). The
    // explicit stop clears `desired` immediately so the server doesn't keep pacing
    // for the desired_until window and overshoot past where the player stopped
    // (which made the prediction snap forward → "jump" on stop).
    let (tx, rx) = InputSender::channel();

    // Connected sound-SSE clients; the game loop pushes sound frames to these.
    let sse_hub: SseHub = Arc::new(Mutex::new(Vec::new()));
    // World-map POIs (towns/shops/dungeons/…), parsed once from the embedded data.
    let pois: Arc<String> = Arc::new(parse_pois());
    // Custom-house building catalog (walls/floors/doors/misc/stairs/roofs/
    // teleporters), served at `GET /housecatalog`. Unlike `pois` above, the
    // house designer is opt-in and rare, so this is read+parsed lazily on the
    // first request rather than blocking every startup — see
    // `HouseCatalogCache`'s doc.
    let house_catalog: Arc<HouseCatalogCache> = Arc::new(HouseCatalogCache::new(data_dir.clone()));
    // Guard-zone rectangles: parsed once from a local ServUO `Regions.xml` if one
    // is reachable (`$ANIMA_REGIONS` or `$HOME/dev/uo/servuo/Data/Regions.xml` —
    // see `regions::resolve_path`). This is server-local data with no packet
    // equivalent, so a remote server with no local copy just gets no overlay
    // (never fails the server).
    let regions_path = crate::regions::resolve_path();
    let guard_rects: Arc<Vec<GuardRect>> = Arc::new(match std::fs::read_to_string(&regions_path) {
        Ok(xml) => {
            let rects = crate::regions::parse(&xml);
            eprintln!(
                "play: regions loaded ({} guarded rects from {})",
                rects.len(),
                regions_path.display()
            );
            rects
        }
        Err(_) => {
            eprintln!("regions: not loaded");
            Vec::new()
        }
    });
    // Current session facet, kept current by the game loop each tick so the
    // `/regions.json` HTTP thread can filter to the facet the player is on.
    let facet: Arc<AtomicU8> = Arc::new(AtomicU8::new(0));
    // Login credentials submitted by the web login page (host, port, user, pass).
    let active_login: ActiveLogin = Arc::new(Mutex::new(None));
    let (login_tx, login_rx) = mpsc::channel::<(LoginAttempt, LoginControl)>();
    let (character_tx, character_rx) = mpsc::channel::<PromptDecision>();

    // Asset-only mode (`read_only` + no game loop): HTTP serves `/terrain.json`
    // from these files so the replay viewer can draw the isometric world without
    // a play-server Session. The facet-0 map moves over (a spectator draws from its
    // bridge's own map); multis/animdata stay for `into_monitor` and load lazily there.
    let terrain = if cfg.read_only {
        let mut maps = HashMap::new();
        if let Some(m) = map.take() {
            maps.insert(0u8, m);
        }
        Some(Arc::new(Mutex::new(TerrainState {
            data_dir: data_dir.clone(),
            maps,
            readers: None,
        })))
    } else {
        None
    };

    // The HTTP server comes up FIRST so the login page is reachable before we've
    // connected to any game server. Bound to loopback by default — this process
    // must never accept a connection from off the machine unless the caller
    // opted in via `cfg.bind_addr` (see its doc comment / the `play` bin's
    // `ANIMA_BIND`).
    let server = match Server::http((cfg.bind_addr.as_str(), cfg.http_port)) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("play: http server failed: {e}");
            return Err(io::Error::other(e));
        }
    };
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .unwrap_or(cfg.http_port);

    spawn_http(
        server,
        SpawnHttp {
            launcher: launcher.clone(),
            active_login: active_login.clone(),
            web_dir: cfg.web_dir.clone(),
            scene: scene.clone(),
            tx: tx.clone(),
            login: login_tx,
            character: character_tx,
            art: art.clone(),
            anim: anim.clone(),
            gumps,
            hues,
            tiledata: tiledata.clone(),
            cliloc: cliloc.clone(),
            lights: lights.clone(),
            texmaps,
            worldmap,
            sounds,
            music,
            sse_hub: sse_hub.clone(),
            pois,
            guard_rects,
            house_catalog,
            facet: facet.clone(),
            read_only: cfg.read_only,
            watch: watch.clone(),
            skillinfo,
            professions: professions.clone(),
            fonts: fonts.clone(),
            tileart: tileart.clone(),
            multimap: multimap.clone(),
            terrain: terrain.clone(),
        },
    );

    Ok(PlayServer {
        launcher,
        active_login,
        cfg,
        port,
        map: map.take(),
        multis,
        art,
        anim,
        cliloc,
        animdata,
        tiledata,
        scene,
        input: tx,
        rx,
        login_rx,
        character_rx,
        sse_hub,
        facet,
        watch,
        speech,
        tileart,
    })
}

/// Milliseconds since the unix epoch (monotonic enough for "is anyone watching").
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A read-only spectator view of a session somebody ELSE owns.
///
/// [`PlayServer::run`] owns its session: it logs in and drives the game loop. That is
/// the wrong shape for watching an agent, because the agent already holds the only
/// session that character is allowed to have — a second login would disconnect it
/// (ServUO's character-select handler disposes the previous `NetState`). So the serving
/// half is split off here: the HTTP renderer, its assets, and the shared scene buffer,
/// with the session left to its real owner. The owner calls [`publish`](Monitor::publish)
/// whenever it wants the viewer to see a new frame.
///
/// The viewer is a spectator, not a second pair of hands: `PlayConfig::read_only`
/// refuses `/input`, `/login` and `/character` in the HTTP layer itself.
pub struct Monitor {
    port: u16,
    scene: Arc<Mutex<String>>,
    watch: Arc<AtomicU64>,
    multis: Option<Multis>,
    art: Option<Arc<Mutex<Art>>>,
    anim: Option<Arc<Anim>>,
    cliloc: Option<Arc<Cliloc>>,
    animdata: Option<AnimData>,
    facet: Arc<AtomicU8>,
    tileart: Option<Arc<TileArt>>,
    /// Our OWN cursor into `World::journal`. Deliberately not `Session::observation()`,
    /// which advances the session's single shared journal cursor — reading frames for a
    /// spectator must never consume journal lines the session's real owner has not seen.
    journal_cursor: usize,
    journal: Vec<serde_json::Value>,
    journal_seq: u64,
    last_build: Option<Instant>,
    build_count: u64,
    build_sum: Duration,
    build_max: Duration,
}

/// How long after a `/scene.json` fetch we keep considering someone to be watching.
const WATCH_TIMEOUT: Duration = Duration::from_secs(5);
/// Floor on time between published frames (the human loop uses the same 250ms).
const MIN_PUBLISH_GAP: Duration = Duration::from_millis(250);
/// Journal lines kept for the renderer (same cap as the human game loop).
const JOURNAL_KEEP: usize = 50;

impl Monitor {
    /// The HTTP port actually bound (resolves `PlayConfig.http_port == 0`).
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Is a browser actually looking right now?
    ///
    /// Building a frame is real work (the human loop logs a warning past 30ms), and an
    /// agent bridge may be one of several sharing a single-threaded shard, so a session
    /// owner should skip publishing while nobody is watching. Also rate-limits to
    /// `MIN_PUBLISH_GAP`, so a fast tick loop cannot spend all its time rendering.
    pub fn watching(&self) -> bool {
        if self
            .last_build
            .is_some_and(|t| t.elapsed() < MIN_PUBLISH_GAP)
        {
            return false;
        }
        now_millis().saturating_sub(self.watch.load(Ordering::Relaxed))
            < WATCH_TIMEOUT.as_millis() as u64
    }

    /// Render `session`'s current world into the buffer the viewer polls.
    ///
    /// `map` is the caller's own terrain reader (the agent bridge already keeps one for
    /// pathfinding) so a monitored process never loads a second copy.
    pub fn publish(&mut self, session: &mut Session, map: Option<&mut MapData>) {
        let t0 = Instant::now();
        self.drain_journal(session);
        self.facet.store(session.world.map_index, Ordering::Relaxed);
        let mut art_guard = self.art.as_ref().map(|a| a.lock().unwrap());
        let json = build_scene(
            session,
            map,
            art_guard.as_deref_mut(),
            self.cliloc.as_deref(),
            self.animdata.as_ref(),
            self.anim.as_deref(),
            self.multis.as_ref(),
            self.tileart.as_deref(),
            &self.journal,
        );
        drop(art_guard);
        *self.scene.lock().unwrap() = json;
        let t = t0.elapsed();
        self.build_count += 1;
        self.build_sum += t;
        if t > self.build_max {
            self.build_max = t;
        }
        // Same threshold the human game loop warns at. This runs on the bridge's own
        // thread, i.e. IN the brain's critical path, so a slow frame directly costs the
        // agent playing time — say so rather than leaving it to be inferred from a
        // sluggish run.
        // Periodic cost report, so "being watched is cheap" is a measured claim rather
        // than an assumption — this work sits in the brain's critical path.
        if self.build_count.is_multiple_of(50) {
            eprintln!(
                "[anima-agent] monitor frames n={} avg={:.1}ms max={:.1}ms",
                self.build_count,
                self.build_sum.as_secs_f64() * 1000.0 / self.build_count as f64,
                self.build_max.as_secs_f64() * 1000.0,
            );
        }
        if t > Duration::from_millis(30) {
            eprintln!(
                "[anima-agent] slow monitor frame: {:.1}ms (n={} avg={:.1}ms max={:.1}ms)",
                t.as_secs_f64() * 1000.0,
                self.build_count,
                self.build_sum.as_secs_f64() * 1000.0 / self.build_count as f64,
                self.build_max.as_secs_f64() * 1000.0,
            );
        }
        self.last_build = Some(Instant::now());
    }

    /// Frames built, and what they cost — for a caller that wants to report the price
    /// of being watched.
    pub fn build_stats(&self) -> (u64, Duration, Duration) {
        (self.build_count, self.build_sum, self.build_max)
    }

    /// Copy any new journal lines out of the world with our own cursor, mirroring the
    /// human game loop's own formatting and cap.
    fn drain_journal(&mut self, session: &mut Session) {
        let all = &session.world.journal;
        if self.journal_cursor > all.len() {
            self.journal_cursor = 0; // journal was reset (relog/map change)
        }
        for j in &all[self.journal_cursor..] {
            self.journal_seq += 1;
            self.journal.push(serde_json::json!({
                "seq": self.journal_seq, "serial": j.serial, "name": j.name,
                "text": j.text, "type": j.msg_type, "hue": j.hue, "cliloc": j.cliloc,
            }));
        }
        self.journal_cursor = all.len();
        while self.journal.len() > JOURNAL_KEEP {
            self.journal.remove(0);
        }
    }
}

impl PlayServer {
    /// Give up the login/game loop and keep only the serving half, for a caller that
    /// already owns a live [`Session`] and wants it watched (see [`Monitor`]).
    pub fn into_monitor(self) -> Monitor {
        Monitor {
            port: self.port,
            scene: self.scene,
            watch: self.watch,
            multis: self.multis,
            art: self.art,
            anim: self.anim,
            cliloc: self.cliloc,
            animdata: self.animdata,
            facet: self.facet,
            tileart: self.tileart,
            journal_cursor: 0,
            journal: Vec::new(),
            journal_seq: 0,
            last_build: None,
            build_count: 0,
            build_sum: Duration::ZERO,
            build_max: Duration::ZERO,
        }
    }

    /// The HTTP port actually bound (resolves `PlayConfig.http_port == 0`).
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Keep serving HTTP art/gumps/fonts without connecting to a shard.
    /// `/scene.json` stays empty. `GET /terrain.json` builds the map window
    /// (the replay viewer draws recorded matches over it).
    pub fn serve_assets(self) -> io::Result<()> {
        eprintln!(
            "assets: serving UO files at http://{}:{}/  (no game session)",
            self.cfg.bind_addr, self.port
        );
        loop {
            std::thread::park();
        }
    }

    /// Log in (auto or via the served login page) and run the game loop.
    /// Blocks until the game connection closes.
    pub fn run(self) -> io::Result<()> {
        let PlayServer {
            launcher,
            active_login,
            cfg,
            port,
            mut map,
            multis,
            art,
            anim,
            cliloc,
            animdata,
            tiledata,
            scene,
            input,
            rx,
            login_rx,
            character_rx,
            sse_hub,
            facet,
            watch: _watch,
            speech,
            tileart,
        } = self;

        // Starting city for a newly-created character (ServUO honors the selection):
        // 0=Magincia/New Haven list-dependent, 3=Britain, ... Override via ANIMA_CITY.
        let city_index: u16 = std::env::var("ANIMA_CITY")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3);

        // Connect to the game server. With login_page we serve the web login page
        // and wait for the browser to POST a server + account; otherwise we auto-login
        // with the configured host/port/user/pass (backward compatible with scripts/agents).
        let connect = |attempt: LoginAttempt, control: &LoginControl| {
            while character_rx.try_recv().is_ok() {}
            control.check()?;
            let LoginAttempt {
                host,
                port,
                username,
                password,
                character_slot,
                interactive,
                create,
                shard,
                account_id,
            } = attempt;
            let cache_host = host.clone();
            let cache_user = username.clone();
            let mut c = LoginConfig {
                username,
                password,
                server_index: shard,
                create_new: create.is_some(),
                character_slot: character_slot.unwrap_or(0),
                require_character_slot: create.is_none() && character_slot.is_some(),
                ..Default::default()
            };
            if let Some(appearance) = create {
                c.appearance = appearance;
            } else {
                c.appearance.city_index = city_index;
            }
            let endpoint = Endpoint::new(host, port);
            if interactive {
                Session::connect_and_login_controlled(
                    &endpoint,
                    c,
                    control,
                    Some(&mut |prompt| {
                        let CharacterPrompt {
                            list,
                            delete_rejected,
                        } = prompt;
                        let slots: Vec<serde_json::Value> = list
                            .slots
                            .iter()
                            .map(|slot| serde_json::json!({"index": slot.index, "name": slot.name}))
                            .collect();
                        // `city.index` is a position in THIS server's list, not a
                        // fixed id — CreateCharacter 0xF8 must echo it back
                        // verbatim, so the browser needs the real list rather than
                        // a hardcoded guess (shards/expansions order it differently).
                        if let Some(id) = &account_id {
                            let cached = list
                                .slots
                                .iter()
                                .map(|s| CachedCharacter {
                                    index: s.index,
                                    name: s.name.clone(),
                                })
                                .collect();
                            if let Err(error) = launcher.cache_characters(
                                id,
                                &cache_host,
                                port,
                                shard,
                                &cache_user,
                                cached,
                            ) {
                                eprintln!("play: could not cache character names: {error}");
                            }
                        }
                        let cities: Vec<serde_json::Value> = list
                            .cities
                            .iter()
                            .map(|city| {
                                let mut value = serde_json::json!({
                                    "index": city.index,
                                    "name": city.name,
                                    "building": city.building,
                                });
                                // Legacy (63-byte) records carry no `location` at
                                // all — omit x/y/z/map/desc rather than send zeros
                                // that would look like a real Felucca (0,0,0).
                                if let Some(location) = &city.location {
                                    value["x"] = serde_json::json!(location.x);
                                    value["y"] = serde_json::json!(location.y);
                                    value["z"] = serde_json::json!(location.z);
                                    value["map"] = serde_json::json!(location.map);
                                    // `desc` is the same city blurb the real UO
                                    // client shows at character creation — resolve
                                    // the cliloc and strip its markup to plain
                                    // text; omit it entirely if we can't produce
                                    // anything useful.
                                    let desc = (location.description != 0)
                                        .then_some(cliloc.as_deref())
                                        .flatten()
                                        .and_then(|c| c.get(location.description))
                                        .map(cliloc_markup_to_plain_text)
                                        .filter(|text| !text.is_empty());
                                    if let Some(desc) = desc {
                                        value["desc"] = serde_json::json!(desc);
                                    }
                                }
                                value
                            })
                            .collect();
                        let choice_id = crate::connection::fresh_context_id();
                        let mut scene_value = serde_json::json!({
                            "auth": "characters",
                            "choice_id": choice_id,
                            "slots": slots,
                            "capacity": list.slot_count.max(1),
                            "cities": cities,
                        });
                        // Set only when this prompt is a re-prompt after a
                        // rejected delete, so the browser can show the reason
                        // (e.g. ServUO's 7-day delete delay) without the JSON
                        // shape changing for the common "no error" case.
                        if let Some(rejection) = &delete_rejected {
                            scene_value["error"] = serde_json::json!(rejection.text);
                        }
                        *scene.lock().unwrap() = scene_value.to_string();
                        eprintln!(
                        "play: character list ready ({} occupied / {} slots, {} starting cities)",
                        list.slots.len(),
                        list.slot_count,
                        list.cities.len()
                    );
                        if let Some(rejection) = &delete_rejected {
                            // Recoverable, not a login failure: the delete simply
                            // didn't go through (ClassicUO parity) — the session
                            // stays up and the driver just re-shows the list above.
                            eprintln!(
                            "play: character delete rejected (reason {}): {} -- staying on character selection",
                            rejection.reason, rejection.text
                        );
                        }
                        loop {
                            control.check()?;
                            match character_rx.recv_timeout(Duration::from_millis(100)) {
                                Ok(decision) => match decision.for_prompt(&choice_id) {
                                    Some(CharacterDecision::Choose(choice)) => break Ok(choice),
                                    Some(CharacterDecision::Cancel) => {
                                        break Err(DriverError::CharacterChoiceCancelled)
                                    }
                                    None => continue,
                                },
                                Err(mpsc::RecvTimeoutError::Timeout) => {}
                                Err(error) => break Err(DriverError::Io(io::Error::other(error))),
                            }
                        }
                    }),
                )
            } else {
                Session::connect_and_login_controlled(&endpoint, c, control, None)
            }
        };
        'connections: loop {
            let mut session = if !cfg.login_page {
                eprintln!(
                    "play: connecting to {}:{} as {} ...",
                    cfg.host, cfg.port, cfg.user
                );
                match connect(
                    LoginAttempt {
                        host: cfg.host.clone(),
                        port: cfg.port,
                        username: cfg.user.clone(),
                        password: cfg.pass.clone(),
                        character_slot: None,
                        interactive: false,
                        create: None,
                        shard: cfg.shard,
                        account_id: None,
                    },
                    &LoginControl::default(),
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("login failed: {e}");
                        // Library code must not exit the process out from under an
                        // embedding GUI (anima-desktop) — return the error instead;
                        // the `play` bin maps it back to the same log line + exit(1).
                        return Err(io::Error::other(e));
                    }
                }
            } else {
                // Keep the previous session's logout/disconnect explanation
                // visible until a new login is submitted.
                eprintln!("play: login page at http://127.0.0.1:{port}/  (enter server + account)");
                loop {
                    let (attempt, control) = match login_rx.recv() {
                        Ok(v) => v,
                        // Sender dropped (the HTTP worker pool is gone) — nothing can
                        // submit the login form anymore. Same reasoning as above: return
                        // rather than exit, so an embedding GUI keeps control.
                        Err(e) => return Err(io::Error::other(e)),
                    };
                    let (lh, lp, lu) =
                        (attempt.host.clone(), attempt.port, attempt.username.clone());
                    let login_target = serde_json::json!({
                        "host": lh, "port": lp, "shard": attempt.shard, "username": lu
                    });
                    *scene.lock().unwrap() = r#"{"auth":"connecting"}"#.into();
                    eprintln!("play: connecting to {lh}:{lp} as {lu} ...");
                    let result = connect(attempt, &control);
                    *active_login.lock().unwrap() = None;
                    match result {
                        Ok(s) => break s,
                        Err(
                            DriverError::CharacterChoiceCancelled | DriverError::LoginCancelled,
                        ) => {
                            eprintln!("play: connection cancelled");
                            *scene.lock().unwrap() = r#"{"auth":"login","msg":"Connection cancelled. Choose a server when you are ready."}"#.into();
                        }
                        Err(e) => {
                            eprintln!("login failed: {e}");
                            *scene.lock().unwrap() =
                                serde_json::json!({"auth":"error", "msg":friendly_login_error(&e), "login_target":login_target})
                                    .to_string();
                        }
                    }
                }
            };
            let active_input = input.activate(session.id());
            if let Some(ref table) = speech {
                session.set_speech(table.clone());
            }
            eprintln!(
                "play: in world. open http://127.0.0.1:{port}/  (WASD/arrows move, T to talk)"
            );

            let mut journal: Vec<serde_json::Value> = Vec::new();
            let mut journal_seq: u64 = 0; // monotonic id so the client floats each line once
            let mut cursor = 0usize;
            let mut last_ping = std::time::Instant::now();
            let mut last_build = Instant::now() - Duration::from_secs(1);
            // Seed from the live spawn position so the first step's Z is resolved from
            // the right current_z (not a phantom 0).
            let mut last_pos = session
                .world
                .player_mobile()
                .map(|p| (p.pos.x, p.pos.y, p.pos.z))
                .unwrap_or((0u16, 0u16, 0i8));
            let mut dirty = true;
            // Last seen seqs for the time-sensitive event queues (sound 0x54, damage 0x0B,
            // effects 0x70/0xC0/0xC7). These don't move the player or add journal lines, so
            // without this the scene would only rebuild on the 250ms timer → audible/visible
            // lag (a sound could sit up to ~250ms before it even reaches the served scene).
            // Bump `dirty` the instant any advances so the next poll (≤150ms) plays it.
            let mut last_event_seqs = (0u64, 0u64, 0u64); // (sound, damage, effect)
            let mut last_heartbeat = Instant::now(); // SSE keepalive + dead-connection reaper
                                                     // Click-to-walk (server-paced auto-walk) state. Unlike manual walk (browser-
                                                     // paced), the server owns the route: it re-paths to `auto_goal` each cadence,
                                                     // issues one step, and blacklists denied tiles so it routes around them.
            let mut auto_goal: Option<(u32, u32)> = None;
            let mut auto_blocked: std::collections::HashSet<(u32, u32)> =
                std::collections::HashSet::new();
            // Bookkeeping for `Use` attempts sent to open a closed door blocking a
            // given tile on the current route — see `decide_blocked_step`, which
            // this feeds: how many attempts so far, when the most recent one was
            // sent, and the door's own graphic at that moment (to detect a
            // visible state change since — see `DoorUseAttempt`'s doc).
            let mut auto_door_attempts: std::collections::HashMap<(u32, u32), DoorUseAttempt> =
                std::collections::HashMap::new();
            let mut auto_steps: u32 = 0;
            let mut last_step = Instant::now() - Duration::from_millis(AUTO_WALK_STEP_MS);
            // Whether the last issued step was a real move (vs a turn) and where we were
            // when we issued it — so we can detect a server deny (position didn't change).
            let mut auto_pending_move = false;
            let mut auto_from = (0u16, 0u16);
            let mut auto_target = (0u32, 0u32);
            let mut auto_max_expansions = AUTO_WALK_MAX_EXPANSIONS;
            let mut auto_max_steps = AUTO_WALK_MAX_STEPS;
            // Last core 0x38 event mirrored into this loop's own auto-walk state.
            let mut server_pathfind_seq = 0u64;
            let mut last_patches_gen = u64::MAX;
            // Movement (ClassicUO model): the *browser* is the pacer. Its prediction commits
            // one step per UO cadence (ClassicUO `Walker.LastStepRequestTime`) and sends one
            // `walk` per committed step; we just execute each step once. There is no
            // server-side pacing/`desired` window, so a key tap = exactly one step and a
            // release stops immediately — no "한 발자국 더" overshoot.
            // diagnostics
            let mut diag_since = Instant::now();
            let mut builds = 0u32;
            let mut build_max_us = 0u128;
            let mut build_sum_us = 0u128;
            let mut last_reqs = 0u64;
            let trace_t0 = Instant::now(); // ANIMA_DEBUG movement trace clock
            let mut session_end = GameSessionEnd::ConnectionLost;
            loop {
                // Drain input. The browser paces (ClassicUO model): each `walk` is one step
                // it already committed, so we execute it once — no `desired`/cadence here.
                // `None` (old stop signal) is now a no-op. We still resolve CanWalk so a
                // blocked diagonal slides along the wall, matching the browser's prediction.
                while let Ok(msg) = rx.try_recv() {
                    let Some(msg) = msg.for_session(session.id()) else {
                        continue;
                    };
                    match msg {
                        None => {}
                        Some(Action::Walk { dir, run }) => {
                            // A manual movement key cancels any active auto-walk route.
                            auto_goal = None;
                            let (facing, px, py, pz) = session
                                .world
                                .player_mobile()
                                .map(|p| {
                                    (p.direction, p.pos.x as i64, p.pos.y as i64, p.pos.z as i32)
                                })
                                .unwrap_or((dir & 7, 0, 0, 0));
                            let req = dir & 7;
                            let resolved = map.as_mut().and_then(|m| {
                                can_walk(&session.world, m, multis.as_ref(), px, py, pz, req)
                            });
                            let send = if facing == req {
                                resolved.map(|(nd, _, _)| nd)
                            } else {
                                Some(resolved.map(|(nd, _, _)| nd).unwrap_or(req))
                            };
                            if std::env::var("ANIMA_DEBUG").is_ok() {
                                eprintln!(
                                "[srv {}] rx walk req={req} run={} facing={facing} -> send={:?} pos=({px},{py})",
                                trace_t0.elapsed().as_millis(),
                                run as u8,
                                send
                            );
                            }
                            if let Some(sd) = send {
                                let _ = session.walk(sd, run);
                            }
                        }
                        // Click-to-walk: set the goal. The actual stepping happens below in
                        // the loop body at the walk cadence. A far/out-of-range click is
                        // rejected up front so it fails fast. A new WalkTo replaces any
                        // active route (and clears the denied-tile blacklist).
                        Some(Action::WalkTo { x, y }) => {
                            match prepare_walkto(
                                &mut session.world,
                                map.as_mut(),
                                multis.as_ref(),
                                x,
                                y,
                                Some(AUTO_WALK_MAX_RANGE),
                                AUTO_WALK_MAX_EXPANSIONS,
                            ) {
                                WalkToStart::Start(goal) => {
                                    auto_goal = Some(goal);
                                    auto_blocked.clear();
                                    auto_door_attempts.clear();
                                    auto_steps = 0;
                                    auto_pending_move = false;
                                    auto_max_expansions = AUTO_WALK_MAX_EXPANSIONS;
                                    auto_max_steps = AUTO_WALK_MAX_STEPS;
                                    last_step =
                                        Instant::now() - Duration::from_millis(AUTO_WALK_STEP_MS);
                                }
                                WalkToStart::Stop => auto_goal = None,
                            }
                        }
                        // Equip with layer 0 means "figure out the layer for me": look up the
                        // item's graphic in the world and resolve its tiledata wear layer.
                        Some(Action::Equip { serial, layer: 0 }) => {
                            let layer = session
                                .world
                                .items
                                .get(&serial)
                                .map(|it| it.graphic)
                                .and_then(|g| tiledata.as_ref().map(|t| t.item_layer(g)))
                                .unwrap_or(0);
                            let _ = session.apply_action(&Action::Equip { serial, layer });
                        }
                        Some(other) => {
                            let _ = session.apply_action(&other);
                        }
                    }
                }
                if last_ping.elapsed().as_secs() >= 15 {
                    let _ = session.send(&[0x73, 0x00]);
                    last_ping = std::time::Instant::now();
                }
                // Pump the network briefly (keeps input responsive).
                // Short pump so the loop ticks fast → the movement cadence gate fires near
                // its exact UO step time (low jitter). Confirms are still processed every
                // loop. (A long pump made the loop coarse → uneven step timing.)
                if let Err(e) = session.observe(Duration::from_millis(20)) {
                    // Print the cause: a clean server-side close and a packet we
                    // failed to decode both end the session here, and telling them
                    // apart from the log is the difference between "the shard
                    // dropped us" and "we have a parser bug" (see DriverError).
                    eprintln!("play: connection closed: {e}");
                    break;
                }
                if let Some(allowed) = session.take_logout_ack() {
                    if allowed {
                        eprintln!("play: server authorized logout");
                        session_end = GameSessionEnd::LoggedOut;
                        break;
                    }
                    session
                        .world
                        .push_system_note("The server refused the logout request.");
                    dirty = true;
                }

                // A facet change and a server Pathfind request can arrive in the same
                // pump. Reload first so route validation never consults the map we just
                // left (the old loop did this only after one auto-walk tick).
                let want_facet = session.world.map_index;
                if map.as_ref().map(MapData::facet) != Some(want_facet) {
                    match MapData::open_facet(&cfg.data_dir, want_facet) {
                        Ok(m) => {
                            map = Some(m);
                            last_patches_gen = u64::MAX;
                        }
                        Err(e) => eprintln!(
                            "play: facet {want_facet} map load failed: {e} (keeping current map)"
                        ),
                    }
                }
                if let Some(m) = map.as_mut() {
                    if session.world.map_patches_gen != last_patches_gen {
                        let (land, sta) = session
                            .world
                            .map_patch_counts
                            .get(m.facet() as usize)
                            .copied()
                            .unwrap_or((0, 0));
                        m.apply_patches(land, sta);
                        last_patches_gen = session.world.map_patches_gen;
                    }
                }

                // 0x38 Pathfinding is a server-issued WalkTo. Feed it through the
                // same map/blocked-goal policy as a browser click, but with
                // ClassicUO's 10,000-node bound and no browser-only 32-tile cap.
                // A resend to the same tile deliberately restarts it.
                if let Some(request) = session
                    .world
                    .server_pathfind
                    .filter(|request| request.seq > server_pathfind_seq)
                {
                    server_pathfind_seq = request.seq;
                    match prepare_walkto(
                        &mut session.world,
                        map.as_mut(),
                        multis.as_ref(),
                        request.x,
                        request.y,
                        None,
                        SERVER_PATHFIND_MAX_EXPANSIONS,
                    ) {
                        WalkToStart::Start(goal) => {
                            auto_goal = Some(goal);
                            auto_blocked.clear();
                            auto_door_attempts.clear();
                            auto_steps = 0;
                            auto_pending_move = false;
                            auto_max_expansions = SERVER_PATHFIND_MAX_EXPANSIONS;
                            auto_max_steps = SERVER_PATHFIND_MAX_STEPS;
                            last_step = Instant::now() - Duration::from_millis(AUTO_WALK_STEP_MS);
                        }
                        WalkToStart::Stop => auto_goal = None,
                    }
                }

                // --- Click-to-walk advance: re-path to the goal and issue one step per
                // walk cadence (server-paced, unlike manual browser-paced walk). Confirms
                // have been processed by observe() above, so the player tile here is
                // current. Cancelled by a manual Walk / new WalkTo (handled above). ---
                if let Some((gx, gy)) = auto_goal {
                    let here = session
                        .world
                        .player_mobile()
                        .map(|p| (p.pos.x, p.pos.y, p.pos.z, p.direction));
                    match here {
                        Some((px, py, _, _)) if (px as u32, py as u32) == (gx, gy) => {
                            auto_goal = None; // arrived
                        }
                        // Cadence and run flag both come from live world state
                        // (mount, stamina, 0xBF/0x26 SpeedMode), so a mounted
                        // click-to-walk no longer crawls at unmounted-walk
                        // speed. Recomputed per tick because all three inputs
                        // can change mid-route.
                        Some((px, py, pz, facing))
                            if last_step.elapsed()
                                >= Duration::from_millis(walk_pacing(&session.world, true).1) =>
                        {
                            let auto_run = walk_pacing(&session.world, true).0;
                            // Did the previous *move* land? If our tile didn't change, the
                            // server denied that tile → blacklist it so the re-path detours.
                            if auto_pending_move && (px, py) == auto_from {
                                auto_blocked.insert(auto_target);
                            }
                            auto_pending_move = false;

                            let path = map.as_mut().and_then(|m| {
                                let mut terrain = MapTerrain {
                                    world: &session.world,
                                    map: m,
                                    blocked: &auto_blocked,
                                    multis: multis.as_ref(),
                                };
                                find_path(
                                    &mut terrain,
                                    (px as u32, py as u32, pz as i32),
                                    (gx, gy),
                                    auto_max_expansions,
                                )
                            });
                            match path {
                                Some(p) if !p.is_empty() => {
                                    let want = p[0].dir;
                                    // Resolve like a manual key: a blocked diagonal slides to
                                    // a free cardinal; a turn precedes a move on a new facing.
                                    let resolved = map.as_mut().and_then(|m| {
                                        can_walk(
                                            &session.world,
                                            m,
                                            multis.as_ref(),
                                            px as i64,
                                            py as i64,
                                            pz as i32,
                                            want,
                                        )
                                    });
                                    let send = if facing == want {
                                        resolved.map(|(nd, _, _)| nd)
                                    } else {
                                        Some(resolved.map(|(nd, _, _)| nd).unwrap_or(want))
                                    };
                                    if let Some(sd) = send {
                                        // A turn is not a step: sending it with
                                        // the run flag would ask the server for a
                                        // running turn we haven't earned.
                                        let run = auto_run && facing == sd;
                                        if session.walk(sd, run).unwrap_or(false) {
                                            auto_from = (px, py);
                                            // Same-facing = a real tile move; a facing change
                                            // is a turn (no move) and must not count as a deny.
                                            auto_pending_move = facing == sd;
                                            auto_target = resolved
                                                .map(|(_, nx, ny)| (nx as u32, ny as u32))
                                                .unwrap_or((px as u32, py as u32));
                                            auto_steps += 1;
                                            if auto_steps > auto_max_steps {
                                                auto_goal = None; // runaway guard
                                            }
                                        }
                                    } else {
                                        // Fully blocked here. A closed door isn't a wall — it's
                                        // something we can open (see `decide_blocked_step`) — so
                                        // try that a bounded number of times before giving up on
                                        // the tile like any other blocker.
                                        let tile = (p[0].x, p[0].y);
                                        let door = map.as_ref().and_then(|m| {
                                            door_blocking_at(
                                                &session.world,
                                                m,
                                                tile.0 as i64,
                                                tile.1 as i64,
                                                pz as i32,
                                            )
                                        });
                                        let prior = auto_door_attempts.get(&tile).copied();
                                        let attempts = prior.map_or(0, |p| p.count);
                                        // Has the door's own graphic moved since our last `Use`? If
                                        // so, that `Use` already landed (ServUO toggled it) — safe
                                        // (and necessary, e.g. it toggled back closed) to act again
                                        // immediately, cooldown or not. `door` being `None` here
                                        // (the tile's blocker vanished/changed identity) also counts
                                        // as "changed" so a stale wait can't get stuck.
                                        let door_state_changed = match (door, prior) {
                                            (Some(serial), Some(p)) => {
                                                session.world.items.get(&serial).is_none_or(|it| {
                                                    it.graphic != p.graphic_at_send
                                                })
                                            }
                                            _ => true,
                                        };
                                        let pending_use_sent_at = prior.map(|p| p.sent_at);
                                        match decide_blocked_step(
                                            door,
                                            attempts,
                                            pending_use_sent_at,
                                            door_state_changed,
                                            Instant::now(),
                                        ) {
                                            BlockedStepAction::OpenDoor(serial) => {
                                                if std::env::var("ANIMA_DEBUG").is_ok() {
                                                    eprintln!(
                                                    "play: walkto ({gx},{gy}) opening door {serial:#x} at {tile:?} (attempt {})",
                                                    attempts + 1
                                                );
                                                }
                                                let graphic_at_send = session
                                                    .world
                                                    .items
                                                    .get(&serial)
                                                    .map_or(0, |it| it.graphic);
                                                auto_door_attempts.insert(
                                                    tile,
                                                    DoorUseAttempt {
                                                        count: attempts + 1,
                                                        sent_at: Instant::now(),
                                                        graphic_at_send,
                                                    },
                                                );
                                                let _ = session.apply_action(&Action::OpenDoor);
                                            }
                                            BlockedStepAction::AwaitDoor => {
                                                // A `Use` for this door hasn't had time to land / show
                                                // an effect yet — do nothing this tick (see
                                                // `decide_blocked_step`'s doc); resending now would
                                                // risk toggling shut what the first `Use` is about to
                                                // open (the very race FIX 5 exists to close).
                                            }
                                            BlockedStepAction::Blacklist => {
                                                auto_blocked.insert(tile);
                                            }
                                        }
                                    }
                                    last_step = Instant::now();
                                }
                                // No route given what we've learned (boxed in by newly-
                                // blacklisted denied tiles) → stop, and say so. This fires at
                                // most once per abandoned route (clearing `auto_goal` stops
                                // this block from running again), so no spam risk.
                                _ => {
                                    eprintln!("play: walkto ({gx},{gy}) abandoned: boxed in");
                                    session.world.push_system_note(format!(
                                        "walkto ({gx},{gy}) abandoned: boxed in"
                                    ));
                                    auto_goal = None;
                                }
                            }
                        }
                        _ => {}
                    }
                }

                // Keep the shared facet in step so `/regions.json` can filter its
                // guard-zone rects to wherever the player currently is (0xBF/0x08
                // MapChange updates `world.map_index` directly; see its doc).
                facet.store(session.world.map_index, Ordering::Relaxed);
                let obs = session.world.observe(&mut cursor);
                for j in &obs.new_journal {
                    journal_seq += 1;
                    // For a localized (cliloc) line, `j.text` holds the raw tab-separated
                    // args; resolve them against the Cliloc table into display text so the
                    // journal + overhead show real words instead of a blank line. Fall back
                    // to `#<id>` when the id isn't in the table.
                    let text = if j.cliloc != 0 {
                        cliloc
                            .as_deref()
                            .and_then(|c| c.format(j.cliloc, &j.text))
                            .unwrap_or_else(|| format!("#{}", j.cliloc))
                    } else {
                        j.text.clone()
                    };
                    journal.push(serde_json::json!({
                        "seq": journal_seq, "serial": j.serial, "name": j.name,
                        "text": text, "type": j.msg_type, "hue": j.hue, "cliloc": j.cliloc
                    }));
                    dirty = true;
                }
                while journal.len() > 50 {
                    journal.remove(0);
                }
                // Rebuild the (expensive) scene only when the player moved, the journal
                // changed, or ~250ms passed — not on every 100ms loop iteration.
                // Include Z so climbing stairs (Z changes, maybe same X/Y) rebuilds the
                // scene → maxDrawZ recomputes and the visible floor switches with you.
                let pos = session
                    .world
                    .player_mobile()
                    .map(|p| (p.pos.x, p.pos.y, p.pos.z))
                    .unwrap_or(last_pos);
                if (pos.0, pos.1) != (last_pos.0, last_pos.1) {
                    dirty = true;
                    if std::env::var("ANIMA_DEBUG").is_ok() {
                        eprintln!(
                            "[srv {}] MOVED ({},{}) -> ({},{})  confirms={} denies={}",
                            trace_t0.elapsed().as_millis(),
                            last_pos.0,
                            last_pos.1,
                            pos.0,
                            pos.1,
                            session.confirms,
                            session.denies
                        );
                    }
                    // The server's ConfirmWalk (0x22) carries no Z; like ClassicUO
                    // (Pathfinder.CalculateNewZ) the client resolves the standing Z of the
                    // tile it stepped onto from the map — bounded by the tile it came from
                    // and the step's direction, picking the surface/bridge nearest the
                    // current Z with clearance. This is what makes stairs/ramps climb.
                    let mut nz = pos.2;
                    if let Some(m) = map.as_mut() {
                        let dir = delta_dir(
                            pos.0 as i64 - last_pos.0 as i64,
                            pos.1 as i64 - last_pos.1 as i64,
                        );
                        if let Some(z) = calculate_new_z(
                            &session.world,
                            m,
                            multis.as_ref(),
                            pos.0 as i64,
                            pos.1 as i64,
                            last_pos.2 as i32,
                            dir,
                        ) {
                            nz = z as i8;
                            if let Some(p) = session.world.player_mobile_mut() {
                                p.pos.z = nz;
                            }
                            // Stairs/ramps show up here as a Z change with the same (or a
                            // 1-tile) X/Y — best-effort detail only (diagnostics, not
                            // correctness-critical): name the static whose [z, z+height)
                            // span covers the resolved Z if one is cheaply findable, else
                            // just say the land surface accounts for it.
                            if std::env::var("ANIMA_DEBUG").is_ok() && nz != last_pos.2 {
                                let land_z = m.land(pos.0 as u32, pos.1 as u32).z;
                                let static_note = m
                                    .statics(pos.0 as u32, pos.1 as u32)
                                    .into_iter()
                                    .find(|s| {
                                        (s.z as i32) <= z && z <= s.z as i32 + s.height as i32
                                    })
                                    .map(|s| {
                                        format!(
                                            "static g=0x{:04X} top={}",
                                            s.graphic,
                                            s.z as i32 + s.height as i32
                                        )
                                    })
                                    .unwrap_or_else(|| "land surface accounts for it".to_string());
                                eprintln!(
                                "play: step dir={dir} ({},{}) z {} -> {nz} (land z={land_z}, {static_note})",
                                pos.0, pos.1, last_pos.2
                            );
                            }
                        }
                    }
                    last_pos = (pos.0, pos.1, nz);
                }
                // A new sound/damage/effect event must be reflected immediately (not on the
                // 250ms timer), or it plays/shows late. Rebuild the scene the moment any of
                // these monotonic seqs advances.
                let seqs = (
                    session.world.sound_seq,
                    session.world.damage_seq,
                    session.world.effect_seq,
                );
                if seqs != last_event_seqs {
                    // Push each newly-arrived sound to the SSE clients immediately (no poll
                    // wait). Damage/effects still ride the scene poll — only sound is pushed.
                    let prev_sound = last_event_seqs.0;
                    if session.world.sound_seq > prev_sound {
                        for &(seq, id, x, y) in &session.world.recent_sounds {
                            if seq > prev_sound {
                                sse_broadcast(
                                    &sse_hub,
                                    format!(
                                    "data: {{\"sessionId\":{},\"seq\":{seq},\"id\":{id},\"x\":{x},\"y\":{y}}}\n\n", serde_json::to_string(session.id()).unwrap()
                                )
                                    .as_bytes(),
                                );
                            }
                        }
                    }
                    last_event_seqs = seqs;
                    dirty = true;
                }
                // SSE keepalive: a periodic comment frame both keeps proxies from closing
                // the stream and lets a write to a vanished client fail → that worker thread
                // unblocks and the dead sender is reaped on the next broadcast.
                if last_heartbeat.elapsed() >= Duration::from_secs(15) {
                    sse_broadcast(&sse_hub, b": ping\n\n");
                    last_heartbeat = Instant::now();
                }
                if dirty || last_build.elapsed() >= Duration::from_millis(250) {
                    let t0 = Instant::now();
                    let mut art_guard = art.as_ref().map(|a| a.lock().unwrap());
                    let json = build_scene(
                        &mut session,
                        map.as_mut(),
                        art_guard.as_deref_mut(),
                        cliloc.as_deref(),
                        animdata.as_ref(),
                        anim.as_deref(),
                        multis.as_ref(),
                        tileart.as_deref(),
                        &journal,
                    );
                    drop(art_guard);
                    *scene.lock().unwrap() = json;
                    last_build = Instant::now();
                    dirty = false;

                    let us = t0.elapsed().as_micros();
                    builds += 1;
                    build_sum_us += us;
                    build_max_us = build_max_us.max(us);
                    if us > 30_000 {
                        eprintln!("[diag] slow scene build: {:.1}ms", us as f64 / 1000.0);
                    }
                }

                // Periodic diagnostics line.
                if diag_since.elapsed() >= Duration::from_secs(5) {
                    let reqs = REQ_COUNT.load(Ordering::Relaxed);
                    let avg = if builds > 0 {
                        build_sum_us / builds as u128
                    } else {
                        0
                    };
                    eprintln!(
                        "[diag] 5s: scene builds={builds} avg={:.1}ms max={:.1}ms | http reqs={}",
                        avg as f64 / 1000.0,
                        build_max_us as f64 / 1000.0,
                        reqs - last_reqs,
                    );
                    diag_since = Instant::now();
                    builds = 0;
                    build_sum_us = 0;
                    build_max_us = 0;
                    last_reqs = reqs;
                }
            }
            drop(active_input);
            if !cfg.login_page {
                break 'connections;
            }
            while rx.try_recv().is_ok() {}
            let msg = match session_end {
                GameSessionEnd::LoggedOut => "Logged out safely.",
                GameSessionEnd::ConnectionLost => "Connection lost. You can sign in again.",
            };
            *scene.lock().unwrap() = serde_json::json!({
                "auth": "login",
                "msg": msg,
            })
            .to_string();
            eprintln!("play: {msg} waiting for a new login");
        }
        Ok(())
    }
}

// Keyed by (is_static, graphic, hue) so hued effect frames don't collide with the
// plain terrain/static art.
type TileCache = Arc<Mutex<ByteCache<(bool, u16, u16, bool), Vec<u8>>>>;
// Keyed by (body, group, dir, frame, hue) so hued + un-hued frames don't collide.
// Cached anim frame: (PNG bytes, draw-center cx, cy). The center is sent to the
// client as headers so it can position each part (body/equipment/mount) correctly.
type AnimCache = Arc<Mutex<ByteCache<(u16, u8, u8, u16, u16), (Vec<u8>, i16, i16)>>>;
type TexmapCache = Arc<Mutex<ByteCache<u16, Vec<u8>>>>;
type GumpCache = Arc<Mutex<ByteCache<(u32, u16), Vec<u8>>>>;

/// HTTP requests served (for the periodic diagnostics line).
static REQ_COUNT: AtomicU64 = AtomicU64::new(0);

// ── Sound push channel (Server-Sent Events) ────────────────────────────────
// Sounds used to ride the 150ms scene poll, so a hit could play up to a poll late.
// Instead the game loop pushes each sound the instant it arrives over an SSE stream
// (`GET /sounds`). The hub is the set of connected clients' senders; the loop
// broadcasts `data: {"seq":..,"id":..}\n\n` frames (plus a periodic heartbeat that
// also reaps dead connections, since a blocked reader only unblocks on a failed write).
type SseHub = Arc<Mutex<Vec<mpsc::Sender<Vec<u8>>>>>;
