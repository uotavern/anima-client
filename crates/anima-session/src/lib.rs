//! Native TCP driver for `anima-core`'s sans-IO protocol — the headless half of
//! the client, with no UI in it.
//!
//! `anima-core` knows the UO protocol but never touches a socket; this crate
//! provides the blocking `std::net` loop that feeds bytes in and writes bytes
//! out, driving the [`LoginMachine`] to completion and then maintaining a live
//! [`World`] from the server's game-packet stream. The browser build will have
//! an analogous WebSocket driver; the core stays identical.
//!
//! It also carries what an out-of-process brain needs and nothing a player's
//! screen does: the observation/action JSON ([`json`]), walking and pathing
//! ([`pathing`]) and the NDJSON bridge ([`bridge`], built as `anima-bridge`).
//! The web play server, launcher and render scene live in `anima-net`, which
//! re-exports everything here, so `anima_net::Session` keeps working.

// The scene builder's `json!` player literal outgrew rustc's default macro
// recursion depth as fields were added (same reason anima-contract-json raises
// it). Nothing here recurses at run time.
#![recursion_limit = "512"]
use std::collections::{HashMap, HashSet};
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::time::{Duration, Instant};

pub mod bridge;
pub mod connection;
#[cfg(test)]
mod connection_tests;
pub mod json;
pub mod pathing;

use connection::{LoginControl, LoginPhase};

use anima_assets::{Cliloc, MapData, Speeches};
use anima_core::agent::{survey_terrain, Action, HouseDesignAction, Observation};
use anima_core::net::outgoing::{
    build_animate_request, build_ascii_prompt_response, build_attack, build_bandage_target,
    build_boat_move_request, build_book_header_change, build_book_page_request,
    build_book_page_write, build_bulletin_post_message, build_bulletin_remove_message,
    build_bulletin_request_message, build_bulletin_request_summary, build_buy, build_cast_spell,
    build_cast_spell_from_book, build_change_race_cancel, build_change_race_request,
    build_chat_create_channel, build_chat_join, build_chat_leave, build_chat_message,
    build_chat_open, build_client_view_range, build_disarm_request, build_double_click, build_drop,
    build_emote_action, build_equip, build_equip_last_weapon, build_guild_menu_request,
    build_gump_response, build_help_request, build_house_design_add_item,
    build_house_design_add_roof, build_house_design_add_stair, build_house_design_backup,
    build_house_design_clear, build_house_design_close, build_house_design_commit,
    build_house_design_delete_item, build_house_design_delete_roof, build_house_design_go_to_floor,
    build_house_design_request, build_house_design_restore, build_house_design_revert,
    build_house_design_sync, build_hue_picker_response, build_invoke_virtue, build_language,
    build_legacy_menu_response, build_logout_request, build_map_add_pin, build_map_change_pin,
    build_map_clear_pins, build_map_insert_pin, build_map_remove_pin, build_map_toggle_editable,
    build_name_request, build_object_help_request, build_open_door, build_open_spellbook,
    build_open_uo_store, build_opl_request, build_party_accept, build_party_can_loot,
    build_party_decline, build_party_invite, build_party_leave, build_party_message,
    build_party_private_message, build_party_remove, build_pick_up, build_ping,
    build_popup_request, build_popup_select, build_profile_request, build_profile_update,
    build_prompt_response, build_public_house_content, build_query_guild_positions,
    build_query_party_positions, build_quest_arrow_click, build_quest_menu_request,
    build_rename_request, build_say, build_sell, build_single_click, build_skill_lock,
    build_stat_lock, build_status_request, build_stun_request, build_target_by_resource,
    build_target_response, build_targeted_skill, build_targeted_spell,
    build_text_entry_dialog_response, build_tip_request, build_toggle_flying, build_trade_accept,
    build_trade_cancel, build_trade_gold, build_unicode_say, build_use_ability, build_use_skill,
    build_war_mode, BOAT_SPEED_FAST, BOAT_SPEED_SLOW, BOAT_SPEED_STOP, OPL_REQUEST_BATCH,
};
use anima_core::net::{
    apply_packet, build_client_version, walk_pacing, CharacterChoice, CharacterPrompt,
    FramingError, GameServerAddress, LoginConfig, LoginDirective, LoginError, LoginMachine,
    LoginResult, StreamDecoder, Walker, CHARACTER_LIST_FLAG_LOGOUT_HANDSHAKE,
};
use anima_core::path::{find_path, find_path_near, Terrain, DEFAULT_MAX_EXPANSIONS};
use anima_core::world::{LegacyMenuKind, PromptKind, TipKind, World};

// `DOOR_USE_COOLDOWN`/`MAX_DOOR_OPEN_ATTEMPTS` are only referenced by
// `route_tests` below (production code only needs `decide_blocked_step` to
// already have them baked in) — imported there, not here, so a non-test
// build doesn't warn about unused imports.
use crate::pathing::{decide_blocked_step, BlockedStepAction, MapTerrain};

/// Client version we report to the server (must match the login seed version).
const CLIENT_VERSION: &str = "7.0.102.3";

/// Fill in every localized string an [`Observation`] carries but the core
/// cannot resolve: journal lines, buff names/descriptions, and property lists.
///
/// Journal lines get `display` — the cliloc resolved against the client's
/// table with its arguments substituted, and 0xCC's affix joined on the side
/// the server asked for. Buffs get `display`/`display_desc` the same way,
/// falling back to the short English `name` table when the server sent no
/// title cliloc.
///
/// This lives in the driver for the same reason terrain perception does: the
/// core has no assets, so it can only carry `(cliloc, args, affix)` and leave
/// the words to whoever loaded `Cliloc.enu`. Without it a brain sees system
/// messages as bare numbers — it can be told "you have been added to the
/// party" and read `#1005445`.
///
/// Plain speech (`cliloc == 0`) is already text; it is copied through so a
/// consumer can read `display` uniformly. With no table, a cliloc line falls
/// back to `#<id>`, matching what the renderer shows.
pub fn localize(obs: &mut Observation, cliloc: Option<&Cliloc>) {
    for j in &mut obs.new_journal {
        let base = if j.cliloc == 0 {
            j.text.clone()
        } else {
            cliloc
                .and_then(|c| c.format(j.cliloc, &j.text))
                .unwrap_or_else(|| format!("#{}", j.cliloc))
        };
        j.display = if j.affix.is_empty() {
            base
        } else if j.affix_prepend {
            format!("{}{base}", j.affix)
        } else {
            format!("{base}{}", j.affix)
        };
    }
    // Property lists: "Spell Damage Increase 10%" instead of `1060483 / 10`.
    obs.opl_text = obs
        .opl
        .iter()
        .map(|(serial, lines)| {
            let text = lines
                .iter()
                .map(|(id, args)| {
                    cliloc
                        .and_then(|c| c.format(*id, args))
                        .unwrap_or_else(|| format!("#{id}"))
                })
                .collect();
            (*serial, text)
        })
        .collect();
    for b in &mut obs.buffs {
        b.display = match b.title_cliloc {
            0 => b.name.clone(),
            id => cliloc
                .and_then(|c| c.format(id, &b.title_args))
                .unwrap_or_else(|| b.name.clone()),
        };
        b.display_desc = match b.desc_cliloc {
            0 => String::new(),
            id => cliloc
                .and_then(|c| c.format(id, &b.desc_args))
                .unwrap_or_default(),
        };
    }
}

/// A UO server address.
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    /// Never dial the game-server address the shard advertises in `0x8C`; go
    /// straight back to `host`/`port` for phase 2. ClassicUO's `IgnoreRelayIp`.
    /// Off by default — [`connect_game_server`] already falls back on its own,
    /// so this is only needed when the advertised address is not merely
    /// unreachable but *wrong* (a live host that isn't this shard), where a
    /// failed connect would never happen to trigger the fallback.
    pub ignore_relay_ip: bool,
}

impl Endpoint {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
            ignore_relay_ip: false,
        }
    }
}

#[derive(Debug)]
pub enum DriverError {
    Io(std::io::Error),
    Framing(FramingError),
    Login(LoginError),
    /// Server closed the connection before login finished.
    ConnectionClosed,
    /// The login machine asked for an interactive character choice, but this
    /// driver call did not provide a chooser.
    CharacterChoiceRequired,
    /// The interactive chooser intentionally abandoned this game-server login.
    CharacterChoiceCancelled,
    /// The caller cancelled this connection attempt.
    LoginCancelled,
    /// A transport or handshake phase exceeded its bounded wait.
    LoginTimeout,
}

impl std::fmt::Display for DriverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DriverError::Io(e) => write!(f, "io error: {e}"),
            DriverError::Framing(e) => write!(f, "framing error: {e}"),
            DriverError::Login(e) => write!(f, "login error: {e}"),
            DriverError::ConnectionClosed => write!(f, "connection closed by server"),
            DriverError::CharacterChoiceRequired => write!(f, "character choice required"),
            DriverError::CharacterChoiceCancelled => write!(f, "character choice cancelled"),
            DriverError::LoginCancelled => write!(f, "connection cancelled"),
            DriverError::LoginTimeout => write!(f, "server response timed out"),
        }
    }
}

impl std::error::Error for DriverError {}

impl From<std::io::Error> for DriverError {
    fn from(e: std::io::Error) -> Self {
        DriverError::Io(e)
    }
}

const CONNECT_READ_TIMEOUT: Duration = Duration::from_secs(20);
/// How long to wait on the game-server address a shard advertises in `0x8C`
/// before falling back to the endpoint we logged in through. Short on purpose:
/// see [`connect_game_server`].
const RELAY_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
// Short so the game loop ticks fast (like ClassicUO's per-frame loop): the
// movement *pacing* gate (run 200ms / walk 400ms) is only as precise as how
// often the loop checks it. A long read timeout stalls the loop on the socket
// when no packet is arriving, which throttled running down to walk speed.
const PUMP_READ_TIMEOUT: Duration = Duration::from_millis(20);

/// Keepalive-ping cadence (0x73). A client that sends nothing for long enough is
/// dropped by the server's idle timeout; ClassicUO pings on a similar heartbeat.
/// How often the 0x73 keepalive goes out. ClassicUO pings once a second
/// (`GameScene.Update`: `_timePing = Time.Ticks + 1000`) and averages the last
/// five, which is also what makes the number worth showing; a 30-second
/// keepalive kept the connection alive but measured latency once every half
/// minute. Two bytes a second each way.
const PING_INTERVAL: Duration = Duration::from_secs(1);

/// How often we ask the shard where our out-of-view party/guild members are
/// (0xF0). ClassicUO's `WorldMapEntityManager` polls every 250 ms; that cadence
/// is sized for a map gump the player is staring at, and ours feeds a minimap
/// refreshed on a 150 ms scene poll, so a second is enough and costs four bytes
/// each way instead of sixteen. Only sent while there is something to ask about
/// — see the call site.
const TRACK_INTERVAL: Duration = Duration::from_secs(1);

/// How many unanswered 0xF0 queries to send before concluding the shard does not
/// implement the extension. Three seconds of probing, then silence.
const TRACK_MAX_PROBES: u8 = 3;
/// Draw range (tiles) we advertise to the server on world entry (0xC8). 18 is
/// the classic-client default; the server uses it to decide what falls in view.
const DEFAULT_VIEW_RANGE: u8 = 18;

/// [`Action::WalkTo`] step cadence, mirroring the play-server's own
/// click-to-walk pacing (`anima-net/src/bin/play.rs`'s `AUTO_WALK_STEP_MS`):
/// ClassicUO's unmounted-walk step is 400ms.
/// Slowest step cadence — unmounted walking. The live cadence comes from
/// [`walk_pacing`] per tick ([`Route::step_delay`]); this remains the floor a
/// fresh `Route` starts from and what "already due" is measured against.
const ROUTE_STEP: Duration = Duration::from_millis(400);
/// Give up a route after this many issued steps (runaway guard, mirrors
/// `play.rs`'s `AUTO_WALK_MAX_STEPS`).
const ROUTE_MAX_STEPS: u32 = 200;
/// ClassicUO's 0x38 pathfinder node/path bound; server commands are not subject
/// to the interactive click route's smaller runaway guard.
const SERVER_ROUTE_MAX_STEPS: u32 = 10_000;
/// Like `play_server`'s `WALKTO_GOAL_SLOP`: a route whose *exact* goal tile
/// turns out unreachable (a wall decoration, a tree, a crate someone dropped
/// on it) still resolves to the nearest reachable tile within this many
/// Chebyshev tiles instead of giving up outright — see
/// `anima_core::path::find_path_near`'s doc.
const ROUTE_GOAL_SLOP: u32 = 2;

/// What [`Route::advance`] wants the caller ([`Session::advance_route`]) to do.
/// Kept separate from the actual packet send so the state machine itself is
/// network-free and unit-testable with a stubbed [`Terrain`].
#[derive(Debug, PartialEq, Eq)]
enum RouteStep {
    /// Cadence hasn't elapsed since the last step attempt — do nothing.
    Wait,
    /// Walk one step in this direction next.
    Walk(u8),
    /// The next hop is a closed door (see [`Terrain::door_at`]) — send `Use`
    /// on this serial instead of walking into it. Unlike `Walk`, the caller
    /// doesn't need to report back whether the packet actually landed (a
    /// `Use` has no `Walker`-style pending-step budget to gate it) — `advance`
    /// itself owns all the open/await/give-up bookkeeping (see
    /// [`Route::door_attempts`]).
    OpenDoor(u32),
    /// The goal is reached, or no path remains given what we've learned —
    /// drop the route.
    Done,
}

/// [`Action::WalkTo`] (click-to-walk) bookkeeping for the headless driver —
/// the non-blocking analogue of [`Session::navigate_to`]. Mirrors the
/// play-server's own click-to-walk loop (`anima-net/src/bin/play.rs`, its
/// `auto_goal`/`auto_blocked`/… locals), just packaged as a struct so
/// [`Session::advance_route`] can drive it one tick at a time instead of
/// owning a bespoke loop. Deliberately network-free (no `Session`/socket
/// access) so [`Route::advance`] is unit-testable with a stubbed [`Terrain`].
/// A step `advance` has proposed but not yet confirmed sent. [`Route::step_sent`]
/// only promotes this into the armed `pending_move`/`from`/`target` fields when
/// the packet actually reached the wire — mirrors `play.rs`'s `auto_pending_move`,
/// which is likewise only set inside `if session.walk(sd, false).unwrap_or(false)`.
/// A gated attempt (the movement-prediction budget was exhausted, or
/// `walking_failed` latched) must be dropped instead of armed, or the *next*
/// `advance` would mistake "we never sent this" for "the server denied this"
/// and wrongly blacklist a tile that was never attempted.
#[derive(Debug, Clone, Copy)]
struct Candidate {
    from: (u16, u16),
    target: (u32, u32),
    is_move: bool,
}

/// Per-tile door-open retry bookkeeping for [`Route::advance`] — a lighter
/// mirror of `pathing::DoorUseAttempt` (attempt count + when the last `Use` was
/// sent), minus the door's own graphic: `Route` never sees a live [`World`],
/// so it has no way to tell "this `Use` already landed and toggled the door"
/// the way `play_server`'s executor can (see `decide_blocked_step`'s
/// `door_state_changed` doc) — it always takes that function's cooldown-only
/// path instead. Safe (just occasionally a little slower to react to a door
/// that already reopened than `play_server`'s human-facing loop would be).
#[derive(Debug, Clone, Copy)]
struct DoorAttempt {
    count: u32,
    sent_at: Instant,
}

#[derive(Debug)]
struct Route {
    goal: (u32, u32),
    /// Tiles the server has *denied* (static map said walkable, a
    /// building/dynamic blocker disagreed) — re-paths route around them, like
    /// `navigate_to`'s `Avoiding`. Also gains a tile whose closed door never
    /// opened after [`MAX_DOOR_OPEN_ATTEMPTS`] tries (see `advance`'s
    /// door-handling arm) — treated like any other wall from then on.
    blocked: HashSet<(u32, u32)>,
    /// Steps successfully issued so far (the runaway guard). Only real walks
    /// count — a door `Use` attempt does not (mirrors `play_server`'s
    /// `auto_steps`, which likewise only increments on an actual walk send).
    steps: u32,
    max_steps: u32,
    last_step: Instant,
    /// Cadence for the next step, refreshed from [`walk_pacing`] each tick by
    /// [`Session::advance_route`] — a mounted or running character steps two to
    /// four times as often as [`ROUTE_STEP`]'s unmounted walk. Seeded to the
    /// slowest tier so a `Route` driven directly (the unit tests, any caller
    /// that doesn't refresh it) keeps the old, always-safe pacing.
    step_delay: Duration,
    /// Whether the last *armed* (successfully sent) step was a real move (not
    /// a turn) and, if so, where we were and which tile we aimed for — lets
    /// the next `advance` detect a server deny (the tile didn't change) and
    /// blacklist it. Only [`Route::step_sent`] arms these, from `candidate`.
    pending_move: bool,
    from: (u16, u16),
    target: (u32, u32),
    /// `advance`'s most recent proposed step, awaiting `step_sent` to say
    /// whether it actually went out. See [`Candidate`].
    candidate: Option<Candidate>,
    /// Closed doors currently blocking the route's next hop, keyed by tile —
    /// see [`DoorAttempt`] and `advance`'s door-handling arm.
    door_attempts: HashMap<(u32, u32), DoorAttempt>,
}

impl Route {
    fn new(gx: u32, gy: u32) -> Self {
        Self::with_max_steps(gx, gy, ROUTE_MAX_STEPS)
    }

    fn from_server(gx: u32, gy: u32) -> Self {
        Self::with_max_steps(gx, gy, SERVER_ROUTE_MAX_STEPS)
    }

    fn with_max_steps(gx: u32, gy: u32, max_steps: u32) -> Self {
        Route {
            goal: (gx, gy),
            blocked: HashSet::new(),
            steps: 0,
            max_steps,
            // Already "due" so the very first `advance` after a `WalkTo` steps
            // immediately instead of waiting a full cadence.
            last_step: Instant::now() - ROUTE_STEP,
            step_delay: ROUTE_STEP,
            pending_move: false,
            from: (0, 0),
            target: (0, 0),
            candidate: None,
            door_attempts: HashMap::new(),
        }
    }

    /// Decide the next move given the current player pose. Does not touch the
    /// network or mutate `steps`/`last_step` for a [`RouteStep::Walk`] — the
    /// caller reports back via [`Route::step_sent`] once it knows whether the
    /// packet actually went out (a zero movement-prediction budget can mean it
    /// didn't); only then does `step_sent` arm the deny-detection bookkeeping
    /// below (see [`Candidate`]). A [`RouteStep::OpenDoor`]/an internally
    /// abandoned door tile, by contrast, is fully decided here — see
    /// [`RouteStep::OpenDoor`]'s doc.
    ///
    /// Uses [`find_path_near`] (not the exact-goal-only `find_path`) so a
    /// goal whose precise tile isn't reachable still resolves to the nearest
    /// standable tile within [`ROUTE_GOAL_SLOP`] instead of hard-rejecting —
    /// ClassicUO parity, mirroring `play_server`'s own `WalkTo` handling (see
    /// `find_path_near`'s doc). `terrain`'s [`Terrain::door_at`] — a no-op
    /// default for a plain grid/`MapData`, real for `pathing::MapTerrain` —
    /// is what actually gives this door awareness; the pathfinding itself
    /// doesn't need to know about doors (planning already treats a closed
    /// one as passable).
    fn advance<T: Terrain>(
        &mut self,
        terrain: &mut T,
        pos: (u16, u16, i8),
        facing: u8,
    ) -> RouteStep {
        let (px, py, pz) = pos;
        if (px as u32, py as u32) == self.goal {
            return RouteStep::Done;
        }
        if self.last_step.elapsed() < self.step_delay {
            return RouteStep::Wait;
        }
        // Did the previously *armed* move land? If our tile didn't change, the
        // server denied that tile — blacklist it so the re-path detours (mirrors
        // `navigate_to`/`play.rs`'s own deny detection).
        if self.pending_move && (px, py) == self.from {
            self.blocked.insert(self.target);
        }
        self.pending_move = false;

        // Loops only on `BlockedStepAction::Blacklist` (a door that gave up):
        // that permanently adds one more tile to `self.blocked` before
        // re-pathing, so this terminates — bounded by the (finite) number of
        // distinct door tiles any candidate route could ever offer up.
        loop {
            let resolved = {
                let mut avoid = Avoiding {
                    inner: terrain,
                    blocked: &self.blocked,
                };
                find_path_near(
                    &mut avoid,
                    (px as u32, py as u32, pz as i32),
                    self.goal,
                    ROUTE_GOAL_SLOP,
                    DEFAULT_MAX_EXPANSIONS,
                )
            };
            let Some((_resolved_goal, steps)) = resolved else {
                return RouteStep::Done; // nothing reachable at all, even nearby — give up
            };
            if steps.is_empty() {
                // Already standing at the nearest reachable tile — a legitimate
                // "arrived" (mirrors `find_path_near`'s empty-path semantics), not
                // a failure just because the exact goal itself is unstandable.
                return RouteStep::Done;
            }
            let step = steps[0];
            let tile = (step.x, step.y);

            // Is the chosen next hop a closed door right now? Planning already
            // treats it as passable (see `Terrain::door_at`'s doc), so negotiate
            // actually opening it instead of walking into what the real server
            // would just deny.
            if let Some(serial) = terrain.door_at(step.x, step.y, pz as i32) {
                let prior = self.door_attempts.get(&tile).copied();
                let attempts = prior.map_or(0, |a| a.count);
                let sent_at = prior.map(|a| a.sent_at);
                // `door_state_changed` is always `false` here — see
                // `DoorAttempt`'s doc for why `Route` can't tell any better.
                let action =
                    decide_blocked_step(Some(serial), attempts, sent_at, false, Instant::now());
                match action {
                    BlockedStepAction::OpenDoor(serial) => {
                        self.door_attempts.insert(
                            tile,
                            DoorAttempt {
                                count: attempts + 1,
                                sent_at: Instant::now(),
                            },
                        );
                        // Consumes this tick's cadence, like a real walk attempt.
                        self.last_step = Instant::now();
                        return RouteStep::OpenDoor(serial);
                    }
                    BlockedStepAction::AwaitDoor => {
                        self.last_step = Instant::now();
                        return RouteStep::Wait;
                    }
                    BlockedStepAction::Blacklist => {
                        // Not a decision worth reporting to the caller — prune this
                        // dead-end tile and immediately re-path around it, same as
                        // if the server had denied it (see the `pending_move` check
                        // above). No cadence cost: whatever this loop lands on next
                        // (a detour, or truly `Done`) is this tick's real answer.
                        self.blocked.insert(tile);
                        self.door_attempts.remove(&tile);
                        continue;
                    }
                }
            }
            // No longer (or never) blocked by a door here — drop any stale
            // bookkeeping (harmless no-op if absent).
            self.door_attempts.remove(&tile);

            // Not armed yet — just proposed. `step_sent` decides whether this
            // becomes the next `advance`'s deny check.
            self.candidate = Some(Candidate {
                from: (px, py),
                target: (step.x, step.y),
                is_move: facing == step.dir,
            });
            return RouteStep::Walk(step.dir);
        }
    }

    /// Record that `advance`'s proposed step attempt is done for this tick —
    /// always resets the cadence clock (mirrors `play.rs`, which paces on
    /// attempts, not just successful sends). Only `sent` arms the pending
    /// candidate (see [`Candidate`]) into `pending_move`/`from`/`target` and
    /// counts it toward the runaway guard; a gated send (`false`) discards the
    /// candidate, so a tile that was never attempted can't be blacklisted as if
    /// the server had denied it — the route just retries the same tile once
    /// next due.
    fn step_sent(&mut self, sent: bool) {
        self.last_step = Instant::now();
        if sent {
            self.steps += 1;
            if let Some(c) = self.candidate.take() {
                self.from = c.from;
                self.target = c.target;
                self.pending_move = c.is_move;
            }
        } else {
            self.candidate = None;
        }
    }
}

/// Convert the latest core 0x38 event into a fresh native route exactly once.
/// A repeated destination with a newer seq intentionally replaces the route,
/// matching ClassicUO's `WalkTo` restart semantics.
fn next_server_pathfind_route(world: &World, last_seq: &mut u64) -> Option<Route> {
    let request = world.server_pathfind?;
    if request.seq <= *last_seq {
        return None;
    }
    *last_seq = request.seq;
    Some(Route::from_server(request.x as u32, request.y as u32))
}

fn correlate_logout_ack(
    pending: bool,
    after_seq: u64,
    ack: Option<anima_core::world::LogoutAck>,
) -> Option<bool> {
    pending
        .then_some(ack)
        .flatten()
        .filter(|ack| ack.seq > after_seq)
        .map(|ack| ack.allowed)
}

/// A live connection to a UO server: the game-phase socket plus the world state
/// it feeds.
pub struct Session {
    id: String,
    layout_identity: String,
    stream: TcpStream,
    decoder: StreamDecoder,
    walker: Walker,
    journal_cursor: usize,
    pub world: World,
    pub confirms: u32,
    pub denies: u32,
    /// The active [`Action::WalkTo`] route, if any — see [`Session::advance_route`].
    route: Option<Route>,
    /// Last 0x38 server pathfinding event converted into `route`.
    server_pathfind_seq: u64,
    /// Whether a 0xD1 request is awaiting a fresh server permission reply.
    logout_pending: bool,
    /// Core reply sequence current when the pending request was sent.
    logout_after_seq: u64,
    /// Whether the 0xA9 character-list flags require the 0xD1 handshake.
    logout_handshake: bool,
    /// Immediate-disconnect path used when that capability flag is absent.
    logout_immediate: bool,
    /// Last time we sent a 0x73 keepalive ping.
    last_ping: Instant,
    /// Last time we asked for 0xF0 party/guild world-map positions.
    last_track: Instant,
    /// Consecutive 0xF0 queries sent without the shard ever having answered.
    /// Reset to 0 by any reply; once it reaches `TRACK_MAX_PROBES` we stop
    /// asking a shard that evidently does not speak the extension.
    track_probes: u8,
    /// Rolling sequence byte for the keepalive ping.
    ping_seq: u8,
    /// Traffic + latency counters for the UO socket (see [`NetStats`]).
    pub stats: NetStats,
    /// `speech.mul` keyword table. When set, [`Action::Say`] that matches a
    /// keyword goes out as encoded 0xAD so ServUO fills `e.Keywords`.
    speech: Option<Speeches>,
}

/// What the link to the game server is actually doing — ClassicUO's
/// `NetStatistics`, measured where it can be measured: here, in the driver that
/// owns the socket, not in the sans-IO core that has neither a socket nor a
/// clock.
///
/// The ping is a real round trip, not an estimate: 0x73 carries a sequence byte
/// and ServUO echoes it back untouched (`PacketHandlers.PingReq` →
/// `PingAck.Instantiate(pvSrc.ReadByte())`), so the reply identifies which send
/// it answers. Like ClassicUO we keep the last five and average the ones that
/// have come back.
#[derive(Debug, Clone, Default)]
pub struct NetStats {
    /// Bytes read off the socket since login. Counted before decompression, so
    /// this is what actually crossed the wire — the game phase is Huffman-coded
    /// server→client and the decoded stream is much larger.
    pub bytes_in: u64,
    /// Bytes written to the socket since login.
    pub bytes_out: u64,
    /// Complete game packets decoded since login.
    pub packets_in: u64,
    /// Packets sent since login.
    pub packets_out: u64,
    /// Round-trip times of the last five pings, in **microseconds**; `None` =
    /// that slot has not answered yet.
    ///
    /// ClassicUO stores milliseconds and uses 0 for "unanswered"
    /// (`NetStatistics.Ping` skips zero slots), which cannot tell a link faster
    /// than a millisecond from a link that never replied — against a shard on
    /// the same machine, as here, its gump reads 0 ms forever. Microseconds and
    /// an explicit `None` separate the two.
    pings: [Option<u32>; 5],
    /// Which slot the next ping will use, and when it went out.
    ping_idx: usize,
    ping_sent: Option<(u8, Instant)>,
}

impl NetStats {
    /// Mean round trip of the pings that have come back, in microseconds.
    /// `None` before the first reply, which is a different thing from a fast
    /// link and is shown as a different thing.
    pub fn ping_us(&self) -> Option<u32> {
        let answered: Vec<u32> = self.pings.iter().filter_map(|&p| p).collect();
        if answered.is_empty() {
            return None;
        }
        Some((answered.iter().map(|&p| p as u64).sum::<u64>() / answered.len() as u64) as u32)
    }

    /// A 0x73 came back. Only the sequence byte we are waiting on counts — a
    /// stale echo (or a server that answers twice) must not be timed against
    /// the newest send.
    fn ping_echo(&mut self, seq: u8) {
        if let Some((sent_seq, at)) = self.ping_sent {
            if sent_seq == seq {
                let slot = self.ping_idx % self.pings.len();
                self.pings[slot] = Some(at.elapsed().as_micros().min(u32::MAX as u128) as u32);
                self.ping_idx = self.ping_idx.wrapping_add(1);
                self.ping_sent = None;
            }
        }
    }
}

impl Session {
    /// Stable for this connection; a reconnect gets a new ID even if the server
    /// assigns the same player serial. Renderers use it to discard old UI work.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The account/shard/character identity the web client keys its saved
    /// window layout on (read by `anima-net`'s scene builder).
    pub fn layout_identity(&self) -> &str {
        &self.layout_identity
    }

    /// Connect, run the full two-phase login handshake, enter the world, and
    /// return a session whose [`World`] is seeded with the login result.
    pub fn connect_and_login(
        endpoint: &Endpoint,
        cfg: LoginConfig,
    ) -> Result<Session, DriverError> {
        Self::connect_and_login_controlled(endpoint, cfg, &LoginControl::default(), None)
    }

    /// Connect and pause after account authentication so a caller can display
    /// the real server-provided character list before choosing or creating.
    /// `chooser` may be invoked more than once for a single login: a rejected
    /// `CharacterChoice::Delete` (server `0x85`) re-invokes it with the same
    /// list plus [`CharacterPrompt::delete_rejected`] set, instead of failing
    /// the login (ClassicUO parity — a rejected delete is informational).
    pub fn connect_and_login_with_character_chooser<F>(
        endpoint: &Endpoint,
        mut cfg: LoginConfig,
        mut chooser: F,
    ) -> Result<Session, DriverError>
    where
        F: FnMut(CharacterPrompt) -> Result<CharacterChoice, DriverError>,
    {
        cfg.defer_character_choice = true;
        Self::connect_and_login_controlled(
            endpoint,
            cfg,
            &LoginControl::default(),
            Some(&mut chooser),
        )
    }

    /// Connect with a caller-owned cancellation handle. A cancelled attempt
    /// closes its transport; a committed live session is no longer cancellable.
    pub fn connect_and_login_controlled(
        endpoint: &Endpoint,
        mut cfg: LoginConfig,
        control: &LoginControl,
        chooser: Option<&mut dyn FnMut(CharacterPrompt) -> Result<CharacterChoice, DriverError>>,
    ) -> Result<Session, DriverError> {
        if chooser.is_some() {
            cfg.defer_character_choice = true;
        }
        let result = Self::connect_and_login_inner(endpoint, cfg, chooser, control);
        control.release();
        control.check()?;
        if result.is_ok() {
            control.finish()?;
        }
        result
    }

    fn connect_and_login_inner(
        endpoint: &Endpoint,
        cfg: LoginConfig,
        chooser: Option<&mut dyn FnMut(CharacterPrompt) -> Result<CharacterChoice, DriverError>>,
        control: &LoginControl,
    ) -> Result<Session, DriverError> {
        // A renderer hashes this non-secret identity with the actual player
        // serial for durable layout storage; connection IDs intentionally change.
        let layout_identity = serde_json::to_string(&(
            "native-v1",
            endpoint.host.trim().to_lowercase(),
            endpoint.port,
            cfg.server_index,
            &cfg.username,
        ))
        .unwrap();
        let (result, stream, decoder) =
            login(endpoint, cfg, chooser, control, CONNECT_READ_TIMEOUT)?;
        let mut world = World::new();
        world.enter_world(&result);
        stream.set_read_timeout(Some(PUMP_READ_TIMEOUT)).ok();
        let mut session = Session {
            id: connection::fresh_context_id(),
            layout_identity,
            stream,
            decoder,
            walker: Walker::new(),
            journal_cursor: 0,
            world,
            confirms: 0,
            denies: 0,
            route: None,
            server_pathfind_seq: 0,
            logout_pending: false,
            logout_after_seq: 0,
            logout_handshake: result.character_list_flags & CHARACTER_LIST_FLAG_LOGOUT_HANDSHAKE
                != 0,
            logout_immediate: false,
            last_ping: Instant::now(),
            last_track: Instant::now(),
            track_probes: 0,
            ping_seq: 0,
            stats: NetStats::default(),
            speech: None,
        };
        // ServUO doesn't push our stats/skills unsolicited — request them so the
        // first Observation carries them (ClassicUO does the same on login).
        // 0x11 stats, then 0x3A skills.
        session.send(&build_status_request(4, result.serial))?;
        session.send(&build_status_request(5, result.serial))?;
        // Advertise our draw range so the server sends mobiles/items in view
        // (ClassicUO sends 0xC8 on login); keep World in sync with what we asked.
        session.send(&build_client_view_range(DEFAULT_VIEW_RANGE))?;
        session.world.client_view_range = DEFAULT_VIEW_RANGE;
        Ok(session)
    }

    /// Attach a `speech.mul` table so [`Action::Say`] can send encoded keywords.
    /// Without this, speech still works as plain text; NPC/boat keyword commands
    /// will not.
    pub fn set_speech(&mut self, speech: Speeches) {
        self.speech = Some(speech);
    }

    /// Build a perception [`Observation`] for a brain (advances the journal cursor
    /// so each line is seen once).
    ///
    /// The result's `terrain` is `None`: the ground is not in any packet, so
    /// only a caller holding map data can perceive it — see
    /// [`Session::observation_with_terrain`].
    pub fn observation(&mut self) -> Observation {
        self.world.observe(&mut self.journal_cursor)
    }

    /// [`Session::observation`] plus a walkability window of `radius` tiles
    /// around the player, so a brain can see walls, water, height and doors
    /// instead of delegating every movement decision to this driver's
    /// pathfinder.
    ///
    /// Surveyed through the same [`pathing::MapTerrain`] the auto-walk route
    /// uses, so what the brain sees and what `Action::WalkTo` will actually do
    /// cannot disagree. Costs `(2 * radius + 1)²` walkability queries against
    /// cached map blocks; `radius` 8–12 covers the screen, and the caller
    /// chooses because a combat brain polling every tick wants a smaller
    /// window than a mapper.
    pub fn observation_with_terrain(&mut self, map: &mut MapData, radius: u8) -> Observation {
        let mut obs = self.observation();
        let Some(p) = self.world.player_mobile() else {
            return obs; // not in the world yet — nothing to centre on
        };
        let (center, from_z) = ((p.pos.x, p.pos.y), p.pos.z);
        let empty = HashSet::new();
        let mut terrain = MapTerrain {
            world: &self.world,
            map,
            blocked: &empty,
            multis: None,
        };
        obs.terrain = Some(survey_terrain(&mut terrain, center, from_z, radius));
        obs
    }

    /// Execute a high-level [`Action`] from a brain.
    pub fn apply_action(&mut self, action: &Action) -> Result<(), DriverError> {
        match action {
            Action::Walk { dir, run } => {
                // A manual step cancels any active auto-walk route (mirrors
                // play.rs's manual-key handling).
                self.route = None;
                self.walk(*dir, *run)?;
            }
            // Keywords (from speech.mul) force encoded 0xAD even for ASCII —
            // ServUO's 0x03 path never fills e.Keywords. No match: ASCII stays
            // on 0x03, everything else is unencoded 0xAD so Korean survives.
            Action::Say { text, mode } => {
                let msg_type = mode.wire();
                let ids = self
                    .speech
                    .as_ref()
                    .map(|s| s.keywords(text))
                    .unwrap_or_default();
                if !ids.is_empty() {
                    self.send(&build_unicode_say(text, msg_type, 0x0034, 3, &ids))?
                } else if text.is_ascii() {
                    self.send(&build_say(text, msg_type, 0x0034, 3))?
                } else {
                    self.send(&build_unicode_say(text, msg_type, 0x0034, 3, &[]))?
                }
            }
            Action::PartySay { text } => self.send(&build_party_message(text))?,
            Action::Attack { serial } => {
                self.world.last_attack = Some(*serial);
                self.send(&build_attack(*serial))?
            }
            // Pick the best target from the world (last target if still a live
            // in-view hostile, else nearest in-view hostile) and attack it.
            Action::AutoAttack => {
                if let Some(serial) = self.world.auto_attack_target() {
                    self.world.last_attack = Some(serial);
                    self.send(&build_attack(serial))?;
                }
            }
            // Re-attack the remembered last target (no-op if none yet).
            Action::AttackLast => {
                if let Some(serial) = self.world.last_attack {
                    self.send(&build_attack(serial))?;
                }
            }
            Action::Use { serial } => self.send(&build_double_click(*serial))?,
            Action::Click { serial } => self.send(&build_single_click(*serial))?,
            Action::PickUp { serial, amount } => self.send(&build_pick_up(*serial, *amount))?,
            Action::Drop {
                serial,
                x,
                y,
                z,
                container,
            } => self.send(&build_drop(*serial, *x, *y, *z, *container))?,
            Action::Equip { serial, layer } => {
                let mobile = self.world.player_mobile().map(|p| p.serial).unwrap_or(0);
                self.send(&build_equip(*serial, *layer, mobile))?
            }
            Action::WarMode { on } => self.send(&build_war_mode(*on))?,
            Action::CastSpell { spell } => self.send(&build_cast_spell(*spell))?,
            Action::TargetObject { serial } => self.respond_target(Some(*serial), 0, 0, 0, 0)?,
            Action::TargetGround { x, y, z, graphic } => {
                self.respond_target(None, *x, *y, *z, *graphic)?
            }
            Action::TargetCancel => self.cancel_target()?,
            Action::BuyItems { vendor, items } => self.send(&build_buy(*vendor, items))?,
            Action::SellItems { vendor, items } => {
                self.send(&build_sell(*vendor, items))?;
                // The sell list is consumed once we answer it — clear it
                // locally so a later, unrelated sell trip can't accidentally
                // re-answer this stale list (mirrors PopupSelect clearing
                // world.popup below).
                self.world.close_shop_sell();
            }
            Action::GumpResponse {
                serial,
                gump_id,
                button,
                switches,
                entries,
            } => {
                self.send(&build_gump_response(
                    *serial, *gump_id, *button, switches, entries,
                ))?;
                // The gump is consumed once we answer it — drop it from the world so
                // the renderer/brain stop seeing a stale dialog.
                self.world.close_gump(*serial);
            }
            Action::PopupRequest { serial } => self.send(&build_popup_request(*serial))?,
            Action::PopupSelect { serial, index } => {
                self.send(&build_popup_select(*serial, *index))?;
                // The menu is consumed once we pick — clear it locally so the
                // renderer/brain stop seeing a stale popup.
                self.world.popup = None;
            }
            Action::LegacyMenuSelect { serial, index } => {
                // Resolve all opaque response fields from the current menu. A stale
                // action or out-of-range nonzero index is a no-op rather than a
                // forged/cancel response to the wrong server-side menu.
                let response = self.world.legacy_menu(*serial).and_then(|menu| {
                    if *index == 0 {
                        Some((menu.menu_id, 0, 0))
                    } else {
                        menu.entries.get(*index as usize - 1).map(|entry| {
                            let (graphic, hue) = match menu.kind {
                                LegacyMenuKind::Items => (entry.graphic, entry.hue),
                                LegacyMenuKind::Question => (0, 0),
                            };
                            (menu.menu_id, graphic, hue)
                        })
                    }
                });
                if let Some((menu_id, graphic, hue)) = response {
                    self.send(&build_legacy_menu_response(
                        *serial, menu_id, *index, graphic, hue,
                    ))?;
                    self.world.close_legacy_menu(*serial);
                }
            }
            Action::HuePickerSelect { serial, hue } => {
                // Picker serials are server callbacks. Never answer a stale picker:
                // ServUO would ignore it, while keeping our actual live picker open.
                if self.world.hue_picker(*serial).is_some() {
                    self.send(&build_hue_picker_response(*serial, *hue))?;
                    self.world.close_hue_picker(*serial);
                }
            }
            Action::BookRequest { serial, pages } => {
                self.send(&build_book_page_request(*serial, *pages))?;
            }
            Action::UseAbility { ability } => {
                let serial = self.world.player_mobile().map(|p| p.serial).unwrap_or(0);
                self.send(&build_use_ability(serial, *ability))?;
                // The optimistic half of `World::armed_ability`: an arm is never
                // acknowledged, only revoked (0xBF/0x21), so if we don't record
                // it here nothing ever will. Same shape as the skill/stat locks
                // above, and `arm_ability` applies ClassicUO's re-arm toggle.
                self.world.arm_ability(*ability);
            }
            Action::DisarmRequest => self.send(&build_disarm_request())?,
            Action::StunRequest => self.send(&build_stun_request())?,
            Action::ToggleFlying => self.send(&build_toggle_flying())?,
            Action::BandageTarget { bandage, target } => {
                // target 0 = "myself" (see the Action's doc).
                let target = if *target != 0 {
                    *target
                } else {
                    self.world.player_mobile().map(|p| p.serial).unwrap_or(0)
                };
                self.send(&build_bandage_target(*bandage, target))?;
            }
            Action::TargetedSpell { spell, target } => {
                let target = if *target != 0 {
                    *target
                } else {
                    self.world.player_mobile().map(|p| p.serial).unwrap_or(0)
                };
                self.send(&build_targeted_spell(*spell, target))?;
            }
            Action::TargetedSkill { skill, target } => {
                let target = if *target != 0 {
                    *target
                } else {
                    self.world.player_mobile().map(|p| p.serial).unwrap_or(0)
                };
                self.send(&build_targeted_skill(*skill, target))?;
            }
            Action::TargetByResource { tool, resource } => {
                self.send(&build_target_by_resource(*tool, *resource))?;
            }
            Action::SkillLock { skill, lock } => {
                self.send(&build_skill_lock(*skill, *lock))?;
                // Optimistically reflect the new lock locally so the UI updates
                // immediately (the server also echoes a 0x3A single update).
                if let Some(s) = self.world.skills.get_mut(skill) {
                    s.lock = *lock;
                }
            }
            Action::StatLock { stat, lock } => {
                self.send(&build_stat_lock(*stat, *lock))?;
                // Same optimistic local update as `SkillLock` above: ServUO
                // echoes the new state in the next 0xBF/0x19, but the UI
                // shouldn't wait a round trip to show the toggle.
                match stat {
                    0 => self.world.player_stats.str_lock = *lock,
                    1 => self.world.player_stats.dex_lock = *lock,
                    2 => self.world.player_stats.int_lock = *lock,
                    _ => {}
                }
            }
            Action::UseSkill { skill } => self.send(&build_use_skill(*skill))?,
            Action::OpenDoor => self.send(&build_open_door())?,
            Action::OpenSpellbook { book_type } => self.send(&build_open_spellbook(*book_type))?,
            Action::EquipLastWeapon => {
                let serial = self.world.player_mobile().map(|p| p.serial).unwrap_or(0);
                self.send(&build_equip_last_weapon(serial))?;
            }
            Action::InvokeVirtue { id } => self.send(&build_invoke_virtue(*id))?,
            Action::EmoteAction { action } => self.send(&build_emote_action(action))?,
            Action::CastSpellFromBook { spell, book } => {
                self.send(&build_cast_spell_from_book(*spell, *book))?;
            }
            Action::AllNames => {
                const CAP: usize = 60;
                let self_serial = self.world.player_mobile().map(|p| p.serial);
                let mut n = 0usize;
                let mobiles: Vec<u32> = self
                    .world
                    .mobiles
                    .values()
                    .filter(|m| Some(m.serial) != self_serial)
                    .map(|m| m.serial)
                    .collect();
                for serial in mobiles {
                    if n >= CAP {
                        break;
                    }
                    self.send(&build_single_click(serial))?;
                    n += 1;
                }
                let corpses: Vec<u32> = self
                    .world
                    .items
                    .values()
                    .filter(|it| it.graphic == 0x2006)
                    .map(|it| it.serial)
                    .collect();
                for serial in corpses {
                    if n >= CAP {
                        break;
                    }
                    self.send(&build_single_click(serial))?;
                    n += 1;
                }
            }
            Action::ChangeRace {
                skin_hue,
                hair_style,
                hair_hue,
                beard_style,
                beard_hue,
            } => {
                self.send(&build_change_race_request(
                    *skin_hue,
                    *hair_style,
                    *hair_hue,
                    *beard_style,
                    *beard_hue,
                ))?;
                self.world.race_change = None;
            }
            Action::ChangeRaceCancel => {
                self.send(&build_change_race_cancel())?;
                self.world.race_change = None;
            }
            Action::OpenUOStore => self.send(&build_open_uo_store())?,
            Action::OplRequest { serial } => self.send(&build_opl_request(&[*serial]))?,
            Action::PartyInvite => self.send(&build_party_invite())?,
            Action::PartyAccept { leader } => {
                // leader 0 = "the pending inviter" (the UI may omit the serial).
                let leader = if *leader != 0 {
                    *leader
                } else {
                    self.world.party.pending_invite.unwrap_or(0)
                };
                self.send(&build_party_accept(leader))?;
                // We answered the invite — drop it locally so the prompt clears even
                // before the server's member-list update lands.
                self.world.party.pending_invite = None;
            }
            Action::PartyDecline { leader } => {
                let leader = if *leader != 0 {
                    *leader
                } else {
                    self.world.party.pending_invite.unwrap_or(0)
                };
                self.send(&build_party_decline(leader))?;
                self.world.party.pending_invite = None;
            }
            Action::PartyLeave => {
                let serial = self.world.player_mobile().map(|p| p.serial).unwrap_or(0);
                self.send(&build_party_leave(serial))?;
            }
            Action::PartyKick { member } => self.send(&build_party_remove(*member))?,
            Action::PartyPrivateMessage { member, text } => {
                self.send(&build_party_private_message(*member, text))?;
            }
            Action::PartySetCanLoot { can_loot } => {
                self.send(&build_party_can_loot(*can_loot))?;
            }
            Action::StatusRequest { serial } => {
                // serial 0 = ourselves, the same sentinel `BandageTarget` uses.
                let serial = if *serial != 0 {
                    *serial
                } else {
                    self.world.player_mobile().map(|p| p.serial).unwrap_or(0)
                };
                self.send(&build_status_request(4, serial))?;
            }
            Action::SkillsRequest => {
                let serial = self.world.player_mobile().map(|p| p.serial).unwrap_or(0);
                self.send(&build_status_request(5, serial))?;
            }
            Action::NameRequest { serial } => self.send(&build_name_request(*serial))?,
            Action::ViewRange { range } => {
                let range = (*range).clamp(5, 24);
                self.send(&build_client_view_range(range))?;
                self.world.client_view_range = range;
            }
            Action::ObjectHelp { serial } => self.send(&build_object_help_request(*serial))?,
            Action::Language { code } => self.send(&build_language(code))?,
            Action::Animate { action } => self.send(&build_animate_request(*action))?,
            Action::PublicHouseContent { show } => self.send(&build_public_house_content(*show))?,
            Action::BulletinRequestMessage { board, message } => {
                self.send(&build_bulletin_request_message(*board, *message))?;
            }
            Action::BulletinRequestSummary { board, message } => {
                self.send(&build_bulletin_request_summary(*board, *message))?;
            }
            Action::BulletinPost {
                board,
                reply_to,
                subject,
                lines,
            } => {
                let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
                self.send(&build_bulletin_post_message(
                    *board, *reply_to, subject, &refs,
                ))?;
            }
            Action::BulletinRemove { board, message } => {
                self.send(&build_bulletin_remove_message(*board, *message))?;
            }
            Action::BoatMove { dir, run } => {
                let serial = self.world.player_mobile().map(|p| p.serial).unwrap_or(0);
                let speed = if *run {
                    BOAT_SPEED_FAST
                } else {
                    BOAT_SPEED_SLOW
                };
                self.send(&build_boat_move_request(serial, *dir, speed))?;
            }
            Action::BoatStop => {
                let serial = self.world.player_mobile().map(|p| p.serial).unwrap_or(0);
                // Direction is irrelevant to a stop; ServUO reaches `StopMove`
                // through the zero speed, not through `d`. Send our facing so
                // the packet is never nonsense on the wire.
                let dir = self.world.player_mobile().map(|p| p.direction).unwrap_or(0);
                self.send(&build_boat_move_request(serial, dir, BOAT_SPEED_STOP))?;
            }
            // Book edits are unacknowledged like map pins, but unlike them the
            // local copy is the server's own text echoed back on the next open,
            // so there is nothing to apply optimistically — a re-read is the
            // confirmation.
            Action::BookHeaderChange {
                serial,
                title,
                author,
            } => {
                self.send(&build_book_header_change(*serial, title, author))?;
            }
            Action::BookPageWrite {
                serial,
                page,
                lines,
            } => {
                self.send(&build_book_page_write(*serial, *page, lines))?;
            }
            // `MapToggleEditable` is answered (0x56 command 7) and the
            // server's verdict can differ from a plain flip, so it is left to
            // the echo. The pin edits are NOT answered — ServUO records them
            // and sends nothing — so the local view only changes if we change
            // it; `apply_map_edit` is why that has to be conditional.
            Action::MapToggleEditable { serial } => {
                self.send(&build_map_toggle_editable(*serial))?;
            }
            Action::MapAddPin { serial, x, y } => {
                self.send(&build_map_add_pin(*serial, *x, *y))?;
                self.apply_map_edit(*serial, 1, 0, *x, *y);
            }
            Action::MapInsertPin {
                serial,
                index,
                x,
                y,
            } => {
                self.send(&build_map_insert_pin(*serial, *index, *x, *y))?;
                self.apply_map_edit(*serial, 2, *index, *x, *y);
            }
            Action::MapChangePin {
                serial,
                index,
                x,
                y,
            } => {
                self.send(&build_map_change_pin(*serial, *index, *x, *y))?;
                self.apply_map_edit(*serial, 3, *index, *x, *y);
            }
            Action::MapRemovePin { serial, index } => {
                self.send(&build_map_remove_pin(*serial, *index))?;
                self.apply_map_edit(*serial, 4, *index, 0, 0);
            }
            Action::MapClearPins { serial } => {
                self.send(&build_map_clear_pins(*serial))?;
                self.apply_map_edit(*serial, 5, 0, 0, 0);
            }
            Action::ChatOpen => {
                // ServUO ignores the name and uses `from.Name`; send ours anyway
                // for wire parity with ClassicUO (see `build_chat_open`).
                let name = self
                    .world
                    .player_mobile()
                    .map(|p| p.name.clone())
                    .unwrap_or_default();
                self.send(&build_chat_open(&name))?;
            }
            Action::ChatJoin { channel, password } => {
                self.send(&build_chat_join(channel, password))?;
            }
            Action::ChatCreate { channel, password } => {
                self.send(&build_chat_create_channel(channel, password))?;
            }
            Action::ChatLeave => self.send(&build_chat_leave())?,
            Action::ChatSay { text } => self.send(&build_chat_message(text))?,
            Action::Rename { serial, name } => self.send(&build_rename_request(*serial, name))?,
            Action::QuestArrowClick { right_click } => {
                self.send(&build_quest_arrow_click(*right_click))?;
            }
            Action::HelpRequest => self.send(&build_help_request())?,
            Action::GuildMenu => {
                let serial = self.world.player_mobile().map(|p| p.serial).unwrap_or(0);
                self.send(&build_guild_menu_request(serial))?;
            }
            Action::QuestMenu => {
                let serial = self.world.player_mobile().map(|p| p.serial).unwrap_or(0);
                self.send(&build_quest_menu_request(serial))?;
            }
            Action::PromptResponse { text } => self.respond_prompt(text, false)?,
            Action::PromptCancel => self.respond_prompt("", true)?,
            Action::TipNavigate { seq, next } => self.navigate_tip(*seq, *next)?,
            Action::TipClose { seq } => self.world.close_tip(*seq),
            Action::TextEntryResponse {
                seq,
                text,
                accepted,
            } => self.respond_text_entry(*seq, text, *accepted)?,
            Action::TextEntryClose { seq } => {
                if self
                    .world
                    .text_entry_dialog(*seq)
                    .is_some_and(|dialog| dialog.can_close)
                {
                    self.world.close_text_entry_dialog(*seq);
                }
            }
            Action::ProfileRequest { serial } => self.send(&build_profile_request(*serial))?,
            Action::ProfileUpdate { seq, text } => self.update_profile(*seq, text)?,
            Action::ProfileClose { seq } => self.world.close_character_profile(*seq),
            Action::Logout => self.request_logout()?,
            // No-op if no session has `container` (the brain raced it away — it
            // may have just closed, or belongs to a session with a different
            // opponent that never existed on our side).
            Action::TradeAccept { container, accept } => {
                if self
                    .world
                    .trades
                    .iter()
                    .any(|t| t.my_container == *container)
                {
                    self.send(&build_trade_accept(*container, *accept))?;
                    // Optimistically reflect our own accept state locally (mirrors
                    // `SkillLock`'s optimistic update) — the server also echoes a
                    // 0x6F action-2 Update.
                    if let Some(t) = self.world.trade_mut(*container) {
                        t.my_accept = *accept;
                    }
                }
            }
            Action::TradeCancel { container } => {
                if self
                    .world
                    .trades
                    .iter()
                    .any(|t| t.my_container == *container)
                {
                    self.send(&build_trade_cancel(*container))?;
                    // The trade is over the moment we cancel — drop just this
                    // session locally (and purge its leftover container contents,
                    // see `World::close_trade`) so the renderer/brain stop seeing a
                    // stale session; the server's own 0x6F Close echo would
                    // otherwise lag a poll behind. Other concurrent sessions (a
                    // different opponent) are untouched.
                    self.world.close_trade(*container);
                }
            }
            Action::TradeGold {
                container,
                gold,
                platinum,
            } => {
                if self
                    .world
                    .trades
                    .iter()
                    .any(|t| t.my_container == *container)
                {
                    self.send(&build_trade_gold(*container, *gold, *platinum))?;
                    if let Some(t) = self.world.trade_mut(*container) {
                        t.my_offer_gold = *gold;
                        t.my_offer_platinum = *platinum;
                    }
                }
            }
            // Start (or replace) a non-blocking auto-walk route. This only
            // records the goal — [`Session::advance_route`] (called once per
            // tick by a runner that owns the terrain/map, e.g. `anima-agent`'s
            // loop) does the actual pathfinding + pacing; the play-server's own
            // HTTP loop instead intercepts `WalkTo` before it reaches here and
            // paces its own equivalent `auto_goal`.
            Action::WalkTo { x, y } => {
                self.route = Some(Route::new(*x as u32, *y as u32));
            }
            // Custom-house designer edit (0xD7). Every one of ServUO's
            // `Designer_*` handlers keys the whole session off the mobile that
            // sent the packet, so — like `PartyLeave`/`Logout` above — the
            // driver fills in our own serial rather than trusting the brain.
            Action::HouseDesign(cmd) => {
                let player = self.world.player_mobile().map(|p| p.serial).unwrap_or(0);
                let bytes = match *cmd {
                    HouseDesignAction::AddItem { graphic, x, y } => {
                        build_house_design_add_item(player, graphic, x, y)
                    }
                    HouseDesignAction::DeleteItem { graphic, x, y, z } => {
                        build_house_design_delete_item(player, graphic, x, y, z)
                    }
                    HouseDesignAction::AddStair { graphic, x, y } => {
                        build_house_design_add_stair(player, graphic, x, y)
                    }
                    HouseDesignAction::AddRoof { graphic, x, y, z } => {
                        build_house_design_add_roof(player, graphic, x, y, z)
                    }
                    HouseDesignAction::DeleteRoof { graphic, x, y, z } => {
                        build_house_design_delete_roof(player, graphic, x, y, z)
                    }
                    HouseDesignAction::GoToFloor(floor) => {
                        build_house_design_go_to_floor(player, floor)
                    }
                    HouseDesignAction::Commit => build_house_design_commit(player),
                    HouseDesignAction::Close => build_house_design_close(player),
                    HouseDesignAction::Clear => build_house_design_clear(player),
                    HouseDesignAction::Revert => build_house_design_revert(player),
                    HouseDesignAction::Backup => build_house_design_backup(player),
                    HouseDesignAction::Restore => build_house_design_restore(player),
                    HouseDesignAction::Sync => build_house_design_sync(player),
                };
                self.send(&bytes)?;
                // The five MUTATING edits are the only `Designer_*` handlers that
                // leave the client stale: each ends in `mcl.Add/Remove(...);
                // design.OnRevised();` and stops — no `SendDetailedInfoTo`, and not
                // even the `DesignStateGeneral` revision notice `Designer_Level`
                // sends. (Their lone `SendDetailedInfoTo` calls are error paths:
                // `!ValidPiece` in `Designer_Build`, the undeletable-tile bail in
                // `Designer_Delete`.) So the wall lands server-side and the player
                // never sees it appear. Clear/Revert/Restore/Level DO answer and
                // need nothing here. ClassicUO papers over the gap by mirroring the
                // piece into its own local house copy (`HouseCustomizationManager`
                // → `house.Add`), but `World` is our single source of truth, so we
                // chase each edit with a Sync (0x0E) — the handler whose whole job
                // is "resend full house state" — and render only what the server
                // confirms. That also makes the error paths free: a rejected piece
                // resyncs to the unchanged design instead of a bad optimistic add.
                if matches!(
                    *cmd,
                    HouseDesignAction::AddItem { .. }
                        | HouseDesignAction::DeleteItem { .. }
                        | HouseDesignAction::AddStair { .. }
                        | HouseDesignAction::AddRoof { .. }
                        | HouseDesignAction::DeleteRoof { .. }
                ) {
                    self.send(&build_house_design_sync(player))?;
                }
            }
        }
        Ok(())
    }

    /// Advance the active [`Action::WalkTo`] route by at most one step, paced
    /// at [`ROUTE_STEP`] — call this once per tick (e.g. right after
    /// [`Session::observe`]) so a headless brain's `WalkTo` actually walks. A
    /// no-op if no route is active. `map` is the runner-owned static map data;
    /// this builds a [`pathing::MapTerrain`] over it *and* `self.world` — the
    /// SAME door/dynamic-item-aware planning oracle `play_server`'s
    /// click-to-walk executor uses (see its doc), so a route can path through
    /// a closed door and, via `route.advance`'s [`RouteStep::OpenDoor`] arm
    /// below, actually open it on approach — not just the play-server's
    /// human-facing loop. Re-paths around a server deny, mirrors
    /// [`Session::navigate_to`]'s `Avoiding` for a tile the static map says is
    /// walkable but the server disagreed with (layered on top of, not
    /// instead of, `MapTerrain`'s own blacklist parameter, which is left
    /// empty here — `Route` owns the one blacklist that matters).
    pub fn advance_route(&mut self, map: &mut MapData) -> Result<(), DriverError> {
        let Some(mut route) = self.route.take() else {
            return Ok(());
        };
        let Some(p) = self.world.player_mobile() else {
            self.route = Some(route); // not in the world yet — try again next tick
            return Ok(());
        };
        let pos = (p.pos.x, p.pos.y, p.pos.z);
        let facing = p.direction;
        // Auto-walk *runs*, like a player holding the mouse down — but only
        // as fast as this character is actually allowed to move right now.
        // Re-read every tick: mounting, dismounting, running out of stamina
        // and a 0xBF/0x26 SpeedMode change all move this mid-route.
        let (run, step_ms) = walk_pacing(&self.world, true);
        route.step_delay = Duration::from_millis(step_ms);
        // Scoped so `terrain`'s borrow of `self.world` ends before the match
        // arms below need `&mut self` (e.g. `self.walk`/`self.apply_action`).
        let step = {
            let empty = HashSet::new();
            let mut terrain = MapTerrain {
                world: &self.world,
                map,
                blocked: &empty,
                multis: None,
            };
            route.advance(&mut terrain, pos, facing)
        };
        match step {
            RouteStep::Wait => self.route = Some(route),
            RouteStep::Done => {} // arrived, or no path left — drop the route
            RouteStep::Walk(dir) => {
                let sent = self.walk(dir, run)?;
                route.step_sent(sent);
                if route.steps <= route.max_steps {
                    self.route = Some(route);
                }
            }
            RouteStep::OpenDoor(serial) => {
                // Mirrors `play_server`'s `BlockedStepAction::OpenDoor` arm: a
                // closed door on the next hop — ClassicUO `GameActions.OpenDoor`
                // (0x12/0x58, facing tile) instead of walking into what the real
                // server would just deny. `serial` is only for the debug log;
                // the packet itself has no serial. The route stays live either way.
                if std::env::var("ANIMA_DEBUG").is_ok() {
                    eprintln!(
                        "anima-net: route to {:?} opening door {serial:#x}",
                        route.goal
                    );
                }
                self.apply_action(&Action::OpenDoor)?;
                self.route = Some(route);
            }
        }
        Ok(())
    }

    /// Answer the pending target cursor (if any) and clear it. `serial = Some` is
    /// an object target (type 0); `None` is a ground target (type 1). No-ops when
    /// nothing is targeting (the brain raced the cursor away).
    fn respond_target(
        &mut self,
        serial: Option<u32>,
        x: u16,
        y: u16,
        z: i16,
        graphic: u16,
    ) -> Result<(), DriverError> {
        let Some(cursor) = self.world.pending_target else {
            return Ok(());
        };
        let (target_type, serial) = match serial {
            Some(s) => (0u8, s),
            None => (1u8, 0u32),
        };
        let pkt = build_target_response(
            target_type,
            cursor.cursor_id,
            cursor.cursor_flag,
            serial,
            x,
            y,
            z,
            graphic,
        );
        self.send(&pkt)?;
        self.world.pending_target = None;
        Ok(())
    }

    /// Cancel a pending target cursor (Esc). UO signals a cancel by echoing the
    /// cursor with serial 0 and an all-`0xFFFF` location; the server then aborts the
    /// spell/skill that was waiting for a target instead of staying in target mode.
    fn cancel_target(&mut self) -> Result<(), DriverError> {
        let Some(cursor) = self.world.pending_target else {
            return Ok(());
        };
        let pkt = build_target_response(
            cursor.target_type,
            cursor.cursor_id,
            cursor.cursor_flag,
            0,
            0xFFFF,
            0xFFFF,
            0,
            0,
        );
        self.send(&pkt)?;
        self.world.pending_target = None;
        Ok(())
    }

    /// Answer (or cancel) the pending 0x9A ASCII / 0xC2 Unicode server text
    /// prompt with its matching wire encoding, echoing the two opaque ids and
    /// clearing it locally. No-op when the brain raced the prompt away.
    fn respond_prompt(&mut self, text: &str, cancel: bool) -> Result<(), DriverError> {
        let Some(p) = self.world.prompt else {
            return Ok(());
        };
        let pkt = match p.kind {
            PromptKind::Ascii => {
                build_ascii_prompt_response(p.sender_serial, p.prompt_id, text, cancel)
            }
            PromptKind::Unicode => {
                build_prompt_response(p.sender_serial, p.prompt_id, text, cancel)
            }
        };
        self.send(&pkt)?;
        self.world.prompt = None;
        Ok(())
    }

    /// Navigate one exact pageable Tip window and close it once its 0xA7
    /// request is sent. Notice windows and stale seqs are intentionally inert.
    fn navigate_tip(&mut self, seq: u64, next: bool) -> Result<(), DriverError> {
        let Some(tip) = self
            .world
            .tip(seq)
            .filter(|tip| tip.kind == TipKind::Tip)
            .map(|tip| tip.tip)
        else {
            return Ok(());
        };
        self.send(&build_tip_request(tip, next))?;
        self.world.close_tip(seq);
        Ok(())
    }

    /// Answer one exact 0xAB callback using only its server-owned fields. Both
    /// OK and explicit Cancel send 0xAC; stale seqs are intentionally inert.
    fn respond_text_entry(
        &mut self,
        seq: u64,
        text: &str,
        accepted: bool,
    ) -> Result<(), DriverError> {
        let Some(dialog) = self.world.text_entry_dialog(seq).cloned() else {
            return Ok(());
        };
        self.send(&build_text_entry_dialog_response(
            dialog.serial,
            dialog.parent_id,
            dialog.button_id,
            text,
            accepted,
            dialog.variant,
            dialog.max_length,
        ))?;
        self.world.close_text_entry_dialog(seq);
        Ok(())
    }

    /// Persist a changed editable self profile on close. The live profile owns
    /// both callback permission and original text; stale/read-only actions are
    /// inert rather than becoming forged updates.
    fn update_profile(&mut self, seq: u64, text: &str) -> Result<(), DriverError> {
        let Some(profile) = self
            .world
            .character_profile(seq)
            .filter(|profile| profile.can_edit)
            .cloned()
        else {
            return Ok(());
        };
        if text != profile.body {
            self.send(&build_profile_update(profile.serial, text))?;
        }
        self.world.close_character_profile(seq);
        Ok(())
    }

    /// Begin logout. Send one 0xD1 request when the server advertised the
    /// handshake; otherwise arm ClassicUO's immediate-disconnect fallback.
    /// Repeated actions while either path is pending are inert.
    pub fn request_logout(&mut self) -> Result<(), DriverError> {
        if self.logout_pending || self.logout_immediate {
            return Ok(());
        }
        if !self.logout_handshake {
            self.logout_immediate = true;
            return Ok(());
        }
        let after_seq = self.world.logout_ack_seq;
        self.send(&build_logout_request())?;
        self.logout_after_seq = after_seq;
        self.logout_pending = true;
        Ok(())
    }

    /// Consume the immediate fallback or the fresh server reply corresponding
    /// to the outstanding request. An unsolicited/stale 0xD1 can never
    /// terminate a handshake-enabled session.
    pub fn take_logout_ack(&mut self) -> Option<bool> {
        if self.logout_immediate {
            self.logout_immediate = false;
            return Some(true);
        }
        let allowed = correlate_logout_ack(
            self.logout_pending,
            self.logout_after_seq,
            self.world.logout_ack,
        )?;
        self.logout_pending = false;
        Some(allowed)
    }

    /// Read whatever is available once and apply every complete game packet to
    /// the world. Returns the number of packets applied (0 on a read timeout).
    pub fn pump_once(&mut self) -> Result<usize, DriverError> {
        // Keepalive: nudge the server's idle timer so an inactive client isn't
        // dropped. pump_once runs on a tight loop, so gate on the interval.
        if self.last_ping.elapsed() >= PING_INTERVAL {
            self.send(&build_ping(self.ping_seq))?;
            // Remember which sequence is outstanding so the echo can be timed;
            // an unanswered one is simply overwritten by the next send.
            self.stats.ping_sent = Some((self.ping_seq, Instant::now()));
            self.ping_seq = self.ping_seq.wrapping_add(1);
            self.last_ping = Instant::now();
        }
        // World-map tracking (0xF0): where the party/guild members we CANNOT see
        // are. Nine bytes a second, against ClassicUO's four-times-a-second poll.
        //
        // The gate is a probe budget rather than ClassicUO's ACK, because the
        // ACK (reply 0x00) is one ServUO never sends — see `World::map_tracking`.
        // So: ask a few times, and keep asking only if the shard ever answers.
        // A shard with no 0xF0 handler at all then costs three packets total,
        // not one per second forever.
        if self.last_track.elapsed() >= TRACK_INTERVAL {
            if self.world.map_tracking {
                self.track_probes = 0;
            }
            if self.world.map_tracking || self.track_probes < TRACK_MAX_PROBES {
                self.track_probes = self.track_probes.saturating_add(1);
                // The party query is worth sending only while we are in one; the
                // guild query doubles as the probe, since we cannot know whether
                // we are in a guild without asking.
                if !self.world.party.members.is_empty() {
                    self.send(&build_query_party_positions())?;
                }
                self.send(&build_query_guild_positions())?;
            }
            self.last_track = Instant::now();
        }
        let mut buf = [0u8; 8192];
        match self.stream.read(&mut buf) {
            Ok(0) => return Err(DriverError::ConnectionClosed),
            Ok(n) => {
                self.stats.bytes_in += n as u64;
                self.decoder.feed(&buf[..n]);
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => {
                return Ok(0)
            }
            Err(e) => return Err(DriverError::Io(e)),
        }
        let mut applied = 0;
        loop {
            match self.decoder.pop() {
                Ok(Some(frame)) => {
                    self.stats.packets_in += 1;
                    self.handle_frame(&frame)?;
                    applied += 1;
                }
                Ok(None) => break,
                Err(e) => return Err(DriverError::Framing(e)),
            }
        }
        // 0xBF/0x1D revision notices (applied above) only *queue* a design
        // request — core never sends bytes, so drain and answer them here.
        for serial in self.world.take_house_design_requests() {
            self.send(&build_house_design_request(serial))?;
        }
        // Same shape for 0xDC OPLInfo: the handler only queues the serials whose
        // tooltip went stale, so send the refetches here. Batched 15 to a packet
        // like ClassicUO's `Send_MegaClilocRequest` — ServUO's
        // `BatchQueryProperties` reads as many serials as the length carries, but
        // there's no reason to diverge from the client every shard is tuned for.
        let stale_opl = self.world.take_opl_requests();
        for batch in stale_opl.chunks(OPL_REQUEST_BATCH) {
            self.send(&build_opl_request(batch))?;
        }
        // 0x2C DeathStatus asks a ClassicUO-compatible client to request peace
        // mode. Preserve duplicate action-0/action-2 requests from ServUO; the
        // server treats the ordinary 0x72 packets idempotently.
        for on in self.world.take_war_mode_requests() {
            self.send(&build_war_mode(on))?;
        }
        Ok(applied)
    }

    /// Route a frame: movement acks drive the [`Walker`], the version request
    /// gets answered, everything else goes to the world codec.
    fn handle_frame(&mut self, frame: &[u8]) -> Result<(), DriverError> {
        match frame.first().copied() {
            // 0x22 ConfirmWalk: [id][seq][notoriety]
            Some(0x22) if frame.len() >= 2 => {
                self.confirms += 1;
                self.walker.on_confirm(&mut self.world, frame[1]);
                // A bad/out-of-order confirm desynced us → request a Resync
                // (ClassicUO ConfirmWalk isBadStep → Send_Resync). Walking stays
                // gated (Walker.walking_failed) until the server replies with a deny.
                if let Some(pkt) = self.walker.take_resync() {
                    self.send(&pkt)?;
                }
            }
            // 0x21 DenyWalk: [id][seq][x:u16][y:u16][dir:u8][z:i8]
            Some(0x21) if frame.len() >= 8 => {
                self.denies += 1;
                let seq = frame[1];
                let x = u16::from_be_bytes([frame[2], frame[3]]);
                let y = u16::from_be_bytes([frame[4], frame[5]]);
                let dir = frame[6] & 0x07;
                let z = frame[7] as i8;
                self.walker.on_deny(&mut self.world, seq, x, y, z, dir);
            }
            // 0x73 Ping echo: ServUO sends back the sequence byte we chose, which
            // is what makes this a round-trip measurement rather than a guess.
            // Timed here rather than in the core, which has no clock by design.
            Some(0x73) if frame.len() >= 2 => self.stats.ping_echo(frame[1]),
            // 0xBD ClientVersion request — must answer or the server denies movement.
            Some(0xBD) => {
                self.send(&build_client_version(CLIENT_VERSION))?;
            }
            _ => {
                // A server-pushed jump of the player's tile (>1 step) is a teleport
                // — e.g. a GM [Set X Y Z, a moongate, a recall. It can arrive as
                // 0x20 / 0x77 / 0x78 depending on the server, so detect it by the
                // position delta rather than the packet id, and resync the walk
                // predictor (stale sequence + pending steps would deny all movement).
                let before = self.world.player_mobile().map(|m| m.pos);
                apply_packet(&mut self.world, frame);
                if let Some(route) =
                    next_server_pathfind_route(&self.world, &mut self.server_pathfind_seq)
                {
                    self.route = Some(route);
                }
                if let (Some(b), Some(a)) = (before, self.world.player_mobile().map(|m| m.pos)) {
                    if b.x.abs_diff(a.x).max(b.y.abs_diff(a.y)) > 1 {
                        self.walker.reset();
                    }
                }
                // The other reason a 0x20 arrives: it is ServUO `Resynchronize`
                // answering the 0x22 we sent after a bad confirm — the repair
                // leg, and the ONLY thing that unfreezes walking. The delta test
                // above cannot stand in for it, because a sequence desync
                // normally leaves us where the server already thinks we are, so
                // the jump is zero tiles and the reset never fires. Missing this
                // costs the whole session's movement, not one step.
                if frame.first() == Some(&0x20) {
                    self.walker.on_player_update();
                }
            }
        }
        Ok(())
    }

    /// Apply a pin edit to our own [`anima_core::world::MapView`] — but only
    /// when the map is in edit mode, because that is the gate the server
    /// applies and a pin edit is never acknowledged.
    ///
    /// ServUO checks `ValidateEdit` (= `m_Editable && Validate(from)`) on every
    /// mutator and, when it fails, drops the request in silence. Applying
    /// unconditionally therefore invents pins: measured live against a decoded
    /// treasure map still in view mode, our window showed
    /// `[[169,184],[50,50]]` where the server held only `[[169,184]]`.
    ///
    /// `editable` is the part of that gate we can see. The rest of `Validate` —
    /// in reach, not protected, not someone else's — is not visible from here,
    /// so a refusal for one of those still desyncs. That self-heals on the next
    /// display: ServUO re-sends the full pin list on every `DisplayTo` and the
    /// decoder rebuilds from it (verified live — reopening the map restored
    /// the single real pin).
    fn apply_map_edit(&mut self, serial: u32, command: u8, number: u8, x: u16, y: u16) {
        if self
            .world
            .map_gumps
            .get(&serial)
            .is_some_and(|mv| mv.editable)
        {
            self.world.apply_map_command(serial, command, number, x, y);
        }
    }

    /// Request one step in `dir` (UO direction 0..7). Sends the walk packet if
    /// the pending budget allows; the caller should [`pump_once`](Self::pump_once)
    /// to receive the confirm/deny. Returns whether a packet was sent.
    pub fn walk(&mut self, dir: u8, run: bool) -> Result<bool, DriverError> {
        if let Some(packet) = self.walker.step(&mut self.world, dir, run) {
            self.send(&packet)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Pump until `duration` elapses, accumulating world state.
    pub fn observe(&mut self, duration: Duration) -> Result<usize, DriverError> {
        let deadline = Instant::now() + duration;
        let mut total = 0;
        // At least one pass, even for a zero duration: `pump_once` is also where
        // the keepalive ping goes out. A `while` here made `observe(0)` a no-op,
        // so a caller keeping an idle session alive with `{"cmd":"pump","ms":0}`
        // sent nothing and ServUO dropped it after 90 s ("Disconnecting due to
        // inactivity" — live-caught on the staff bridges of a duel experiment).
        loop {
            total += self.pump_once()?;
            if Instant::now() >= deadline {
                break;
            }
        }
        Ok(total)
    }

    /// Pathfind to `(gx, gy)` over `terrain` and walk there on the server,
    /// re-pathing each step. Tiles the server *denies* (the static map said
    /// walkable but a building/dynamic blocker disagrees) are blacklisted and
    /// routed around. Returns whether we arrived within `max_steps`.
    pub fn navigate_to<T: Terrain>(
        &mut self,
        terrain: &mut T,
        gx: u32,
        gy: u32,
        max_steps: usize,
    ) -> Result<bool, DriverError> {
        let mut blocked: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
        for _ in 0..max_steps {
            let p = match self.world.player_mobile() {
                Some(p) => p.clone(),
                None => return Ok(false),
            };
            let (px, py, pz) = (p.pos.x as u32, p.pos.y as u32, p.pos.z as i32);
            if (px, py) == (gx, gy) {
                return Ok(true);
            }

            let path = {
                let mut avoid = Avoiding {
                    inner: terrain,
                    blocked: &blocked,
                };
                match find_path(&mut avoid, (px, py, pz), (gx, gy), DEFAULT_MAX_EXPANSIONS) {
                    Some(p) if !p.is_empty() => p,
                    _ => return Ok(false), // no route given what we've learned
                }
            };

            let step = path[0];
            let was_facing = p.direction == step.dir; // a same-facing step is a real move
            self.walk(step.dir, false)?;
            self.observe(std::time::Duration::from_millis(450))?;

            // If a move (not a turn) didn't change our position, the server
            // denied that tile — remember it so the next re-path avoids it.
            if was_facing {
                if let Some(np) = self.world.player_mobile() {
                    if (np.pos.x as u32, np.pos.y as u32) == (px, py) {
                        blocked.insert((step.x, step.y));
                    }
                }
            }
        }
        Ok(false)
    }

    /// Send a pre-built packet to the server (client→server is uncompressed).
    /// Packets written since login. A caller that compares it across
    /// [`Session::apply_action`] learns whether the action went out at all: a
    /// target, prompt, menu or trade reply with nothing outstanding to answer
    /// is dropped locally, and so is a queued `WalkTo` until `advance_route`.
    pub fn packets_sent(&self) -> u64 {
        self.stats.packets_out
    }

    pub fn send(&mut self, bytes: &[u8]) -> Result<(), DriverError> {
        self.stream.write_all(bytes)?;
        self.stats.bytes_out += bytes.len() as u64;
        self.stats.packets_out += 1;
        Ok(())
    }
}

/// Run the login handshake and return the live game-server connection.
fn login(
    endpoint: &Endpoint,
    cfg: LoginConfig,
    mut chooser: Option<&mut dyn FnMut(CharacterPrompt) -> Result<CharacterChoice, DriverError>>,
    control: &LoginControl,
    response_timeout: Duration,
) -> Result<(LoginResult, TcpStream, StreamDecoder), DriverError> {
    let (mut machine, initial) = LoginMachine::start(cfg);

    let mut stream = connect(endpoint, control)?;
    control.check()?;
    control.set_phase(LoginPhase::Authenticating);
    stream.write_all(&initial)?;
    let mut deadline = Instant::now() + response_timeout;

    let mut decoder = StreamDecoder::new();
    let mut buf = [0u8; 8192];

    loop {
        loop {
            control.check()?;
            if Instant::now() >= deadline {
                return Err(DriverError::LoginTimeout);
            }
            let frame = match decoder.pop() {
                Ok(Some(f)) => f,
                Ok(None) => break,
                Err(e) => return Err(DriverError::Framing(e)),
            };
            for directive in machine.on_packet(&frame).map_err(DriverError::Login)? {
                match directive {
                    LoginDirective::Send(bytes) => stream.write_all(&bytes)?,
                    LoginDirective::ReconnectToGameServer { address, then } => {
                        control.set_phase(LoginPhase::GameServer);
                        stream = connect_game_server(endpoint, address, control)?;
                        control.set_phase(LoginPhase::Authenticating);
                        deadline = Instant::now() + response_timeout;
                        decoder.switch_to_game();
                        stream.write_all(&then)?;
                    }
                    LoginDirective::ChooseCharacter(prompt) => {
                        control.set_phase(LoginPhase::Characters);
                        let choice = chooser
                            .as_deref_mut()
                            .ok_or(DriverError::CharacterChoiceRequired)?(
                            prompt
                        )?;
                        control.check()?;
                        control.set_phase(LoginPhase::CharacterAction);
                        deadline = Instant::now() + response_timeout;
                        for followup in machine
                            .choose_character(choice)
                            .map_err(DriverError::Login)?
                        {
                            match followup {
                                LoginDirective::Send(bytes) => stream.write_all(&bytes)?,
                                _ => {
                                    return Err(DriverError::Login(
                                        LoginError::CharacterChoiceNotExpected,
                                    ));
                                }
                            }
                        }
                    }
                    LoginDirective::Done(result) => return Ok((result, stream, decoder)),
                }
            }
        }

        control.check()?;
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            return Err(DriverError::LoginTimeout);
        };
        stream.set_read_timeout(Some(left.min(Duration::from_millis(200))))?;
        let n = match stream.read(&mut buf) {
            Ok(n) => n,
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                continue
            }
            Err(error) => {
                control.check()?;
                return Err(error.into());
            }
        };
        control.check()?;
        if n == 0 {
            return Err(DriverError::ConnectionClosed);
        }
        decoder.feed(&buf[..n]);
    }
}

/// Wraps a terrain with a dynamic blacklist of server-denied tiles.
struct Avoiding<'a, T: Terrain> {
    inner: &'a mut T,
    blocked: &'a std::collections::HashSet<(u32, u32)>,
}

impl<T: Terrain> Terrain for Avoiding<'_, T> {
    fn walkable_step(&mut self, x: u32, y: u32, from_z: i32) -> Option<i32> {
        if self.blocked.contains(&(x, y)) {
            None
        } else {
            self.inner.walkable_step(x, y, from_z)
        }
    }

    // Forwarded unchanged: a tile this wrapper blacklists never reaches
    // `find_path`/`find_path_near` as a candidate next hop in the first place
    // (its `walkable_step` above already denies it), so there's nothing
    // door-related to special-case here.
    fn door_at(&mut self, x: u32, y: u32, current_z: i32) -> Option<u32> {
        self.inner.door_at(x, y, current_z)
    }
}

fn connect(e: &Endpoint, control: &LoginControl) -> Result<TcpStream, DriverError> {
    connection::dial(e, control)
}

/// Open the phase-2 (game-server) connection.
///
/// A shard names its own game server in `0x8C`, and on any real multi-shard
/// login server that address is the only way to reach the shard you picked —
/// so it is tried first. It is also frequently unreachable *from where we are*:
/// a shard behind NAT advertises its LAN address, and a tunnelled one
/// advertises whatever its config says rather than the tunnel. So a failure to
/// connect is not fatal — we fall back to the endpoint the caller dialed for
/// phase 1, which is exactly what this driver did unconditionally before, and
/// what ClassicUO does under `IgnoreRelayIp` / `ip == 0`.
///
/// The advertised attempt is bounded by [`RELAY_CONNECT_TIMEOUT`] rather than
/// the OS default: an address that black-holes SYNs would otherwise stall
/// login for over a minute before the fallback that was always going to work.
/// No DNS is involved (`0x8C` carries four raw bytes), so a `SocketAddrV4` is
/// built directly.
fn connect_game_server(
    login: &Endpoint,
    advertised: GameServerAddress,
    control: &LoginControl,
) -> Result<TcpStream, DriverError> {
    let same_as_login = advertised.host() == login.host && advertised.port == login.port;
    if !login.ignore_relay_ip && advertised.is_routable() && !same_as_login {
        let addr = SocketAddrV4::new(Ipv4Addr::from(advertised.ip), advertised.port);
        match connection::dial_address(addr.into(), RELAY_CONNECT_TIMEOUT, control) {
            Ok(stream) => {
                stream.set_nodelay(true).ok();
                stream.set_read_timeout(Some(CONNECT_READ_TIMEOUT)).ok();
                return Ok(stream);
            }
            Err(e) if std::env::var("ANIMA_DEBUG").is_ok() => {
                eprintln!(
                    "[login] shard advertised {addr}, unreachable ({e}); \
                     falling back to {}:{}",
                    login.host, login.port
                );
            }
            Err(_) => {}
        }
    }
    control.check()?;
    connect(login, control)
}

#[cfg(test)]
mod net_stats_tests {
    use super::*;

    #[test]
    fn ping_averages_only_answered_slots() {
        let mut st = NetStats::default();
        // Nothing has come back yet — distinct from "the link is instant".
        assert_eq!(st.ping_us(), None);
        st.pings = [Some(10_000), Some(20_000), Some(30_000), None, None];
        assert_eq!(
            st.ping_us(),
            Some(20_000),
            "unanswered slots must not drag the mean to 12ms"
        );
        // A localhost round trip is a few hundred microseconds. ClassicUO would
        // store 0 here and its own filter would then discard it as "no reply".
        st.pings = [Some(180), None, None, None, None];
        assert_eq!(st.ping_us(), Some(180));
    }

    #[test]
    fn only_the_outstanding_sequence_is_timed() {
        let mut st = NetStats {
            ping_sent: Some((7, Instant::now())),
            ..Default::default()
        };
        // A stale echo (a different sequence, or a duplicate of one already
        // consumed) must not be timed against the send we are still waiting on.
        st.ping_echo(6);
        assert_eq!(st.ping_idx, 0);
        assert!(st.ping_sent.is_some());
        st.ping_echo(7);
        assert_eq!(st.ping_idx, 1);
        assert!(st.ping_sent.is_none(), "the answered send is cleared");
        st.ping_echo(7);
        assert_eq!(st.ping_idx, 1, "a second copy of the same echo is ignored");
    }

    #[test]
    fn ping_slots_wrap_over_five() {
        let mut st = NetStats::default();
        for seq in 0..7u8 {
            st.ping_sent = Some((seq, Instant::now()));
            st.ping_echo(seq);
        }
        assert_eq!(st.ping_idx, 7);
        // Seven answers, five slots: the ring holds the newest five.
        assert!(st.pings.iter().all(|p| p.is_some()));
    }
}

#[cfg(test)]
mod route_tests {
    //! [`Route`]'s state machine is deliberately network-free (see its doc), so
    //! it's tested directly here with a stubbed [`Terrain`] — no socket needed.
    //! `Session::apply_action`'s one-line cancel-on-`Walk`/replace-on-`WalkTo`
    //! wiring around it isn't separately unit-tested: exercising it needs a
    //! live `Session` (a connected `TcpStream`), which per this crate's testing
    //! rules stays out of unit tests.
    use super::*;

    #[test]
    fn logout_ack_requires_pending_request_and_fresh_sequence() {
        let denied = Some(anima_core::world::LogoutAck {
            seq: 4,
            allowed: false,
        });
        assert_eq!(correlate_logout_ack(false, 0, denied), None);
        assert_eq!(correlate_logout_ack(true, 4, denied), None);
        assert_eq!(correlate_logout_ack(true, 3, denied), Some(false));
        assert_eq!(
            correlate_logout_ack(
                true,
                4,
                Some(anima_core::world::LogoutAck {
                    seq: 5,
                    allowed: true,
                })
            ),
            Some(true)
        );
    }

    #[test]
    fn server_pathfind_event_starts_once_and_resend_replaces_route() {
        let mut world = World::new();
        let mut seen = 0;

        world.set_server_pathfind(1200, 800, 17);
        let route = next_server_pathfind_route(&world, &mut seen).expect("fresh route");
        assert_eq!(route.goal, (1200, 800));
        assert_eq!(route.max_steps, SERVER_ROUTE_MAX_STEPS);
        assert_eq!(seen, 1);
        assert!(next_server_pathfind_route(&world, &mut seen).is_none());

        world.set_server_pathfind(1200, 800, 17);
        let replacement =
            next_server_pathfind_route(&world, &mut seen).expect("resend restarts route");
        assert_eq!(replacement.goal, (1200, 800));
        assert_eq!(seen, 2);
    }

    /// An unbounded, always-walkable grid — isolates the route bookkeeping
    /// (cadence/blacklist/arrival) from pathfinding-around-obstacles, which
    /// `anima-core::path` already covers.
    struct OpenGrid;
    impl Terrain for OpenGrid {
        fn walkable_step(&mut self, _x: u32, _y: u32, _from_z: i32) -> Option<i32> {
            Some(0)
        }
    }

    /// Nothing is walkable — models an unreachable goal.
    struct Sealed;
    impl Terrain for Sealed {
        fn walkable_step(&mut self, _x: u32, _y: u32, _from_z: i32) -> Option<i32> {
            None
        }
    }

    #[test]
    fn advance_steps_toward_goal_when_due() {
        let mut terrain = OpenGrid;
        let mut route = Route::new(5, 5);
        // `Route::new` starts already "due" so the very first tick steps
        // immediately instead of waiting a full cadence.
        match route.advance(&mut terrain, (0, 0, 0), 0) {
            RouteStep::Walk(_) => {}
            other => panic!("expected Walk, got {other:?}"),
        }
    }

    #[test]
    fn advance_reports_done_on_arrival() {
        let mut terrain = OpenGrid;
        let mut route = Route::new(3, 3);
        assert_eq!(route.advance(&mut terrain, (3, 3, 0), 0), RouteStep::Done);
    }

    #[test]
    fn advance_reports_done_when_unreachable() {
        let mut terrain = Sealed;
        let mut route = Route::new(5, 5);
        assert_eq!(route.advance(&mut terrain, (0, 0, 0), 0), RouteStep::Done);
    }

    #[test]
    fn advance_waits_out_the_cadence_between_steps() {
        let mut terrain = OpenGrid;
        let mut route = Route::new(5, 5);
        assert!(matches!(
            route.advance(&mut terrain, (0, 0, 0), 0),
            RouteStep::Walk(_)
        ));
        route.step_sent(true);
        assert_eq!(route.steps, 1);
        // The cadence clock was just reset — immediately due again is a Wait,
        // not a second step (mirrors play.rs's own `AUTO_WALK_STEP_MS` gate).
        assert_eq!(route.advance(&mut terrain, (0, 0, 0), 0), RouteStep::Wait);
    }

    #[test]
    fn advance_blacklists_a_denied_tile_and_reroutes() {
        let mut terrain = OpenGrid;
        let mut route = Route::new(5, 0);
        // Already facing east (2 — see `direction_delta`), so the proposed
        // step is a real move, not a turn-first.
        assert_eq!(
            route.advance(&mut terrain, (0, 0, 0), 2),
            RouteStep::Walk(2)
        );
        // Only `step_sent(true)` arms the candidate — the send succeeded here.
        route.step_sent(true);
        assert_eq!(route.target, (1, 0));

        // Force the cadence due again and simulate the server denying that
        // step: the player is still at (0, 0) instead of having moved to (1, 0).
        route.last_step = Instant::now() - ROUTE_STEP;
        let next = route.advance(&mut terrain, (0, 0, 0), 2);
        assert!(
            route.blocked.contains(&(1, 0)),
            "denied tile should be blacklisted"
        );
        assert!(
            matches!(next, RouteStep::Walk(_)),
            "should reroute, not give up"
        );
    }

    #[test]
    fn advance_does_not_blacklist_a_gated_send_and_retries_the_same_tile() {
        // Regression for the case where a Walker gate (5 unacked steps in
        // flight, or `walking_failed` latched) swallows the walk packet:
        // `advance` must not treat "we never sent this" as a server deny.
        let mut terrain = OpenGrid;
        let mut route = Route::new(5, 0);
        // Already facing east, so the proposed step is a real move.
        assert_eq!(
            route.advance(&mut terrain, (0, 0, 0), 2),
            RouteStep::Walk(2)
        );
        // The send was gated (e.g. `Session::walk` returned `false`) — nothing
        // reached the wire, so nothing should be armed.
        route.step_sent(false);
        assert_eq!(
            route.steps, 0,
            "a gated send must not count toward the runaway guard"
        );

        // Force the cadence due again. The player never moved (no packet went
        // out), so this must not be mistaken for a server deny on (1, 0).
        route.last_step = Instant::now() - ROUTE_STEP;
        let next = route.advance(&mut terrain, (0, 0, 0), 2);
        assert!(
            route.blocked.is_empty(),
            "a never-sent step must not blacklist anything"
        );
        assert_eq!(
            next,
            RouteStep::Walk(2),
            "should simply retry the same tile, not give up"
        );
    }

    #[test]
    fn advance_gives_up_once_fully_boxed_in() {
        // A single-width corridor along y=0: a complete path exists at first,
        // but once its only first step is blacklisted (a denied "move") there
        // is no detour (every other row is walled), so the route gives up.
        struct Corridor;
        impl Terrain for Corridor {
            fn walkable_step(&mut self, _x: u32, y: u32, _from_z: i32) -> Option<i32> {
                if y == 0 {
                    Some(0)
                } else {
                    None
                }
            }
        }
        let mut terrain = Corridor;
        let mut route = Route::new(5, 0);
        assert_eq!(
            route.advance(&mut terrain, (0, 0, 0), 2),
            RouteStep::Walk(2)
        );
        route.step_sent(true);

        route.last_step = Instant::now() - ROUTE_STEP;
        let next = route.advance(&mut terrain, (0, 0, 0), 2); // deny: still at (0,0)
        assert!(route.blocked.contains(&(1, 0)));
        assert_eq!(next, RouteStep::Done);
    }

    // ------------------------------------------------------------------
    // Door awareness + `find_path_near` — mirrors `play_server`'s own
    // `find_path_routes_through_a_closed_door` / `decide_blocked_step_*` /
    // `find_path_near_*` tests, but exercised through `Route::advance` itself
    // (the actual thing a headless brain drives), using `scene`'s door
    // constants directly so a tuning change there can't silently desync the
    // two suites.
    // ------------------------------------------------------------------
    use crate::pathing::{DOOR_USE_COOLDOWN, MAX_DOOR_OPEN_ATTEMPTS};

    /// A single-row corridor (like [`advance_gives_up_once_fully_boxed_in`]'s
    /// `Corridor`) whose only connection at `door_tile` is a closed door —
    /// PLANNING (`walkable_step`) treats it as passable (mirrors
    /// `tile_walkable_for_planning`'s door exception) so a route can be found
    /// through it at all; `door_at` reports the door only while `open` is
    /// `false`, letting a test flip it to simulate the server's `Use` response
    /// landing.
    struct DoorCorridor {
        door_tile: (u32, u32),
        door_serial: u32,
        open: std::cell::Cell<bool>,
    }
    impl Terrain for DoorCorridor {
        fn walkable_step(&mut self, _x: u32, y: u32, _from_z: i32) -> Option<i32> {
            if y == 0 {
                Some(0)
            } else {
                None
            }
        }
        fn door_at(&mut self, x: u32, y: u32, _current_z: i32) -> Option<u32> {
            if (x, y) == self.door_tile && !self.open.get() {
                Some(self.door_serial)
            } else {
                None
            }
        }
    }

    #[test]
    fn advance_plans_a_route_through_a_closed_door_only_connection() {
        // The door is the ONLY connection in this corridor — if planning
        // treated a closed door as an ordinary wall, this would report `Done`
        // (no path) immediately, exactly like `advance_gives_up_once_fully_boxed_in`'s
        // sealed corridor. Instead it must recognize the door and negotiate
        // opening it, not give up.
        let mut terrain = DoorCorridor {
            door_tile: (1, 0),
            door_serial: 0xDEAD,
            open: false.into(),
        };
        let mut route = Route::new(5, 0);
        assert_eq!(
            route.advance(&mut terrain, (0, 0, 0), 2),
            RouteStep::OpenDoor(0xDEAD)
        );
    }

    #[test]
    fn advance_opens_the_door_on_approach_then_walks_through_once_open() {
        let mut terrain = DoorCorridor {
            door_tile: (1, 0),
            door_serial: 0xDEAD,
            open: false.into(),
        };
        let mut route = Route::new(5, 0);
        assert_eq!(
            route.advance(&mut terrain, (0, 0, 0), 2),
            RouteStep::OpenDoor(0xDEAD)
        );
        // A door-open attempt is not a walk step — mirrors `play_server`'s
        // `auto_steps`, which likewise only increments on an actual walk send.
        assert_eq!(route.steps, 0);

        // The door "opens" (as if the server's `Use` response — and the
        // resulting item update — already landed). Once due again, `advance`
        // must actually walk onto it instead of negotiating forever.
        terrain.open.set(true);
        route.last_step = Instant::now() - ROUTE_STEP;
        assert_eq!(
            route.advance(&mut terrain, (0, 0, 0), 2),
            RouteStep::Walk(2)
        );
    }

    #[test]
    fn advance_awaits_a_recent_door_use_before_resending() {
        // Mirrors `decide_blocked_step_awaits_a_recent_use_with_no_visible_change`:
        // a `Use` was JUST sent (well within `DOOR_USE_COOLDOWN`) — even though
        // the route's own (much shorter) `ROUTE_STEP` cadence is due again, it
        // must not resend yet (ServUO's `Use` toggles a door, so an impatient
        // resend could close what the first `Use` is about to open).
        let mut terrain = DoorCorridor {
            door_tile: (1, 0),
            door_serial: 0xDEAD,
            open: false.into(),
        };
        let mut route = Route::new(5, 0);
        assert_eq!(
            route.advance(&mut terrain, (0, 0, 0), 2),
            RouteStep::OpenDoor(0xDEAD)
        );

        route.last_step = Instant::now() - ROUTE_STEP; // only the route cadence elapses
        assert_eq!(route.advance(&mut terrain, (0, 0, 0), 2), RouteStep::Wait);
        // Still only the one attempt — the await did not resend.
        assert_eq!(route.door_attempts.get(&(1, 0)).map(|a| a.count), Some(1));
    }

    #[test]
    fn advance_resends_the_door_use_once_the_cooldown_elapses() {
        let mut terrain = DoorCorridor {
            door_tile: (1, 0),
            door_serial: 0xDEAD,
            open: false.into(),
        };
        let mut route = Route::new(5, 0);
        assert_eq!(
            route.advance(&mut terrain, (0, 0, 0), 2),
            RouteStep::OpenDoor(0xDEAD)
        );

        // Force BOTH the route cadence and the door cooldown to have elapsed.
        route.last_step = Instant::now() - ROUTE_STEP;
        if let Some(a) = route.door_attempts.get_mut(&(1, 0)) {
            a.sent_at = Instant::now() - DOOR_USE_COOLDOWN;
        }
        assert_eq!(
            route.advance(&mut terrain, (0, 0, 0), 2),
            RouteStep::OpenDoor(0xDEAD)
        );
        assert_eq!(route.door_attempts.get(&(1, 0)).map(|a| a.count), Some(2));
    }

    #[test]
    fn advance_gives_up_on_a_door_past_the_attempt_cap_and_blacklists_it() {
        // Mirrors `decide_blocked_step_gives_up_on_a_door_past_the_cap`: a door
        // that never opens (a locked door, in real UO terms) still ends in
        // "boxed in" instead of hammering `Use` on it forever.
        let mut terrain = DoorCorridor {
            door_tile: (1, 0),
            door_serial: 0xDEAD,
            open: false.into(),
        };
        let mut route = Route::new(5, 0);

        for attempt in 0..MAX_DOOR_OPEN_ATTEMPTS {
            let step = route.advance(&mut terrain, (0, 0, 0), 2);
            assert_eq!(step, RouteStep::OpenDoor(0xDEAD), "attempt {attempt}");
            // Simulate the cooldown elapsing with no visible effect, so the
            // NEXT `advance` is willing to retry rather than await.
            if let Some(a) = route.door_attempts.get_mut(&(1, 0)) {
                a.sent_at = Instant::now() - DOOR_USE_COOLDOWN;
            }
            route.last_step = Instant::now() - ROUTE_STEP;
        }
        // The cap is reached — treat the tile like any other wall: blacklist
        // it, and (being the corridor's only connection) abandon the route.
        let next = route.advance(&mut terrain, (0, 0, 0), 2);
        assert!(route.blocked.contains(&(1, 0)));
        assert_eq!(next, RouteStep::Done);
    }

    #[test]
    fn advance_walks_to_nearest_reachable_tile_when_exact_goal_is_blocked() {
        // Mirrors `find_path_near`'s ClassicUO-parity fallback (and
        // `play_server`'s own `WalkTo` adjustment): the exact goal tile is
        // unstandable (a wall decoration, a tree, a crate), but `Route` must
        // still walk up to it and stop adjacent instead of refusing to move
        // at all (the OLD `find_path`-only behavior: no path to the exact
        // goal → `Done` at zero steps issued).
        struct BlockedGoal;
        impl Terrain for BlockedGoal {
            fn walkable_step(&mut self, x: u32, y: u32, _from_z: i32) -> Option<i32> {
                if (x, y) == (5, 5) {
                    None
                } else {
                    Some(0)
                }
            }
        }
        let mut terrain = BlockedGoal;
        let mut route = Route::new(5, 5);
        let mut pos = (0u16, 0u16, 0i8);
        let mut facing = 2u8;
        let mut walked = 0;
        for _ in 0..20 {
            route.last_step = Instant::now() - ROUTE_STEP;
            match route.advance(&mut terrain, pos, facing) {
                RouteStep::Walk(dir) => {
                    route.step_sent(true);
                    walked += 1;
                    let (dx, dy) = anima_core::net::movement::direction_delta(dir);
                    pos = ((pos.0 as i32 + dx) as u16, (pos.1 as i32 + dy) as u16, 0);
                    facing = dir;
                }
                RouteStep::Done => break,
                other => panic!("unexpected {other:?}"),
            }
        }
        assert!(
            walked > 0,
            "must actually walk toward the blocked goal, not give up at step 0"
        );
        let cheb = (pos.0 as i32 - 5)
            .unsigned_abs()
            .max((pos.1 as i32 - 5).unsigned_abs());
        assert_eq!(cheb, 1, "should stop exactly adjacent to the blocked goal");
        assert_ne!(
            (pos.0 as u32, pos.1 as u32),
            (5, 5),
            "must not walk onto the unstandable goal tile itself"
        );
    }
}
