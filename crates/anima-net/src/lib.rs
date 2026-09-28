//! The anima client's UI layer: the web play server, the launcher and the render
//! scene, on top of the headless [`anima_session`] (TCP driver, observation/action
//! JSON, pathing, NDJSON bridge).
//!
//! Everything in `anima_session` is re-exported here, so `anima_net::Session`,
//! `anima_net::json` and friends keep their old paths.

// The scene builder's `json!` player literal outgrew rustc's default macro
// recursion depth as fields were added (same reason anima-contract-json raises
// it). Nothing here recurses at run time.
#![recursion_limit = "512"]

pub use anima_session::*;

pub mod launcher;
pub mod play_server;
pub mod regions;
pub mod scene;
pub mod uo_dir;
