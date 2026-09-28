//! Z resolution: which surface a body actually stands on.
//!
//! A port of ClassicUO's `CalculateNewZ`/`GetAverageZ` chain, kept together
//! because the pieces only make sense as one algorithm — build the candidate
//! surface list for a tile, bound it by what the body can climb, and pick the
//! landing Z. `max_draw_z` is the rendering half of the same question: which
//! floor the camera is on, so roofs above it can be culled.

use super::*;

/// Real statics at `(x, y)` PLUS, when `multis` is given, any in-view multi
/// component there — as `(z, flags)` pairs, everything [`max_draw_z`] /
/// [`calculate_near_z`]'s roof-culling needs. A placed multi's own roof (a
/// house has real `FLAG_ROOF` components) must lift off exactly like a real
/// static roof does when the player is inside it — the static map alone has
/// no idea a multi is even there (see [`multi_components_at`]'s doc), so
/// without this a boat/house roof would never cull and the interior would
/// never show.
pub fn roof_scan_tiles(
    scan: &TileScan,
    multis: Option<&Multis>,
    map: &mut MapData,
    x: i64,
    y: i64,
) -> Vec<(i32, u64)> {
    let mut out: Vec<(i32, u64)> = map
        .statics(x as u32, y as u32)
        .into_iter()
        .map(|s| (s.z as i32, s.flags))
        .collect();
    if let Some(multis) = multis {
        out.extend(
            multi_components_at_scanned(scan, multis, x, y)
                .into_iter()
                .map(|(graphic, z)| (z, map.item_flags(graphic))),
        );
    }
    out
}

/// ClassicUO `UpdateMaxDrawZ` output (`GameSceneDrawingSorting.cs:69-206`).
///
/// Inferring `_noDrawRoofs` from `max_z < 127` is the documented fidelity gap:
/// a cave (`max_z = pz+16`) is not "under a roof", and a player at z≥111 clamps
/// `max_z` back to 127 while still needing roofs lifted.
///
/// `_maxGroundZ` is a **picking** bound, not a draw bound. ClassicUO's last
/// assignment (`:206`) writes the *local* `maxGroundZ`, which is 127 except on
/// the land-overhang/cave branch (`:96-102`). `PushToRenderQueue` then refuses
/// mouse selection of anything with `Z > _maxGroundZ`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrawCeiling {
    pub max_z: i32,
    pub max_ground_z: i32,
    pub no_draw_roofs: bool,
}

impl DrawCeiling {
    pub const OPEN: Self = Self {
        max_z: 127,
        max_ground_z: 127,
        no_draw_roofs: false,
    };
}

/// ClassicUO `ProcessAlpha` roof/Z rule for one object (`:337` / `:355`):
/// hide at/above `_maxZ`, else hide if `_noDrawRoofs && IsRoof`.
pub fn ceil_hz(z: i32, max_z: i32, no_draw_roofs: bool, is_roof: bool) -> bool {
    z >= max_z || (no_draw_roofs && is_roof)
}

/// ClassicUO `UpdateMaxDrawZ`: the Z at/above which statics are hidden so a roof
/// or upper floor over the player vanishes and the interior shows. 127 = draw all.
/// `multis` widens both scans below to in-view multi components (a house roof
/// is no different from a real static one) via [`roof_scan_tiles`].
pub fn max_draw_z_scanned(
    scan: &TileScan,
    map: &mut MapData,
    multis: Option<&Multis>,
    px: i64,
    py: i64,
    pz: i32,
) -> DrawCeiling {
    if px < 0 || py < 0 {
        return DrawCeiling::OPEN;
    }
    let mut max_z = 127i32;
    let mut no_draw_roofs = false;
    let pz14 = pz + 14;
    let pz16 = pz + 16;

    // Ground above the player (terrain overhang/cave) → cap at pz+16.
    // ClassicUO does NOT set `_noDrawRoofs` on this branch (`:96-102`); it
    // DOES set the local `maxGroundZ` that later becomes the picking bound.
    if pz16 <= map.land(px as u32, py as u32).z as i32 {
        return DrawCeiling {
            max_z: pz16,
            max_ground_z: pz16,
            no_draw_roofs: false,
        };
    }
    // Statics (+ multi components) over the player's own tile: an upper floor
    // / non-roof blocker.
    for (tz, flags) in roof_scan_tiles(scan, multis, map, px, py) {
        if tz > pz14 && tz < max_z {
            let is_roof = flags & FLAG_ROOF != 0;
            let is_surface = flags & FLAG_SURFACE != 0;
            if (flags & 0x2_0004) == 0 && (!is_roof || is_surface) {
                max_z = tz;
                no_draw_roofs = true;
            }
        }
    }
    // Roofs over the tile the player faces into (x+1, y+1). A roof collapses the
    // ceiling to the *near-Z* of its whole connected span (CalculateNearZ), so a
    // pitched roof lifts off cleanly instead of just its peak band.
    let mut roof_found = false;
    for (tz, flags) in roof_scan_tiles(scan, multis, map, px + 1, py + 1) {
        if tz > pz14 && tz < max_z {
            let is_roof = flags & FLAG_ROOF != 0;
            if (flags & 0x204) == 0 && is_roof {
                let mut visited = HashSet::new();
                max_z = calculate_near_z(scan, multis, map, px + 1, py + 1, tz, tz, &mut visited);
                roof_found = true;
                no_draw_roofs = true;
            }
        }
    }

    // ClassicUO clamps the ceiling to at least pz+16 (you always see ~16 above
    // your head). Only when something was actually found over the player.
    // The clamp can push `max_z` back to 127 (player z≥111); `_noDrawRoofs`
    // must survive that, or the roof stays drawn.
    if max_z != 127 || roof_found {
        max_z = max_z.max(pz16);
    }
    DrawCeiling {
        max_z,
        // ClassicUO `:206`: `_maxGroundZ = maxGroundZ` where the local is 127
        // unless the land-overhang branch fired (early-returned above).
        max_ground_z: 127,
        no_draw_roofs,
    }
}

/// ClassicUO `HasSurfaceOverhead` (`GameSceneDrawingSorting.cs:511`): one
/// Static/Multi above `obj_z` with NoShoot or Window, close enough to the
/// current draw ceiling. The 4×4 neighborhood check is [`has_surface_overhead`].
pub fn overhead_covers(obj_z: i32, max_z: i32, tile_z: i32, flags: u64) -> bool {
    tile_z > obj_z
        && flags & (FLAG_NOSHOOT | FLAG_WINDOW) != 0
        && max_z - tile_z + 5 >= tile_z - obj_z
}

/// True when every cell of ClassicUO's `x,y in -1..=2` neighborhood around
/// `(mx, my)` has an overhead cover. One gap and the mobile stays drawn —
/// that's why a vendor in a doorway is visible from the street and someone
/// deep inside a shop is not.
pub fn has_surface_overhead_neighborhood(mut covered: impl FnMut(i32, i32) -> bool) -> bool {
    for dy in -1..=2 {
        for dx in -1..=2 {
            if !covered(dx, dy) {
                return false;
            }
        }
    }
    true
}

fn tile_has_overhead_cover(
    scan: &TileScan,
    map: &mut MapData,
    multis: Option<&Multis>,
    x: i64,
    y: i64,
    obj_z: i32,
    max_z: i32,
) -> bool {
    if x < 0 || y < 0 {
        return false;
    }
    roof_scan_tiles(scan, multis, map, x, y)
        .into_iter()
        .any(|(tz, flags)| overhead_covers(obj_z, max_z, tz, flags))
}

/// ClassicUO `HasSurfaceOverhead` for a mobile at `(mx, my, mz)`. Never run
/// on the player — the caller already dropped them from `scene.mobiles`.
/// `cache` is `(tile_x, tile_y, obj_z) → covered` so overlapping 4×4s of
/// nearby mobiles don't re-scan the same statics.
#[allow(clippy::too_many_arguments)] // each is a distinct input the scan needs
pub fn has_surface_overhead(
    scan: &TileScan,
    map: &mut MapData,
    multis: Option<&Multis>,
    mx: i64,
    my: i64,
    mz: i32,
    max_z: i32,
    cache: &mut std::collections::HashMap<(i64, i64, i32), bool>,
) -> bool {
    for dy in -1..=2 {
        for dx in -1..=2 {
            let tx = mx + dx;
            let ty = my + dy;
            let key = (tx, ty, mz);
            let covered = *cache
                .entry(key)
                .or_insert_with(|| tile_has_overhead_cover(scan, map, multis, tx, ty, mz, max_z));
            if !covered {
                return false;
            }
        }
    }
    true
}

/// Flood-fill the lowest connected roof Z within ±6 of `z`, starting at (x, y).
/// Ported from ClassicUO `Map.CalculateNearZ`. `visited` prevents revisits.
/// `multis` (see [`roof_scan_tiles`]) lets a house's own roof components join
/// the flood, so a multi roof spanning several tiles lifts off as one
/// connected span instead of stopping dead at the first non-static tile.
#[allow(clippy::too_many_arguments)]
pub fn calculate_near_z(
    scan: &TileScan,
    multis: Option<&Multis>,
    map: &mut MapData,
    x: i64,
    y: i64,
    z: i32,
    default_z: i32,
    visited: &mut HashSet<(i64, i64)>,
) -> i32 {
    if x < 0 || y < 0 || !visited.insert((x, y)) {
        return default_z;
    }
    let roof = roof_scan_tiles(scan, multis, map, x, y)
        .into_iter()
        .find(|&(tz, flags)| flags & FLAG_ROOF != 0 && (z - tz).abs() <= 6);
    let Some((tz, _)) = roof else {
        return default_z;
    };
    let mut near = default_z.min(tz);
    near = calculate_near_z(scan, multis, map, x - 1, y, tz, near, visited);
    near = calculate_near_z(scan, multis, map, x + 1, y, tz, near, visited);
    near = calculate_near_z(scan, multis, map, x, y - 1, tz, near, visited);
    near = calculate_near_z(scan, multis, map, x, y + 1, tz, near, visited);
    near
}

/// ClassicUO `PATH_OBJECT_FLAGS` (we only model the NORMAL step state).
pub const POF_IMPASS: u32 = 0x1; // POF_IMPASSABLE_OR_SURFACE

pub const POF_SURFACE: u32 = 0x2;

pub const POF_BRIDGE: u32 = 0x4;

/// `Constants.DEFAULT_BLOCK_HEIGHT` — head/body clearance needed to stand.
pub const BLOCK_HEIGHT: i32 = 16;

/// 8-direction deltas (`Pathfinder._offsetX/_offsetY`), dir 0=N..7=NW.
pub const OFF_X: [i64; 8] = [0, 1, 1, 1, 0, -1, -1, -1];

pub const OFF_Y: [i64; 8] = [-1, -1, 0, 1, 1, 1, 0, -1];

/// One walkable/blocking surface on a tile (ClassicUO `PathObject`). Plain data
/// (all `Copy` fields) — derived so tests can build small synthetic tile lists
/// (e.g. a staircase) without fighting the borrow checker over reused literals.
#[derive(Clone, Copy)]
pub struct PathObj {
    pub flags: u32,
    pub z: i32,
    pub avg_z: i32,
    pub height: i32,
    pub land_stretched: bool,
}

/// Land Z at (x, y), or a deep floor for out-of-bounds (ClassicUO uses -125).
pub fn land_z(map: &mut MapData, x: i64, y: i64) -> i32 {
    if x < 0 || y < 0 {
        return -125;
    }
    map.land(x as u32, y as u32).z as i32
}

/// Land `AverageZ` / `MinZ` from the 4 corners (ClassicUO `Land.ApplyStretch`),
/// plus whether the tile is sloped (corners differ → "stretched").
pub fn land_avg_min(map: &mut MapData, x: i64, y: i64) -> (i32, i32, bool) {
    let z_top = land_z(map, x, y);
    let z_right = land_z(map, x + 1, y);
    let z_left = land_z(map, x, y + 1);
    let z_bottom = land_z(map, x + 1, y + 1);
    let avg = if (z_top - z_bottom).abs() <= (z_left - z_right).abs() {
        (z_top + z_bottom) >> 1
    } else {
        (z_left + z_right) >> 1
    };
    let min = z_top.min(z_right).min(z_left).min(z_bottom);
    let stretched = !(z_top == z_right && z_right == z_left && z_left == z_bottom);
    (avg, min, stretched)
}

/// ClassicUO `Land.CalculateCurrentAverageZ` — the slope Z toward `direction`.
pub fn calc_current_average_z(map: &mut MapData, x: i64, y: i64, direction: i32) -> i32 {
    let z_top = land_z(map, x, y);
    let z_right = land_z(map, x + 1, y);
    let z_bottom = land_z(map, x + 1, y + 1);
    let z_left = land_z(map, x, y + 1);
    let gdz = |d: i32| match d & 3 {
        1 => z_right,
        2 => z_bottom,
        3 => z_left,
        _ => z_top,
    };
    let result = gdz(((direction >> 1) + 1) & 3);
    if direction & 1 != 0 {
        result
    } else {
        (result + gdz(direction >> 1)) >> 1
    }
}

/// Turn a tiledata-flags-bearing object at world Z `z` with tiledata `height`
/// into a [`PathObj`] the same way ClassicUO's `CreateItemList` treats a real
/// static, or `None` if it contributes nothing to standing (`flags == 0` —
/// neither impassable nor surface/bridge). Shared by [`create_item_list`]'s
/// real-statics loop and its multi-component loop (a boat deck plank or house
/// floor tile) so the two can never derive the impassable/surface/bridge bits
/// differently.
pub fn tiledata_path_obj(z: i32, height: i32, tile_flags: u64) -> Option<PathObj> {
    let impassable = tile_flags & FLAG_IMPASSABLE != 0;
    let is_surface = tile_flags & FLAG_SURFACE != 0;
    let is_bridge = tile_flags & FLAG_BRIDGE != 0;
    let mut flags = 0u32;
    if impassable || is_surface {
        flags = POF_IMPASS;
    }
    if !impassable {
        if is_surface {
            flags |= POF_SURFACE;
        }
        if is_bridge {
            flags |= POF_BRIDGE;
        }
    }
    if flags == 0 {
        return None;
    }
    // Bridges (stairs/ramps) stand at half height; surfaces at full.
    let avg = if is_bridge { height / 2 } else { height } + z;
    Some(PathObj {
        flags,
        z,
        avg_z: avg,
        height,
        land_stretched: false,
    })
}

/// ClassicUO `Pathfinder.CreateItemList`: land + statics + **ordinary dynamic
/// items** (see [`dynamic_statics_at`]'s doc — a boat deck on this shard is
/// exactly this shape) **and, when `multis` is given, in-view multi
/// components** (a boat deck/hull, house floor/wall) on a tile, as `PathObj`s
/// (mobiles are not modelled here — they rarely change the standing Z).
/// Dynamic items and multi components matter here for the SAME reason they
/// matter for blocking (see `multi_blocker_at`'s doc): without them, stepping
/// onto/around a boat whose deck sits at a Z the static map alone knows
/// nothing about would resolve the wrong standing Z (or none at all) and every
/// step would look like a deny. Every dynamic item is folded in through
/// [`tiledata_path_obj`] exactly like a real static or multi component — this
/// list-building loop, unlike [`explain_tile_walkable`]'s scoring, has no
/// impassable/surface split to worry about (its only caller, [`step_ok`], has
/// its own separate `blocked_by_item` check regardless of what
/// `calculate_new_z` decides).
pub fn create_item_list(
    scan: &TileScan,
    map: &mut MapData,
    multis: Option<&Multis>,
    x: i64,
    y: i64,
) -> Vec<PathObj> {
    let mut list = Vec::new();
    if x < 0 || y < 0 {
        return list;
    }
    let land = map.land(x as u32, y as u32);
    let g = land.graphic;
    // Skip the "no-draw" land graphics (void/cave markers), like ClassicUO.
    if (g < 0x01AE && g != 2) || (g > 0x01B5 && g != 0x01DB) {
        let mut flags = POF_IMPASS;
        if !land.impassable() {
            flags |= POF_SURFACE | POF_BRIDGE;
        }
        let (avg, min, stretched) = land_avg_min(map, x, y);
        list.push(PathObj {
            flags,
            z: min,
            avg_z: avg,
            height: avg - min,
            land_stretched: stretched,
        });
    }
    for s in map.statics(x as u32, y as u32) {
        if let Some(obj) = tiledata_path_obj(s.z as i32, s.height as i32, s.flags) {
            list.push(obj);
        }
    }
    for it in dynamic_statics_at_scanned(scan, x, y) {
        if let Some(obj) = tiledata_path_obj(it.z as i32, it.height as i32, it.flags) {
            list.push(obj);
        }
    }
    if let Some(multis) = multis {
        for (graphic, cz) in multi_components_at_scanned(scan, multis, x, y) {
            let h = map.item_height(graphic) as i32;
            if let Some(obj) = tiledata_path_obj(cz, h, map.item_flags(graphic)) {
                list.push(obj);
            }
        }
    }
    list
}

/// Pure core of [`calc_min_max_z`] (ClassicUO `Pathfinder.CalculateMinMaxZ`'s
/// scoring loop): given the tile-behind's already-built [`PathObj`] list and
/// (for a stretched/sloped land tile) its direction-biased average Z, compute
/// the step's `(min_z, max_z)` bound. Split out — like
/// `anima_assets::map::score_walkable_z` — so a synthetic staircase (no real
/// `MapData`) can unit-test the standing-Z math directly; see
/// `resolve_standing_z` for the matching destination-tile half.
pub fn bound_min_max_z(source: &[PathObj], current_z: i32, stretched_avg: i32) -> (i32, i32) {
    let mut min_z = -128i32;
    let mut max_z = current_z;
    for obj in source {
        let avg = obj.avg_z;
        if avg <= current_z && obj.land_stretched {
            min_z = min_z.max(stretched_avg);
            max_z = max_z.max(stretched_avg);
        } else {
            if obj.flags & POF_IMPASS != 0 && avg <= current_z && min_z < avg {
                min_z = avg;
            }
            if obj.flags & POF_BRIDGE != 0 && current_z == avg {
                max_z = max_z.max(obj.z + obj.height);
                min_z = min_z.min(obj.z);
            }
        }
    }
    (min_z, max_z + 2)
}

/// ClassicUO `Pathfinder.CalculateMinMaxZ`: bound the step using the tile we
/// came *from* (opposite of `direction`). Returns `(min_z, max_z)`.
pub fn calc_min_max_z(
    scan: &TileScan,
    map: &mut MapData,
    multis: Option<&Multis>,
    x: i64,
    y: i64,
    current_z: i32,
    direction: u8,
) -> (i32, i32) {
    let back = (direction ^ 4) & 7;
    let sx = x + OFF_X[back as usize];
    let sy = y + OFF_Y[back as usize];
    let source = create_item_list(scan, map, multis, sx, sy);
    // Only land can be "stretched" (sloped) — at most one land entry per tile,
    // so this is computed at most once, matching the original inline call site.
    let stretched_avg = if source.iter().any(|o| o.land_stretched) {
        calc_current_average_z(map, sx, sy, direction as i32)
    } else {
        0
    };
    bound_min_max_z(&source, current_z, stretched_avg)
}

/// Pure core of [`calculate_new_z`] (ClassicUO `Pathfinder.CalculateNewZ`'s
/// surface/bridge/headroom scoring loop): given the destination tile's
/// already-built (unsorted) [`PathObj`] list and the step's `(min_z, max_z)`
/// bound from [`bound_min_max_z`], resolve the standing Z. `None` when nothing
/// in the list has clearance to stand on (a real DenyWalk situation). Split out
/// so a synthetic staircase can unit-test this without a real `MapData`.
pub fn resolve_standing_z(
    mut list: Vec<PathObj>,
    min_z: i32,
    max_z: i32,
    current_z: i32,
) -> Option<i32> {
    if list.is_empty() {
        return None;
    }
    // Sort by Z then height (PathObject.CompareTo), then add the "sky" sentinel.
    list.sort_by(|a, b| a.z.cmp(&b.z).then(a.height.cmp(&b.height)));
    list.push(PathObj {
        flags: POF_IMPASS,
        z: 128,
        avg_z: 128,
        height: 128,
        land_stretched: false,
    });

    let mut z = current_z;
    if z < min_z {
        z = min_z;
    }
    let mut min_z = min_z;
    let mut result_z = -128i32;
    let mut best_delta = i32::MAX;
    let mut cur_z = -128i32;

    for i in 0..list.len() {
        if list[i].flags & POF_IMPASS == 0 {
            continue;
        }
        let obj_z = list[i].z;
        // A ceiling object with clearance above the floor below it: find the
        // best surface/bridge under it that we can actually stand on.
        if obj_z - min_z >= BLOCK_HEIGHT {
            for j in (0..i).rev() {
                let t = &list[j];
                if t.flags & (POF_SURFACE | POF_BRIDGE) == 0 {
                    continue;
                }
                let tavg = t.avg_z;
                let fits = (tavg <= max_z && t.flags & POF_SURFACE != 0)
                    || (t.flags & POF_BRIDGE != 0 && t.z <= max_z);
                if tavg >= cur_z && obj_z - tavg >= BLOCK_HEIGHT && fits {
                    let delta = (z - tavg).abs();
                    if delta < best_delta {
                        best_delta = delta;
                        result_z = tavg;
                    }
                }
            }
        }
        let avg = list[i].avg_z;
        min_z = min_z.max(avg);
        cur_z = cur_z.max(avg);
    }

    if result_z == -128 {
        None
    } else {
        Some(result_z)
    }
}

/// ClassicUO `Pathfinder.CalculateNewZ`: the standing Z when stepping onto
/// `(x, y)` from `current_z` heading `direction`. `None` when the tile has no
/// valid surface to stand on (a real DenyWalk situation). `multis` (when given)
/// lets a boat deck/house floor contribute a standing Z the static map alone
/// wouldn't know about — see [`create_item_list`]'s doc.
pub fn calculate_new_z(
    world: &World,
    map: &mut MapData,
    multis: Option<&Multis>,
    x: i64,
    y: i64,
    current_z: i32,
    direction: u8,
) -> Option<i32> {
    calculate_new_z_scanned(
        &TileScan::build(world, map),
        map,
        multis,
        x,
        y,
        current_z,
        direction,
    )
}

/// [`calculate_new_z`] against a scan the caller already built — the tile loop
/// resolves ~168 of these per frame and must not rebuild the index each time.
#[allow(clippy::too_many_arguments)] // mirrors `calculate_new_z`
pub fn calculate_new_z_scanned(
    scan: &TileScan,
    map: &mut MapData,
    multis: Option<&Multis>,
    x: i64,
    y: i64,
    current_z: i32,
    direction: u8,
) -> Option<i32> {
    if x < 0 || y < 0 {
        return None;
    }
    let (min_z, max_z) = calc_min_max_z(scan, map, multis, x, y, current_z, direction);
    let list = create_item_list(scan, map, multis, x, y);
    resolve_standing_z(list, min_z, max_z, current_z)
}

/// See [`max_draw_z_scanned`]. Called once per scene build (and by tests), so
/// it builds its own index.
pub fn max_draw_z(
    world: &World,
    map: &mut MapData,
    multis: Option<&Multis>,
    px: i64,
    py: i64,
    pz: i32,
) -> DrawCeiling {
    let scan = TileScan::build(world, map);
    max_draw_z_scanned(&scan, map, multis, px, py, pz)
}
