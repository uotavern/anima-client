//! Can the player stand there, and if not, is it a door?
//!
//! The one place the static map is combined with `World`'s dynamic items and
//! placed multis. Two strictnesses live here and must not be confused: route
//! *planning* treats a closed door as passable, while a real committed step does
//! not — see [`tile_walkable_for_planning`]. `MapTerrain` is the `Terrain` impl
//! A* runs against, and the door-vs-wall decision an executor makes is
//! [`decide_blocked_step`].

use super::*;
use anima_core::world::Item;

/// Why [`explain_tile_walkable`] (or [`can_step_to`] — the movement-gate
/// twin, scored via [`calculate_new_z`] instead of `walkable_z_explain`)
/// would allow/deny a step onto `(x, y)` from `current_z` — the exact same
/// checks, decomposed for `[pathdbg]` diagnostics. [`tile_walkable`] is now a
/// thin wrapper over `explain_tile_walkable` (`.is_ok()`), and [`step_ok`]/
/// [`can_walk`] are now a thin wrapper over `can_step_to` the same way, so
/// none of the four can ever disagree about what this enum names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepDeny {
    OffMap,
    Terrain(ZReason),
    DynamicItem {
        graphic: u16,
        item_z: i32,
    },
    /// [`can_step_to`]'s equivalent of "nothing to land on at all":
    /// [`calculate_new_z`] returned `None` — no candidate surface/bridge
    /// within the StepHeight climb limit, or the nearest one lacked
    /// headroom. Unlike [`StepDeny::Terrain`] (`explain_tile_walkable`'s
    /// `walkable_z_explain` scorer, which tells NoSurface/OutOfReach/Blocked
    /// apart), `calculate_new_z`'s single `None` doesn't discriminate those
    /// cases — this is deliberately its own flat variant rather than reusing
    /// (and thereby misreporting) a [`ZReason`] that implies detail
    /// `can_step_to` doesn't actually have.
    NoLanding,
}

/// Ground items and placed multis, bucketed once instead of rescanned per tile.
///
/// [`dynamic_statics_at`] and [`multi_components_at`] each walked **all** of
/// `World::items` for every tile asked about. `build_scene` asks about 2,232
/// tiles per frame, so even with only ~200 items in view that was ~30ms of a
/// ~48ms scene build — against ~2ms of actual terrain math — and it blocked
/// the game loop (movement pacing + net pump) exactly as the `Value`
/// round-trip used to. Building this once makes both a hash lookup.
///
/// Cheap enough that the one-shot entry points ([`tile_walkable`] and friends)
/// just build one per call: that is the same single pass they already paid for.
pub struct TileScan<'a> {
    world: &'a World,
    ground: std::collections::HashMap<(i64, i64), Vec<StaticTile>>,
    multis: Vec<(u32, &'a Item)>,
}

impl<'a> TileScan<'a> {
    pub fn build(world: &'a World, map: &MapData) -> Self {
        let mut ground: std::collections::HashMap<(i64, i64), Vec<StaticTile>> =
            std::collections::HashMap::new();
        let mut multis = Vec::new();
        for (serial, it) in world.items.iter() {
            if it.is_multi {
                multis.push((*serial, it));
            } else if it.container.is_none() {
                // `height`/`flags` are resolved here rather than per lookup —
                // the same tiledata reads `dynamic_statics_at` did, just once
                // per item instead of once per (item, tile) pair.
                ground
                    .entry((it.pos.x as i64, it.pos.y as i64))
                    .or_default()
                    .push(StaticTile {
                        graphic: it.graphic,
                        z: it.pos.z,
                        height: map.item_height(it.graphic),
                        flags: map.item_flags(it.graphic),
                        hue: 0,
                    });
            }
        }
        Self {
            world,
            ground,
            multis,
        }
    }

    /// Just the multi list — no ground buckets, so no tiledata and no map.
    /// [`multi_components_at`] needs nothing else.
    pub fn multis_only(world: &'a World) -> Self {
        Self {
            world,
            ground: std::collections::HashMap::new(),
            multis: world
                .items
                .iter()
                .filter(|(_, it)| it.is_multi)
                .map(|(serial, it)| (*serial, it))
                .collect(),
        }
    }

    pub fn world(&self) -> &'a World {
        self.world
    }

    /// Dynamic (non-multi, uncontained) items standing on `(x, y)`.
    pub fn ground_at(&self, x: i64, y: i64) -> &[StaticTile] {
        self.ground.get(&(x, y)).map_or(&[][..], |v| &v[..])
    }

    /// Every placed multi, as `(serial, item)`. Usually a handful; the point is
    /// not to walk the whole item table to find them.
    pub fn multis(&self) -> &[(u32, &'a Item)] {
        &self.multis
    }
}

/// Every multi component (boat hull/deck, house wall/floor — never the
/// multi's own `World::items` entry, which carries a multi id in `graphic`,
/// not an ART graphic) sitting at world tile `(x, y)`, as `(graphic,
/// absolute_z)` pairs. The ONE shared fold every multi-aware walkability check
/// (blocking, standing-surface contribution, step-Z resolution) builds on, so
/// they can never disagree about which components are even in play on a tile.
/// Resolved through each in-view multi's own tile-indexed component list
/// ([`Multis::components_at`]) instead of a direct `World::items` hit — a
/// component isn't its own `World::items` entry. Cheap even per A* node:
/// `World::items` only ever holds the handful of multis actually in view
/// (pruned by 0x1D like any item), and `components_at` is O(components on
/// this ONE tile) after the first call per multi id.
///
/// Folds on [`MultiComponent::server_keeps`], NOT on `visible`: the two are
/// different questions and a UOP `flags` of `0x101` answers them opposite ways
/// — ClassicUO won't draw such a component, ServUO maps it to
/// `TileFlag.Generic` and keeps it in the collision grid (see
/// `anima_assets::multis`' module doc for the full flag table). Predicting
/// walkability off `visible` made the client walk through tiles the server
/// blocks, which is the rubber-band direction.
///
/// Index-0 is force-included regardless (`MultiComponent::is_origin`), because
/// ServUO's grid does the same whatever that record's flags say
/// (`Server/MultiData.cs` `MultiComponentList`, every constructor:
/// `if (i == 0 || allTiles[i].m_Flags != 0)`).
///
/// This is the WALKABILITY rule only. Rendering (the tile loop in
/// [`emit_tiles`]) draws visible components as sprites; an invisible index-0
/// is drawn as the parent Item's sprite when `graphic > 2` (ClassicUO
/// `Item.MultiGraphic` / `AllowedToDraw`); other invisible-but-authoritative
/// components are never-drawn pathing records.
///
/// (Both fold through [`TileScan`] rather than rescanning the item table.)
pub fn multi_components_at_scanned(
    scan: &TileScan,
    multis: &Multis,
    x: i64,
    y: i64,
) -> Vec<(u16, i32)> {
    let world = scan.world();
    let mut out = Vec::new();
    for (serial, it) in scan.multis().iter().map(|(s, it)| (s, *it)) {
        let (dx, dy) = (x - it.pos.x as i64, y - it.pos.y as i64);
        if dx < i16::MIN as i64
            || dx > i16::MAX as i64
            || dy < i16::MIN as i64
            || dy > i16::MAX as i64
        {
            continue; // absurdly far from this multi's origin — never one of its tiles
        }
        // A decoded custom-house design (0xD8) REPLACES the foundation's
        // multi.mul components entirely for THIS multi — it's the
        // authoritative piece list once ready (ServUO's own server-side
        // collision is the design, not the stock foundation shape), so once
        // `tiles_ready` this is the ONLY source, never a fallback/merge. Keyed
        // i8 (house footprints are tiny — 18x18 max), so a dx/dy outside i8
        // range is never a design tile either way. This is the WALKABILITY
        // fold — see `ensure_house_tiles`'s and this fn's own doc; the
        // rendering loop in `build_scene` performs the identical swap.
        if let Some(d) = world.house_designs.get(serial).filter(|d| d.tiles_ready) {
            if dx >= i8::MIN as i64
                && dx <= i8::MAX as i64
                && dy >= i8::MIN as i64
                && dy <= i8::MAX as i64
            {
                if let Some(tiles) = d.tiles.get(&(dx as i8, dy as i8)) {
                    for &(g, dz) in tiles {
                        out.push((g, it.pos.z as i32 + dz as i32));
                    }
                }
            }
            continue;
        }
        for c in multis.components_at(it.graphic as u32, dx as i16, dy as i16) {
            if c.server_keeps || c.is_origin {
                out.push((c.graphic, it.pos.z as i32 + c.dz as i32));
            }
        }
    }
    out
}

/// [`multi_components_at`]'s tuples, reshaped into synthetic [`StaticTile`]s
/// so they can be folded straight into [`MapData::walkable_z_explain`]'s own
/// candidate scoring ([`crate::scene`]'s only consumer of `extra`) — a boat
/// deck then contributes a standing surface, and a hull wall genuinely
/// blocks, using the EXACT SAME impassable/surface/bridge rules a real static
/// gets (`StaticTile::impassable`/`::surface`), not a parallel ad hoc check.
pub fn multi_statics_at(
    scan: &TileScan,
    multis: &Multis,
    map: &MapData,
    x: i64,
    y: i64,
) -> Vec<StaticTile> {
    multi_components_at_scanned(scan, multis, x, y)
        .into_iter()
        .map(|(graphic, z)| StaticTile {
            graphic,
            z: z.clamp(i8::MIN as i32, i8::MAX as i32) as i8,
            height: map.item_height(graphic),
            flags: map.item_flags(graphic),
            hue: 0,
        })
        .collect()
}

/// `multi_statics_at`'s counterpart for **ordinary dynamic items**: on this
/// shard a boat's deck arrives as perfectly ordinary [`World::items`]
/// entries, not as a multi at all — live-verified graphics
/// 0x3EA1/0x3EAC/0x3EB0 sitting at `z=-5` with tiledata `height` 3 and
/// `SURFACE` (not `Impassable`), giving a standing Z of `-5 + 3 = -2`, with
/// the hull/mast (0x3E9F/0x3EB1) as plain `Impassable` items right alongside,
/// and the gangplank (0x3EC0/0x3ED4) as `SURFACE|BRIDGE`. Before this existed,
/// `explain_tile_walkable`'s scoring only ever folded in **multi** components
/// (via [`multi_statics_at`]) — an ordinary item was only ever consulted as a
/// *blocker* (`MapData::item_blocks`), never as a surface contributor — so a
/// deck shaped like this was entirely invisible to `walkable_z_explain`, and
/// every step onto it read as unwalkable with `sz` falling back to the water
/// underneath. ClassicUO's own `Pathfinder.CreateItemList` has an explicit
/// `case Item item2:` arm alongside Land/Static/Multi for exactly this
/// reason.
///
/// Same shape as [`multi_statics_at`] — every matching item, unfiltered (a
/// hull piece becomes a synthetic `StaticTile` here too, same as a real
/// static would) — so a single call collects everything
/// [`explain_tile_walkable`] needs from `World::items`: it derives BOTH the
/// standing-surface fold AND the blocker check from this ONE scan instead of
/// two (see that function's doc for why the surface fold still has to filter
/// what it takes from here). Excludes multis (`is_multi` — `multi_statics_at`'s
/// job) and contained items (inventory, not standing on the tile). `z` is
/// copied straight from `Item::pos.z`, which is already the wire's `i8` —
/// unlike a multi component's synthesized `(origin_z + dz)` sum, there's no
/// offset arithmetic here that could overflow, so no clamp is needed.
pub fn dynamic_statics_at_scanned<'s>(scan: &'s TileScan, x: i64, y: i64) -> &'s [StaticTile] {
    scan.ground_at(x, y)
}

/// Does a **multi component** block a body at `current_z` stepping onto `(x,
/// y)`? A real interactive door is never baked into a multi's component list
/// (ServUO places it as its own separate door `Item`, e.g.
/// `BaseHouse.AddSouthDoor`), so no door exception is needed here — that
/// already flows through the ordinary dynamic-item path above.
pub fn multi_blocker_at(
    scan: &TileScan,
    multis: &Multis,
    map: &mut MapData,
    x: i64,
    y: i64,
    current_z: i32,
    ghost: bool,
) -> Option<(u16, i32)> {
    multi_components_at_scanned(scan, multis, x, y)
        .into_iter()
        .find(|&(graphic, comp_z)| {
            map.item_blocks(graphic, comp_z, current_z) && !(ghost && map.item_is_door(graphic))
        })
}

/// The **blocker** half of [`explain_tile_walkable`]: does an impassable
/// dynamic item (crate, closed door — ghost exception applies) or multi
/// component (hull/house wall) deny a body from occupying `(x, y)` while
/// standing at `current_z`? Split out so [`build_scene`]'s per-tile `w` flag
/// can reuse these EXACT rules (never re-derive/duplicate them) while pairing
/// them with the authoritative `sz_chain` answer instead of
/// [`MapData::walkable_z_explain`]'s simpler scorer.
///
/// Why that pairing is needed — a real bug, diagnosed live: standing on a
/// house foundation's stairs, a body sits on a **bridge** (`0x0751`, height
/// 5, z 0 — a bridge's stand Z is `z + height/2`, giving stand z=2). The next
/// tile north carries an **impassable** riser (`0x0063`, z 0..5, the
/// foundation's edge) topped by the empty plot's own **surface**
/// (`0x31F4`, z 7). Stepping there is a +5 climb — exactly what a bridge is
/// for — and [`calculate_new_z`] (ClassicUO's `Pathfinder.CalculateNewZ`,
/// which its `CanWalk` uses directly) resolves it correctly to `sz=7`. But
/// `tile_walkable`, checked at the OLD `w=0`: `walkable_z_explain`'s scorer
/// doesn't model the bridge-widened max Z, AND (verified directly against
/// this exact riser/floor pair) THIS fn's own blocker rules deny it too —
/// `item_blocks`'s span test (`item_z < current_z + CHAR_HEIGHT`) genuinely
/// overlaps the riser's `0..5` span against a body still down at `current_z=2`
/// (the pre-step Z `tile_walkable` always checks against, matching ClassicUO
/// `CanWalk`/our own [`step_ok`]) — even though that exact riser is well clear
/// of a body actually AT the resolved z=7. So the fix is two-part: `sz_chain`
/// already carries the authoritative (`calculate_new_z`-derived) landing Z;
/// [`build_scene`] passes THAT resolved Z as `current_z` here instead of the
/// player's pre-step `pz` — asking "does this blocker overlap the body once
/// the step actually lands" instead of "…while it's still down where it
/// started" — which is what turns this exact case walkable without weakening
/// a single blocker rule (a closed door, judged at its OWN — usually
/// unchanged — tile, still denies; see the tests). `dyn_items` is passed in
/// rather than re-fetched so a caller that already ran
/// [`dynamic_statics_at`] (as [`explain_tile_walkable`] does, for its surface
/// fold) never scans `World::items` twice for the same tile.
#[allow(clippy::too_many_arguments)] // tile coords + the caller's pre-fetched fold
pub fn blocking_item_at_scanned(
    scan: &TileScan,
    map: &mut MapData,
    multis: Option<&Multis>,
    x: i64,
    y: i64,
    current_z: i32,
    dyn_items: &[StaticTile],
    ghost: bool,
) -> Option<StepDeny> {
    if let Some(it) = dyn_items.iter().find(|st| {
        map.item_blocks(st.graphic, st.z as i32, current_z)
            && !(ghost && map.item_is_door(st.graphic))
    }) {
        return Some(StepDeny::DynamicItem {
            graphic: it.graphic,
            item_z: it.z as i32,
        });
    }
    if let Some(multis) = multis {
        if let Some((graphic, item_z)) = multi_blocker_at(scan, multis, map, x, y, current_z, ghost)
        {
            return Some(StepDeny::DynamicItem { graphic, item_z });
        }
    }
    None
}

/// Is tile (x, y) walkable for a body at `current_z`, and if so what Z would it
/// stand at? Combines the static map (land + statics, via
/// [`MapData::walkable_z_explain`]) — widened, when `multis` is given, with
/// any **in-view multi component** (boat deck/hull, house floor/wall) folded
/// in via [`multi_statics_at`] so a component can CONTRIBUTE a standing
/// surface (a boat deck) exactly like a real static, not just block one —
/// and widened again with any **ordinary dynamic item** that is itself a
/// genuine surface (see [`dynamic_statics_at`] — the real shape of a boat
/// deck on this shard) — with **dynamic world items** on top — an impassable
/// placed object (e.g. a crate) blocks too — and then, same as
/// [`can_walk`]/[`step_ok`]'s own two-layer shape, a final
/// [`multi_blocker_at`] pass for a multi component occupying this exact body
/// span.
///
/// The surface fold and the blocker check both come from ONE call to
/// [`dynamic_statics_at`] (a single `World::items` scan) instead of two
/// separate passes — this runs per tile of the ~49×49 scene window on every
/// build, so a second full scan here is real, measurable cost. Only a
/// synthetic tile that is a genuine surface/bridge and NOT impassable is
/// folded into the scoring `extra`: `walkable_z_explain`'s own
/// candidate-blocking loop tests every `extra` entry, impassable ones
/// included, so folding in an impassable item too (a closed door, a crate)
/// would let it silently reclassify an otherwise-fine land candidate as
/// `ZReason::Blocked` — stealing the denial from the dedicated
/// `StepDeny::DynamicItem` path below (with its ghost/door exception), which
/// already denies it correctly and which click-to-walk planning depends on
/// to tell "wall" from "door" apart. The blocker check itself still walks
/// every item [`dynamic_statics_at`] returned (unfiltered), so an impassable
/// item denies exactly as before.
pub fn explain_tile_walkable_scanned(
    scan: &TileScan,
    map: &mut MapData,
    multis: Option<&Multis>,
    x: i64,
    y: i64,
    current_z: i32,
) -> Result<i32, StepDeny> {
    let world = scan.world();
    if x < 0 || y < 0 {
        return Err(StepDeny::OffMap);
    }
    let ghost = player_is_ghost(world);
    let dyn_items = dynamic_statics_at_scanned(scan, x, y);
    let mut extra = multis
        .map(|m| multi_statics_at(scan, m, map, x, y))
        .unwrap_or_default();
    extra.extend(
        dyn_items
            .iter()
            .filter(|st| st.surface() && !st.impassable())
            .copied(),
    );
    let z = map
        .walkable_z_explain(x as u32, y as u32, current_z, &extra)
        .map_err(StepDeny::Terrain)?;
    if let Some(deny) =
        blocking_item_at_scanned(scan, map, multis, x, y, current_z, dyn_items, ghost)
    {
        return Err(deny);
    }
    Ok(z)
}

/// Is tile (x, y) walkable for a body at `current_z`? Combines the static map
/// (land + statics, via [`MapData::walkable_z`]) with **dynamic world items** —
/// an impassable placed object (e.g. a crate) blocks too. Both the renderer's
/// `w` flag and the play-server's pacing use this so we never try to step into
/// an impassable object (it would just DenyWalk → snap back). Thin wrapper over
/// [`explain_tile_walkable`] so the two can never drift apart.
pub fn tile_walkable(
    world: &World,
    map: &mut MapData,
    multis: Option<&Multis>,
    x: i64,
    y: i64,
    current_z: i32,
) -> bool {
    let scan = TileScan::build(world, map);
    explain_tile_walkable_scanned(&scan, map, multis, x, y, current_z).is_ok()
}

/// Is tile (x, y) walkable for **click-to-walk route planning**, at
/// `current_z`? Like [`explain_tile_walkable`], except a closed door never
/// blocks: a closed door isn't a wall, it's a wall we're allowed to open, and
/// ClassicUO's own pathfinder treats it the same way (`Pathfinder.CanWalk`'s
/// `SmoothDoors`-style `dropFlags` for door items, plus its
/// `PlayerMobile.TryOpenDoors` auto-open-as-you-approach convenience). The
/// A* terrain adapter (`play_server::MapTerrain`) uses this so a route can be
/// planned *through* a closed door; the executor then really opens it (see
/// `play_server`'s auto-walk loop) before stepping onto its tile — so what
/// gets planned and what gets walked never disagree about the real world.
/// Manual walking (`can_walk`/`step_ok`, via [`can_step_to`]) and the debug
/// minimap overlay (`tile_walkable`, beyond `build_scene`'s `CHAIN_RADIUS`)
/// both keep this same strict door semantics: a closed door genuinely blocks
/// a single committed step until something has actually opened it. (Only the
/// SURFACE half of that strictness now differs between the two — `can_walk`/
/// `step_ok` score it via `calculate_new_z`, `tile_walkable` via
/// `walkable_z_explain` — see [`can_step_to`]'s doc for why.)
pub fn tile_walkable_for_planning(
    world: &World,
    map: &mut MapData,
    multis: Option<&Multis>,
    x: i64,
    y: i64,
    current_z: i32,
) -> Option<i32> {
    let scan = TileScan::build(world, map);
    explain_tile_walkable_for_planning_scanned(&scan, map, multis, x, y, current_z).0
}

/// [`tile_walkable_for_planning`]'s full answer: the resolved standing Z, PLUS
/// — when the tile is walkable-for-planning only BECAUSE every impassable
/// dynamic item on it is an openable closed door — that door's serial. Split
/// out the same way [`explain_tile_walkable`]/[`tile_walkable`] already are,
/// so a caller that needs to actually ACT on the door (not just know the tile
/// is plannable) — [`build_scene`]'s `dr` field, which names it for the
/// browser to auto-open before a manual step, mirroring ClassicUO's
/// `PlayerMobile.TryOpenDoors` — gets the serial from this EXACT "every
/// blocker is a door" walk instead of a second, possibly-diverging copy of
/// it. A `Some` serial only ever comes back alongside a `Some` Z; a tile
/// that's walkable outright (no door involved, e.g. an already-open doorway)
/// reports a Z with no serial.
pub fn explain_tile_walkable_for_planning_scanned(
    scan: &TileScan,
    map: &mut MapData,
    multis: Option<&Multis>,
    x: i64,
    y: i64,
    current_z: i32,
) -> (Option<i32>, Option<u32>) {
    let world = scan.world();
    match explain_tile_walkable_scanned(scan, map, multis, x, y, current_z) {
        Ok(z) => (Some(z), None),
        Err(StepDeny::DynamicItem { .. }) => {
            // `explain_tile_walkable`'s `.find()` only reports the FIRST
            // blocking dynamic item it happens to hit (`World::items` is a
            // `HashMap` — iteration order isn't the same as "the" blocker).
            // A door on the tile only makes it plannable-through if EVERY
            // impassable dynamic item there is a door — a crate someone
            // dropped in the same doorway must still deny, in either
            // find-order (see the FIX 4 regression test). Multi components are
            // never doors themselves (see `multi_blocker_at`'s doc), so any
            // multi blocker on this tile always fails the "every blocker is a
            // door" test — a wall/hull never becomes plannable-through.
            let ghost = player_is_ghost(world);
            // Remembered in passing as the `.all()` below walks every item
            // anyway — if every blocker turns out to be a door, this is one
            // of them (any one will do: see this fn's doc and the `dr`
            // field's doc for why a double-leaf doorway doesn't need a
            // specific leaf named).
            let mut a_door = None;
            let all_blockers_are_doors = world.items.values().all(|it| {
                let is_door = map.item_is_door(it.graphic);
                let blocks = !it.is_multi
                    && it.container.is_none()
                    && it.pos.x as i64 == x
                    && it.pos.y as i64 == y
                    && map.item_blocks(it.graphic, it.pos.z as i32, current_z)
                    && !(ghost && is_door);
                if blocks && is_door {
                    a_door = Some(it.serial);
                }
                !blocks || is_door
            }) && multis
                .is_none_or(|m| multi_blocker_at(scan, m, map, x, y, current_z, ghost).is_none());
            if all_blockers_are_doors {
                // Every blocker on this tile is an openable door — recompute
                // without dynamic items (the static base — real statics AND
                // any multi-contributed surface — still applies).
                let extra = multis
                    .map(|m| multi_statics_at(scan, m, map, x, y))
                    .unwrap_or_default();
                let z = map
                    .walkable_z_explain(x as u32, y as u32, current_z, &extra)
                    .ok();
                // Only pair the door with a Z that actually resolved — a
                // `None` Z here (rare: the static base itself denies once the
                // dynamic items are dropped) must report no door either.
                (z, z.and(a_door))
            } else {
                (None, None)
            }
        }
        Err(_) => (None, None),
    }
}

/// Serial of a **closed door** item sitting on (x, y) that's currently
/// blocking a body at `current_z`, if any — used by the click-to-walk
/// executor to know when it should open a door instead of giving up (see
/// [`tile_walkable_for_planning`]'s doc for why this is safe to treat as
/// "walkable, given we act on it"). Multi components are never doors
/// themselves (see [`multi_blocker_at`]'s doc), so this only ever needs to
/// look at `World::items`.
pub fn door_blocking_at(
    world: &World,
    map: &MapData,
    x: i64,
    y: i64,
    current_z: i32,
) -> Option<u32> {
    world
        .items
        .values()
        .find(|it| {
            !it.is_multi
                && it.container.is_none()
                && it.pos.x as i64 == x
                && it.pos.y as i64 == y
                && map.item_is_door(it.graphic)
                && map.item_blocks(it.graphic, it.pos.z as i32, current_z)
        })
        .map(|it| it.serial)
}

/// [`Terrain`] over the live map + dynamic world items, with a blacklist of tiles
/// the server has *denied* (static map says walkable, a building/blocker disagrees)
/// so re-paths route around them. Mirrors `Session::navigate_to`'s `Avoiding`.
/// Shared by `play_server`'s click-to-walk executor and `lib.rs`'s `Route` (the
/// headless `anima-agent`/`anima2` driver) — both plan a route the same way, so
/// this is the ONE place that combines the static map with `World`'s dynamic
/// items for A* planning; see [`tile_walkable_for_planning`]'s doc.
pub struct MapTerrain<'a> {
    pub world: &'a World,
    pub map: &'a mut MapData,
    pub blocked: &'a HashSet<(u32, u32)>,
    pub multis: Option<&'a Multis>,
}

impl Terrain for MapTerrain<'_> {
    fn walkable_step(&mut self, x: u32, y: u32, from_z: i32) -> Option<i32> {
        if self.blocked.contains(&(x, y)) {
            return None;
        }
        // Planning, not a real committed step: a closed door doesn't block a
        // *route* (see `tile_walkable_for_planning`'s doc) — the auto-walk
        // executor opens any door it actually needs to step through.
        tile_walkable_for_planning(
            self.world,
            self.map,
            self.multis,
            x as i64,
            y as i64,
            from_z,
        )
    }

    /// `Terrain::door_at`'s real (dynamic-item-aware) implementation — reuses
    /// [`door_blocking_at`] so this can never drift from `play_server`'s own
    /// door check. Shared by `play_server`'s click-to-walk executor (which
    /// still calls `door_blocking_at` directly, having `world`/`map` in hand
    /// already) and `lib.rs`'s `Route` (via this generic `Terrain` hook,
    /// which is all a headless driver has).
    fn door_at(&mut self, x: u32, y: u32, current_z: i32) -> Option<u32> {
        door_blocking_at(self.world, self.map, x as i64, y as i64, current_z)
    }
}

/// A closed door blocking the next hop gets this many `Use` (open) attempts,
/// one per cadence tick, before we give up and treat its tile like any other
/// wall (blacklist + re-path around it). Bounds the case a real UO player
/// would also fail at — a *locked* door — so that still ends in "boxed in"
/// instead of hammering `Use` on it forever. Shared by `play_server`'s
/// click-to-walk executor and `lib.rs`'s `Route` — both open a door the same
/// way (see [`decide_blocked_step`]).
pub const MAX_DOOR_OPEN_ATTEMPTS: u32 = 3;

/// How long to wait after sending `Use` on a door before resending it, if the
/// door's own state hasn't visibly changed in the meantime — comfortably
/// above a realistic RTT + server processing time, so a slow (but eventually
/// successful) round trip doesn't get its own toggle undone by an impatient
/// resend (see [`BlockedStepAction::AwaitDoor`]'s doc). Well above the 400ms
/// cadence tick both `play_server` and `Route` check this on.
pub const DOOR_USE_COOLDOWN: Duration = Duration::from_millis(1200);

/// What the auto-walk executor should do about a next-hop tile that the
/// *strict* (real-movement) check just denied. Pulled out as a pure function
/// so the door-vs-wall decision is unit-testable without a live map/session.
/// Shared by `play_server`'s click-to-walk loop and `lib.rs`'s `Route`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockedStepAction {
    /// Send `Use` on this door serial instead of walking — it may just be
    /// closed, not locked, and this tick hasn't tried (enough), and either
    /// we've never sent one yet or the previous one has had a full
    /// [`DOOR_USE_COOLDOWN`] to land with no visible effect.
    OpenDoor(u32),
    /// A `Use` for this door was sent recently and hasn't had time to show
    /// an effect yet — do nothing this tick. ServUO's `Use` TOGGLES a door,
    /// so blindly resending every cadence tick (400ms) would close what a
    /// slower-than-usual round trip (RTT > 400ms) had *just* opened.
    AwaitDoor,
    /// Give up on this tile like any other wall: blacklist it so the next
    /// re-path routes around (or "boxed in" if that was the only way).
    Blacklist,
}

/// Per-blocked-tile bookkeeping for the door-open retry loop (see
/// [`decide_blocked_step`]): how many `Use` attempts have been sent so far,
/// when the most recent one was sent, and the door's own graphic at that
/// moment. The graphic is ServUO's usual tell that a door's state actually
/// changed (open/closed swap the item's graphic — a `0x1A`/delta update
/// arrives for it), so comparing it against the door's CURRENT graphic is
/// how the executor knows a sent `Use` already landed instead of guessing
/// off a fixed timer alone.
#[derive(Debug, Clone, Copy)]
pub struct DoorUseAttempt {
    pub count: u32,
    pub sent_at: Instant,
    pub graphic_at_send: u16,
}

/// Decide what to do about a blocked next-hop tile. A closed door gets up to
/// [`MAX_DOOR_OPEN_ATTEMPTS`] `Use` attempts (it might open); anything else —
/// including a door we've already tried enough times (probably locked) — is
/// treated like a wall. Among those attempts, a fresh `Use` is only sent once
/// either the door's state has visibly changed since the last one we sent
/// (`door_state_changed`) or [`DOOR_USE_COOLDOWN`] has elapsed with no such
/// change (`pending_use_sent_at`, `now`) — otherwise we're still waiting on
/// the previous `Use` and must not resend (see [`BlockedStepAction::AwaitDoor`]).
pub fn decide_blocked_step(
    door: Option<u32>,
    attempts_so_far: u32,
    pending_use_sent_at: Option<Instant>,
    door_state_changed: bool,
    now: Instant,
) -> BlockedStepAction {
    match door {
        Some(serial) if attempts_so_far < MAX_DOOR_OPEN_ATTEMPTS => match pending_use_sent_at {
            Some(sent_at)
                if !door_state_changed && now.duration_since(sent_at) < DOOR_USE_COOLDOWN =>
            {
                BlockedStepAction::AwaitDoor
            }
            _ => BlockedStepAction::OpenDoor(serial),
        },
        _ => BlockedStepAction::Blacklist,
    }
}

/// A dead player uses one of ServUO's race-specific ghost bodies. Ghosts walk
/// through doors.
pub fn player_is_ghost(world: &World) -> bool {
    world
        .player_mobile()
        .is_some_and(|m| anima_core::world::is_ghost_body(m.body))
}

/// UO direction (0=N..7=NW) → (dx, dy) tile delta.
pub fn delta(d: u8) -> (i64, i64) {
    match d & 7 {
        0 => (0, -1),
        1 => (1, -1),
        2 => (1, 0),
        3 => (1, 1),
        4 => (0, 1),
        5 => (-1, 1),
        6 => (-1, 0),
        _ => (-1, -1),
    }
}

/// Inverse of [`delta`]: a one-tile (dx, dy) step → its UO direction, or `None` if
/// not a unit step. Used to pick the approach direction for [`calculate_new_z`].
pub fn dir_from_delta(dx: i64, dy: i64) -> Option<u8> {
    match (dx, dy) {
        (0, -1) => Some(0),
        (1, -1) => Some(1),
        (1, 0) => Some(2),
        (1, 1) => Some(3),
        (0, 1) => Some(4),
        (-1, 1) => Some(5),
        (-1, 0) => Some(6),
        (-1, -1) => Some(7),
        _ => None,
    }
}

/// The server's real movement gate: can a body at `(px, py, pz)` step in
/// direction `dir`, and if so what Z would it land at? Faithful to ClassicUO
/// `CanWalk`'s per-tile test — `CanWalk` IS `CalculateNewZ`, there is no
/// separate scoring pass in the client — so, unlike [`explain_tile_walkable`]
/// (which scores via the coarser `MapData::walkable_z_explain`), this
/// resolves the landing Z with the full [`calculate_new_z`] (surfaces,
/// bridges, headroom, the StepHeight climb limit) and then judges
/// [`blocking_item_at`]'s SAME dynamic-item/multi-component blocker rules
/// against THAT resolved landing Z, not the pre-step one — exactly the
/// pairing `build_scene`'s per-tile `w` already uses inside `CHAIN_RADIUS`
/// (see `blocking_item_at`'s doc for the live foundation-stairs bug this
/// fixes: bridge `0x0751` h=5 at z=0 → stand z=2; impassable riser `0x0063`
/// z=0..5; plot surface `0x31F4` at z=7 → landing z=7 — the riser is well
/// clear of a body actually AT z=7, even though it overlaps one still down at
/// z=2). Before this existed, [`step_ok`] re-derived its own blocker check
/// inline, checked at `fz` (the pre-step Z) — the same bug `blocking_item_at`
/// was split out to fix for `build_scene`, just not yet applied to the real
/// movement gate; this is that fix, applied once, for every caller that asks
/// "can this body take this step" (see [`step_ok`]/[`can_walk`], now thin
/// wrappers over this).
pub fn can_step_to(
    world: &World,
    map: &mut MapData,
    multis: Option<&Multis>,
    px: i64,
    py: i64,
    pz: i32,
    dir: u8,
) -> Result<i32, StepDeny> {
    let (dx, dy) = delta(dir);
    let (nx, ny) = (px + dx, py + dy);
    if nx < 0 || ny < 0 {
        return Err(StepDeny::OffMap);
    }
    let z = calculate_new_z(world, map, multis, nx, ny, pz, dir).ok_or(StepDeny::NoLanding)?;
    let ghost = player_is_ghost(world);
    let scan = TileScan::build(world, map);
    let dyn_items = dynamic_statics_at_scanned(&scan, nx, ny);
    match blocking_item_at_scanned(&scan, map, multis, nx, ny, z, dyn_items, ghost) {
        Some(deny) => Err(deny),
        None => Ok(z),
    }
}

/// Can a body at (fx, fy, fz) step in direction `dir`? Thin wrapper over
/// [`can_step_to`] (`.is_ok()`) — see its doc for what changed and why.
pub fn step_ok(
    world: &World,
    map: &mut MapData,
    multis: Option<&Multis>,
    fx: i64,
    fy: i64,
    fz: i32,
    dir: u8,
) -> bool {
    can_step_to(world, map, multis, fx, fy, fz, dir).is_ok()
}

/// ClassicUO `Pathfinder.CanWalk`: resolve a requested step from (x, y, z).
/// Returns the (possibly redirected) direction and destination tile, or `None`
/// if fully blocked. A **diagonal** step (1) forbids corner-cutting — both
/// adjacent cardinal tiles must be free — and (2) if blocked, redirects to the
/// first free adjacent cardinal, so you *slide along a wall* instead of stopping.
/// A blocked **cardinal** step just fails (no redirect), matching ClassicUO.
pub fn can_walk(
    world: &World,
    map: &mut MapData,
    multis: Option<&Multis>,
    x: i64,
    y: i64,
    z: i32,
    dir: u8,
) -> Option<(u8, i64, i64)> {
    let dir = dir & 7;
    let (dx, dy) = delta(dir);
    let (mut nx, mut ny, mut ndir) = (x + dx, y + dy, dir);
    let mut passed = step_ok(world, map, multis, x, y, z, dir);

    if dir % 2 == 1 {
        // Diagonal: no corner-cutting — both flanking cardinals must be open too.
        if passed {
            for off in [1i32, -1] {
                let cd = (dir as i32 + off).rem_euclid(8) as u8;
                if !step_ok(world, map, multis, x, y, z, cd) {
                    passed = false;
                    break;
                }
            }
        }
        // Blocked diagonal → slide: redirect to the first open flanking cardinal.
        if !passed {
            for off in [1i32, -1] {
                let cd = (dir as i32 + off).rem_euclid(8) as u8;
                if step_ok(world, map, multis, x, y, z, cd) {
                    let (cx, cy) = delta(cd);
                    ndir = cd;
                    nx = x + cx;
                    ny = y + cy;
                    passed = true;
                    break;
                }
            }
        }
    }

    if passed {
        Some((ndir, nx, ny))
    } else {
        None
    }
}

// One-shot entry points, in the `&World` shape these had before the index: each
// builds a `TileScan` and hands off, which is the single pass they already paid
// for. Callers asking about many tiles (the scene's tile loop) build one scan
// and call the `_scanned` forms directly.
//
// Only `explain_tile_walkable` survives outside tests — the rest are kept
// because the tests read better calling them, and are marked as such rather
// than left looking like live API.

/// See [`explain_tile_walkable_scanned`].
pub fn explain_tile_walkable(
    world: &World,
    map: &mut MapData,
    multis: Option<&Multis>,
    x: i64,
    y: i64,
    current_z: i32,
) -> Result<i32, StepDeny> {
    let scan = TileScan::build(world, map);
    explain_tile_walkable_scanned(&scan, map, multis, x, y, current_z)
}

/// See [`explain_tile_walkable_for_planning_scanned`].
pub fn explain_tile_walkable_for_planning(
    world: &World,
    map: &mut MapData,
    multis: Option<&Multis>,
    x: i64,
    y: i64,
    current_z: i32,
) -> (Option<i32>, Option<u32>) {
    let scan = TileScan::build(world, map);
    explain_tile_walkable_for_planning_scanned(&scan, map, multis, x, y, current_z)
}

/// See [`blocking_item_at_scanned`].
#[allow(clippy::too_many_arguments)] // mirrors the scanned form
pub fn blocking_item_at(
    world: &World,
    map: &mut MapData,
    multis: Option<&Multis>,
    x: i64,
    y: i64,
    current_z: i32,
    dyn_items: &[StaticTile],
    ghost: bool,
) -> Option<StepDeny> {
    let scan = TileScan::build(world, map);
    blocking_item_at_scanned(&scan, map, multis, x, y, current_z, dyn_items, ghost)
}

/// See [`multi_components_at_scanned`].
pub fn multi_components_at(world: &World, multis: &Multis, x: i64, y: i64) -> Vec<(u16, i32)> {
    multi_components_at_scanned(&TileScan::multis_only(world), multis, x, y)
}

/// See [`dynamic_statics_at_scanned`].
pub fn dynamic_statics_at(world: &World, map: &MapData, x: i64, y: i64) -> Vec<StaticTile> {
    TileScan::build(world, map).ground_at(x, y).to_vec()
}
