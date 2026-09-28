//! The brain↔body IPC bridge, built headless as `anima-bridge` (this crate) and
//! with an optional web spectator as `anima-agent` (`anima-net`).
//!
//! Connects to a UO server and logs in, then speaks **newline-delimited JSON**
//! (NDJSON) over stdin/stdout so an out-of-process brain (anima2, Python) can
//! drive this character. stderr carries human logs only.
//!
//! A [`Spectator`] (the `anima-agent` build's read-only web view, switched on by
//! `ANIMA_MONITOR_PORT`) sees the session after every command, on the bridge's
//! own thread; the headless build has none.
//!
//! Usage: `anima-bridge [host] [port] [username] [password] [data_dir]`
//! (defaults: 127.0.0.1 2594 animatest animatest — ServUO auto-creates accounts;
//! `data_dir` defaults to `$HOME/dev/uo/uo-resource`, like `play.rs`/the `anima-agent` crate's
//! `main.rs`.) `data_dir` is where the UO client files live — it's the
//! pathfinding terrain for `Action::WalkTo` (see `pump` below); a brain that
//! never sends `WalkTo` runs fine without it.
//!
//! Protocol — one JSON object per line:
//!   → `{"cmd":"observe"}`            ← `{"ok":true,"obs":{...}}`
//!     (add `"terrain_radius":N` to widen/narrow the walkability window in
//!     `obs.terrain`, or `0` to omit it; it is only ever filled when
//!     `data_dir` gave us map files to read)
//!   → `{"cmd":"act","action":{...}}` ← `{"ok":true,"sent":bool}`
//!     (`sent` is false when nothing reached the server: a target/prompt/menu/
//!     trade reply with nothing outstanding to answer, a local-only close, or a
//!     `WalkTo`, which `pump` walks)
//!   → `{"cmd":"pump","ms":400}`      ← `{"ok":true,"applied":N}`
//!   → `{"cmd":"logout"}`             ← `{"ok":true,"allowed":bool}`
//!     (asks the server and waits up to `wait_ms`, default 10 s; allowed = the
//!     session is closed and only `login`/`quit` work until the next login)
//!   → `{"cmd":"login", ...}`         ← `{"ok":true,"schema_version":N,"player":{...}}`
//!     (ends any live session, then logs in again; optional `user`, `password`,
//!     `shard`, `character` (name or slot), `create` (an appearance), `choose`
//!     override the bridge's settings — how a brain switches characters)
//!   → `{"cmd":"quit"}`               ← `{"ok":true,"bye":true}` then exit
//!
//! Choosing a character. By default the bridge plays the account's first
//! character, creating a default one on an empty account. `ANIMA_SHARD` picks
//! the shard's index, `ANIMA_CHARACTER` a character by name or slot, and
//! `ANIMA_CREATE` (a JSON appearance: `name`, `female`, `strength`/`dexterity`/
//! `intelligence`, `skills` as up to four `[id, value]` pairs, `city_index`,
//! hues and styles) creates one when that name is absent. With
//! `ANIMA_CHOOSE=1` (or `"choose":true` on `login`) the bridge instead emits
//!   `{"event":"characters","slots":[...],"cities":[...],"delete_rejected":...}`
//! and waits for `{"cmd":"choose","play":slot}` / `{"cmd":"choose","create":{...}}`
//! / `{"cmd":"choose","delete":slot}` — a delete re-emits the refreshed list.
//! On any error: `{"ok":false,"error":"..."}` (the loop keeps running).
//! On startup, emits one line:
//! `{"event":"ready","schema_version":N,"player":{...}}`.
//!
//! `act`'s `WalkTo` only queues the route (see [`Session::apply_action`]);
//! `pump` is what actually drives it, one step per call at its own cadence —
//! call `pump` on a steady tick (like `main.rs`'s per-tick loop) or the route
//! stalls between brain turns.

use std::io::{BufRead, Write};
use std::time::Duration;

use crate::json::{
    action_from_json, appearance_from_json, character_choice_from_json, character_prompt_to_json,
    observation_to_json, SCHEMA_VERSION,
};
use crate::{DriverError, Endpoint, Session};
use anima_assets::{Cliloc, MapData, Speeches};
use anima_core::agent::Action;
use anima_core::net::{CharacterAppearance, CharacterChoice, CharacterPrompt, LoginConfig};
use std::sync::OnceLock;

/// Default half-width of the walkability window in `observe`'s `obs.terrain`.
/// 12 covers roughly what the renderer draws, so a brain sees the same ground a
/// human would; 625 tiles of it costs about a kilobyte on the wire (see
/// `terrain_json`'s packing).
const TERRAIN_RADIUS: u8 = 12;
use serde_json::{json, Value};

/// Everything the bridge needs to (re)log in. Set from the command line and
/// the `ANIMA_*` environment at startup; a `login` command may override the
/// account, shard and character for the next session.
#[derive(Clone)]
struct Login {
    host: String,
    port: u16,
    username: String,
    password: String,
    /// The shard's own index in the 0xA8 list (`ANIMA_SHARD`).
    shard: u16,
    /// Play the character with this name, or this slot if it is a number
    /// (`ANIMA_CHARACTER`).
    character: Option<String>,
    /// Create this character when `character` is not found, or always when no
    /// `character` is named (`ANIMA_CREATE`, a JSON appearance).
    create: Option<Value>,
    /// Hand the character list to the brain as a `characters` event and wait
    /// for its `{"cmd":"choose",...}` (`ANIMA_CHOOSE=1`).
    choose: bool,
}

type Lines<'a> = std::io::Lines<std::io::StdinLock<'a>>;

/// A read-only view of the bridge's character, such as `anima-net`'s web
/// spectator. It is called on the bridge's own thread after every command, so it
/// never touches the session concurrently with the brain and needs no lock.
pub trait Spectator {
    fn after_command(&mut self, session: &mut Session, map: Option<&mut MapData>);
}

static NAME: OnceLock<&'static str> = OnceLock::new();

/// The binary's name, for the `[name] ...` stderr lines.
fn name() -> &'static str {
    NAME.get().copied().unwrap_or("anima-bridge")
}

/// Run the bridge until stdin closes or the brain sends `quit`. `name` prefixes
/// the stderr log; `spectator` is asked once, after the game data is loaded
/// (it gets the data directory), whether to attach a [`Spectator`].
pub fn run(bin_name: &'static str, spectator: impl FnOnce(&str) -> Option<Box<dyn Spectator>>) {
    let _ = NAME.set(bin_name);
    let mut args = std::env::args().skip(1);
    let host = args.next().unwrap_or_else(|| "127.0.0.1".to_string());
    let port: u16 = args.next().and_then(|s| s.parse().ok()).unwrap_or(2594);
    let username = args.next().unwrap_or_else(|| "animatest".to_string());
    let password = args.next().unwrap_or_else(|| "animatest".to_string());
    let home = std::env::var("HOME").unwrap_or_default();
    let data_dir = args
        .next()
        .unwrap_or_else(|| format!("{home}/dev/uo/uo-resource"));
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let mut login = Login {
        host,
        port,
        username,
        password,
        shard: env("ANIMA_SHARD").and_then(|v| v.parse().ok()).unwrap_or(0),
        character: env("ANIMA_CHARACTER"),
        create: env("ANIMA_CREATE").and_then(|v| serde_json::from_str(&v).ok()),
        choose: env("ANIMA_CHOOSE").is_some_and(|v| v != "0"),
    };
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();

    let mut session = match connect(&login, &mut lines) {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("[{}] login failed: {e}", name());
            std::process::exit(1);
        }
    };
    // `MapData` is the pathfinding terrain `pump` feeds `Session::advance_route`
    // (see `handle`) so a brain's `Action::WalkTo` actually walks — mirrors
    // the `anima-agent` crate's `main.rs`. Missing game data degrades gracefully: `WalkTo`
    // still queues a route (the contract stays honest — `act` doesn't lie about
    // it), it just never advances, so we log it loudly once here and again on
    // every `WalkTo` `act` while it's missing.
    let mut map = MapData::open(&data_dir).ok();
    // Localizes the journal for the brain — see `resolve_journal`.
    let cliloc = Cliloc::open(&data_dir).ok();
    let speech = Speeches::open(&data_dir).ok();
    if let (Some(s), Some(sp)) = (session.as_mut(), speech.clone()) {
        eprintln!("[{}] speech.mul loaded ({} keywords)", name(), sp.len());
        s.set_speech(sp);
    }
    eprintln!(
        "[{}] map data {}",
        name(),
        if map.is_some() {
            "loaded".to_string()
        } else {
            format!("not loaded at {data_dir} (WalkTo actions will be accepted but won't path)")
        }
    );
    let mut spectator = spectator(&data_dir);

    if let Some(s) = session.as_mut() {
        emit(&ready_event(&ready_player(s)));
    }
    eprintln!("[{}] ready — speaking NDJSON on stdout", name());

    while let Some(line) = lines.next() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                emit(&json!({ "ok": false, "error": format!("bad json: {e}") }));
                continue;
            }
        };
        let result = match msg.get("cmd").and_then(Value::as_str) {
            // Session lifecycle: these work with or without a live session.
            Some("login") => {
                session = None; // one character per bridge: the old session goes first
                apply_login_overrides(&mut login, &msg);
                match connect(&login, &mut lines) {
                    Ok(mut s) => {
                        if let Some(sp) = speech.clone() {
                            s.set_speech(sp);
                        }
                        let player = ready_player(&mut s);
                        session = Some(s);
                        Ok(Some(
                            json!({ "ok": true, "schema_version": SCHEMA_VERSION, "player": player }),
                        ))
                    }
                    Err(e) => Err(format!("login failed: {e}")),
                }
            }
            Some("logout") => match session.as_mut() {
                None => Ok(Some(
                    json!({ "ok": true, "allowed": true, "already": true }),
                )),
                Some(s) => {
                    let wait = msg.get("wait_ms").and_then(Value::as_u64).unwrap_or(10_000);
                    match logout(s, Duration::from_millis(wait)) {
                        Ok(true) => {
                            session = None;
                            Ok(Some(json!({ "ok": true, "allowed": true })))
                        }
                        // Refused (in combat, or the shard's logout timer): still connected.
                        Ok(false) => Ok(Some(json!({ "ok": true, "allowed": false }))),
                        Err(e) => {
                            session = None;
                            Err(format!("logout: {e}"))
                        }
                    }
                }
            },
            Some("quit") => Ok(None),
            _ => match session.as_mut() {
                Some(s) => handle(s, map.as_mut(), cliloc.as_ref(), &msg),
                None => Err("logged out: send {\"cmd\":\"login\"} first".to_string()),
            },
        };
        // Let a spectator see the session the brain just advanced (see `Spectator`).
        if let (Some(v), Some(s)) = (spectator.as_mut(), session.as_mut()) {
            v.after_command(s, map.as_mut());
        }
        match result {
            Ok(Some(reply)) => emit(&reply),
            Ok(None) => {
                emit(&json!({ "ok": true, "bye": true }));
                break;
            }
            Err(e) => emit(&json!({ "ok": false, "error": e })),
        }
    }
}

/// Drain the first burst after entering the world so the player is complete.
fn ready_player(session: &mut Session) -> Value {
    let _ = session.observe(Duration::from_millis(500));
    observation_to_json(&session.observation())["player"].clone()
}

/// A `login` command may name a different account, shard or character; any
/// key it leaves out keeps the bridge's current setting.
fn apply_login_overrides(login: &mut Login, msg: &Value) {
    let s = |k: &str| msg.get(k).and_then(Value::as_str).map(str::to_string);
    if let Some(v) = s("user") {
        login.username = v;
    }
    if let Some(v) = s("password") {
        login.password = v;
    }
    if let Some(v) = msg.get("shard").and_then(Value::as_u64) {
        login.shard = v as u16;
    }
    match msg.get("character") {
        Some(Value::String(v)) => login.character = Some(v.clone()),
        Some(Value::Number(n)) => login.character = Some(n.to_string()),
        Some(Value::Null) => login.character = None,
        _ => {}
    }
    if let Some(v) = msg.get("create") {
        login.create = (!v.is_null()).then(|| v.clone());
    }
    // Naming the character (or what to create) is itself the choice; `choose`
    // stays on only when the brain asks for the list again.
    if msg.get("character").is_some() || msg.get("create").is_some() {
        login.choose = false;
    }
    if let Some(v) = msg.get("choose").and_then(Value::as_bool) {
        login.choose = v;
    }
}

/// Log in as `login` says. With no character named, nothing to create and no
/// interactive choice, this is the old automatic path (the first character, or
/// a default one on an empty account).
fn connect(login: &Login, lines: &mut Lines) -> Result<Session, String> {
    eprintln!(
        "[{}] connecting to {}:{} as {} ...",
        name(),
        login.host,
        login.port,
        login.username
    );
    let cfg = LoginConfig {
        username: login.username.clone(),
        password: login.password.clone(),
        server_index: login.shard,
        ..Default::default()
    };
    let endpoint = Endpoint::new(login.host.clone(), login.port);
    if login.character.is_none() && login.create.is_none() && !login.choose {
        return Session::connect_and_login(&endpoint, cfg).map_err(|e| e.to_string());
    }
    let create = match &login.create {
        Some(v) => Some(appearance_from_json(v)?),
        None => None,
    };
    let mut why: Option<String> = None;
    let result = Session::connect_and_login_with_character_chooser(&endpoint, cfg, |prompt| {
        if login.choose {
            return ask_brain(&prompt, lines).map_err(|e| {
                why = Some(e);
                DriverError::CharacterChoiceCancelled
            });
        }
        choose_automatically(&prompt, login.character.as_deref(), create.as_ref()).map_err(|e| {
            why = Some(e);
            DriverError::CharacterChoiceCancelled
        })
    });
    result.map_err(|e| why.take().unwrap_or_else(|| e.to_string()))
}

/// `ANIMA_CHARACTER` by name (case-insensitive) or slot number; otherwise
/// create `ANIMA_CREATE` if given.
fn choose_automatically(
    prompt: &CharacterPrompt,
    character: Option<&str>,
    create: Option<&CharacterAppearance>,
) -> Result<CharacterChoice, String> {
    if let Some(want) = character {
        let named = prompt.list.slots.iter().find(|s| {
            !s.name.is_empty()
                && (s.name.eq_ignore_ascii_case(want) || want.parse::<u8>() == Ok(s.index))
        });
        if let Some(slot) = named {
            return Ok(CharacterChoice::Play(slot.index));
        }
    }
    match create {
        Some(a) => Ok(CharacterChoice::Create(a.clone())),
        None => Err(format!(
            "no character {:?} on this account (slots: {:?})",
            character.unwrap_or(""),
            prompt
                .list
                .slots
                .iter()
                .filter(|s| !s.name.is_empty())
                .map(|s| &s.name)
                .collect::<Vec<_>>()
        )),
    }
}

/// Emit the character list and read the brain's `{"cmd":"choose",...}`.
fn ask_brain(prompt: &CharacterPrompt, lines: &mut Lines) -> Result<CharacterChoice, String> {
    let mut event = character_prompt_to_json(prompt);
    event["event"] = json!("characters");
    emit(&event);
    loop {
        let line = match lines.next() {
            Some(Ok(l)) => l,
            _ => return Err("stdin closed while choosing a character".to_string()),
        };
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                emit(&json!({ "ok": false, "error": format!("bad json: {e}") }));
                continue;
            }
        };
        match msg.get("cmd").and_then(Value::as_str) {
            Some("choose") => match character_choice_from_json(&msg) {
                Ok(c) => return Ok(c),
                Err(e) => emit(&json!({ "ok": false, "error": e })),
            },
            Some("quit") => return Err("quit while choosing a character".to_string()),
            _ => emit(
                &json!({ "ok": false, "error": "choosing a character: send {\"cmd\":\"choose\",\"play\"|\"create\"|\"delete\":...}" }),
            ),
        }
    }
}

/// Ask to leave and wait for the server's answer. `Ok(true)` = the session is
/// over (the caller drops it, closing the socket); `Ok(false)` = refused.
fn logout(session: &mut Session, wait: Duration) -> Result<bool, String> {
    session
        .apply_action(&Action::Logout)
        .map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + wait;
    loop {
        if let Some(allowed) = session.take_logout_ack() {
            return Ok(allowed);
        }
        if std::time::Instant::now() >= deadline {
            return Ok(false);
        }
        session
            .observe(Duration::from_millis(200))
            .map_err(|e| e.to_string())?;
    }
}

fn ready_event(player: &Value) -> Value {
    json!({
        "event": "ready",
        "schema_version": SCHEMA_VERSION,
        "player": player,
    })
}

/// Returns `Ok(Some(reply))` to answer, `Ok(None)` to quit, `Err(msg)` on failure.
/// `map` is the `WalkTo` pathfinding terrain (`None` if `data_dir` had no game
/// data — see `main`'s startup log).
fn handle(
    session: &mut Session,
    map: Option<&mut MapData>,
    cliloc: Option<&Cliloc>,
    msg: &Value,
) -> Result<Option<Value>, String> {
    let cmd = msg
        .get("cmd")
        .and_then(Value::as_str)
        .ok_or("missing 'cmd'")?;
    match cmd {
        "observe" => {
            // With map data loaded, the observation carries local walkability
            // too — the brain can see walls/water/doors rather than only being
            // able to hand `WalkTo` a destination and hope. `radius` is the
            // caller's, since a combat brain polling every tick wants a
            // smaller window than a mapper; the default covers the screen.
            let radius = msg
                .get("terrain_radius")
                .and_then(Value::as_u64)
                .map_or(TERRAIN_RADIUS, |r| r.min(u64::from(u8::MAX)) as u8);
            let mut obs = match (map, radius) {
                (Some(map), 1..) => session.observation_with_terrain(map, radius),
                // No map files, or the brain explicitly asked for none.
                _ => session.observation(),
            };
            crate::localize(&mut obs, cliloc);
            Ok(Some(
                json!({ "ok": true, "obs": observation_to_json(&obs) }),
            ))
        }
        "act" => {
            let action = action_from_json(msg.get("action").ok_or("missing 'action'")?)?;
            if matches!(action, Action::WalkTo { .. }) && map.is_none() {
                eprintln!(
                    "[{}] WalkTo queued but no map data loaded — it can't path (see startup log)",
                    name()
                );
            }
            let before = session.packets_sent();
            session.apply_action(&action).map_err(|e| e.to_string())?;
            // `sent: false` = nothing reached the server on this call: a reply
            // with nothing outstanding (no cursor, prompt, menu or trade), a
            // local-only close, or a WalkTo that `pump` will walk.
            Ok(Some(
                json!({ "ok": true, "sent": session.packets_sent() > before }),
            ))
        }
        "pump" => {
            let ms = msg.get("ms").and_then(Value::as_u64).unwrap_or(400);
            let applied = session
                .observe(Duration::from_millis(ms))
                .map_err(|e| e.to_string())?;
            // Advance any active `Action::WalkTo` route by at most one step,
            // paced internally — a no-op most calls. Only possible with map
            // data; without it a queued route just sits idle (see `main`).
            if let Some(m) = map {
                if let Err(e) = session.advance_route(m) {
                    eprintln!("[{}] route error: {e}", name());
                }
            }
            Ok(Some(json!({ "ok": true, "applied": applied })))
        }
        other => Err(format!("unknown cmd: {other}")),
    }
}

fn emit(v: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_event_advertises_contract_schema_version() {
        let player = json!({ "serial": 0x1234, "dead": false });
        let ready = ready_event(&player);

        assert_eq!(ready["event"], "ready");
        assert_eq!(ready["schema_version"], SCHEMA_VERSION);
        assert_eq!(ready["player"], player);
    }
}
