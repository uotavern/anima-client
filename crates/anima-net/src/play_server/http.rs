//! The HTTP layer: routing, request limits, and static files.
//!
//! `handle_request` is the router; everything else here is the plumbing it needs
//! — body-size limits, the same-origin check that makes every state-changing
//! route safe to expose on loopback, and the SSE fan-out the sound stream uses.

use super::*;

pub(super) const MAX_POST_BODY_BYTES: usize = 16 * 1024;

/// Startup args for [`spawn_http`] (grouped to dodge the arg-count lint).
pub(super) struct SpawnHttp {
    pub(super) launcher: Arc<LauncherStore>,
    pub(super) active_login: ActiveLogin,
    pub(super) web_dir: Option<PathBuf>,
    pub(super) scene: Arc<Mutex<String>>,
    pub(super) tx: InputSender,
    pub(super) login: mpsc::Sender<(LoginAttempt, LoginControl)>,
    pub(super) character: mpsc::Sender<PromptDecision>,
    pub(super) art: Option<Arc<Mutex<Art>>>,
    pub(super) anim: Option<Arc<Anim>>,
    pub(super) gumps: Option<Arc<Gumps>>,
    pub(super) hues: Option<Arc<Hues>>,
    pub(super) tiledata: Option<Arc<TileData>>,
    pub(super) cliloc: Option<Arc<Cliloc>>,
    pub(super) lights: Option<Arc<Lights>>,
    pub(super) texmaps: Option<Arc<Texmaps>>,
    pub(super) worldmap: Arc<Mutex<Option<Vec<u8>>>>,
    pub(super) sounds: Option<Arc<Sounds>>,
    pub(super) music: Arc<HashMap<u16, PathBuf>>,
    pub(super) sse_hub: SseHub,
    pub(super) pois: Arc<String>,
    pub(super) guard_rects: Arc<Vec<GuardRect>>,
    pub(super) house_catalog: Arc<HouseCatalogCache>,
    pub(super) facet: Arc<AtomicU8>,
    /// Refuse everything that would touch the world/session (spectator mode).
    pub(super) read_only: bool,
    /// Epoch-millis of the last `/scene.json` fetch.
    pub(super) watch: Arc<AtomicU64>,
    /// Prebuilt `skills.mul` JSON for `GET /skillinfo.json`.
    pub(super) skillinfo: Arc<String>,
    pub(super) professions: Arc<String>,
    pub(super) fonts: Option<Arc<Fonts>>,
    pub(super) tileart: Option<Arc<TileArt>>,
    pub(super) multimap: Option<Arc<Vec<u8>>>,
    pub(super) terrain: Option<Arc<Mutex<super::TerrainState>>>,
}

/// Spawn the worker-thread pool serving `server` (already bound by [`bind`]).
pub(super) fn spawn_http(server: Arc<Server>, args: SpawnHttp) {
    let SpawnHttp {
        launcher,
        active_login,
        web_dir,
        scene,
        tx,
        login,
        character,
        art,
        anim,
        gumps,
        hues,
        tiledata,
        cliloc,
        lights,
        texmaps,
        worldmap,
        sounds,
        music,
        sse_hub,
        pois,
        guard_rects,
        house_catalog,
        facet,
        read_only,
        watch,
        skillinfo,
        professions,
        fonts,
        tileart,
        multimap,
        terrain,
    } = args;
    let tile_cache: TileCache = Arc::new(Mutex::new(ByteCache::new(TILE_CACHE_BYTES)));
    let anim_cache: AnimCache = Arc::new(Mutex::new(ByteCache::new(ANIM_CACHE_BYTES)));
    let texmap_cache: TexmapCache = Arc::new(Mutex::new(ByteCache::new(TEXMAP_CACHE_BYTES)));
    let gump_cache: GumpCache = Arc::new(Mutex::new(ByteCache::new(GUMP_CACHE_BYTES)));
    // Worker threads: a burst of tile/sprite PNG requests must never block the
    // frequent /scene.json polls (tiny_http's Server is shareable across threads).
    for _ in 0..6 {
        let server = server.clone();
        let launcher = launcher.clone();
        let active_login = active_login.clone();
        let web_dir = web_dir.clone();
        let scene = scene.clone();
        let tx = tx.clone();
        let login = login.clone();
        let character = character.clone();
        let art = art.clone();
        let anim = anim.clone();
        let gumps = gumps.clone();
        let hues = hues.clone();
        let tiledata = tiledata.clone();
        let cliloc = cliloc.clone();
        let lights = lights.clone();
        let texmaps = texmaps.clone();
        let tile_cache = tile_cache.clone();
        let anim_cache = anim_cache.clone();
        let texmap_cache = texmap_cache.clone();
        let gump_cache = gump_cache.clone();
        let worldmap = worldmap.clone();
        let sounds = sounds.clone();
        let music = music.clone();
        let sse_hub = sse_hub.clone();
        let pois = pois.clone();
        let guard_rects = guard_rects.clone();
        let house_catalog = house_catalog.clone();
        let watch = watch.clone();
        let facet = facet.clone();
        let skillinfo = skillinfo.clone();
        let professions = professions.clone();
        let fonts = fonts.clone();
        let tileart = tileart.clone();
        let multimap = multimap.clone();
        let terrain = terrain.clone();
        thread::spawn(move || {
            while let Ok(req) = server.recv() {
                handle_request(Ctx {
                    launcher: &launcher,
                    active_login: &active_login,
                    req,
                    web_dir: &web_dir,
                    scene: &scene,
                    tx: &tx,
                    login: &login,
                    character: &character,
                    art: &art,
                    anim: &anim,
                    gumps: &gumps,
                    hues: &hues,
                    tiledata: &tiledata,
                    cliloc: &cliloc,
                    lights: &lights,
                    texmaps: &texmaps,
                    tile_cache: &tile_cache,
                    anim_cache: &anim_cache,
                    texmap_cache: &texmap_cache,
                    gump_cache: &gump_cache,
                    worldmap: &worldmap,
                    sounds: &sounds,
                    music: &music,
                    sse_hub: &sse_hub,
                    pois: &pois,
                    guard_rects: &guard_rects,
                    house_catalog: &house_catalog,
                    facet: &facet,
                    read_only,
                    watch: &watch,
                    skillinfo: &skillinfo,
                    professions: &professions,
                    fonts: &fonts,
                    tileart: &tileart,
                    multimap: &multimap,
                    terrain: &terrain,
                });
            }
        });
    }
}

/// Everything a request handler needs (groups args to dodge the arg-count lint).
pub(super) struct Ctx<'a> {
    pub(super) launcher: &'a Arc<LauncherStore>,
    pub(super) active_login: &'a ActiveLogin,
    pub(super) req: tiny_http::Request,
    pub(super) web_dir: &'a Option<PathBuf>,
    pub(super) scene: &'a Arc<Mutex<String>>,
    pub(super) tx: &'a InputSender,
    pub(super) login: &'a mpsc::Sender<(LoginAttempt, LoginControl)>,
    pub(super) character: &'a mpsc::Sender<PromptDecision>,
    pub(super) art: &'a Option<Arc<Mutex<Art>>>,
    pub(super) anim: &'a Option<Arc<Anim>>,
    pub(super) gumps: &'a Option<Arc<Gumps>>,
    pub(super) hues: &'a Option<Arc<Hues>>,
    pub(super) tiledata: &'a Option<Arc<TileData>>,
    pub(super) cliloc: &'a Option<Arc<Cliloc>>,
    pub(super) lights: &'a Option<Arc<Lights>>,
    pub(super) texmaps: &'a Option<Arc<Texmaps>>,
    pub(super) tile_cache: &'a TileCache,
    pub(super) anim_cache: &'a AnimCache,
    pub(super) texmap_cache: &'a TexmapCache,
    pub(super) gump_cache: &'a GumpCache,
    pub(super) worldmap: &'a Arc<Mutex<Option<Vec<u8>>>>,
    pub(super) sounds: &'a Option<Arc<Sounds>>,
    pub(super) music: &'a Arc<HashMap<u16, PathBuf>>,
    pub(super) sse_hub: &'a SseHub,
    pub(super) pois: &'a Arc<String>,
    pub(super) guard_rects: &'a Arc<Vec<GuardRect>>,
    pub(super) house_catalog: &'a Arc<HouseCatalogCache>,
    pub(super) facet: &'a Arc<AtomicU8>,
    pub(super) read_only: bool,
    pub(super) watch: &'a Arc<AtomicU64>,
    pub(super) skillinfo: &'a Arc<String>,
    pub(super) professions: &'a Arc<String>,
    pub(super) fonts: &'a Option<Arc<Fonts>>,
    pub(super) tileart: &'a Option<Arc<TileArt>>,
    pub(super) multimap: &'a Option<Arc<Vec<u8>>>,
    pub(super) terrain: &'a Option<Arc<Mutex<super::TerrainState>>>,
}

pub(super) fn handle_request(ctx: Ctx) {
    REQ_COUNT.fetch_add(1, Ordering::Relaxed);
    let Ctx {
        launcher,
        active_login,
        mut req,
        web_dir,
        scene,
        read_only,
        watch,
        tx,
        login,
        character,
        art,
        anim,
        gumps,
        hues,
        tiledata,
        cliloc,
        lights,
        texmaps,
        tile_cache,
        anim_cache,
        texmap_cache,
        gump_cache,
        worldmap,
        sounds,
        music,
        sse_hub,
        pois,
        guard_rects,
        house_catalog,
        facet,
        skillinfo,
        professions,
        fonts,
        tileart,
        multimap,
        terrain,
    } = ctx;
    let raw_url = req.url().to_string();
    // Parse the optional `?hue=<n>` query before stripping it. 0 = no hue.
    let hue = parse_hue_query(&raw_url);
    let url = raw_url.split('?').next().unwrap_or("/").to_string();
    let is_post = *req.method() == Method::Post;

    // CSRF guard: every state-changing route here is a POST (`/input`, `/login`,
    // `/character`, `/log`), and with the `play` bin's well-known port a malicious page loaded
    // in any tab could otherwise drive the session with no preflight (simple
    // requests aren't subject to CORS). A browser always sends `Origin` on a
    // cross-origin request and can't be told not to, so reject when it disagrees
    // with `Host`. No `Origin` header (curl/scripts/same-origin form posts) is
    // let through unchanged — this only blocks cross-origin *browser* requests.
    if is_post && !origin_allowed(header_value(&req, "Origin"), header_value(&req, "Host")) {
        let _ = req
            .respond(Response::from_string("cross-origin request rejected").with_status_code(403));
        return;
    }

    if is_post && url == "/login/cancel" {
        if read_only || !launcher_request_allowed(&req) {
            let _ = req.respond(
                Response::from_string("Use the local login screen.").with_status_code(403),
            );
            return;
        }
        let id = read_request_body(&mut req)
            .ok()
            .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
            .and_then(|value| value["attempt_id"].as_str().map(str::to_owned));
        let cancelled = active_login
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|control| Some(control.id()) == id.as_deref() && control.cancel());
        let status = if cancelled { 200 } else { 409 };
        let message = if cancelled {
            "Cancelling connection…"
        } else {
            "This connection attempt has already ended."
        };
        let _ = req.respond(Response::from_string(message).with_status_code(status));
        return;
    }

    if url == "/launcher" {
        if read_only || !launcher_request_allowed(&req) {
            let _ = req.respond(
                Response::from_string("Open profiles from the local Anima login screen.")
                    .with_status_code(403),
            );
            return;
        }
        let result = if is_post {
            match read_request_body_limited(&mut req, 1024 * 1024 + 1024) {
                Ok(body) => serde_json::from_str::<serde_json::Value>(&body)
                    .map_err(|_| "Invalid profile request.".to_string())
                    .and_then(|body| launcher.command(&body)),
                Err((status, message)) => {
                    let _ = req.respond(Response::from_string(message).with_status_code(status));
                    return;
                }
            }
        } else if *req.method() == Method::Get {
            launcher.snapshot()
        } else {
            Err("Unsupported profile request.".into())
        };
        let (body, status) = match result {
            Ok(data) => (data, 200),
            Err(error) => (
                serde_json::json!({"error": error, "recoverable": launcher.can_recover()}),
                400,
            ),
        };
        let _ = req.respond(
            Response::from_string(body.to_string())
                .with_status_code(status)
                .with_header(ctype("application/json"))
                .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap()),
        );
        return;
    }

    if is_post && url == "/log" {
        // Diagnostic trace from the browser: print verbatim so client + server
        // events interleave in one log (only when ANIMA_DEBUG is set).
        let body = match read_request_body(&mut req) {
            Ok(body) => body,
            Err((status, message)) => {
                let _ = req.respond(Response::from_string(message).with_status_code(status));
                return;
            }
        };
        if std::env::var("ANIMA_DEBUG").is_ok() {
            eprintln!("[cli] {}", body.trim());
        }
        let _ = req.respond(Response::from_string("ok"));
    } else if read_only && is_post && matches!(url.as_str(), "/input" | "/login" | "/character") {
        // Spectator mode. Refused here, before the body is even read, so a request can
        // never reach the action/login channels — the guarantee is structural, not a
        // promise made by the renderer's UI.
        let _ = req.respond(
            Response::from_string("read-only monitor: input is disabled").with_status_code(403),
        );
    } else if is_post && url == "/input" {
        let body = match read_request_body(&mut req) {
            Ok(body) => body,
            Err((status, message)) => {
                let _ = req.respond(Response::from_string(message).with_status_code(status));
                return;
            }
        };
        let action = if body.trim() == "stop" {
            None
        } else {
            match parse_house_design_command(&body).or_else(|| parse_command(&body)) {
                Some(action) => Some(action),
                None => {
                    let _ = req.respond(
                        Response::from_string("Invalid input command.").with_status_code(400),
                    );
                    return;
                }
            }
        };
        let id = req
            .headers()
            .iter()
            .find(|h| h.field.equiv("X-Anima-Session"))
            .map(|h| h.value.as_str());
        let response = match tx.send(id, action) {
            Ok(()) => Response::from_string("ok"),
            Err(message) => Response::from_string(message).with_status_code(409),
        };
        let _ = req.respond(response);
    } else if is_post && url == "/login" {
        // The browser sends JSON so an optional character-creation request can
        // accompany the credentials. Colon-separated legacy requests remain valid.
        let body = match read_request_body(&mut req) {
            Ok(body) => body,
            Err((status, message)) => {
                let _ = req.respond(Response::from_string(message).with_status_code(status));
                return;
            }
        };
        // Saved secrets never go back to the page. Resolve the bound endpoint
        // and account inside the native process, ignoring caller-supplied hosts.
        let body = if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(id) = value.get("account_id").filter(|v| !v.is_null()) {
                if !launcher_request_allowed(&req) {
                    let _ = req.respond(
                        Response::from_string("Saved accounts require the local login screen.")
                            .with_status_code(403),
                    );
                    return;
                }
                let result = id
                    .as_str()
                    .ok_or_else(|| "Invalid saved account.".to_string())
                    .and_then(|id| {
                        launcher.resolve_login(id, value["password"].as_str().unwrap_or(""))
                    });
                match result {
                    Ok(saved) => {
                        value["host"] = serde_json::json!(saved.host);
                        value["port"] = serde_json::json!(saved.port);
                        value["shard"] = serde_json::json!(saved.shard);
                        value["username"] = serde_json::json!(saved.username);
                        value["password"] = serde_json::json!(saved.password);
                    }
                    Err(error) => {
                        let _ = req.respond(Response::from_string(error).with_status_code(400));
                        return;
                    }
                }
            }
            value.to_string()
        } else {
            body
        };
        match parse_login_attempt(&body) {
            Ok(attempt) => {
                let mut current_scene = scene.lock().unwrap();
                if !login_attempt_expected(&current_scene) {
                    drop(current_scene);
                    let _ = req.respond(
                        Response::from_string("login is not expected while a session is active")
                            .with_status_code(409),
                    );
                    return;
                }
                *current_scene = serde_json::json!({
                    "auth": "connecting",
                    "msg": "Connecting…",
                })
                .to_string();
                let control = LoginControl::default();
                *active_login.lock().unwrap() = Some(control.clone());
                drop(current_scene);
                if login.send((attempt, control)).is_ok() {
                    let _ = req.respond(Response::from_string("ok"));
                } else {
                    *active_login.lock().unwrap() = None;
                    *scene.lock().unwrap() = serde_json::json!({
                        "auth": "error",
                        "msg": "login service is unavailable",
                    })
                    .to_string();
                    let _ = req.respond(
                        Response::from_string("login service is unavailable").with_status_code(409),
                    );
                }
            }
            Err(message) => {
                let _ = req.respond(Response::from_string(message).with_status_code(400));
            }
        }
    } else if is_post && url == "/character" {
        let body = match read_request_body(&mut req) {
            Ok(body) => body,
            Err((status, message)) => {
                let _ = req.respond(Response::from_string(message).with_status_code(status));
                return;
            }
        };
        match parse_prompt_decision(&body) {
            Ok(decision) => {
                let progress = match &decision.decision {
                    CharacterDecision::Choose(CharacterChoice::Play(_)) => "Entering world…",
                    CharacterDecision::Choose(CharacterChoice::Create(_)) => "Creating character…",
                    CharacterDecision::Choose(CharacterChoice::Delete(_)) => "Deleting character…",
                    CharacterDecision::Cancel => "Returning to account login…",
                };
                let mut current_scene = scene.lock().unwrap();
                let awaiting_choice = serde_json::from_str::<serde_json::Value>(&current_scene)
                    .ok()
                    .is_some_and(|value| {
                        value["auth"] == "characters"
                            && value["choice_id"].as_str() == Some(&decision.choice_id)
                    });
                if !awaiting_choice {
                    drop(current_scene);
                    let _ = req.respond(
                        Response::from_string("character choice is not expected")
                            .with_status_code(409),
                    );
                    return;
                }
                *current_scene = serde_json::json!({
                    "auth": "connecting",
                    "msg": progress,
                })
                .to_string();
                drop(current_scene);
                match character.send(decision) {
                    Ok(()) => {
                        let _ = req.respond(Response::from_string("ok"));
                    }
                    Err(_) => {
                        let _ = req.respond(
                            Response::from_string("character chooser is unavailable")
                                .with_status_code(409),
                        );
                    }
                }
            }
            Err(message) => {
                let _ = req.respond(Response::from_string(message).with_status_code(400));
            }
        }
    } else if url == "/scene.json" {
        // Somebody is looking — let a session owner skip building frames nobody wants.
        watch.store(now_millis(), Ordering::Relaxed);
        let mut body = scene.lock().unwrap().clone();
        if let Some(control) = active_login.lock().unwrap().as_ref() {
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&body) {
                if value["auth"] == "connecting" {
                    value["attempt_id"] = serde_json::json!(control.id());
                    value["cancellable"] = serde_json::json!(control.is_active());
                    value["msg"] = serde_json::json!(control.message());
                    body = value.to_string();
                }
            }
        }
        let mut r = Response::from_string(body);
        r.add_header(Header::from_bytes("Cache-Control", "no-store").unwrap());
        r.add_header(ctype("application/json"));
        let _ = req.respond(r);
    } else if url == "/replay-art.json" {
        let g: u16 = raw_url
            .split_once("?g=")
            .and_then(|(_, v)| v.parse().ok())
            .unwrap_or(0);
        let (frames, interval) = terrain
            .as_ref()
            .and_then(|t| {
                let mut state = t.lock().ok()?;
                state
                    .animdata()
                    .map(|a| (a.frame_sequence(g), a.frames(g).1))
            })
            .unwrap_or((vec![g], 0));
        let flags = tiledata.as_ref().map_or(0, |t| t.item_flags(g));
        let height = tiledata.as_ref().map_or(0, |t| t.item_height(g));
        let mut r = Response::from_string(serde_json::json!({
            "frames": frames, "interval": interval, "partial": flags & 0x4_0000 != 0, "height": height
        }).to_string());
        r.add_header(ctype("application/json"));
        let _ = req.respond(r);
    } else if url == "/replay-look.json" {
        // Resolve recorded raw appearance through the same UO asset tables as play.
        let query = raw_url.split_once('?').map_or("", |(_, q)| q);
        let val = |key: &str| -> u16 {
            query
                .split('&')
                .find_map(|part| {
                    let (k, v) = part.split_once('=')?;
                    (k == key).then(|| v.parse().ok()).flatten()
                })
                .unwrap_or(0)
        };
        let (raw_body, raw_hue, g) = (val("body"), val("hue"), val("g"));
        let (body, fallback) = anim.as_ref().map_or((raw_body, 0), |a| a.remap(raw_body));
        let mut hue = if raw_hue == 0 { fallback } else { raw_hue };
        let at = anim.as_ref().map_or(2, |a| a.anim_type(body));
        let dg = anim.as_ref().map_or(21, |a| a.death_group(body));
        let mut equip_anim = tiledata.as_ref().map_or(0, |t| t.item_anim(g));
        if g != 0 {
            hue = raw_hue;
            if let Some(ec) = anim.as_ref().and_then(|a| a.equip_conv(body, equip_anim)) {
                equip_anim = ec.graphic;
                if hue == 0 {
                    hue = ec.hue;
                }
            }
            if hue != 0
                && tiledata
                    .as_ref()
                    .is_some_and(|t| t.item_flags(g) & 0x4_0000 != 0)
            {
                hue |= 0x8000;
            }
        }
        let (mount_anim, mount_off) =
            anima_assets::mounts::mount_body(g).unwrap_or((equip_anim, 0));
        let mut r = Response::from_string(
            serde_json::json!({
                "mountAnim": mount_anim, "mountOff": mount_off,
                "body": body, "at": at, "dg": dg, "hue": hue, "anim": equip_anim
            })
            .to_string(),
        );
        r.add_header(ctype("application/json"));
        let _ = req.respond(r);
    } else if url == "/terrain.json" {
        serve_terrain_json(terrain, art, &raw_url, req);
    } else if url == "/sounds" {
        // SSE stream. tiny_http's Response buffers the socket writer and only flushes
        // when the body completes — useless for a never-ending stream (headers never
        // reach the client). So we take the raw socket via into_writer() and write +
        // FLUSH each frame ourselves. This blocks the worker thread for the
        // connection's lifetime (one of 6 — fine for a single renderer); it ends when
        // a write fails (client gone — a heartbeat triggers this) or the hub drops us.
        let (s, rx) = mpsc::channel::<Vec<u8>>();
        sse_hub.lock().unwrap().push(s);
        let mut w = req.into_writer();
        // Stream on a DEDICATED thread, not the shared worker pool: an SSE connection
        // lives for the page's lifetime, so blocking a pooled worker here meant a few
        // browser refreshes (each leaving a stale stream until the next heartbeat
        // reaps it) could occupy all workers → /scene.json and /login stopped
        // responding ("can't connect"). The worker returns to the pool immediately.
        thread::spawn(move || {
            let head = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                Cache-Control: no-cache\r\nConnection: keep-alive\r\n\
                Access-Control-Allow-Origin: *\r\n\r\n: ok\n\n";
            if w.write_all(head).and_then(|_| w.flush()).is_ok() {
                while let Ok(frame) = rx.recv() {
                    if w.write_all(&frame).and_then(|_| w.flush()).is_err() {
                        break;
                    }
                }
            }
        });
    } else if url == "/worldmap.png" {
        // Ready once the background render finishes; 503 (retry) until then.
        let bytes = worldmap.lock().unwrap().clone();
        match bytes {
            Some(b) => respond_png(req, b),
            None => {
                let _ = req.respond(Response::from_string("building").with_status_code(503));
            }
        }
    } else if url == "/skillinfo.json" {
        // Skill names + HasAction from skills.mul. Static per data dir.
        let mut r = Response::from_string(skillinfo.as_str());
        r.add_header(ctype("application/json"));
        r.add_header(Header::from_bytes(&b"Cache-Control"[..], &b"max-age=3600"[..]).unwrap());
        let _ = req.respond(r);
    } else if url == "/professions.json" {
        let mut r = Response::from_string(professions.as_str());
        r.add_header(ctype("application/json"));
        r.add_header(Header::from_bytes(&b"Cache-Control"[..], &b"max-age=3600"[..]).unwrap());
        let _ = req.respond(r);
    } else if url == "/multimap.png" {
        match multimap.as_ref() {
            Some(b) => respond_png(req, b.to_vec()),
            None => {
                let _ = req.respond(Response::from_string("no Multimap.rle").with_status_code(404));
            }
        }
    } else if let Some((uni, font, ch)) = parse_font_glyph_url(&url) {
        serve_font_glyph(fonts, uni, font, ch, req);
    } else if url == "/font/text.png" {
        serve_font_text(fonts, &raw_url, req);
    } else if let Some((g, amount)) = parse_tileart_stack_url(&url) {
        let resolved = tileart
            .as_ref()
            .and_then(|t| t.get(g as u32))
            .map(|info| info.stack_graphic(amount) as u16)
            .unwrap_or(g);
        let mut r = Response::from_string(format!("{{\"g\":{resolved}}}"));
        r.add_header(ctype("application/json"));
        r.add_header(Header::from_bytes(&b"Cache-Control"[..], &b"max-age=86400"[..]).unwrap());
        let _ = req.respond(r);
    } else if url == "/pois.json" {
        // World-map points of interest (towns/banks/shops/dungeons/…). Static — built
        // once at startup; the client fetches it once when the world map opens.
        let mut r = Response::from_string(pois.as_str());
        r.add_header(ctype("application/json"));
        r.add_header(Header::from_bytes(&b"Cache-Control"[..], &b"max-age=3600"[..]).unwrap());
        let _ = req.respond(r);
    } else if url == "/regions.json" {
        // Guard-zone (guarded-region) rectangles for the CURRENT facet only —
        // `guard_rects` holds every facet's, so filter by the live `facet` the
        // game loop keeps updated. No Cache-Control: unlike `/pois.json` this
        // depends on server-side session state (the facet can change mid-session
        // via a moongate/sewer), so the client must always get a fresh answer for
        // whichever facet it's asking about "now".
        let cur = facet.load(Ordering::Relaxed);
        let body = regions_json(guard_rects, cur);
        let mut r = Response::from_string(body);
        r.add_header(ctype("application/json"));
        let _ = req.respond(r);
    } else if url == "/abilities.json" {
        // The combat book's catalogue: cliloc text for all 32 weapon moves plus
        // the tile names of the weapon graphics the caller listed. Static per
        // (data files, query), so it caches like /pois.json.
        let body = abilities_json(
            cliloc.as_deref(),
            tiledata.as_deref(),
            &parse_graphics_query(&raw_url),
        );
        // No Cache-Control on purpose, unlike /pois.json: this answer is
        // assembled from the server's cliloc and tiledata, and the renderer
        // already fetches it once per page load, so an hour of browser cache
        // buys one request and hides a data-file (or server) change behind a
        // stale copy. Found the hard way — a restarted server kept serving the
        // previous binary's answer to the same URL.
        let mut r = Response::from_string(body);
        r.add_header(ctype("application/json"));
        let _ = req.respond(r);
    } else if url == "/staticfilters.json" {
        // ClassicUO's StaticFilters tables, resolved against this install's
        // tiledata (the tree/vegetation split depends on impassability). Static
        // per data files; the renderer fetches it once.
        let mut r = Response::from_string(static_filters_json(tiledata.as_deref()));
        r.add_header(ctype("application/json"));
        let _ = req.respond(r);
    } else if url == "/housecatalog" {
        // Custom-house building catalog (walls/floors/doors/misc/stairs/roofs/
        // teleporters). Static per-process data, parsed once on the FIRST
        // request and cached from then on — see `HouseCatalogCache`'s doc.
        let mut r = Response::from_string((*house_catalog.get()).clone());
        r.add_header(ctype("application/json"));
        r.add_header(Header::from_bytes(&b"Cache-Control"[..], &b"max-age=3600"[..]).unwrap());
        let _ = req.respond(r);
    } else if let Some(id) = parse_sound_url(&url) {
        serve_sound(sounds, id, req);
    } else if let Some(id) = parse_music_url(&url) {
        serve_music(music, id, req);
    } else if let Some((is_static, g)) = parse_art_url(&url) {
        serve_art(
            art,
            hues,
            tile_cache,
            is_static,
            g,
            hue,
            has_fx_query(&raw_url),
            req,
        );
    } else if let Some(id) = parse_light_url(&url) {
        serve_light(lights, id, parse_color_query(&raw_url), req);
    } else if let Some(id) = parse_texmap_url(&url) {
        serve_texmap(texmaps, texmap_cache, id, req);
    } else if let Some((body, group, dir)) = parse_animinfo_url(&url) {
        // Per-frame draw-centers let the renderer position each part (body, worn
        // equipment, rider on mount) correctly instead of foot-anchoring them all.
        let centers = anim
            .as_ref()
            .and_then(|a| a.frame_centers(body, group, dir))
            .unwrap_or_default();
        let frames = centers.len();
        let c = centers
            .iter()
            .map(|(cx, cy)| format!("[{cx},{cy}]"))
            .collect::<Vec<_>>()
            .join(",");
        let mut r = Response::from_string(format!("{{\"frames\":{frames},\"c\":[{c}]}}"));
        r.add_header(ctype("application/json"));
        let _ = req.respond(r);
    } else if let Some(graphic) = parse_tilename_url(&url) {
        // Names one map static for the renderer's single-click label. A static
        // has no serial and so no OPL, and the scene's per-static record is far
        // too hot to carry a string, so the browser asks per graphic and
        // memoizes. Static per data files, but deliberately no Cache-Control:
        // same reasoning as /abilities.json just above — the renderer already
        // caches each graphic for the life of the page, so browser caching would
        // buy nothing and only hide a data-file or server change behind a stale
        // copy.
        let mut r = Response::from_string(tile_name_json(
            cliloc.as_deref(),
            tiledata.as_deref(),
            graphic,
        ));
        r.add_header(ctype("application/json"));
        let _ = req.respond(r);
    } else if let Some(body) = parse_idleanim_url(&url) {
        // The three fidget groups ClassicUO would choose between for this body,
        // each with whether it actually has frames. The renderer rolls the
        // index and runs the clock (30-60 s of standing still, suppressed while
        // mounted or in war mode) — only the group table needs the data files.
        let idle = anim
            .as_ref()
            .map(|a| a.idle_groups(body, has_fly_query(&raw_url)));
        let (g, e) = match idle {
            Some(rows) => (
                rows.iter()
                    .map(|(g, _)| g.to_string())
                    .collect::<Vec<_>>()
                    .join(","),
                rows.iter()
                    .map(|(_, e)| u8::from(*e).to_string())
                    .collect::<Vec<_>>()
                    .join(","),
            ),
            None => (String::new(), String::new()),
        };
        let mut r = Response::from_string(format!("{{\"g\":[{g}],\"e\":[{e}]}}"));
        r.add_header(ctype("application/json"));
        let _ = req.respond(r);
    } else if let Some(graphic) = parse_iteminfo_url(&url) {
        let anim_id = tiledata.as_ref().map(|t| t.item_anim(graphic)).unwrap_or(0);
        // `lt`/`lid`: does this ART graphic emit light, and which `light.mul`
        // shape. ClassicUO asks the same two questions of an EFFECT's art
        // (`GameEffectView.cs:248`, `data.IsLight` on the effect's current
        // animated graphic), and the browser owns the effect's live position —
        // so it looks the flag up per graphic here and adds the light itself.
        let (is_light, light_id) = tiledata.as_ref().map_or((false, 0), |t| {
            (t.item_is_light(graphic), t.item_layer(graphic))
        });
        let lt = u8::from(is_light);
        let mut r = Response::from_string(format!(
            "{{\"anim\":{anim_id},\"lt\":{lt},\"lid\":{light_id}}}"
        ));
        r.add_header(ctype("application/json"));
        let _ = req.respond(r);
    } else if let Some((body, group, dir, frame)) = parse_anim_url(&url) {
        serve_anim(anim, hues, anim_cache, body, group, dir, frame, hue, req);
    } else if let Some(id) = parse_gump_url(&url) {
        serve_gump(gumps, hues, gump_cache, id, hue, req);
    } else if url == "/hues/dyed.json" {
        // One compact palette fetch for the 0x95 picker. Loading 200/1000
        // individual `/hue/<id>.json` swatches would needlessly fan out HTTP.
        let mut r = Response::from_string(dyed_palette_json(hues.as_deref()));
        r.add_header(ctype("application/json"));
        r.add_header(Header::from_bytes(&b"Cache-Control"[..], &b"max-age=3600"[..]).unwrap());
        let _ = req.respond(r);
    } else if let Some(hid) = url
        .strip_prefix("/hue/")
        .and_then(|s| s.strip_suffix(".json"))
        .and_then(|s| s.parse::<u16>().ok())
    {
        // Resolve a hue id → a representative swatch colour (mid-bright ramp), so the
        // paperdoll can show the dye colour of hair/beard/clothing on hover.
        let c = hues
            .as_ref()
            .map(|h| h.color(hid, 24))
            .unwrap_or([0, 0, 0, 0]);
        let mut r = Response::from_string(format!(
            "{{\"rgb\":\"#{:02x}{:02x}{:02x}\"}}",
            c[0], c[1], c[2]
        ));
        r.add_header(ctype("application/json"));
        let _ = req.respond(r);
    } else {
        serve_static(web_dir, &url, req);
    }
}

pub(super) fn read_request_body(
    req: &mut tiny_http::Request,
) -> Result<String, (u16, &'static str)> {
    read_request_body_limited(req, MAX_POST_BODY_BYTES)
}
fn read_request_body_limited(
    req: &mut tiny_http::Request,
    limit: usize,
) -> Result<String, (u16, &'static str)> {
    if req.body_length().is_some_and(|length| length > limit) {
        return Err((413, "request body too large"));
    }
    match read_text_limited(req.as_reader(), limit) {
        Ok(Some(body)) => Ok(body),
        Ok(None) => Err((413, "request body too large")),
        Err(_) => Err((400, "invalid request body")),
    }
}

pub(super) fn read_text_limited(
    reader: &mut dyn io::Read,
    max_bytes: usize,
) -> io::Result<Option<String>> {
    let mut bytes = Vec::with_capacity(max_bytes.min(1024));
    reader.take(max_bytes as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Ok(None);
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

/// Case-insensitively look up a request header's value.
pub(super) fn header_value<'a>(req: &'a tiny_http::Request, name: &'static str) -> Option<&'a str> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}

/// CSRF guard: is a POST from this `Origin` (if any) allowed against this
/// `Host`? A missing `Origin` (curl, scripts, same-origin form posts) is
/// always allowed — only a *present-but-mismatched* `Origin` is rejected, so
/// this blocks cross-origin browser requests without affecting anything else.
/// Pure and unit-tested (`play_server` otherwise has none — see FIX 4).
pub(super) fn origin_allowed(origin: Option<&str>, host: Option<&str>) -> bool {
    let (Some(origin), Some(host)) = (origin, host) else {
        return true;
    };
    // `Origin` is `<scheme>://<host>[:<port>]`; strip the scheme to compare
    // against `Host`'s `<host>[:<port>]`.
    let origin_host = origin.split_once("://").map_or(origin, |(_, rest)| rest);
    origin_host.eq_ignore_ascii_case(host)
}

/// Serve a `web/` static asset. A configured `web_dir` on disk wins when it has
/// the file; otherwise (or with `web_dir: None`) fall back to the copy embedded
/// in the binary at compile time ([`EMBEDDED_WEB`]) — this is what lets
/// `anima-desktop` serve the renderer with no `web/` directory on disk at all.
pub(super) fn serve_static(web_dir: &Option<PathBuf>, url: &str, req: tiny_http::Request) {
    let rel = if url == "/" {
        "index.html"
    } else {
        url.trim_start_matches('/')
    };
    // Prevent path traversal.
    if rel.contains("..") {
        let _ = req.respond(Response::from_string("bad path").with_status_code(400));
        return;
    }
    let bytes = web_dir
        .as_ref()
        .and_then(|d| std::fs::read(d.join(rel)).ok())
        .or_else(|| EMBEDDED_WEB.get_file(rel).map(|f| f.contents().to_vec()));
    match bytes {
        Some(bytes) => {
            let mut r = Response::from_data(bytes);
            r.add_header(ctype(content_type(rel)));
            // Never cache the app shell (index.html / main.js / css) — Safari caches
            // it aggressively without this, so code changes never reached the page.
            r.add_header(
                Header::from_bytes(&b"Cache-Control"[..], &b"no-store, must-revalidate"[..])
                    .unwrap(),
            );
            let _ = req.respond(r);
        }
        None => {
            let _ = req.respond(Response::from_string("404").with_status_code(404));
        }
    }
}

/// Query for `GET /terrain.json?x=&y=&z=&map=&season=`. Missing keys default to 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct TerrainQuery {
    pub x: i64,
    pub y: i64,
    pub z: i32,
    pub map: u8,
    pub season: u8,
}

pub(super) fn parse_terrain_query(raw_url: &str) -> TerrainQuery {
    let mut q = TerrainQuery {
        x: 0,
        y: 0,
        z: 0,
        map: 0,
        season: 0,
    };
    let Some(qs) = raw_url.split('?').nth(1) else {
        return q;
    };
    for kv in qs.split('&') {
        let Some((k, v)) = kv.split_once('=') else {
            continue;
        };
        match k {
            "x" => q.x = v.parse().unwrap_or(0),
            "y" => q.y = v.parse().unwrap_or(0),
            "z" => q.z = v.parse().unwrap_or(0),
            "map" => q.map = v.parse().unwrap_or(0),
            "season" => q.season = v.parse().unwrap_or(0),
            _ => {}
        }
    }
    q
}

fn serve_terrain_json(
    terrain: &Option<Arc<Mutex<super::TerrainState>>>,
    art: &Option<Arc<Mutex<Art>>>,
    raw_url: &str,
    req: tiny_http::Request,
) {
    let Some(terrain) = terrain else {
        let _ = req.respond(Response::from_string("404").with_status_code(404));
        return;
    };
    let q = parse_terrain_query(raw_url);
    let body = {
        let Ok(mut state) = terrain.lock() else {
            let _ = req.respond(Response::from_string("lock").with_status_code(500));
            return;
        };
        let mut art_guard = art.as_ref().and_then(|a| a.lock().ok());
        state.with_facet(q.map, |map, multis, animdata| {
            crate::scene::build_terrain_window(
                map,
                multis,
                animdata,
                art_guard.as_deref_mut(),
                (q.x, q.y, q.z),
                q.season,
            )
        })
    };
    match body {
        Some(s) => {
            let mut r = Response::from_string(s);
            r.add_header(ctype("application/json"));
            r.add_header(Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap());
            let _ = req.respond(r);
        }
        None => {
            let _ = req.respond(Response::from_string("no map").with_status_code(404));
        }
    }
}

pub(super) fn ctype(v: &str) -> Header {
    Header::from_bytes(&b"Content-Type"[..], v.as_bytes()).unwrap()
}

/// Send a raw SSE frame to every connected client; drop any whose receiver is gone.
pub(super) fn sse_broadcast(hub: &SseHub, frame: &[u8]) {
    let mut g = hub.lock().unwrap();
    g.retain(|s| s.send(frame.to_vec()).is_ok());
}

pub(super) fn content_type(path: &str) -> &'static str {
    if path.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".js") {
        "text/javascript"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".json") {
        "application/json"
    } else {
        "application/octet-stream"
    }
}

// Literal loopback Host prevents DNS rebinding; a custom header prevents simple
// cross-origin requests. Password-backed profiles are never exposed to LAN peers.
fn launcher_request_allowed(req: &tiny_http::Request) -> bool {
    req.remote_addr()
        .is_some_and(|address| address.ip().is_loopback())
        && header_value(req, "X-Anima-Launcher") == Some("1")
        && local_launcher_host(header_value(req, "Host"))
        && origin_allowed(header_value(req, "Origin"), header_value(req, "Host"))
}
fn local_launcher_host(host: Option<&str>) -> bool {
    host.and_then(|h| h.rsplit_once(':')).is_some_and(|(h, p)| {
        matches!(h, "127.0.0.1" | "localhost" | "[::1]") && p.parse::<u16>().is_ok_and(|p| p != 0)
    })
}

#[cfg(test)]
mod csrf_tests {
    use super::{content_type, local_launcher_host, origin_allowed, parse_terrain_query};

    #[test]
    fn launcher_styles_have_a_browser_accepted_mime_type() {
        assert_eq!(content_type("launcher.css"), "text/css; charset=utf-8");
    }

    #[test]
    fn launcher_host_rejects_rebinding_and_non_loopback_names() {
        for host in ["127.0.0.1:8090", "localhost:8090", "[::1]:8090"] {
            assert!(local_launcher_host(Some(host)));
        }
        for host in [
            "evil.example:8090",
            "127.0.0.1.evil.example:8090",
            "192.168.1.1:8090",
            "localhost",
            "localhost:0",
            "localhost:65536",
            "localhost:abc",
            "user@localhost:8090",
        ] {
            assert!(!local_launcher_host(Some(host)));
        }
        assert!(!local_launcher_host(None));
    }

    #[test]
    fn no_origin_header_is_allowed() {
        // curl / scripts / same-origin form posts never send Origin.
        assert!(origin_allowed(None, Some("127.0.0.1:8090")));
    }

    #[test]
    fn matching_origin_is_allowed() {
        assert!(origin_allowed(
            Some("http://127.0.0.1:8090"),
            Some("127.0.0.1:8090")
        ));
    }

    #[test]
    fn scheme_is_ignored() {
        assert!(origin_allowed(
            Some("https://127.0.0.1:8090"),
            Some("127.0.0.1:8090")
        ));
    }

    #[test]
    fn mismatched_origin_is_rejected() {
        assert!(!origin_allowed(
            Some("http://evil.example:1234"),
            Some("127.0.0.1:8090")
        ));
    }

    #[test]
    fn no_host_header_is_allowed() {
        // Malformed request with no Host at all — nothing to compare against;
        // not this guard's job to reject it.
        assert!(origin_allowed(Some("http://evil.example"), None));
    }

    #[test]
    fn terrain_query_defaults_and_parses_center() {
        assert_eq!(
            parse_terrain_query("/terrain.json"),
            super::TerrainQuery {
                x: 0,
                y: 0,
                z: 0,
                map: 0,
                season: 0,
            }
        );
        assert_eq!(
            parse_terrain_query("/terrain.json?x=1495&y=1629&z=10&map=1&season=3"),
            super::TerrainQuery {
                x: 1495,
                y: 1629,
                z: 10,
                map: 1,
                season: 3,
            }
        );
        assert_eq!(
            parse_terrain_query("/terrain.json?x=bad&y=2"),
            super::TerrainQuery {
                x: 0,
                y: 2,
                z: 0,
                map: 0,
                season: 0,
            }
        );
    }
}
