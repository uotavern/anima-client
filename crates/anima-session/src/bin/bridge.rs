//! `anima-bridge` — the headless brain↔body bridge: NDJSON on stdin/stdout, no
//! UI linked in. See [`anima_session::bridge`] for the protocol.
//!
//! Usage: `anima-bridge [host] [port] [username] [password] [data_dir]`

fn main() {
    if std::env::var_os("ANIMA_MONITOR_PORT").is_some() {
        eprintln!(
            "[anima-bridge] ANIMA_MONITOR_PORT is set, but this headless build has no web \
             spectator; build `anima-agent` (cargo build --release -p anima-net) for one"
        );
    }
    anima_session::bridge::run("anima-bridge", |_| None);
}
