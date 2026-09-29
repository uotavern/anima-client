// ----------------------------------------------------------------------------
// Step-Z resolution — a faithful port of ClassicUO `Pathfinder.CalculateNewZ`
// (+ `CalculateMinMaxZ`, `CreateItemList`), mirroring the Rust port at
// crates/anima-net/src/scene.rs ~L789-1098. `tileSZ` above is the SERVER's
// hint: scene.rs chains CalculateNewZ outward from the server's own live
// position, so it's only authoritative near the server's tile and is a stale
// guess by the time our prediction has run a few tiles ahead. Computing it
// HERE, from the client's own predicted Z (`pred.z`, passed in as `currentZ`),
// makes prediction self-consistent — same trick as ClassicUO, whose
// CalculateNewZ origin is `Steps.Back().Z` (its OWN last predicted step), never
// a server-side value.
//
// Unlike the Rust original (which owns the whole facet via `MapData`), the
// client only has the windowed slice of land tiles (`scene.map`) and statics
// (`scene.statics`) the server chose to send this poll, and — deliberately —
// the new per-tile path fields (`t.li`, `s.h`, `s.pf`) only within 10 tiles of
// the player. Every helper below therefore returns `null` (never a guessed
// number) the moment it needs a tile the window doesn't have, and that null
// propagates all the way out of `calculateNewZ` so the caller falls back to
// `tileSZ`. This is a purely additive JS-side concern with no Rust equivalent
// (the server never has to "not know" about its own map); the path-field
// ABSENCE contract (`li` absent = passable, `h`/`pf` absent = 0) is separate
// and faithfully modelled — see `tiledataPathObj`.
// ----------------------------------------------------------------------------

// ClassicUO `PATH_OBJECT_FLAGS` (we only model the NORMAL step state).
const POF_IMPASS = 0x1; // POF_IMPASSABLE_OR_SURFACE
const POF_SURFACE = 0x2;
const POF_BRIDGE = 0x4;
// `Constants.DEFAULT_BLOCK_HEIGHT` — head/body clearance needed to stand.
const BLOCK_HEIGHT = 16;
// 8-direction deltas (`Pathfinder._offsetX/_offsetY`), dir 0=N..7=NW. Same
// convention/order as this file's own `DIR_DELTA`.
const OFF_X = [0, 1, 1, 1, 0, -1, -1, -1];
const OFF_Y = [-1, -1, 0, 1, 1, 1, 0, -1];

// Per-tile index of `scene.statics` (a flat array), keyed "x,y" -> array of
// static entries on that tile. Built ONCE per poll — indexing the flat array
// per calculateNewZ query would be O(statics-in-window) per lookup, and a
// step's Z is resolved every frame it's at the front of the queue until
// `zFixed` latches it. Rebuilt only when `syncWorld` hands us a genuinely new
// `statics` array (every real poll: `scene = await r.json()` mints a fresh
// array each time, so this fires once per poll, never mid-poll).
let staticIndex = new Map();
let staticIndexSrc = null;
function rebuildStaticIndex(statics) {
  if (statics === staticIndexSrc) return;
  staticIndexSrc = statics;
  staticIndex = new Map();
  for (const st of statics || []) {
    const key = st.x + "," + st.y;
    let arr = staticIndex.get(key);
    if (!arr) { arr = []; staticIndex.set(key, arr); }
    arr.push(st);
  }
}
// The statics on world tile (x,y) this poll, or null if there are none indexed.
function staticsAt(x, y) {
  return staticIndex.get(x + "," + y) || null;
}

// Same treatment for `scene.items` (dynamic world items). Most shards' items
// carry no path data at all (loot, decor) and are irrelevant here, but some
// shards — this one included — send a boat deck as ordinary dynamic items
// (graphics 0x3EA1/0x3EAC/0x3EB0, z=-5, tiledata height 3, SURFACE flag) with
// no map statics and no multi backing them. Without indexing `scene.items`
// too, createItemList only ever sees the water tile underneath and the player
// freezes on deck. Built/rebuilt on the same once-per-poll cadence as
// staticIndex, keyed on `scene.items` array identity.
let itemIndex = new Map();
let itemIndexSrc = null;
function rebuildItemIndex(items) {
  if (items === itemIndexSrc) return;
  itemIndexSrc = items;
  itemIndex = new Map();
  for (const it of items || []) {
    const key = it.x + "," + it.y;
    let arr = itemIndex.get(key);
    if (!arr) { arr = []; itemIndex.set(key, arr); }
    arr.push(it);
  }
}
// The dynamic items on world tile (x,y) this poll, or null if there are none indexed.
function itemsAt(x, y) {
  return itemIndex.get(x + "," + y) || null;
}

// Raw tile object from the current scene.map window at (x,y), or null when
// (x,y) falls outside the window (mirrors tileSZ's indexing exactly).
function tileAt(x, y) {
  const m = scene && scene.map;
  if (!m) return null;
  const span = 2 * m.radius + 1;
  const col = x - m.cx + m.radius, row = y - m.cy + m.radius;
  if (col < 0 || col >= span || row < 0 || row >= span) return null;
  return m.tiles[row * span + col] || null;
}

// ClassicUO `Land.Z` at (x,y): -125 for the off-world sentinel (x<0||y<0, same
// as the Rust port), or null when the client's window simply doesn't have
// this tile yet (the JS-only "no data" case described above).
function landZ(x, y) {
  if (x < 0 || y < 0) return -125;
  const t = tileAt(x, y);
  return t ? (t.z | 0) : null;
}

// ClassicUO `Land.ApplyStretch`'s `AverageZ`/`MinZ` from the 4 corners, plus
// whether the tile is sloped (corners differ -> "stretched"). null if any
// corner's tile is outside the window.
function landAvgMin(x, y) {
  const zTop = landZ(x, y);
  const zRight = landZ(x + 1, y);
  const zLeft = landZ(x, y + 1);
  const zBottom = landZ(x + 1, y + 1);
  if (zTop === null || zRight === null || zLeft === null || zBottom === null) return null;
  const avg = Math.abs(zTop - zBottom) <= Math.abs(zLeft - zRight)
    ? (zTop + zBottom) >> 1
    : (zLeft + zRight) >> 1;
  const min = Math.min(zTop, zRight, zLeft, zBottom);
  const stretched = !(zTop === zRight && zRight === zLeft && zLeft === zBottom);
  return { avg, min, stretched };
}

// ClassicUO `Land.CalculateCurrentAverageZ` — the slope Z toward `direction`.
// null if a needed corner is outside the window.
function calcCurrentAverageZ(x, y, direction) {
  const zTop = landZ(x, y);
  const zRight = landZ(x + 1, y);
  const zBottom = landZ(x + 1, y + 1);
  const zLeft = landZ(x, y + 1);
  if (zTop === null || zRight === null || zBottom === null || zLeft === null) return null;
  const gdz = (d) => {
    switch (d & 3) {
      case 1: return zRight;
      case 2: return zBottom;
      case 3: return zLeft;
      default: return zTop;
    }
  };
  const result = gdz(((direction >> 1) + 1) & 3);
  if (direction & 1) return result;
  return (result + gdz(direction >> 1)) >> 1;
}

// Turn a path-flags-bearing object at world Z `z` with tiledata `height` into
// a PathObj the same way ClassicUO's `CreateItemList` treats a real static, or
// `null` if it contributes nothing to standing (`flags == 0` — neither
// impassable nor surface/bridge). `pf` is the wire's pre-extracted 3-bit mask
// (bit0 IMPASSABLE, bit1 SURFACE, bit2 BRIDGE — absent/0 means none of the
// three, i.e. a plain decorative static with no tiledata path flags, which is
// also what a real such static resolves to in the Rust port); it happens to
// share POF_IMPASS/POF_SURFACE/POF_BRIDGE's bit values by design, but these
// are the RAW tiledata booleans (input), not the derived PathObj.flags
// (output) computed below.
function tiledataPathObj(z, height, pf) {
  const impassable = (pf & POF_IMPASS) !== 0;
  const isSurface = (pf & POF_SURFACE) !== 0;
  const isBridge = (pf & POF_BRIDGE) !== 0;
  let flags = 0;
  if (impassable || isSurface) flags = POF_IMPASS;
  if (!impassable) {
    if (isSurface) flags |= POF_SURFACE;
    if (isBridge) flags |= POF_BRIDGE;
  }
  if (flags === 0) return null;
  // Bridges (stairs/ramps) stand at half height; surfaces at full. Truncating
  // (not floor/round) integer division, matching Rust's `i32` `height / 2`.
  const avg = (isBridge ? Math.trunc(height / 2) : height) + z;
  return { flags, z, avgZ: avg, height, landStretched: false };
}

// ClassicUO `Pathfinder.CreateItemList`: land + statics + dynamic items on
// tile (x,y) as PathObjs (mobiles are not modelled; multi components arrive
// inside scene.statics with an `ms` field and are covered by the static loop
// below, same as the Rust port's multi-component pass). Dynamic world items
// need their own pass here: on this shard a boat deck is sent as ordinary
// items (graphics 0x3EA1/0x3EAC/0x3EB0, z=-5, tiledata height 3, SURFACE
// flag) rather than as a static or a multi, so without this loop the deck
// tile would resolve to the water underneath and freeze the player on deck.
// Returns `[]` for the off-world sentinel (x<0||y<0, a valid empty list, like
// Rust's early return), or `null` when (x,y) or a corner it needs is outside
// the client's window — the JS-only "no data" case, which the caller must
// propagate as a bail-to-null rather than silently building a partial list.
function createItemList(x, y) {
  if (x < 0 || y < 0) return [];
  const t = tileAt(x, y);
  if (!t) return null;
  const list = [];
  const g = t.g | 0;
  // Skip the "no-draw" land graphics (void/cave markers), like ClassicUO.
  if ((g < 0x01AE && g !== 2) || (g > 0x01B5 && g !== 0x01DB)) {
    const lam = landAvgMin(x, y);
    if (lam === null) return null;
    const landImpassable = t.li === 1; // absent -> passable
    let flags = POF_IMPASS;
    if (!landImpassable) flags |= POF_SURFACE | POF_BRIDGE;
    list.push({ flags, z: lam.min, avgZ: lam.avg, height: lam.avg - lam.min, landStretched: lam.stretched });
  }
  const statics = staticsAt(x, y);
  if (statics) {
    for (const s of statics) {
      const obj = tiledataPathObj(s.z | 0, s.h | 0, s.pf | 0); // absent h/pf -> 0/0
      if (obj) list.push(obj);
    }
  }
  const items = itemsAt(x, y);
  if (items) {
    for (const it of items) {
      // Same helper the statics loop uses, so impassable/surface/bridge
      // derivation can never drift between the two. Absent h/pf (older
      // server, or ordinary loot/decor with no tiledata path flags) ->
      // tiledataPathObj returns null and the item contributes nothing.
      const obj = tiledataPathObj(it.z, it.h ?? 0, it.pf ?? 0);
      if (obj) list.push(obj);
    }
  }
  return list;
}

// Pure core of calcMinMaxZ (ClassicUO `Pathfinder.CalculateMinMaxZ`'s scoring
// loop): given the tile-behind's already-built PathObj list and (for a
// stretched/sloped land tile) its direction-biased average Z, compute the
// step's [minZ, maxZ] bound.
function boundMinMaxZ(source, currentZ, stretchedAvg) {
  let minZ = -128, maxZ = currentZ;
  for (const obj of source) {
    const avg = obj.avgZ;
    if (avg <= currentZ && obj.landStretched) {
      minZ = Math.max(minZ, stretchedAvg);
      maxZ = Math.max(maxZ, stretchedAvg);
    } else {
      if ((obj.flags & POF_IMPASS) !== 0 && avg <= currentZ && minZ < avg) {
        minZ = avg;
      }
      if ((obj.flags & POF_BRIDGE) !== 0 && currentZ === avg) {
        maxZ = Math.max(maxZ, obj.z + obj.height);
        minZ = Math.min(minZ, obj.z);
      }
    }
  }
  return [minZ, maxZ + 2];
}

// ClassicUO `Pathfinder.CalculateMinMaxZ`: bound the step using the tile we
// came *from* (opposite of `direction`). Returns `[minZ, maxZ]`, or `null`
// when that source tile has no data in the client's window.
function calcMinMaxZ(x, y, currentZ, direction) {
  const back = (direction ^ 4) & 7;
  const sx = x + OFF_X[back], sy = y + OFF_Y[back];
  const source = createItemList(sx, sy);
  if (source === null) return null;
  // Only land can be "stretched" (sloped) — at most one land entry per tile.
  const stretchedAvg = source.some((o) => o.landStretched) ? calcCurrentAverageZ(sx, sy, direction) : 0;
  if (stretchedAvg === null) return null;
  return boundMinMaxZ(source, currentZ, stretchedAvg);
}

// Pure core of calculateNewZ (ClassicUO `Pathfinder.CalculateNewZ`'s
// surface/bridge/headroom scoring loop): given the destination tile's
// already-built (unsorted) PathObj list and the step's [minZ, maxZ] bound
// from boundMinMaxZ, resolve the standing Z. `null` when nothing in the list
// has clearance to stand on (a real DenyWalk situation).
function resolveStandingZ(list, minZ, maxZ, currentZ) {
  if (list.length === 0) return null;
  // Sort by Z then height (PathObject.CompareTo — a NUMERIC comparator; the
  // default Array.sort is lexicographic and would be wrong here), then add
  // the "sky" sentinel.
  const sorted = list.slice().sort((a, b) => (a.z - b.z) || (a.height - b.height));
  sorted.push({ flags: POF_IMPASS, z: 128, avgZ: 128, height: 128, landStretched: false });

  let z = currentZ;
  if (z < minZ) z = minZ;
  let curMinZ = minZ;
  let resultZ = -128;
  let bestDelta = Infinity; // Rust i32::MAX -> Infinity (never a real delta)
  let curZ = -128;

  for (let i = 0; i < sorted.length; i++) {
    if ((sorted[i].flags & POF_IMPASS) === 0) continue;
    const objZ = sorted[i].z;
    // A ceiling object with clearance above the floor below it: find the best
    // surface/bridge under it that we can actually stand on.
    if (objZ - curMinZ >= BLOCK_HEIGHT) {
      for (let j = i - 1; j >= 0; j--) {
        const t = sorted[j];
        if ((t.flags & (POF_SURFACE | POF_BRIDGE)) === 0) continue;
        const tavg = t.avgZ;
        const fits = (tavg <= maxZ && (t.flags & POF_SURFACE) !== 0) ||
          ((t.flags & POF_BRIDGE) !== 0 && t.z <= maxZ);
        if (tavg >= curZ && objZ - tavg >= BLOCK_HEIGHT && fits) {
          const delta = Math.abs(z - tavg);
          if (delta < bestDelta) {
            bestDelta = delta;
            resultZ = tavg;
          }
        }
      }
    }
    const avg = sorted[i].avgZ;
    curMinZ = Math.max(curMinZ, avg);
    curZ = Math.max(curZ, avg);
  }

  return resultZ === -128 ? null : resultZ;
}

// ClassicUO `Pathfinder.CalculateNewZ`: the standing Z when stepping onto
// (x,y) from `currentZ` heading `direction`. `null` when the tile has no
// valid surface to stand on (a real DenyWalk situation) OR the client's
// window is missing path data for (x,y) or the tile behind it — the caller
// (processSteps) must fall back to the server's `tileSZ` hint in either case.
function calculateNewZ(x, y, currentZ, direction) {
  if (x < 0 || y < 0) return null;
  const bounds = calcMinMaxZ(x, y, currentZ, direction);
  if (bounds === null) return null;
  const list = createItemList(x, y);
  if (list === null) return null;
  return resolveStandingZ(list, bounds[0], bounds[1], currentZ);
}

// ---- auto-open doors on a blocked walk (ClassicUO PlayerMobile.TryOpenDoors) ----
// Real UO lets you walk INTO a closed door: it opens instead of just stopping you.
// We have no equivalent, so a closed door (tileWalkable → w=0) reads as a solid
// wall and manual (keyboard) walking could never enter a house through one. This
// asks the server to open it (ClassicUO `GameActions.OpenDoor` / 0x12 type
// 0x58 — the door on the facing tile, no serial), but deliberately does NOT
// predict the step through the still-closed door — canWalk still returns null
// this same frame, so the step stays refused. Only once the server actually
// opens it does the NEXT poll's tile report w=1 and the ordinary walk proceed
// on its own; since the key is usually still held, that reads as "bump the
// door, it opens, you walk through". Throttled per-door so a step refused
// every frame (while the key is held) doesn't spam an `opendoor` packet.
const DOOR_REOPEN_MS = 700;
let lastDoorOpen = { serial: 0, t: 0 };
function tryAutoOpenDoor(x, y) {
  if (!settings.autoOpenDoors) return;
  const serial = tileDoor(x, y);
  if (serial == null) return;
  const now = performance.now();
  if (serial === lastDoorOpen.serial && now - lastDoorOpen.t < DOOR_REOPEN_MS) return;
  lastDoorOpen = { serial, t: now };
  sendInput("opendoor");
}

// ClassicUO Pathfinder.CanWalk: resolve a step from (x,y) facing `dir`. Returns
// {dir,x,y} (possibly redirected) or null if blocked. A diagonal forbids corner-
// cutting (both flanking cardinals must be open) and, if blocked, redirects to the
// first open flanking cardinal — so you slide along a wall. A cardinal just fails.
function canWalk(x, y, dir) {
  let nx = x + DIR_DELTA[dir][0], ny = y + DIR_DELTA[dir][1], ndir = dir;
  let passed = tileWalkable(nx, ny);
  const destX = nx, destY = ny; // tile actually being asked for — the only one eligible to auto-open
  if (dir % 2 === 1) {
    if (passed) {
      for (const off of [1, -1]) {
        const cd = (dir + off + 8) % 8;
        if (!tileWalkable(x + DIR_DELTA[cd][0], y + DIR_DELTA[cd][1])) { passed = false; break; }
      }
    }
    if (!passed) {
      for (const off of [1, -1]) {
        const cd = (dir + off + 8) % 8;
        if (tileWalkable(x + DIR_DELTA[cd][0], y + DIR_DELTA[cd][1])) {
          ndir = cd; nx = x + DIR_DELTA[cd][0]; ny = y + DIR_DELTA[cd][1]; passed = true; break;
        }
      }
    }
  }
  // Still refused after any diagonal redirect attempt → ask the server to open a
  // door here, if that's the only reason (redirected slides don't need it; a
  // flanking cardinal that merely denied corner-cutting is a different tile and
  // is intentionally left alone).
  if (!passed) tryAutoOpenDoor(destX, destY);
  return passed ? { dir: ndir, x: nx, y: ny } : null;
}

// Append predicted steps to the queue while a direction is held (ClassicUO
// PlayerMobile.Walk + CanWalk + Mobile.EnqueueStep). A turn is its own step (same
// tile, new facing); a move is the next tile (diagonals slide along walls).
// Faithful port of ClassicUO PlayerMobile.Walk: called every frame while a key is
// held, but SELF-GATED by `LastStepRequestTime` — it queues at most ONE step per
// walkTime (a turn costs TURN_DELAY=100ms, a move costs the step cadence). So a
// quick tap queues exactly one step (→ one tile, no "한 발자국 더"), a held key
// queues one per cadence, and the move right after a turn fires only 100ms later
// (snappy direction changes). processSteps renders the queue and sends one walk
// per committed step (we are the pacer).
function enqueueSteps(now) {
  if (!pred) return;
  if (!moveIntent) {
    // Released: finish the in-progress front step (it commits → one walk = the tile
    // you were already walking into) and drop any BUFFERED step. ClassicUO-faithful:
    // queued steps complete, no new one starts.
    pred.intentDir = null;
    if (pred.steps.length > 1) pred.steps.length = 1;
    return;
  }
  const req = moveIntent.dir, run = moveIntent.run;
  pred.intentDir = req;
  // Walk gate (ClassicUO PlayerMobile.Walk: LastStepRequestTime > now → return) +
  // queue cap. Exactly one step per walkTime — no look-ahead pre-queue (that queued
  // the next tile early, which then committed after release → "한 발자국 더").
  if (pred.steps.length >= MAX_STEPS) return;
  if (now < (pred.lastStepReq || 0)) return;
  const tail = pred.steps.length ? pred.steps[pred.steps.length - 1] : pred;
  const res = canWalk(tail.x, tail.y, req);
  let walkTime = TURN_DELAY;
  const pushTurn = (d) => { pred.steps.push({ x: tail.x, y: tail.y, z: tail.z, dir: d, run, turn: true }); walkTime = TURN_DELAY; trace(`ENQ turn dir=${d} q=${pred.steps.length}`); };
  const pushMove = (d, nx, ny) => {
    const sz = tileSZ(nx, ny);
    pred.steps.push({ x: nx, y: ny, z: sz !== null ? sz : tail.z, dir: d, run, turn: false });
    walkTime = stepDelay(run, mounted());
    trace(`ENQ move dir=${d} q=${pred.steps.length}`);
  };
  if (tail.dir === req) {
    // Facing the requested dir → move (or, if CanWalk redirected a blocked diagonal,
    // turn to the cardinal first). Fully blocked → stand, but still gate so we don't
    // spin the CanWalk check every frame.
    if (!res) { pred.lastStepReq = now + stepDelay(run, mounted()); return; }
    if (res.dir !== req) pushTurn(res.dir); else pushMove(res.dir, res.x, res.y);
  } else if (res && res.dir === tail.dir) {
    pushMove(res.dir, res.x, res.y);            // redirect equals current facing → move
  } else {
    pushTurn(res ? res.dir : req);              // turn toward the resolved dir (or into a wall)
  }
  // Anchor the gate to the rigid step schedule, not jittery wall-clock. processSteps
  // commits on a fixed grid (`t0 += dur`); if the gate were `now + walkTime` it would
  // creep forward each step (each enqueue fires at `now >= prev gate`, only ever
  // later) until it lagged behind the commit grid — then enqueue is blocked on the
  // very frame the step commits, the queue drains for a frame, and the walk micro-
  // stutters. While movement is continuous (this enqueue is within one cadence of the
  // last) we advance from the PREVIOUS gate so it stays locked to the grid; after an
  // idle/release gap we restart from `now` (so taps and resume behave unchanged).
  const cont = pred.lastStepReq && now < pred.lastStepReq + walkTime;
  pred.lastStepReq = (cont ? pred.lastStepReq : now) + walkTime;
}

// Interpolate the rendered position through the queue front (ClassicUO
// Mobile.ProcessSteps): X/Y advance by the step's time fraction; Z eases toward
// the step's target at its own decoupled catch-up rate (see below); a completed
// step commits to the base and the next begins (carrying the time remainder for
// continuous motion). Turns are consumed instantly (facing only).
// ---- per-state sprite tints --------------------------------------------------
// ClassicUO's `overridedHue` (`Views/MobileView.cs:70-133`): a whole-mobile state
// tint that REPLACES every layer's own dye, body and equipment alike (it is
// passed into each layer's draw and overwrites the hue there, :677/:731). We
// showed none of these — poison, the one that matters, was visible only as a
// colour on a 30px health bar, when in UO a poisoned creature is green from
// across the screen and that is how you pick a cure target mid-fight.
const HUE_HIDDEN = 0x038E;         // grey-blue wash
const HUE_DEAD_CREATURE = 0x0386;
const HUE_POISON = 0x0044;         // Profile.PoisonHue, default on
const HUE_PARALYZED = 0x014C;      // Profile.ParalyzedHue, default on
const HUE_INVULNERABLE = 0x0030;   // Profile.InvulnerableHue, default on
const NOTO_INVULNERABLE = 7;       // NotorietyFlag.Invulnerable

// `dead`/`hidden` come from the caller because it already resolved them.
// Order is ClassicUO's, and the order is load-bearing: hidden and dead are
// `else if` (exclusive), while poison / paralysis / invulnerability are three
// consecutive plain `if`s, so each later one overwrites the earlier.
function mobileStateHue(ent, hidden, dead, body) {
  if (hidden) return HUE_HIDDEN;
  // A dead *creature* greys out; a human ghost keeps its own translucent
  // treatment, which we already do with alpha.
  if (dead) return bodyIsHuman(body | 0) ? 0 : HUE_DEAD_CREATURE;
  if (!ent) return 0;
  // Both the paralysis and the yellow-hits tint carry the same guard in
  // ClassicUO (`NotorietyFlag != Invulnerable`, :126/:135) and poison carries
  // none. An invulnerable mobile is already drawn as invulnerable by its
  // notoriety colour, so re-tinting the whole body would only hide that. This
  // one is a read of ClassicUO rather than an observation: the ServUO build
  // tested against never reports notoriety 7 — a blessed NPC came back
  // Innocent with the yellow-hits flag set, and so did vendors and a town
  // crier — so the guard is unreachable there and only bites on a shard whose
  // vendors are invulnerable.
  const invul = (ent.noto | 0) === NOTO_INVULNERABLE;
  let h = 0;
  if (ent.poisoned) h = HUE_POISON;
  if (ent.para && !invul) h = HUE_PARALYZED;
  if (ent.yellow && !invul) h = HUE_INVULNERABLE;
  return h;
}

// ---- footstep sounds ---------------------------------------------------------
// These are CLIENT-generated: ServUO never sends one (grepping it for 0x12B /
// 0x129 finds only a Huffman table entry), so without this the world is silent
// as you walk, and the main audio confirmation that a movement input was even
// accepted is missing.
//
// Ported from ClassicUO `Mobile.ProcessFootstepsSound`
// (Game/GameObjects/Mobile.cs:520-561), which runs every frame from
// ProcessAnimation for any mobile that is human, not hidden, not dead, not
// flying, and has a step pending — i.e. it is time-throttled, not once-per-tile.
// On foot: 0x012B alternating with 0x012C, every 400 ms. Mounted and running:
// 0x0129/0x012A every 150 ms. Mounted and walking: 0x012B, no alternation, every
// 350 ms. Every delay is then scaled by 13/10 there, giving 520/195/455.
const FOOTSTEP_ON_FOOT = 0x012B, FOOTSTEP_MOUNT_RUN = 0x0129;

// ClassicUO `Mobile.IsHuman` (:146-159) — an explicit graphic list, not an
// anim-type test, so a horse or a dragon is silent while a gargoyle is not.
function bodyIsHuman(b) {
  return (b >= 0x0190 && b <= 0x0193) || (b >= 0x00B7 && b <= 0x00BA)
      || (b >= 0x025D && b <= 0x0260)
      || b === 0x029A || b === 0x029B || b === 0x02B6 || b === 0x02B7
      || b === 0x03DB || b === 0x03DF || b === 0x03E2
      || b === 0x02E8 || b === 0x02E9 || b === 0x04E5;
}

// `st` carries the per-mobile throttle + alternation ClassicUO keeps as
// LastStepSoundTime / StepSoundOffset. `flying` silences the mobile outright —
// that is ClassicUO's `!IsFlying` guard, and it is NOT the same rule as the
// `IsMounted || IsFlying` one that paces a flying gargoyle like a rider.
function footstep(st, now, x, y, run, mounted, body, hidden, dead, flying) {
  if (!settings.sfx || !settings.footsteps || audioMuted) return;
  if (!bodyIsHuman(body | 0) || hidden || dead || flying) return;
  if (now < (st.stepSfxAt || 0)) return;
  let inc = st.stepSfxOfs | 0;
  let id = FOOTSTEP_ON_FOOT;
  let delay = 400;
  if (mounted) {
    if (run) { id = FOOTSTEP_MOUNT_RUN; delay = 150; }
    else { inc = 0; delay = 350; }
  }
  st.stepSfxOfs = (inc + 1) % 2;
  st.stepSfxAt = now + delay * 13 / 10;
  playSfx(id + inc, x | 0, y | 0);
}

function processSteps(now, dt) {
  if (!pred) return;
  let guard = 0;
  while (pred.steps.length && guard++ < MAX_STEPS + 2) {
    const s = pred.steps[0];
    if (!pred.t0) pred.t0 = now;
    // The single pacer: a move interpolates over its UO cadence; a turn HOLDS for
    // TURN_DELAY (facing change, no position move) — this is the turn-then-move
    // timing. (Enqueue no longer paces; it just keeps the buffer full.)
    const dur = s.turn ? TURN_DELAY : stepDelay(s.run, mounted());
    const prog = Math.min(1, (now - pred.t0) / dur);
    if (s.turn) {
      pred.dir = s.dir; pred.rx = pred.x; pred.ry = pred.y; pred.rz = pred.z; pred.moving = true;
    } else {
      // INVARIANT: a step's Z target is resolved EXACTLY ONCE — the frame it
      // reaches the FRONT of the queue — and is immutable for the rest of its
      // glide. This is ClassicUO's `Mobile.Step.Z` contract (a step's Z is set
      // at enqueue and only ever read afterwards; it has no re-read anywhere).
      //
      // We latch at the front rather than at enqueue because `sz` is not a
      // property of a tile: scene.rs chains CalculateNewZ outward from the
      // SERVER's live position, so a tile's `sz` is only authoritative within
      // CHAIN_RADIUS (6) of it and degrades to a cheap hint past that. At
      // enqueue the destination can be up to MAX_STEPS(5)+lead past the server —
      // outside the chain, the stale guess the chain was built to replace. At
      // the front it is base+1 (~2-3 tiles from the server), deep inside the
      // chain: the best read we will ever get, taken at the one moment applying
      // it is free (the ease has not started).
      //
      // Re-reading EVERY frame (what this used to do) is what made the avatar
      // dip and recover mid-step: a poll lands, the chain origin has moved, the
      // destination resolves ±1 different, and because `ze` saturates at
      // ZEASE_FRAC the delta lands in FULL on the next frame.
      //
      // Which source to latch from: `tileSZ` reads the SERVER's precomputed
      // `sz`, chained from the server's OWN live position — a different origin
      // than ours once we've predicted a few tiles ahead. Prefer our own
      // calculateNewZ instead, chained from `pred.z` (the client's own
      // predicted Z), so the step we're mid-predicting is resolved from the
      // same walk that predicted it — self-consistent, exactly like
      // ClassicUO's CalculateNewZ, whose origin is `Steps.Back().Z` (its own
      // last predicted step), never a server-side value. Falls back to the
      // server hint when we can't compute it ourselves (tile outside the
      // window, path-fields not yet present, or genuinely nothing to stand
      // on) — see calculateNewZ's doc.
      if (!s.zFixed) {
        const own = calculateNewZ(s.x, s.y, pred.z, s.dir);
        const z = own !== null ? own : tileSZ(s.x, s.y);
        if (z !== null) s.z = z;
        s.zFixed = true;
      }
      pred.rx = pred.x + (s.x - pred.x) * prog;
      pred.ry = pred.y + (s.y - pred.y) * prog;
      // Z eases from the SOURCE tile's Z (`pred.z`, still the pre-step tile until
      // this step commits) to the step's target `s.z`, but FASTER than x/y — it
      // fully resolves within the first `ZEASE_FRAC` of the step (ClassicUO's
      // `Offset.Z = (destZ-srcZ) * x * 4/frames`: Z is done in the first ~4
      // frames, well before the tile boundary). An ease-out shapes it so the
      // vertical speed doesn't lurch at the start. This is FRAME-RATE INDEPENDENT
      // (locked to `prog`, not accumulated per `dt`) and, crucially, reaches the
      // target BEFORE the step commits — so nothing trails into the next step:
      // the old exponential chase left ~8% unresolved every step, which on a
      // real staircase (+5 risers) read as the avatar floating ~2-3px below the
      // steps while climbing, then a snap-up at the top step's commit followed by
      // the descent — the "climbs, jerks up, then comes down" bounce.
      const zt = Math.min(1, prog / ZEASE_FRAC);
      const ze = 1 - (1 - zt) * (1 - zt); // ease-out quad
      pred.rz = pred.z + (s.z - pred.z) * ze;
      pred.dir = s.dir; pred.moving = true;
    }
    if (prog >= 1) {                       // step complete → commit base, carry remainder
      // Commit the base; rz is already at s.z (the mid-step ease resolves Z within
      // the first ZEASE_FRAC of the step), so setting it here is just a belt-and-
      // braces exactness — no residual to snap, which is what removes the
      // staircase bounce.
      if (!s.turn) { pred.x = s.x; pred.y = s.y; pred.z = s.z; pred.rz = s.z; }
      pred.dir = s.dir;
      // ClassicUO model: WE are the pacer. Each committed step (the prediction
      // paced it at the UO cadence) is sent to the server as ONE walk — so the
      // server does exactly the steps we did. A tap commits one step → one walk →
      // one server tile (no overshoot); release stops committing → server stops.
      sendInput(`walk:${s.dir}:${s.run ? 1 : 0}`);
      // A turn in place covers no ground, so it makes no sound.
      if (!s.turn) {
        const me = anim.get("self");
        const pl = scene && scene.player;
        if (me && pl) {
          footstep(me, now, s.x, s.y, !!s.run, !!pl.mounted, pl.body,
                   !!pl.hidden, !!pl.dead, !!pl.fly);
        }
      }
      lastWalkSentAt = now;
      trace(`CMT ${s.turn ? "turn" : "move"} dir=${s.dir} -> walk`);
      pred.steps.shift();
      pred.t0 += dur;
      continue;
    }
    return;
  }
  // Queue empty → *ease* the render onto the base tile rather than snapping. At a
  // stop the server may settle ~1 tile from where we predicted (intent-based pacing
  // can't align the stop boundary exactly); easing that in over ~120ms reads as a
  // gentle final step instead of a teleport. Genuine desyncs/teleports are snapped
  // hard in reconcile (which also sets rx/ry), so this only smooths small offsets.
  pred.t0 = 0;
  const k = 0.25; // ~ease over ~6 frames (~100ms at 60fps)
  pred.rx += (pred.x - pred.rx) * k;
  pred.ry += (pred.y - pred.ry) * k;
  pred.rz += (pred.z - pred.rz) * k;
  const settled = Math.abs(pred.x - pred.rx) < 0.04 && Math.abs(pred.y - pred.ry) < 0.04;
  if (settled) { pred.rx = pred.x; pred.ry = pred.y; pred.rz = pred.z; }
  pred.moving = !settled; // keep the walk cycle while easing the last bit
}

function applyBoatSpriteGlides(now) {
  const move = (sp) => {
    if (sp._boatSerial == null) return;
    const base = { x: sp._boatBaseX, y: sp._boatBaseY, z: sp._boatBaseZ };
    const visual = boatVisual(sp._boatSerial, base, now);
    const dx = isoX(visual.x, visual.y) - isoX(base.x, base.y);
    const dy = isoY(visual.x, visual.y, visual.z) - isoY(base.x, base.y, base.z);
    sp.x = sp._boatBaseSpriteX + dx;
    sp.y = sp._boatBaseSpriteY + dy;
    sp.zIndex = depthZ(
      visual.x,
      visual.y,
      visual.z + (sp._boatPzOffset || 0),
      sp._boatDepthBias || 4,
    );
    if (visual.active) markDirty();
  };
  for (const sp of staticPool.values()) move(sp);
  for (const entry of itemPool.values()) move(entry.sp);
}

// Graphic of the virtual mount ServUO equips on whoever takes the helm
// (`BoatMountItem`, worn on the Mount layer). It is how the client can tell
// "piloting a ship" from "riding a horse" — both report `mounted`.
const BOAT_MOUNT_GRAPHIC = 0x3E96;
function pilotingBoat() {
  const p = scene && scene.player;
  if (!p || !p.mounted || !p.equip) return false;
  return p.equip.some((e) => (e.layer | 0) === 0x19 && (e.g & 0xFFFF) === BOAT_MOUNT_GRAPHIC);
}
// Steer from the same held-key/mouse intent that would otherwise walk.
//
// The ship keeps sailing on its own until told otherwise — one packet starts it
// and one stops it — so this sends only on a CHANGE, unlike the walk path which
// commits a packet per step. Re-sending every frame would flood the server and,
// worse, `OnMousePilotCommand` restarts the move each time, which stutters the
// ship instead of speeding it up.
let boatCmd = null;   // last (dir,run) sent, or null when stopped
function steerBoat() {
  const want = moveIntent ? { dir: moveIntent.dir & 7, run: !!moveIntent.run } : null;
  const same = (a, b) => (!a && !b) || (a && b && a.dir === b.dir && a.run === b.run);
  if (same(want, boatCmd)) return;
  boatCmd = want;
  if (want) sendInput(`boat:${want.dir}:${want.run ? 1 : 0}`);
  else sendInput("boatstop");
}

function renderFrame(dt) {
  if (!scene) return;
  const now = performance.now();
  moveIntent = activeMove();   // mouse (RMB) or held keys → drives prediction
  // Safety net: a teleport/recall/GM move while seated (activeMove() only stands us
  // up on a fresh movement *intent*, not on the real position jumping under us) —
  // don't leave the avatar looking stuck on a now-distant chair.
  if (sitting && pred && cheby(Math.round(pred.x) - sitting.x, Math.round(pred.y) - sitting.y) > 1) standUp();
  // Player: append predicted steps while a key is held, then interpolate the queue.
  const me = anim.get("self");
  if (me && pred) {
    // At the helm the SHIP moves, not the avatar, so the walk predictor is
    // simply the wrong machine — ClassicUO branches the same way, before its
    // own `Player.Walk`. `steerBoat` turns the identical direction intent into
    // 0xBF/0x33 instead, and `boatVisual` below already carries us with the
    // ship's 0xF6 steps.
    if (pilotingBoat()) steerBoat();
    else { enqueueSteps(now); processSteps(now, dt); }
    let carriedByBoat = false;
    if (scene.player) {
      const boatPos = boatVisual(
        scene.player.serial,
        { x: pred.rx, y: pred.ry, z: pred.rz ?? pred.z },
        now,
      );
      if (boatPos.active) {
        pred.rx = boatPos.x; pred.ry = boatPos.y; pred.rz = boatPos.z; pred.moving = true;
        carriedByBoat = true;
        markDirty();
      }
    }
    me.rx = pred.rx; me.ry = pred.ry; me.rz = pred.rz; me.z = pred.z; me.dir = pred.dir;
    // Boat offsets carry a standing passenger without playing a walk cycle.
    me.animMoving = carriedByBoat ? false : pred.moving;
    // Same rule for ourselves — but not while a boat is carrying us, since that
    // is the deck moving, not our legs, and a pose should survive the ride.
    if (me.animMoving && me.act) me.act = null;
    me.stepDur = stepDelay(!!(moveIntent && moveIntent.run), mounted());
    // Leg cadence tied to GROUND COVERED (cyclesPerTile): walking unchanged
    // (80ms/frame); running takes bigger strides so the legs don't whirl. Phase
    // is a 0..1 cycle fraction.
    me.animPhase = me.animMoving
      ? ((me.animPhase || 0) + cyclesPerTile(!!(moveIntent && moveIntent.run)) * dt / (me.stepDur || 300)) % 1
      : 0;
    if (scene.player) me.body = scene.player.body;
  }
  // Glide the OTHER entities (mobiles) toward their target tile at constant
  // velocity, timed to their measured step cadence (×1.12 margin so they're still
  // moving when the next tile arrives). The player ("self") is driven by the queue
  // above, not this glide. Snap on big jumps.
  for (const [id, st] of anim) {
    if (st === me) continue;
    const serial = id.startsWith("m") ? Number(id.slice(1)) : 0;
    const boatPos = serial
      ? boatVisual(serial, { x: st.tx, y: st.ty, z: st.z | 0 }, now)
      : { active: false };
    if (boatPos.active) {
      st.rx = boatPos.x; st.ry = boatPos.y; st.rz = boatPos.z;
      st.animMoving = false; st.animPhase = 0;
      markDirty();
      continue;
    }
    // Ease vertical position (z) too, so stairs/ramps glide instead of popping.
    const tz = st.z | 0;
    if (st.rz === undefined) st.rz = tz;
    if (st.rz !== tz) {
      st.rz += (tz - st.rz) * Math.min(1, (dt / (st.stepDur || 300)) * 2.5);
      if (Math.abs(tz - st.rz) < 0.08) st.rz = tz;
    }
    const dx = st.tx - st.rx, dy = st.ty - st.ry;
    const dist = Math.hypot(dx, dy);
    const mv = dist > 0.06 || now < (st.moveUntil || 0);
    st.animMoving = mv;
    // Walking beats a server-sent pose. ClassicUO drops the animation the moment
    // it evaluates a step — `if (AnimationFromServer) SetAnimation(0xFF)` in
    // `Mobile.ProcessSteps` (:704-709), and again when the queue empties
    // (:275-283) — so a mobile that is struck or swings and then steps switches
    // to its walk cycle instantly instead of gliding across the ground still
    // cycling the swing frames. `st.act` is only ever set from 0x6E/0xE2, which
    // is exactly what `AnimationFromServer` marks there.
    if (mv && st.act) st.act = null;
    // Leg cadence tied to ground covered. The run flag is the SERVER's now
    // (`scene.mobiles[].run`, the 0x80 bit of the direction byte) — this used to
    // infer it from the measured step cadence, which misread whenever the poll
    // jittered, latency spiked, or something stopped mid-run. The cadence
    // fallback survives only for a mobile we have no record for yet.
    const stepDur = st.stepDur || 300;
    const run = st.mobRec ? !!st.mobRec.run : stepDur <= 280;
    if (mv && st.mobRec) {
      // Bodies 402/403 are the human ghost pair, and they sit inside IsHuman's
      // 0x0190..0x0193 range — so without this a ghost would walk audibly, which
      // is exactly what ClassicUO's separate !IsDead test prevents. The scene has
      // no per-mobile `dead`, but it does not need one: for a *human* body the
      // ghost pair is the whole of it.
      const b = st.mobRec.body | 0;
      footstep(st, now, st.tx, st.ty, run, !!st.mobRec.mounted, b,
               !!st.mobRec.hidden, b === 402 || b === 403, !!st.mobRec.fly);
    }
    st.animPhase = mv ? ((st.animPhase || 0) + cyclesPerTile(run) * dt / stepDur) % 1 : 0;
    if (dist < 1e-3) continue;
    if (dist > 3) { st.rx = st.tx; st.ry = st.ty; st.rz = tz; continue; }
    const dur = (st.stepDur || 300) * 1.12;
    const step = dt / dur; // tiles this frame
    if (dist <= step) { st.rx = st.tx; st.ry = st.ty; }
    else { st.rx += (dx / dist) * step; st.ry += (dy / dist) * step; }
  }
  applyBoatSpriteGlides(now);
  // camera follows the eased player so the avatar stays centered (eased z too).
  // Seated: follow the chair TILE (not the sprite's small pixel nudge, see
  // trySit()/chairSeatFor()) so the camera settles exactly like it would after any
  // other one-tile step, with the avatar still centered.
  const self = anim.get("self");
  if (self) {
    const camX = sitting ? isoX(sitting.x, sitting.y) : isoX(self.rx, self.ry);
    const camY = sitting ? isoY(sitting.x, sitting.y, sitting.z) : isoY(self.rx, self.ry, self.rz ?? self.z);
    app.stage.scale.set(camZoom);
    app.stage.position.set(app.screen.width / 2 - camX * camZoom, app.screen.height / 2 - camY * camZoom);
  }
  // Cycle animated statics (flames/fountains/water wheels) to their current frame.
  tickAnimatedStatics(now);
  // Fade statics/foliage that would hide the avatar (circle-of-transparency).
  transparencyPass();
  // …then compose every sprite's alpha from its resting value + active sources.
  easeAlphas(dt);
  // Request a redraw only when something is actually animating: self moving (camera
  // scrolls), a gliding mobile, or a live effect. Idle ⇒ no redraw ⇒ ~0 GPU.
  // This used to read `overLayer.children.length`, which worked only because
  // effects were the sole thing in that layer; they are depth-sorted into
  // `world` now, so ask the effect pool directly.
  if (fxEffects.length) markDirty();
  else for (const st of anim.values()) if (st.animMoving || st.act) { markDirty(); break; }
  drawMobs();
  drawOverheads(now);
  drawDamage(now);
  drawEffects(now);
  drawBars(now);

  // fps / worst-frame
  diag.frames++; diag.acc += dt; diag.worstFrame = Math.max(diag.worstFrame, dt);
  if (dt > 70) console.warn(`[diag] slow frame ${dt.toFixed(0)}ms`);
  if (diag.acc >= 500) {
    diag.fps = Math.round((1000 * diag.frames) / diag.acc);
    diag.frames = 0; diag.acc = 0;
    updateDiag();
  }
}

// Advance animated statics (flames/fountains/water wheels). The server baked each
// one's ART tile-id frame sequence (`_frames`) + interval (`_ai`); we just pick the
// current frame by wall-clock time and swap sp.texture when the index changes (only
// then). Frames that are still streaming in are re-resolved from cache via `_afids`;
// until a frame's texture is ready we keep the current one. markDirty() repaints the
// on-demand renderer whenever a texture actually changed. Cheap: iterates only the
// animated-statics set, and most frames are no-ops between swaps.
function tickAnimatedStatics(now) {
  if (!animatedStatics.size) return;
  let changed = false;
  for (const sp of animatedStatics) {
    if (sp.destroyed) { animatedStatics.delete(sp); continue; }
    const frames = sp._frames, n = frames.length;
    const idx = Math.floor(now / (sp._ai || 200)) % n;
    if (idx === sp._fidx) continue;
    let tex = frames[idx];
    if (!tex) { tex = texFor(sp._frameUrls ? sp._frameUrls[idx] : `art/static/${sp._afids[idx]}.png`); frames[idx] = tex; }
    if (!tex) continue; // frame not loaded yet → keep the current texture
    sp.texture = tex; sp._fidx = idx; changed = true;
    // An animated STACK (syncWorld's `_pile` heap copy) has to cycle with the
    // sprite it doubles, or the second copy freezes on frame 0 behind it.
    if (sp._pile && !sp._pile.destroyed) sp._pile.texture = tex;
  }
  if (changed) markDirty();
}

// See-through for whatever actually COVERS the avatar (stairs, walls, trees).
//
// Iso draw order is correct here: a static one tile nearer the viewer genuinely
// is in front, so it legitimately paints over you — measured live on a stair
// climb, single statics covered 80%/66%/54% of the avatar's sprite. Sorting
// can't fix that; something has to become see-through. ClassicUO's own Circle
// Of Transparency (GameSceneDrawingSorting.CheckCircleOfTransparencyRadius) is
// a SCREEN-SPACE circle with a distance gradient — and it ships disabled by
// default (Profile.UseCircleOfTransparency).
//
// The first attempt here faded every static inside a square TILE radius that
// merely sorted in front, at a flat alpha. That is why it looked wrong: in the
// same measurement, 5 sprites actually covered the avatar while 10–17 more were
// "near and in front" but covered nothing — and those all went translucent too,
// popping in and out at tile boundaries.
//
// So the test is now the honest one: does this sprite's screen rectangle really
// intersect the avatar's? Only then does it fade, and the alpha eases over a few
// frames so nothing pops. Cost is bounded by a cheap tile pre-filter before any
// bounds work.
const fadedSprites = new Set();
const OCC_RADIUS = 4;                    // tile pre-filter; nothing further can overlap
const A_OCC = 0.35, A_OCC_FOLIAGE = 0.45; // faded alpha: solids / foliage
const OCC_FADE = 0.18;                    // per-frame lerp toward the target alpha

// --- alpha: ONE owner, one rule -------------------------------------------
//
// Every pooled world sprite has a RESTING alpha it belongs at when nothing is
// fading it (`_baseAlpha`: 1 normally, `A_TRANSLUCENT` for a TileFlag.Translucent
// static), plus any number of transient fade SOURCES keyed by name. The sprite
// eases toward the MINIMUM of its resting alpha and every active source, and
// `easeAlphas` is the only thing that assigns `.alpha` on a pooled sprite.
//
// Minimum rather than a priority chain, deliberately. ClassicUO's `ProcessAlpha`
// (GameSceneDrawingSorting.cs:326-387) is an if/else-if chain, but read its
// targets in priority order — 0 (above maxZ), 0 (roof), 178 (translucent), 255
// (default), plus 76 for foliage-behind-a-tree (GameScene.cs:641-655) — and it
// is monotonically decreasing: the higher-priority branch always wants the
// LOWER alpha. A priority chain whose targets descend with priority IS a
// minimum. Its one non-monotone branch is the circle of transparency, which
// ClassicUO ships DISABLED by default (Profile.cs:126), so `min` agrees with a
// default-profile ClassicUO on every branch that actually fires — and unlike a
// chain it is order-free, so a new source is one `setAlphaSource` call and
// nothing else moves.
//
// Each source owns its own membership: a producer decides which sprites it
// applies to and clears itself from the rest. That is the part that matters for
// what comes next — `transparencyPass` below only ever *looks* at sprites within
// OCC_RADIUS that overlap the avatar, so a future roof fade (which is a
// `z >= maxZ` predicate over the whole window, occluding nothing) could never
// have piggybacked on its iteration set. It brings its own.
//
// NOTE for this row: `min` never actually binds yet — A_OCC (0.35) and
// A_OCC_FOLIAGE (0.45) are both below A_TRANSLUCENT (0.698), so an occluding
// translucent static lands on the occlusion value either way. This is
// scaffolding that pays off at the next fade source, not a behaviour change.
const alphaActive = new Set(); // sprites with a live source, or still easing home

// The composed target: resting alpha, pulled down by whichever source wants it
// darkest. Used by `easeAlphas` (which eases toward it) and by `drawMobs`
// (which snaps to it), so both go through one definition of "correct alpha".
function alphaTarget(sp) {
  let t = sp._baseAlpha ?? 1;
  const src = sp._aSrc;
  if (src) for (const a of src.values()) if (a < t) t = a;
  return t;
}

// Add, update (`a` = alpha) or clear (`a` = null) one named fade source.
function setAlphaSource(sp, key, a) {
  if (!sp || sp.destroyed) return;
  if (a == null) {
    if (!sp._aSrc || !sp._aSrc.delete(key)) return; // wasn't set: nothing to ease
  } else {
    (sp._aSrc || (sp._aSrc = new Map())).set(key, a);
  }
  alphaActive.add(sp);
}

// Ease every tracked sprite toward its composed target. Runs unconditionally
// each frame — NOT inside `transparencyPass`, which returns early when there is
// no player position and would otherwise strand a half-faded sprite.
function easeAlphas(dt) {
  if (!alphaActive.size) return;
  // Frame-rate independent. `OCC_FADE` was tuned as a per-frame factor, so it is
  // re-anchored to 60 Hz rather than retuned: at 60 fps `k === OCC_FADE` exactly,
  // and at 120 fps the fade now takes the same wall-clock time instead of half.
  // (Before this the fade was ~400 ms at 60 Hz and ~200 ms at 120 Hz. Occlusion
  // hid that; a whole roof fading makes it obvious.) `dt` is clamped so a
  // backgrounded tab resuming after seconds eases instead of snapping.
  const k = 1 - Math.pow(1 - OCC_FADE, Math.min(dt || 16.67, 100) / 16.67);
  let changed = false;
  for (const sp of alphaActive) {
    if (sp.destroyed) { alphaActive.delete(sp); continue; }
    const target = alphaTarget(sp);
    let a = sp.alpha + (target - sp.alpha) * k;
    if (Math.abs(a - target) < 0.01) a = target;
    // `visible` is written UNCONDITIONALLY, not inside the alpha branch below.
    // A ceiling-hidden sprite is created at alpha 0 and stays there, so
    // `a === sp.alpha` on every frame — folding this into that branch would mean
    // it never ran, and the whole point of hiding (hundreds of alpha-0 sprites
    // leaving the batch, each with its own gray-ring filter pass) would quietly
    // never happen. PIXI v8 does NOT skip an alpha-0 sprite; only `visible`
    // removes it from the instruction set.
    const vis = a > 0;
    if (sp.visible !== vis) { sp.visible = vis; changed = true; }
    if (a !== sp.alpha) { sp.alpha = a; changed = true; }
    // Settled AND nothing pulling on it → stop tracking. A translucent static
    // that never gets occluded is therefore never in this set at all: it just
    // sits at the `_baseAlpha` stamped when its sprite was built. A
    // ceiling-hidden one keeps a live source, so it stays — but it has settled,
    // so it costs one `alphaTarget` walk and no writes.
    if (a === target && (!sp._aSrc || sp._aSrc.size === 0)) alphaActive.delete(sp);
  }
  if (changed) markDirty();
}
// A sprite has to genuinely COVER the avatar, not merely touch its box. The
// floor tile of the tile in front sits directly under your feet and grazes the
// avatar's bottom edge by a pixel or two — measured live at (847,2272): floor
// tiles at rel (+1,0) and (0,+1) spanned y235..279 against an avatar of
// y174..236, a 1px overlap (~1.6% of it), and both went translucent. That is
// the "transparency under my feet" this fixes. Real occluders in the same
// measurements covered 32-80%, so any modest floor separates them cleanly.
// Requiring both a minimum band AND a minimum area keeps a thin tall sliver
// (a post seen edge-on) working while rejecting an edge graze.
const OCC_MIN_PX = 6;                     // px: overlap must be at least this wide AND tall
const OCC_MIN_FRAC = 0.05;                // …and cover at least this much of the avatar
function transparencyPass() {
  const newFaded = new Set();
  let ptx, pty, pz;
  if (sitting) { ptx = sitting.x; pty = sitting.y; pz = sitting.z; } // seated: use the chair, not the (unmoved) real tile
  else if (pred) { ptx = Math.round(pred.rx); pty = Math.round(pred.ry); pz = pred.z; }
  else if (scene && scene.player) { ptx = scene.player.x; pty = scene.player.y; pz = scene.player.z; }
  // No position? Fall through with an empty `newFaded` rather than returning:
  // that releases the source from everything currently faded, so nothing is
  // stranded translucent while the player position is momentarily unknown.
  const bodyParts = ptx === undefined ? [] : mobPartSprites("self", "body");
  const body = bodyParts.find((sp) => sp && !sp.destroyed && sp.visible);
  if (body) {
    // Union of every depth strip — the avatar's real on-screen rectangle.
    // Bounds are global, so they already account for the camera and zoom.
    let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity;
    for (const sp of bodyParts) {
      if (!sp || sp.destroyed || !sp.visible) continue;
      const b = sp.getBounds();
      if (b.x < ax0) ax0 = b.x;
      if (b.y < ay0) ay0 = b.y;
      if (b.x + b.width > ax1) ax1 = b.x + b.width;
      if (b.y + b.height > ay1) ay1 = b.y + b.height;
    }
    const minArea = (ax1 - ax0) * (ay1 - ay0) * OCC_MIN_FRAC;
    // Same depth formula drawMobs uses for "self": anything sorting at or below
    // this draws behind us and cannot hide us, whatever its bounds.
    const playerZi = mobDepthZ(ptx, pty, pz | 0); // same key drawMobs sorts the avatar with
    const consider = (sp) => {
      if (!sp || sp.destroyed || !sp.visible) return;
      if (Math.abs(sp._tx - ptx) > OCC_RADIUS || Math.abs(sp._ty - pty) > OCC_RADIUS) return;
      if (sp.zIndex <= playerZi) return;
      const b = sp.getBounds();
      // Measure the actual overlap instead of just testing for one: a floor tile
      // in front only ever grazes the avatar's bottom edge (see OCC_MIN_PX).
      const ow = Math.min(ax1, b.x + b.width) - Math.max(ax0, b.x);
      const oh = Math.min(ay1, b.y + b.height) - Math.max(ay0, b.y);
      if (ow < OCC_MIN_PX || oh < OCC_MIN_PX || ow * oh < minArea) return;
      newFaded.add(sp);
    };
    for (const sp of staticPool.values()) consider(sp);
    for (const e of itemPool.values()) consider(e.sp);
  }
  // Publish the "occ" source: release it from whatever stopped occluding, set it
  // on whatever is. `fadedSprites` is this producer's own membership set — the
  // sprites it currently claims — and easing is `easeAlphas`' job, not ours.
  // Note the resting alpha is never mentioned here: walking a sprite "back to
  // 1" was the old rule, and it is exactly what would have flattened a
  // translucent static to opaque the first time the player stepped behind it.
  for (const sp of fadedSprites) if (!newFaded.has(sp)) setAlphaSource(sp, "occ", null);
  for (const sp of newFaded) setAlphaSource(sp, "occ", sp._foliage ? A_OCC_FOLIAGE : A_OCC);
  fadedSprites.clear();
  for (const sp of newFaded) fadedSprites.add(sp);
}

// Dressed humans composite as a STACK of hued sprites (body + worn equipment),
// all sharing the body's screen position / anchor / depth. mobSprites is keyed by
// "<id>#<slot>" so each stack layer is a persistent sprite (no per-frame re-create
// → no full world re-sort), reused/pruned exactly like the single body was before.
const mobSprites = new Map(); // "<id>#<slot>#<slice>" -> persistent layer sprite in the sorted world layer
function mobPartSprites(id, slot) {
  const prefix = id + "#" + slot + "#";
  const out = [];
  for (const [key, sp] of mobSprites) if (key.startsWith(prefix)) out.push(sp);
  return out;
}
const itemHits = new Map();   // "i"+serial -> invisible click target over a ground-item dot

// UO equipment draw order (back → front). Lower index = drawn earlier/behind, so
// clothes sit over the body and hair (11) / beard (16) / weapons composite on top.
// Per-direction draw order — a faithful port of ClassicUO `LayerOrder.UsedLayers`
// (UO layer numbers). The cloak (20) moves front/back with facing; the backpack (21)
// and mount (25) are NOT in any list → never drawn as a worn body layer (ClassicUO
// skips them). A layer not in the facing's list is not drawn (rank -1).
const _LO_DEF = [5, 4, 3, 24, 13, 8, 9, 14, 15, 19, 7, 23, 17, 22, 10, 11, 12, 16, 18, 1, 20, 6, 2];
const _LO_0 = [5, 4, 3, 24, 13, 8, 9, 14, 15, 19, 7, 23, 17, 22, 10, 11, 12, 16, 18, 1, 6, 2, 20]; // facing away → cloak in front
const _LO_3 = [20, 5, 4, 3, 24, 13, 8, 9, 14, 15, 19, 7, 23, 17, 22, 12, 10, 11, 16, 18, 6, 1, 2]; // facing viewer → cloak behind
const LAYER_ORDER_DIR = [_LO_0, _LO_DEF, _LO_DEF, _LO_3, _LO_DEF, _LO_DEF, _LO_DEF, _LO_DEF];
const layerRank = (l, dir) => LAYER_ORDER_DIR[dir & 7].indexOf(l | 0); // -1 = not drawn

// ClassicUO `MobileView.DrawInternal` draws each mobile part as horizontal
// strips whose depth increases toward the feet (`depth + 1 + i*2`). A raised
// weapon's blade lives in the upper strip (lower depth) so the body's lower
// strip paints over it — without this the whole sword sits in front of the
// torso and reads as floating above the character. Stride stays inside one
// z-step (16) so slices occlude each other without jumping a tile.
function mobileSlicePlan(height, cy, mountOff) {
  const h = height | 0;
  if (h <= 1) return [{ i: 0, sy: 0, sh: Math.max(1, h) }];
  const diffY = (h + (cy | 0)) - (mountOff | 0);
  const value = Math.max(1, diffY);
  let count = Math.max((h / value | 0) + 1, 2);
  if (count > 8) count = 8;
  const out = [];
  let rectH = Math.min(value, h);
  let remains = h - rectH;
  let y = 0;
  for (let i = 0; i < count && y < h; i++) {
    const sh = Math.max(1, Math.min(rectH, h - y));
    out.push({ i, sy: y, sh });
    y += sh;
    rectH = remains;
    remains -= rectH;
  }
  if (y < h) out.push({ i: out.length, sy: y, sh: h - y });
  return out;
}
function textureSlice(tex, sy, sh) {
  const orig = tex.frame;
  const fx = orig ? orig.x : 0;
  const fy = (orig ? orig.y : 0) + sy;
  const fw = orig ? orig.width : tex.width;
  const Rect = PIXI.Rectangle;
  const frame = Rect ? new Rect(fx, fy, fw, sh) : { x: fx, y: fy, width: fw, height: sh };
  return new PIXI.Texture({ source: tex.source, frame });
}
function applySliceTexture(sp, base, sy, sh) {
  const full = sy === 0 && sh >= (base.height | 0);
  if (full) {
    if (sp._ownSliceTex) { sp._ownSliceTex.destroy(false); sp._ownSliceTex = null; }
    sp._sliceTag = null;
    sp._sliceY = 0;
    sp._sliceH = 0;
    if (sp.texture !== base) sp.texture = base;
    return;
  }
  const tag = `${(base.source && base.source.uid) || base.uid || 0}|${sy}|${sh}`;
  if (sp._sliceTag === tag && sp._ownSliceTex) {
    if (sp.texture !== sp._ownSliceTex) sp.texture = sp._ownSliceTex;
    sp._sliceY = sy;
    sp._sliceH = sh;
    return;
  }
  if (sp._ownSliceTex) { sp._ownSliceTex.destroy(false); sp._ownSliceTex = null; }
  const sliced = textureSlice(base, sy, sh);
  sp._ownSliceTex = sliced;
  sp._sliceTag = tag;
  sp._sliceY = sy;
  sp._sliceH = sh;
  sp.texture = sliced;
}
function destroyMobSprite(sp) {
  clearSitDeform(sp);
  if (sp._ownSliceTex) { sp._ownSliceTex.destroy(false); sp._ownSliceTex = null; }
  world.removeChild(sp);
  sp.destroy();
}

// Every ServUO `Body.IsGhost` id and the living people body used to animate it.
// 970 is the legacy male death-shroud body (`H_Male_Robe_Deathshroud`).
const GHOST_ANIMATION_BODIES = new Map([
  [402, 400], [403, 401], // human male/female
  [607, 605], [608, 606], // elf male/female
  [694, 666], [695, 667], // gargoyle male/female
  [970, 400],             // legacy male death shroud
]);
const isGhostBody = (b) => GHOST_ANIMATION_BODIES.has(b | 0);
const ghostAnimationBody = (b) => GHOST_ANIMATION_BODIES.get(b | 0) ?? (b | 0);

// Is a worn layer hidden by something over it? Faithful port of ClassicUO
// MobileView.IsCovered: a robe (and a few special items) hides the inner clothes
// it fully covers, so they don't peek through. `byLayer` maps layer → equip entry
// ({ g: graphic, ... }). UO layers: Shoes 3, Pants 4, Hair 11, Torso 13, Tunic 17,
// Arms 19, Robe 22, Skirt 23, Legs 24, Helmet 6.
function isCovered(byLayer, layer) {
  const g = (l) => (byLayer[l] ? (byLayer[l].g | 0) : null);
  const has = (l) => byLayer[l] != null;
  const robe = g(22);
  switch (layer | 0) {
    case 3: { // Shoes
      const pants = g(4);
      if (has(24) || pants === 0x1411) return true;
      if (pants === 0x0513 || pants === 0x0514 || robe === 0x0504) return true;
      break;
    }
    case 4: { // Pants
      if (has(24) || robe === 0x0504) return true;
      const pants = g(4);
      if (pants === 0x01EB || pants === 0x03E5 || pants === 0x03EB) {
        const skirt = g(23);
        if (skirt != null && skirt !== 0x01C7 && skirt !== 0x01E4) return true;
        if (robe != null && robe !== 0x0229 && (robe <= 0x04E7 || robe > 0x04EB)) return true;
      }
      break;
    }
    case 17: { // Tunic
      if (g(17) === 0x0238) return robe != null && robe !== 0x9985 && robe !== 0x9986 && robe !== 0xA412;
      break;
    }
    case 13: { // Torso
      if (robe != null && robe !== 0 && robe !== 0x9985 && robe !== 0x9986 && robe !== 0xA412 && robe !== 0xA2CA) return true;
      const tunic = g(17);
      if (tunic != null && tunic !== 0x1541 && tunic !== 0x1542) {
        const torso = g(13);
        if (torso === 0x782A || torso === 0x782B) return true;
      }
      break;
    }
    case 19: // Arms
      return robe != null && robe !== 0 && robe !== 0x9985 && robe !== 0x9986 && robe !== 0xA412;
    case 6:   // Helmet
    case 11: { // Hair
      if (robe != null) {
        if (robe > 0x3173) {
          if (robe === 0x4B9D || robe === 0x7816) return true;
        } else if (robe <= 0x2687) {
          if (robe < 0x2683) return robe >= 0x204E && robe <= 0x204F;
          return true;
        } else if (robe === 0x2FB9 || robe === 0x3173) {
          return true;
        }
      }
      break;
    }
  }
  return false;
}

// ClassicUO `Mobile.TryGetSittingInfo`: a human standing on a chair static/item
// (|Z| ≤ 1, not mounted, not flying, not mid-step) sits. The double-click
// overlay (`sitting`) still wins for the local player (adjacent chairs).
const GARGOYLE_BODIES = new Set([666, 667, 0x02B6, 0x02B7]);
function chairUnder(x, y, z) {
  const scan = (list) => {
    for (const o of list || []) {
      if (Math.abs((o.z | 0) - z) > 1) continue;
      const entry = CHAIR_TABLE.get(o.g | 0);
      if (entry) return { graphic: o.g | 0, z: o.z | 0, entry };
    }
    return null;
  };
  return scan(staticsAt(x, y)) || scan(itemsAt(x, y));
}
function seatForEntity(st, ent, faceDir, isSelf) {
  if (isSelf && sitting) return sitting;
  if (st.animMoving) return null;
  if (!ent || ent.mounted || ent.dead) return null;
  if (GARGOYLE_BODIES.has(st.body | 0)) return null;
  // People only (ClassicUO `IsHuman`). Scene `at` is mobtypes (2 = people);
  // self defaults to people until the field lands.
  const at = (ent && ent.at != null) ? (ent.at | 0) : (st.at != null ? (st.at | 0) : null);
  if (isSelf) {
    if (at != null && at !== 2) return null;
  } else if (at !== 2) {
    return null;
  }
  const mx = Math.round(st.rx), my = Math.round(st.ry);
  const mz = (st.rz ?? st.z) | 0;
  const found = chairUnder(mx, my, mz);
  if (!found) return null;
  return { x: mx, y: my, z: found.z, graphic: found.graphic, ...chairSeatFor(faceDir, found.entry) };
}

// ---- random idle fidget (ClassicUO `Mobile.SetIdleAnimation`, Mobile.cs:367-508) ----
// A mobile that has genuinely stood still re-arms a 30-60 s timer and then plays
// one of its body's two or three Fidget groups. Without it every NPC, monster and
// player standing around is a statue holding frame 0 of its stand group.
//
// The GROUP table is the server's (`/idleanim/<body>`): picking a row needs
// mobtypes.txt's offset/UOP flags and "does this group have frames at all", none
// of which the browser has. The CLOCK is ours, which is the same split every
// other animation here already uses.
const IDLE_MIN_MS = 30000;   // `CalculateRandomIdleTime`: 30 s + rand(0..30 s)
// ClassicUO's own per-frame pacing for a `SetAnimation`-driven pose:
// `currentDelay += currentDelay * (_animationInterval + 1)` (Mobile.cs:603) with
// the interval `SetIdleAnimation` picks (1) — so 80 + 80*2. A fidget is a slow,
// deliberate gesture, not a walk cycle.
const IDLE_FRAME_MS = CHAR_ANIM_DELAY * 3;
// body(+flying) -> {g:[3], e:[3]} once loaded, null while the fetch is in flight,
// false when this body has no fidget at all. `has()` is what gates the refetch.
const idleGroups = new Map();
function idleGroupsFor(body, flying) {
  const k = `${body | 0}/${flying ? 1 : 0}`;
  if (idleGroups.has(k)) return idleGroups.get(k);
  idleGroups.set(k, null);
  fetch(`idleanim/${body | 0}` + (flying ? "?fly=1" : ""))
    .then((r) => r.json())
    .then((j) => idleGroups.set(k, (j && j.g && j.g.length === 3) ? j : false))
    .catch(() => idleGroups.set(k, false));
  return null;
}
function idleRearm(st, now) { st.idleAt = now + IDLE_MIN_MS + Math.random() * IDLE_MIN_MS; }
// One entity's idle clock, ticked once per rendered frame from drawMobs (where
// the body/mount/war/ghost state is already resolved). Returns nothing; its whole
// effect is to occasionally set `st.act`, which the pose branch below then plays
// exactly like a server-sent one — which is what ClassicUO does too
// (`SetIdleAnimation` sets `AnimationFromServer = true`).
function tickIdleAnim(st, now, body, moving, mounted, war, flying, ghost) {
  // ClassicUO re-arms in `SetAnimation` (:364) and on every step (:845), so the
  // timer only ever expires after 30-60 s of genuine standing still. Re-arming
  // while `st.act` is live covers the first of those without reaching into the
  // 0x6E/0xE2 ingest: it just measures from the end of the pose instead of its
  // start.
  if (st.idleAt === undefined || moving || st.act || st.death) { idleRearm(st, now); return; }
  if (now < st.idleAt) return;
  // Re-armed BEFORE the suppression checks, as ClassicUO does — `SetIdleAnimation`
  // calls `CalculateRandomIdleTime` on its first line, outside the guard.
  idleRearm(st, now);
  if (mounted || war || ghost) return; // `!IsMounted && !InWarMode`
  const info = idleGroupsFor(body, flying);
  if (!info) return;                   // still loading, or this body has none
  // `RandomHelper.GetValue(0, 2)` is INCLUSIVE of 2 (`_random.Next(low, high+1)`),
  // so all three table entries are reachable. If the rolled group has no frames,
  // ClassicUO flips the index (`first_value == 0 ? 1 : 0`, so 2 also lands on 0)
  // and gives up if that one is missing too.
  let i = Math.floor(Math.random() * 3);
  if (!info.e[i]) i = i === 0 ? 1 : 0;
  if (!info.e[i]) return;
  st.act = { group: info.g[i] | 0, idle: true, fwd: true, startMs: now, frameMs: IDLE_FRAME_MS };
  markDirty();
}

function drawMobs() {
  // Mobiles live *inside* the depth-sorted `world` container (not a top layer) so
  // statics in front occlude them. Sprites are PERSISTENT and updated in place —
  // recreating them every frame marked the (huge) world container's child list
  // dirty, forcing a full re-sort of ~2800 tiles every frame (the CPU hog). Now we
  // only touch a sprite's zIndex when it actually crosses a tile (rarely), so the
  // expensive re-sort happens per-tile, not per-frame.
  entLayer.clear();
  diag.ents = 0;
  const seen = new Set();

  // (Dynamic world items are now drawn as real art sprites in syncWorld's itemPool,
  // not dots here.)
  // Resolve each rendered entity's skin hue + worn equipment from the scene.
  // drawMobs() runs every rendered frame (60Hz) for animation, but `scene` itself
  // only changes once per ~150ms poll (poll() assigns a brand-new parsed object
  // each time) — so build this lookup once per scene and stash it there; a fresh
  // scene object naturally invalidates it, no separate epoch/dirty flag needed.
  let mobById = scene._mobById;
  if (!mobById) {
    mobById = new Map();
    for (const m of scene.mobiles || []) mobById.set("m" + m.serial, m);
    // A mobile that died this poll is no longer in the scene, but its body is
    // still falling: draw it from the record captured when the cue arrived, so
    // it keeps its equipment and hue all the way down.
    for (const [id, dv] of dyingMobs) if (!mobById.has(id)) mobById.set(id, dv.mob);
    scene._mobById = mobById;
  }
  for (const [id, st] of anim) {
    diag.ents++;
    // A cosmetic Swing (0x2F) flash (see `ingestSwings`) briefly overrides the
    // DISPLAYED facing without touching `st.dir`/`pred.dir` — those stay 100%
    // driven by the committed walk stream (server confirms / local prediction),
    // which is what `enqueueSteps`' turn-vs-move split (mirroring anima-core
    // `Walker::step`'s `is_turn = facing != dir`) reads. Expire it on time, or
    // the instant `touch()` (in `updateAnimStates`) sees this entity actually
    // move a tile — a real step is always more authoritative than the flash.
    let faceDir = st.dir;
    if (st.faceOverride) {
      if (visualNow() < st.faceOverride.until) faceDir = st.faceOverride.dir;
      else st.faceOverride = null;
    }
    // We only know run/mount state for our own player; other mobiles walk/stand.
    const isSelf = id === "self";
    // Look up this entity's scene record (self → player; else mobile) for skin hue,
    // worn equipment, and mount state. Mount is per-entity: self uses player.mounted,
    // others use their own `mounted`/`mountAnim` fields.
    const ent = isSelf ? scene.player : mobById.get(id);
    const mounted = !!(ent && ent.mounted);
    // ClassicUO `AllowedToDraw = !HasSurfaceOverhead`: another mobile fully
    // enclosed under NoShoot/Window tiles is not drawn (and not clickable)
    // while we are outside looking at the building. The player is never flagged.
    if (!isSelf && ent && ent.so) continue;
    const pick = isSelf || !(ent && aboveGroundZ(ent.z ?? st.z));
    const mountAnim = (ent && (ent.mountAnim | 0)) || 0;
    // ClassicUO `MobileView`: after the mount is drawn, `drawY += OffsetY` so
    // the rider (body + equipment) sits on the animal. The mount itself stays
    // put; a negative offset lifts the rider (ethereal horse -9), a positive
    // one drops them (cu sidhe +18).
    const mountOff = (ent && (ent.mountOff | 0)) || 0;
    // Ghost bodies use their race/sex-equivalent living people animation, rendered
    // translucent with equipment hidden. Self uses the bridge's authoritative dead
    // bit; nearby mobiles fall back to the same complete body mapping.
    const ghost = ent && typeof ent.dead === "boolean" ? ent.dead : isGhostBody(st.body);
    // Sitting: local double-click overlay, else ClassicUO TryGetSittingInfo on
    // whoever is standing on a chair. Pose/facing come from the chair table —
    // nothing below this ever touches World or `pred`.
    const seat = (!ghost && !mounted) ? seatForEntity(st, ent, faceDir & 7, isSelf) : null;
    const d = seat ? seat.dir : (faceDir & 7);
    const moving = seat ? false : !!st.animMoving; // set in renderFrame (glide + held/mouse)
    const running = REPLAY_MODE ? !!(ent && ent.run) : isSelf && !!(moveIntent && moveIntent.run);
    const bodyAnim = ghost ? ghostAnimationBody(st.body) : (st.body | 0);
    // Hidden (mobile-update status-flags 0x80: Hiding/stealth skill, or a GM
    // `[set Hidden true`). Seeing it at all means the server allows us to
    // perceive this mobile (self, or an ally in Detect Hidden range) — UO
    // gives visual feedback for that by rendering it semi-transparent.
    const hidden = !!(ent && ent.hidden);
    // Authoritative animation type from the server (mobtypes.txt). A ghost is drawn
    // with a living human body, so it animates as people (2) regardless of st.at.
    const atype = ghost ? 2 : (st.at != null ? (st.at | 0) : null);
    // War-mode combat stance applies to our own avatar (the only mobile whose war
    // state the server tells us); others fall back to the normal idle stand.
    const inWar = REPLAY_MODE ? !!(ent && ent.war) : isSelf && !!(scene && scene.war);
    // Fidget when nothing else is happening. Runs before `st.act` is read below,
    // so a fidget that fires this frame starts on this frame.
    if (!REPLAY_MODE) tickIdleAnim(st, visualNow(), bodyAnim, moving, mounted, inWar,
                 !!(ent && ent.fly), ghost);
    // A one-shot 0x6E action (combat swing, bow, get-hit) takes over the pose while
    // it plays, then expires → revert to walk/stand/war. We only retire it once the
    // group's real frame count has loaded (so a placeholder count can't cut it short).
    let group, frames, frame;
    const act = st.act;
    // The raw 0x6E `action` isn't always a direct animation group: spell casts send
    // high "action" codes (UO SpellInfo.Action, ~200+) that map to the cast gesture.
    // resolveActionGroup() folds those onto the body's real group set; a *typed*
    // 0xE2 event instead needs resolveTypedAnimGroup()'s ClassicUO-style dispatch,
    // which can also decide there's nothing to play (e.g. an emote while mounted).
    // A client-generated fidget (`act.idle`) already holds a real animation group
    // — `/idleanim` resolved it against mobtypes.txt — so it must NOT go through
    // resolveActionGroup's `% 35` fold, which would turn a flying gargoyle's
    // group 66 into 31.
    const ag = (act && !ghost)
      ? (act.idle
          ? act.group
          : act.typed
            ? resolveTypedAnimGroup(act.typ, act.action, act.mode, bodyAnim, atype, mounted)
            : resolveActionGroup(act.group, bodyAnim, atype))
      : 0;
    if (act && !ghost) {
      if (ag == null) {
        st.act = null; // no valid animation for this body/mount combo — revert now
      } else {
        framesFor(bodyAnim, ag, d); // kick the frame-count/centers load
        const fk = `${bodyAnim}/${ag}/${d}`;
        const loaded = frameCount.has(fk) ? Math.max(1, frameCount.get(fk)) : 0;
        const fi = Math.floor((visualNow() - act.startMs) / act.frameMs);
        if (loaded > 0 && fi >= loaded) st.act = null; // played every frame → done
      }
    }
    if (st.death) {
      // Death: the group the server resolved (mobtypes-aware, same call a
      // corpse's held frame uses), played once at the standard cadence and then
      // held. `dyingMobs` drops the entity when this reports done, which is
      // ClassicUO removing the body once `frameIndex >= fc`.
      group = st.death.dg;
      frames = framesFor(bodyAnim, group, d);
      const fi = Math.floor((visualNow() - st.death.startMs) / CHAR_ANIM_DELAY);
      frame = Math.max(0, Math.min(frames - 1, fi));
      if (st.prevFrameKey !== `${group}/${d}`) {
        for (let f = 0; f < frames; f++) texFor(`anim/${bodyAnim}/${group}/${d}/${f}.png`);
        st.prevFrameKey = `${group}/${d}`;
      }
      const dying = dyingMobs.get(id);
      if (dying && frameCount.has(`${bodyAnim}/${group}/${d}`) && fi >= frames) dying.done = true;
    } else if (st.act && !ghost) {
      group = ag;
      frames = framesFor(bodyAnim, group, d);
      const fi = Math.max(0, Math.min(frames - 1, Math.floor((visualNow() - act.startMs) / act.frameMs)));
      frame = act.fwd ? fi : (frames - 1 - fi);
      if (st.prevFrameKey !== `${group}/${d}`) {
        for (let f = 0; f < frames; f++) texFor(`anim/${bodyAnim}/${group}/${d}/${f}.png`);
        st.prevFrameKey = `${group}/${d}`;
      }
    } else {
      group = animGroup(moving, running, mounted, bodyAnim, inWar, atype,
        !!(ent && ent.equip && ent.equip.some((e) => (e.layer | 0) === 2)));
      frames = framesFor(bodyAnim, group, d);
      // animPhase is a 0..1 cycle fraction (advanced per ground covered); map it to
      // the real frame count. Prefetch the whole cycle so frames don't pop in.
      frame = moving ? Math.floor((st.animPhase || 0) * frames) % frames : 0;
      if (moving && bodyAnim && st.prevFrameKey !== `${group}/${d}`) {
        // Prefetch the cycle once per (group,dir) change, not every frame.
        for (let f = 0; f < frames; f++) texFor(`anim/${bodyAnim}/${group}/${d}/${f}.png`);
        st.prevFrameKey = `${group}/${d}`;
      }
    }
    // Seated overrides whatever the above picked (even a pending action anim —
    // ClassicUO's TryGetSittingInfo/seated-draw path takes priority unconditionally
    // too): frame 0 of chairSeatFor()'s group, always. framesFor() here just kicks
    // off loading that (group,d)'s frame-count/centers so centerFor() below
    // positions the sprite correctly instead of falling back to the foot anchor.
    if (seat) {
      group = seat.group;
      frames = framesFor(bodyAnim, group, d);
      frame = 0;
    }
    const skinHue = ent && ent.hue ? ent.hue : 0;
    // A state tint outranks every dye on the mobile, exactly as ClassicUO's
    // `overridedHue` does — so it is resolved once here and substituted into
    // both the body URL and every equipment layer's.
    const stateHue = mobileStateHue(ent, hidden, ghost, st.body);
    // Compose the character from stable PARTS (mount, body, each worn layer). Two
    // fixes for the walk/run "naked↔dressed" flicker and the layer-swap bug:
    //  • PER-PART last-good texture (`st.partTex`): when a part's texture for the
    //    current frame is still loading, reuse its previous frame instead of dropping
    //    it — so no layer (or the body) ever vanishes for a frame mid-walk. Stored as
    //    {tex,url} pairs (not just the texture): the url is what forEachLiveTexUrl()
    //    touches every poll, so a fallback that's the ONLY thing currently drawn for
    //    a part doesn't go idle in texLastUsed and get evicted out from under it —
    //    its own url is never re-passed through texFor()/touchTex() while it's the
    //    fallback (the current frame's url is what's being requested instead).
    //  • STABLE per-part keys + rank-based z (not a shifting array index): a layer
    //    that's momentarily missing no longer shoves the others into different slots
    //    and swaps their textures.
    if (!st.partTex) st.partTex = new Map();
    const entries = [];
    // bodyId/grp/frm identify the source frame so we can fetch its draw-center and
    // position the part correctly (ClassicUO math) rather than foot-anchoring it.
    const part = (key, url, rank, interactive, bodyId, grp, frm) => {
      let t = url ? texFor(url) : null;
      const fromUrl = !!t;
      const prev = st.partTex.get(key);
      if (!t && prev) t = prev.tex;
      // Prefer this frame's draw-center; if animinfo hasn't landed (or this
      // layer has fewer frames than the body), keep the last good center so
      // a tall weapon doesn't foot-anchor and stick up through the head.
      let c = bodyId != null ? centerFor(bodyId, grp, d, frm) : null;
      if (!c && prev && prev.cx != null) c = [prev.cx, prev.cy];
      if (t) {
        st.partTex.set(key, {
          tex: t,
          url: fromUrl ? url : (prev ? prev.url : url),
          cx: c ? c[0] : null,
          cy: c ? c[1] : null,
        });
        entries.push({ key, tex: t, rank, interactive, cx: c ? c[0] : null, cy: c ? c[1] : null });
      }
    };
    // MOUNT (behind the rider): the layer-25 item's AnimID animated as an animal
    // (walk=0/run=1/stand=2) driven by the rider's movement; rider uses ONMOUNT groups.
    if (mountAnim > 0 && !ghost) {
      const mg = moving ? (running ? 1 : 0) : 2;
      const mFrames = framesFor(mountAnim, mg, d);
      const mFrame = moving ? Math.floor((st.animPhase || 0) * mFrames) % mFrames : 0;
      if (moving && st.prevMountKey !== `${mg}/${d}`) {
        for (let f = 0; f < mFrames; f++) texFor(`anim/${mountAnim}/${mg}/${d}/${f}.png`);
        st.prevMountKey = `${mg}/${d}`;
      }
      part("mount", `anim/${mountAnim}/${mg}/${d}/${mFrame}.png`, -1, false, mountAnim, mg, mFrame);
    }
    // BODY (hued by skin).
    const bodyHue = stateHue || skinHue;
    part("body", bodyAnim ? `anim/${bodyAnim}/${group}/${d}/${frame}.png${bodyHue ? `?hue=${bodyHue}` : ""}` : null, 0, pick, bodyAnim, group, frame);
    // SHADOW, behind everything. ClassicUO draws exactly one per mobile — an
    // extra pass over the BODY frame only (`MobileView.Draw`'s `hasShadow`
    // branch, `entity = null`), never per worn layer, so overlapping clothes
    // don't darken it. Same gate as well: not while dead, not while hidden.
    if (settings.shadows && !ghost && !hidden) {
      const b = entries.find((e) => e.key === "body");
      if (b && b.cx != null) {
        entries.push({ key: "shadow", tex: b.tex, rank: -2, interactive: false,
                       cx: b.cx, cy: b.cy, shadow: true, mounted: mountAnim > 0 });
      }
    }
    // WORN LAYERS (clothes/hair/beard), each hued, over the body in the facing's UO
    // draw order. Layers not in that order (backpack 21, mount 25) are skipped —
    // the mount is drawn separately as the animal above.
    const byLayer = {};
    if (ent && ent.equip) for (const e of ent.equip) byLayer[e.layer] = e;
    // A ghost wears only the (translucent) death robe — layer 22 OuterTorso. Living
    // mobiles show every worn layer. The robe's anim aligns because we drew the body
    // with the living human anim (bodyAnim) above.
    const worn = st.body && ent && ent.equip
      ? ent.equip.filter((e) => (e.anim | 0) > 0 && layerRank(e.layer, d) >= 0 && !isCovered(byLayer, e.layer)
          && (!ghost || e.layer === 22)) : null;
    if (worn && worn.length) {
      // Prefetch every layer's WHOLE frame cycle once per (group,dir) change, so the
      // full dressed frame is decoded before it's shown (kills per-frame layer lag).
      if (moving && st.prevEquipKey !== `${group}/${d}`) {
        for (const e of worn) for (let f = 0; f < frames; f++) {
          const ph = stateHue || e.hue;
          texFor(`anim/${e.anim}/${group}/${d}/${f}.png${ph ? `?hue=${ph}` : ""}`);
        }
        st.prevEquipKey = `${group}/${d}`;
      }
      for (const e of worn) {
        // Trigger the layer's animinfo load (frame count + per-frame draw-centers)
        // so centerFor(e.anim,…) resolves. Without this the body positions by its
        // real draw-center while clothes fall back to the foot anchor → the worn
        // layers appear shifted down off the body.
        framesFor(e.anim, group, d);
        // A worn layer can have fewer frames than the body's walk/run cycle.
        // ClassicUO mods AnimIndex by that layer's own count (`% frames.Length`);
        // using the body's index 404s the PNG and drops the center, which is
        // how a held weapon jumped to the feet and stuck up through the head.
        const fk = `${e.anim}/${group}/${d}`;
        const n = frameCount.has(fk) ? Math.max(1, frameCount.get(fk)) : 0;
        const idx = n > 0 ? (frame % n) : frame;
        const lh = stateHue || e.hue;
        part("L" + e.layer, `anim/${e.anim}/${group}/${d}/${idx}.png${lh ? `?hue=${lh}` : ""}`,
          1 + layerRank(e.layer, d), false, e.anim, group, idx);
      }
    }
    // Seated: draw at the chair's tile + ClassicUO's pixel nudge (chairSeatFor())
    // instead of the real predicted position — the avatar visually "sits down" onto
    // the seat while the actual World/prediction state never changes (trySit()).
    const x = seat ? isoX(seat.x, seat.y) + seat.dx : isoX(st.rx, st.ry);
    const y = seat ? isoY(seat.x, seat.y, seat.z) + seat.dy : isoY(st.rx, st.ry, st.rz ?? st.z);
    if (entries.length) {
      entries.sort((a, b) => a.rank - b.rank);
      // zIndex only changes when the mobile crosses a tile (assigning it forces a
      // re-sort). All parts share the body's depth; a rank epsilon (≪ the per-z step
      // of 16) keeps them back→front regardless of which parts are present this frame.
      const zi = seat
        ? mobDepthZ(seat.x, seat.y, seat.z)
        : mobDepthZ(Math.round(st.rx), Math.round(st.ry), st.z);
      for (const e of entries) {
        // Seated lean uses a single full-frame mesh (DrawCharacterSitted), not
        // the walking depth strips. Shadow is also one piece (DrawShadow).
        const sitThis = seat && seat.group === 4 && !e.shadow && e.key !== "mount";
        const sliceOff = (e.key === "mount" || e.key === "shadow") ? 0 : mountOff;
        const slices = (!e.shadow && !sitThis && e.cx != null)
          ? mobileSlicePlan(e.tex.height, e.cy, sliceOff)
          : [{ i: 0, sy: 0, sh: e.tex.height | 0 }];
        const riderOff = (e.key !== "mount" && e.key !== "shadow") ? mountOff : 0;
        const topY = e.cx != null ? (y - 3) - e.tex.height - e.cy + riderOff : (y - 3 + riderOff);
        const clickSerial = id === "self"
          ? (scene.player ? ((scene.player.serial >>> 0) + "") : null)
          : (e.interactive ? id.slice(1) : null);
        for (const sl of slices) {
          const key = id + "#" + e.key + "#" + sl.i;
          let sp = mobSprites.get(key);
          if (!sp) {
            sp = new PIXI.Sprite(e.tex);
            sp.anchor.set(0.5, 1.0);
            world.addChild(sp);
            mobSprites.set(key, sp);
          }
          // ClassicUO `_maxGroundZ` is a picking gate, not a draw gate: the
          // mobile stays on screen, it just stops eating clicks (a cave's
          // surface-above-you NPCs). Bind once; flip eventMode as the bound
          // moves.
          if (clickSerial != null && !sp._pickBound) {
            sp._pickBound = true;
            const partKey = e.key;
            sp.hitArea = pixelHitArea(sp, () => { const p = st.partTex.get(partKey); return p ? p.url : null; });
            sp.on("pointerdown", (ev) => onEntityPointerDown(clickSerial, ev));
            sp.on("pointerover", () => {
              hoverEntity(clickSerial);
              for (const s of mobPartSprites(id, "body")) targetHighlightOn(s);
            });
            sp.on("pointerout", () => {
              hoverOut(clickSerial);
              for (const s of mobPartSprites(id, "body")) targetHighlightOff(s);
            });
          }
          if (clickSerial != null) {
            sp.eventMode = "static";
            sp.cursor = "pointer";
          } else {
            sp.eventMode = "none";
            sp.cursor = "default";
          }
          applySliceTexture(sp, e.tex, sl.sy, sl.sh);
          // Position by the frame's draw-center (ClassicUO: top-left at screenX - cx,
          // screenY - height - cy). This is what seats a rider on a mount and aligns
          // held items / armor / hair instead of stacking everything at the feet.
          // Until the center loads, fall back to the foot anchor.
          if (e.shadow) {
            // ClassicUO `Batcher2D.DrawShadow`: the sprite as a parallelogram —
            // half height, top edge pushed right by that same half-height, and
            // lifted 10px so it starts at the feet rather than under them. As a
            // matrix that is [1, 0, -0.5, 0.5], which PIXI expresses as a -45°
            // x-skew with scaleY = cos(45°). Mounted riders drop it 10px more,
            // matching the `drawY + 10` in the mounted branch there.
            const h = e.tex.height;
            sp.anchor.set(0, 0);
            sp.skew.x = -Math.PI / 4;
            sp.scale.set(1, Math.SQRT1_2);
            // +h/2 for the same reason as the static shadow: the shear moves the
            // top right by h/2 while the base must stay under the feet, so the base
            // x (= sprite x, `Position2.X = position.X`) is recovered by adding it
            // back into the translation. Was missing, sliding the shadow h/2 left.
            sp.x = (x - e.cx) + h / 2;
            sp.y = ((y - 3) - h - e.cy) + h / 2 - 10 + (e.mounted ? 10 : 0);
          } else if (e.cx != null) {
            sp.anchor.set(0, 0);
            sp.skew.x = 0;
            sp.scale.set(1, 1);
            sp.x = x - e.cx;
            sp.y = topY + sl.sy;
          } else {
            sp.anchor.set(0.5, 1.0);
            sp.skew.x = 0;
            sp.scale.set(1, 1);
            sp.x = x; sp.y = y - 3 + riderOff;
          }
          // Visibility follows the composed alpha, so a mobile hidden by the
          // ceiling leaves the batch instead of being drawn fully transparent.
          // (Set after the alpha below, so this reads what that computed.)
          // Dead humans render as translucent ghosts; a hidden mobile (still visible to
          // us, per the scene's `hidden` flag) renders semi-transparent too, so we know
          // we're hidden even though we can see ourselves. Sprites are pooled/persistent,
          // so alpha must be reset to 1 every frame for a body that is neither (else a
          // former ghost/hidden mobile stays faint after it dies again/unhides).
          // The shadow shader is `color.rgb = 0; alpha = 0.4` over the sprite's
          // own alpha mask — a flat black silhouette, not a dimmed copy.
          // Written as a RESTING alpha and composed, not assigned: `mobSprites` is
          // a pool no fade source touches today, so `alphaTarget` returns exactly
          // the old value and this is a no-op — but it means there is genuinely
          // one definition of a sprite's alpha rather than two, and when ClassicUO's
          // mobile fade (`z + DEFAULT_CHARACTER_HEIGHT > maxZ`,
          // GameSceneDrawingSorting.cs:829-853) does arrive it has somewhere to go
          // instead of being erased by this unconditional per-frame write.
          if (e.shadow) { sp._baseAlpha = 0.4; sp.tint = 0x000000; }
          else sp._baseAlpha = ghost ? 0.45 : (hidden ? 0.5 : 1);
          // Mobiles fade under a ceiling too. ClassicUO runs them through the very
          // same `ProcessAlpha` as statics, passing an EMPTY `StaticTiles`
          // (GameSceneDrawingSorting.cs:840-850) — so only the `obj.Z >= _maxZ`
          // branch can fire for a mobile, never the roof or translucent ones.
          // (RENDERING.md used to cite `z + DEFAULT_CHARACTER_HEIGHT > maxZ`; that
          // is the branch compared against the literal 150, i.e. dead code.)
          // Needs no server change — `scene.map.maxZ` and each mobile's `z` have
          // both been on the wire all along.
          const mz = scene.map && scene.map.maxZ;
          setAlphaSource(sp, "ceil", mz != null && (st.z | 0) >= mz ? 0 : null);
          // `_baseAlpha` is rewritten every frame here, so re-arm the easer when it
          // actually moves; otherwise a ghost/hidden transition could settle out of
          // `alphaActive` and never be applied.
          if (sp._baseAlphaPrev !== sp._baseAlpha) { alphaActive.add(sp); sp._baseAlphaPrev = sp._baseAlpha; }
          sp.alpha = alphaTarget(sp);
          sp.visible = sp.alpha > 0;
          // ClassicUO `depth + 1 + i*2` (tiles=2). Shadow is unsliced (`DrawShadow`
          // uses the mobile's base depth). Rank epsilon keeps clothes in front of
          // the body inside the same strip.
          const z = e.shadow ? zi + e.rank / 256 : zi + 1 + sl.i * 2 + e.rank / 256;
          if (sp.zIndex !== z) sp.zIndex = z;
          // Seated lean: ClassicUO `DrawCharacterSitted` — three vertical bands,
          // upper shifted ±8px (`flip ? -8 : 8`), mid a trapezoid, lower unshifted.
          // Shadow and the mount stay undeformed (CUO draws the shadow before the
          // sit pass and the mount is a separate animal). The sprite stays for
          // hit-testing; the mesh is the visible draw.
          // Three-band lean is only for E/S (Stand group 4). N/W already use
          // ONMOUNT_STAND (group 25), which is ClassicUO's dedicated sit art —
          // DrawCharacterSitted does not run on those facings.
          if (sitThis) applySitDeform(sp, e.tex, !!seat.flip, sp.x, sp.y, z, sp.alpha, 0xffffff);
          else clearSitDeform(sp);
          seen.add(key);
        }
      }
    } else if (st.body) {
      // Nothing loaded yet → a small fallback dot until textures arrive.
      entLayer.circle(x, y - 3, 3).fill(st.fallback || 0xffffff);
    }
  }
  // Drop layer sprites for entities/slots that left view (or shed equipment).
  for (const [key, sp] of mobSprites) {
    if (!seen.has(key)) { destroyMobSprite(sp); mobSprites.delete(key); }
  }
}

// ClassicUO `Batcher2D.DrawCharacterSitted`: three quads over the stand frame.
// Ratios 0.35 / 0.60 / 0.94 of the frame height; `sittingOffset` is −8 when the
// facing is mirrored (N/E), +8 otherwise.
function makeSitMesh(tex, flip) {
  const w = tex.width, h = tex.height;
  const off = flip ? -8 : 8;
  const h03 = h * 0.35, h06 = h * 0.60, h09 = h * 0.94;
  const aPosition = [
    off, 0,   w + off, 0,   w + off, h03,  off, h03,
    off, h03, w + off, h03, w, h06,        0, h06,
    0, h06,   w, h06,       w, h09,        0, h09,
  ];
  const aUV = [
    0, 0,    1, 0,    1, 0.35,  0, 0.35,
    0, 0.35, 1, 0.35, 1, 0.60,  0, 0.60,
    0, 0.60, 1, 0.60, 1, 0.94,  0, 0.94,
  ];
  const geometry = new PIXI.Geometry({
    attributes: { aPosition, aUV },
    indexBuffer: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11],
  });
  const mesh = new PIXI.Mesh({ geometry, texture: tex });
  mesh.eventMode = "none";
  mesh._sitFlip = flip;
  mesh._sitTex = tex;
  return mesh;
}
function applySitDeform(sp, tex, flip, x, y, zIndex, alpha, tint) {
  let mesh = sp._sitMesh;
  if (!mesh || mesh._sitTex !== tex || mesh._sitFlip !== flip) {
    if (mesh) { world.removeChild(mesh); mesh.destroy(); }
    mesh = makeSitMesh(tex, flip);
    world.addChild(mesh);
    sp._sitMesh = mesh;
  }
  // Sprites with a draw-center use anchor (0,0); the fallback foot-anchor
  // is (0.5, 1). The mesh is always top-left local, so undo the anchor.
  mesh.position.set(x - (sp.anchor?.x || 0) * tex.width, y - (sp.anchor?.y || 0) * tex.height);
  mesh.zIndex = zIndex;
  mesh.alpha = alpha;
  mesh.tint = tint;
  mesh.visible = true;
  sp.renderable = false;
}
function clearSitDeform(sp) {
  if (sp._sitMesh) {
    world.removeChild(sp._sitMesh);
    sp._sitMesh.destroy();
    sp._sitMesh = null;
  }
  sp.renderable = true;
}

// Notoriety → name color (ClassicUO NotorietyFlag): 1 Innocent=blue, 2 Ally=green,
// 3 Gray(attackable)=gray, 4 Criminal=gray, 5 Enemy=orange, 6 Murderer=red,
// 7 Invulnerable=yellow. 0/unknown → neutral off-white.
function notoColor(n) {
  return { 1: 0x4f8cf7, 2: 0x46a758, 3: 0x9aa0a6, 4: 0x9aa0a6, 5: 0xd98a2b, 6: 0xe5484d, 7: 0xf5d442 }[n] || 0xd6dae0;
}
const cssColor = (n) => "#" + (n >>> 0).toString(16).padStart(6, "0");


// ---- corpse equipment layers (ClassicUO ItemView.DrawCorpse) ----------------
//
// A corpse is drawn as the dead body's held death-pose frame; these are the
// clothes and weapons over it. ServUO sends both halves unprompted for a human
// corpse (`Corpse.SendInfoTo` → CorpseContent + CorpseEquip), and non-human
// corpses get neither — which is the server side of the same `ishuman` test
// ClassicUO applies before drawing any layer at all, so an orc corpse correctly
// stays bare.
//
// Everything below reuses the living-mobile machinery: the per-direction
// `LAYER_ORDER_DIR`, the `isCovered` suppression rules, and `centerFor`'s
// per-frame draw-centers. Only the anchoring is new, because a corpse layer
// hangs off the body sprite instead of standing on its own.

// Which layers this corpse would draw, in order, as a change key.
function corpseLayerSig(it) {
  const d = it.dir & 7;
  return (it.equip || [])
    .filter((e) => (e.anim | 0) > 0 && layerRank(e.layer, d) >= 0)
    .map((e) => `${e.layer}:${e.anim}:${e.hue | 0}`)
    .join(",");
}
// Attach one child sprite per worn layer to the corpse's body sprite.
// `bodyH`/`bodyC` are the body frame's height and draw-center, which is what
// the offsets are measured against.
// Returns false when a layer's art or centers had not loaded yet, so the caller
// knows to rebuild on a later poll.
function attachCorpseLayers(sp, it, frame, bodyH, bodyC) {
  const d = it.dir & 7, dg = it.dg | 0;
  const byLayer = {};
  for (const e of it.equip || []) byLayer[e.layer] = e;
  const worn = (it.equip || [])
    .filter((e) => (e.anim | 0) > 0 && layerRank(e.layer, d) >= 0 && !isCovered(byLayer, e.layer))
    .sort((a, b) => layerRank(a.layer, d) - layerRank(b.layer, d));
  let complete = true;
  for (const e of worn) {
    // Kick the layer's animinfo so `centerFor` can resolve; without a center a
    // layer would foot-anchor and sit below the body, which is the same trap
    // the living-mobile path documents.
    const n = framesFor(e.anim, dg, d);
    // A worn layer can have fewer frames than the body's death pose. ClassicUO
    // clamps to the layer's own count (`if (animIndex >= fc) animIndex = fc-1`)
    // rather than dropping it.
    const idx = Math.min(frame, Math.max(0, n - 1));
    const url = `anim/${e.anim}/${dg}/${d}/${idx}.png${e.hue ? `?hue=${e.hue}` : ""}`;
    const t = texFor(url);
    const c = centerFor(e.anim, dg, d, idx);
    // Not loaded yet: skip it this poll and report the corpse as incomplete, so
    // the caller re-runs next poll instead of leaving the layer off for good —
    // the change key tracks the layer list, not the state of its fetches.
    if (!t || !c) { complete = false; continue; }
    const layer = new PIXI.Sprite(t);
    layer.anchor.set(0, 0);
    // Both sprites are placed by their own draw-center against the same origin,
    // so the child's offset is just the difference of the two placements.
    layer.x = bodyC[0] - c[0];
    layer.y = (bodyH + bodyC[1]) - (t.height + c[1]);
    layer.eventMode = "none";     // the body owns the hit test, as in ClassicUO
    sp.addChild(layer);
  }
  return complete;
}

// A static's shadow (ClassicUO shadows trees, foliage and rocks the same way it
// shadows mobiles — `GameSceneDrawingSorting` pushes them with the shadow flag).
// Same parallelogram as `DrawShadow`: half height, top edge pushed right by that
// half-height, lifted 10px. Parented to the static, so `sp`'s own anchor
// (0.5, 1.0 — foot-centred, unlike a mobile's top-left) is what the offsets are
// measured from.
function attachStaticShadow(sp, tex) {
  const shadow = new PIXI.Sprite(tex);
  shadow.anchor.set(0, 0);
  shadow.skew.x = -Math.PI / 4;
  shadow.scale.set(1, Math.SQRT1_2);
  shadow.alpha = 0.4;
  shadow.tint = 0x000000;
  shadow.eventMode = "none";
  // The parent is anchored (0.5, 1.0), so its local origin is the sprite's
  // bottom-centre. ClassicUO's shear pushes the TOP right by h/2 while the base
  // (`Position2.X = position.X`) stays under the sprite, so the base only lands
  // under the trunk when tx carries that +h/2 back: (h - w)/2, not -w/2. Without
  // it the whole shadow slid h/2 to the left of the trunk — worse the taller the
  // art (verified on the dead-tree cluster).
  shadow.x = (tex.height - tex.width) / 2;
  shadow.y = -tex.height / 2 - 10;
  sp.addChildAt(shadow, 0);   // behind the static itself
}
