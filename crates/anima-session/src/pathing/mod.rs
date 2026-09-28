//! Walking and pathing over the live world: which tile a step lands on, what
//! blocks it, doors, and the [`MapTerrain`] a route plans across.
//!
//! Pure logic over `World` + `MapData` — no rendering. The render scene in
//! `anima-net` uses the same predicates for its per-tile walk flags, so a
//! headless brain and the on-screen client agree about what is walkable.

// Shared by `height` and `walk`, which pull them in with `use super::*`.
use std::collections::HashSet;
use std::time::{Duration, Instant};

use anima_assets::{MapData, Multis, StaticTile, ZReason};
use anima_core::path::Terrain;
use anima_core::World;

/// Static tiledata flag bits we need for roof/floor hiding (see [`max_draw_z`])
/// and step-Z resolution (see [`calculate_new_z`]).
pub const FLAG_IMPASSABLE: u64 = 0x40;

pub const FLAG_SURFACE: u64 = 0x200;

pub const FLAG_BRIDGE: u64 = 0x400;

/// `TileFlag.Window` / `TileFlag.NoShoot` (ClassicUO `TileDataLoader.cs:461/465`).
/// Together they are the line-of-sight blockers `HasSurfaceOverhead` looks for
/// on the 4×4 around another mobile — a roof flag alone is not enough.
pub const FLAG_WINDOW: u64 = 0x1000;

pub const FLAG_NOSHOOT: u64 = 0x2000;

pub const FLAG_ROOF: u64 = 0x1000_0000;

mod height;
mod walk;
pub use height::*;
pub use walk::*;
