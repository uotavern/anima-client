//! Asset-only HTTP server: the renderer's art, gumps and fonts plus
//! `GET /terrain.json`, with no game session. The replay viewer draws recorded
//! matches over it.
//!
//! [`play_server::bind`] loads the UO files and starts HTTP; this bin never
//! calls [`PlayServer::run`](anima_net::play_server::PlayServer::run), so there
//! is no shard login and `/scene.json` stays empty. `GET /terrain.json` builds
//! the isometric map window from the same files.
//!
//! Usage: `assets [http_port] [web_dir] [data_dir]`
//!
//! Same bind rules as `play`: loopback by default, `ANIMA_BIND` to opt in to
//! LAN (anyone who can reach the port can fetch your client files).

use std::path::PathBuf;

use anima_net::play_server::{self, PlayConfig};
use anima_net::uo_dir;

fn main() {
    let mut a = std::env::args().skip(1);
    let http_port: u16 = a.next().and_then(|s| s.parse().ok()).unwrap_or(8090);
    let web_dir = PathBuf::from(a.next().unwrap_or_else(|| "web".into()));
    let data_dir = match a.next() {
        Some(p) => {
            let dir = PathBuf::from(p);
            if !uo_dir::looks_like_uo_data(&dir) {
                eprintln!("assets: {} has no tiledata.mul", dir.display());
                std::process::exit(2);
            }
            dir
        }
        None => match uo_dir::detect_uo_dir() {
            Some(d) => d,
            None => {
                eprintln!(
                    "assets: could not find UO client data (tiledata.mul). Pass it as \
                     the 3rd argument, e.g.\n  assets 8090 web /path/to/uo"
                );
                std::process::exit(2);
            }
        },
    };
    let bind_addr = std::env::var("ANIMA_BIND").unwrap_or_else(|_| "127.0.0.1".to_string());
    let cfg = PlayConfig {
        host: "127.0.0.1".into(),
        port: 2594,
        user: String::new(),
        pass: String::new(),
        shard: 0,
        http_port,
        web_dir: Some(web_dir),
        data_dir,
        login_page: false,
        bind_addr,
        read_only: true,
    };
    let server = match play_server::bind(cfg) {
        Ok(s) => s,
        Err(_) => std::process::exit(1),
    };
    if let Err(e) = server.serve_assets() {
        eprintln!("assets: {e}");
        std::process::exit(1);
    }
}
