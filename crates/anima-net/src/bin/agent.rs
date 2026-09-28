//! `anima-agent` — the brain↔body NDJSON bridge ([`anima_session::bridge`]) plus
//! an optional read-only web spectator. `anima-bridge` (in `anima-session`) is
//! the same bridge without any UI linked in.
//!
//! Set `ANIMA_MONITOR_PORT` to also serve a READ-ONLY spectator view of this
//! character on that HTTP port (`0` = pick a free one; the chosen port is printed
//! to stderr as `[anima-agent] monitor on http://.../`). It renders the same web
//! client `play` serves, but refuses every input — the brain stays the only thing
//! driving this body. A spectator cannot be a second login of the same character:
//! ServUO's character-select disposes the previous session, which would kick the
//! agent off, so the bridge publishes frames from the session it already owns.
//!
//! Usage: `anima-agent [host] [port] [username] [password] [data_dir]`

use anima_assets::MapData;
use anima_net::play_server::{self, Monitor, PlayConfig};
use anima_net::Session;
use anima_session::bridge::{self, Spectator};

/// Frames are only built when somebody is actually watching, so an unwatched
/// monitor costs nothing per command beyond one clock read.
struct WebSpectator(Monitor);

impl Spectator for WebSpectator {
    fn after_command(&mut self, session: &mut Session, map: Option<&mut MapData>) {
        if self.0.watching() {
            self.0.publish(session, map);
        }
    }
}

fn main() {
    bridge::run("anima-agent", |data_dir| {
        monitor(data_dir).map(|m| Box::new(WebSpectator(m)) as Box<dyn Spectator>)
    });
}

/// Bind the spectator view if `ANIMA_MONITOR_PORT` asks for one. Bound before the
/// NDJSON loop starts so the port is printed while a human is still reading stderr.
fn monitor(data_dir: &str) -> Option<Monitor> {
    let v = std::env::var("ANIMA_MONITOR_PORT").ok()?;
    let Ok(http_port) = v.parse::<u16>() else {
        eprintln!("[anima-agent] ANIMA_MONITOR_PORT={v:?} is not a port; monitor off");
        return None;
    };
    match play_server::bind(PlayConfig {
        host: String::new(),
        port: 0,
        user: String::new(),
        pass: String::new(),
        shard: 0, // spectator only — this config never logs in
        http_port,
        web_dir: None, // the copy embedded in anima-net at compile time
        data_dir: data_dir.into(),
        login_page: false,
        bind_addr: "127.0.0.1".to_string(),
        read_only: true,
    }) {
        Ok(server) => {
            let m = server.into_monitor();
            eprintln!(
                "[anima-agent] monitor on http://127.0.0.1:{}/ (read-only)",
                m.port()
            );
            Some(m)
        }
        // A monitor is a convenience; never take the brain down with it.
        Err(e) => {
            eprintln!("[anima-agent] monitor failed to bind: {e}");
            None
        }
    }
}
