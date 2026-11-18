// ---- input ----
const KEY_DIR = { ArrowUp: 0, KeyW: 0, ArrowRight: 2, KeyD: 2, ArrowDown: 4, KeyS: 4, ArrowLeft: 6, KeyA: 6, KeyE: 1, KeyC: 3, KeyZ: 5, KeyQ: 7 };
const held = new Set();
let chatting = false;
let shiftHeld = false;
let wasMoving = false;   // last frame sent a walk → send one "stop" on release
// Send "stop" the INSTANT movement ends (key/button up), not on the next 120ms
// tick — otherwise the server keeps pacing for up to a tick and takes one extra
// step (the "한 발자국 더" overshoot), worst at run cadence (200ms).
function stopNow() { if (wasMoving) { sendInput("stop"); wasMoving = false; } }
// Lost keyup (tab out, click a text field, Cursor/OS steals focus) leaves
// `held` with W/↑ = dir 0, so the avatar keeps walking north. Clear every
// movement latch; the next frame's `activeMove()` is then idle.
function releaseMoveKeys() {
  held.clear();
  rightDown = false;
  shiftHeld = false;
  if (rmbEntity) {
    if (rmbEntity.timer) { clearTimeout(rmbEntity.timer); rmbEntity.timer = null; }
    rmbEntity = null;
  }
  stopNow();
}
// RMB steer / context-menu resolve. PIXI drag can suppress the compatibility
// `mouseup`, so callers must also hook `pointerup` or rightDown stays true and
// the avatar keeps running toward the cursor (iso-up = northwest).
function endRightMouse(clientX, clientY) {
  // ClassicUO ends follow mode on a right-click (GameSceneInputHandler:829) —
  // but only one that landed on the WORLD: that arm sits after its
  // `if (!UIManager.IsMouseOverWorld) return false`. This fires on every
  // right-release window-wide, including the one that just closed a gump, so
  // it asks whether the press it is closing actually started on the world:
  // `rightDown` is set by the canvas's own mousedown, `rmbEntity` by a PIXI
  // entity press, and a press on a DOM panel sets neither.
  if (rightDown || rmbEntity) stopFollowing();
  rightDown = false;
  if (rmbEntity) {
    if (rmbEntity.timer) { clearTimeout(rmbEntity.timer); rmbEntity.timer = null; }
    if (!rmbEntity.steering) {
      lastMenuX = clientX; lastMenuY = clientY;
      undismissDialog("popup", rmbEntity.serial >>> 0);
      sendInput("popupreq:" + rmbEntity.serial);
    }
    rmbEntity = null;
  }
}
// Right-button "mouse move" (ClassicUO MoveCharacterByMouseInput): hold RMB and
// the character walks toward the cursor; far from center → run.
let rightDown = false, mouseX = 0, mouseY = 0;
// Right-clicking an entity opens its context menu instead of steering. The PIXI
// pointerdown fires before the canvas DOM mousedown, so it sets this timestamp;
// the button-2 mousedown handler sees it and skips starting RMB steering.
let suppressSteerUntil = 0;
// A right-button press that landed on an entity, pending a quick-tap (→ context
// menu) vs hold/drag (→ steer) decision: { serial, t, x, y, steering, timer } or null.
let rmbEntity = null;
const STEER_HOLD_MS = 180;    // hold RMB this long on an entity → start steering (not a menu)
// Promote a pending entity-RMB into steering (hold/drag detected). After this the
// release won't open a context menu — it was a move, not a tap.
function promoteRmbSteer() {
  if (!rmbEntity || rmbEntity.steering) return;
  rmbEntity.steering = true;
  if (rmbEntity.timer) { clearTimeout(rmbEntity.timer); rmbEntity.timer = null; }
  rightDown = true; // mouseX/mouseY are already tracked → steer toward the cursor
}
// Last cursor position (page coords) where a context menu should open.
let lastMenuX = 0, lastMenuY = 0;
const MOUSE_RUN_RANGE = 190;  // ClassicUO: run when cursor ≥190px from center
const MOUSE_DEADZONE = 18;    // too close to center → don't move (avoid jitter)
// The unified movement intent for this frame: mouse (RMB) wins, else held keys.
let moveIntent = null;        // { dir, run } or null

// ClassicUO GameCursor.GetMouseDirection: classify cursor offset into one of 8
// *screen* directions (0=N/up,1=NE,2=E,3=SE,4=S,5=SW,6=W,7=NW) by sign + ratio.
function screenDir(dx, dy) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  let cls; // 0 = horizontal cardinal, 1 = diagonal, 2 = vertical cardinal
  if (dx === 0) cls = 2;
  else if (dy === 0) cls = 0;
  else if (ay * 5 <= ax * 2) cls = 0;       // |dy/dx| ≤ 0.4
  else if (ay * 2 >= ax * 5) cls = 2;       // |dy/dx| ≥ 2.5
  else cls = 1;
  if (cls === 0) return dx < 0 ? 6 : 2;     // W : E
  if (cls === 2) return dy < 0 ? 0 : 4;     // N : S
  if (dx > 0) return dy < 0 ? 1 : 3;        // NE : SE
  return dy < 0 ? 7 : 5;                     // NW : SW
}

// Direction + run from the cursor relative to the screen center (the avatar).
function mouseMove() {
  // The avatar is drawn at the canvas CENTRE. mouseX/mouseY are CSS-client px
  // (canvas-relative), so the centre must be the canvas's *client* size — NOT
  // app.screen, which is the capped ~1.1MP renderer buffer (see renderSize) and
  // is smaller than the CSS-stretched canvas. Using app.screen put the steer
  // centre up-and-left of the real avatar, skewing every direction. Client space
  // is also zoom-independent (the avatar stays centred at any camZoom).
  const dx = mouseX - app.canvas.clientWidth / 2, dy = mouseY - app.canvas.clientHeight / 2;
  const range = Math.hypot(dx, dy);
  if (range < MOUSE_DEADZONE) return null;
  // screen → world dir: our iso is rotated one step (ClassicUO `facing - 1`).
  const dir = (screenDir(dx, dy) + 7) % 8;
  return { dir, run: range >= MOUSE_RUN_RANGE };
}

function keyboardWantsRun() {
  if (shiftHeld) return true;
  if (!settings.alwaysRun) return false;
  if (settings.alwaysRunUnlessHidden && scene && scene.player && scene.player.hidden) return false;
  return true;
}

// What the player wants to do this frame (single source for prediction + send).
function activeMove() {
  if (typeof sceneTransportAvailable !== "undefined" && !sceneTransportAvailable) return null;
  if (chatting || wmOn) return null;   // don't walk while typing or with the world map open
  if (rightDown) { const m = mouseMove(); if (m) { standUp(); return m; } }
  if (held.size) { standUp(); return { dir: [...held].pop(), run: keyboardWantsRun() }; }
  // Follow mode walks us with the SERVER pathfinder rather than a direction
  // intent, so it returns nothing here — see `followTick`. Ticked from the one
  // function the render loop already calls every frame; `steerBoat` (06-movement)
  // sends from this same per-frame path for the same reason.
  followTick();
  return null;
}

// ---- world-entity interaction (click / use / attack) + target cursor ----
const DBLCLICK_MS = 250;        // single-vs-double-click discrimination window
let clickPend = null;           // pending single-click awaiting a possible double-click
let targetConsumedAt = 0;       // perf-time an entity answered a target click (so the
                                // ground handler below skips the same physical click)
let entityClickedAt = 0;        // perf-time a left-click hit a mobile/item (so the
                                // ground click-to-walk handler skips that same click)
let prevTargetActive = false;   // edge-detect target.active 0→1 (re-show after Esc)
let targetUIHidden = false;     // user pressed Esc → hide crosshair/banner locally

// A left-click landed on a clickable mobile or ground item. Resolves a pending
// target cursor first; otherwise shift = attack, double = use, single = request name.
function onEntityPointerDown(serial, e, isItem) {
  if (e.button === 2) {               // right-button on an entity
    stopFollowing();                  // as on empty ground — a right-click ends follow mode
    // RMB on an entity is ambiguous: a *quick tap* = open its context menu, a
    // *hold or drag* = steer the character. To stop the two from firing together we
    // DON'T steer immediately here (the canvas mousedown checks `rmbEntity` and skips
    // starting the steer). Steering is promoted only once the press is held past
    // STEER_HOLD_MS or the cursor drags > a few px (see the mousemove/timer below);
    // a release before that opens the menu and never moved the character.
    rmbEntity = { serial: serial >>> 0, t: performance.now(), x: e.clientX, y: e.clientY, steering: false };
    lastMenuX = e.clientX; lastMenuY = e.clientY; // anchor a possible menu at the cursor
    rmbEntity.timer = setTimeout(() => { promoteRmbSteer(); }, STEER_HOLD_MS);
    return;
  }
  if (e.button !== 0) return;   // left only — right button still steers movement
  entityClickedAt = performance.now(); // a mobile/item ate this click → no click-to-walk
  e.stopPropagation();          // don't let it bubble to other interaction
  // An armed ignore pick spends itself here, ahead of the server's target
  // cursor: the arm is local and was made two clicks ago, so it is the more
  // specific intent. ClassicUO cannot reach this state at all — its ignore pick
  // IS the target cursor, so arming one cancels the other.
  if (ignorePick) { ignoreMobile(serial); armIgnorePick(false); return; }
  if (inspectPick) { inspectPicked({ serial }); return; }
  if (scene && scene.target && scene.target.active === 1 && !targetUIHidden) {
    targetConsumedAt = performance.now();
    // A harmful cursor aimed at an innocent (or a beneficial one at a criminal)
    // asks first — see `confirmCriminalTarget`. It answers the cursor itself
    // once the player says yes, so this click is finished either way.
    if (!confirmCriminalTarget(serial, isItem)) return;
    resolveObjectTarget(serial);
    return;
  }
  // Alt + left-click a MOBILE = follow it (ClassicUO GameSceneInputHandler:717-728).
  // Deliberately below the target-cursor branch: while the server is waiting for a
  // target, the click belongs to that cursor — Alt is only a movement modifier when
  // nothing else wants the click.
  if (e.altKey && !isItem) { startFollowing(serial); return; }
  if (clickPend && clickPend.serial === serial) {  // second click in time → double-click
    clearTimeout(clickPend.timer); clickPend = null;
    // Any double-click ends a sit (see trySit()) before deciding what this one does —
    // double-clicking the same chair again just re-resolves and re-sits below.
    standUp();
    // War mode: double-clicking another mobile attacks it (ClassicUO behaviour),
    // instead of "use" (which would open its paperdoll).
    if (!isItem && scene && scene.war && (serial >>> 0) !== ((scene.player && scene.player.serial) >>> 0)) {
      sendInput("attack:" + serial);
      return;
    }
    sendInput("use:" + serial);
    // Only world items flagged as CONTAINERS (corpses/chests/bags — scene `c:1`)
    // open a loot window; doors/levers/other double-clickables must not spawn an
    // empty window. Mobiles never do this.
    if (isItem) {
      const it = (scene.items || []).find((x) => (x.serial >>> 0) === (serial >>> 0));
      // ClassicUO `ManualOpenedCorpses`: opening a corpse by hand opts it out of
      // the auto-open path's `SkipEmptyCorpse` hide — you asked to see it.
      if (it && (it.g | 0) === CORPSE_GRAPHIC) manualOpenedCorpses.add(serial >>> 0);
      if (it && it.c) openContainer(serial);
      else if (it) trySit(it); // no-op unless `it.g` is a chair/bench/stool/throne we're next to
    } else {
      // Double-clicked a MOBILE → open its paperdoll (humanoid bodies only, like UO).
      const m = (scene.mobiles || []).find((x) => (x.serial >>> 0) === (serial >>> 0));
      if (m && (m.body | 0) >= 400 && (m.body | 0) <= 407) openMobilePaperdoll(serial);
    }
  } else {
    if (clickPend) clearTimeout(clickPend.timer);
    clickPend = { serial, timer: setTimeout(() => {
      sendInput("click:" + serial);   // ask the server (OPL / name for other mobiles)
      if (!isItem) showNameOverhead(serial); // float the name now, in its notoriety colour
      clickPend = null;
    }, DBLCLICK_MS) };
    // Arm a ground-item pointer-drag: a left-press on a world item may turn into a
    // drag once the cursor moves past DRAG_THRESHOLD (see setupItemDnD). Until then
    // this stays a normal click; starting a drag cancels the pending name-request.
    if (isItem) {
      const it = (scene && scene.items || []).find((x) => (x.serial >>> 0) === (serial >>> 0));
      groundDrag = { serial: serial >>> 0, g: it ? it.g : 0, amount: (it && (it.amount | 0)) || 1,
                     st: !!(it && it.st), hue: (it && it.hue) | 0,
                     sx: e.clientX, sy: e.clientY, started: false, t: performance.now() };
    }
  }
}

// Is this click on the avatar itself? Our own mobile is deliberately NOT a click
// target (so it never eats RMB steering), so a click on the band it occupies at
// the canvas centre is resolved to self instead. dxp/dyp and the 28/68/14
// constants are CSS-client px tuned at zoom 1, so the per-window CSS stretch
// cancels out and only camZoom needs folding in — the sprite is a child of
// app.stage, which camZoom scales — else a self-heal misses the (larger) body
// when zoomed in, or grabs nearby ground when zoomed out.
function clickIsSelfBand(clientX, clientY) {
  if (!(scene && scene.player) || !app || !app.canvas) return false;
  const r = app.canvas.getBoundingClientRect();
  const dxp = (clientX - r.left) - r.width / 2, dyp = (clientY - r.top) - r.height / 2;
  return Math.abs(dxp) < 28 * camZoom && dyp > -68 * camZoom && dyp < 14 * camZoom;
}

// The `z` a 0x6C reply must carry for a MAP STATIC, which is not simply the
// static's own z. ClassicUO (`TargetManager.Target`) adds the tiledata height
// back on for a SURFACE tile on client 7.0.9.0+:
//
//     if (Version >= CV_7090 && itemData.IsSurface) z += itemData.Height;
//
// and that is not cosmetic — it is one half of a round trip. ServUO undoes it
// (`PacketHandlers.TargetResponse`: `if (state.HighSeas) { if (id.Surface) z -=
// id.Height; }`) before validating the reply against `map.Tiles.GetStaticTiles`,
// and it sets `HighSeas` from the client version we ourselves advertise —
// 7.0.102.3 (`anima-core net/login.rs`) lands in `ProtocolChanges.Version70610`,
// which includes `HighSeas`. So we DO need it: without the addition the shard
// subtracts a height nobody added and every surface static fails validation,
// which cancels the whole target. Measured against this install's tiledata a
// table is Surface/height 6 and stone stairs Surface/height 5, so those two are
// off by 6 and 5 — the harvest targets happen not to be (a tree is Impassable,
// not Surface; `cave floor`, the static half of Mining's tile list, is Surface
// with height 0), which is exactly why this has to be reasoned from the version
// rather than from whether chopping works.
//
// `pf` bit 1 is `TileFlag.Surface` and `h` the tiledata height, both baked into
// the static record by the server (`scene/tiles.rs` `path_bits`). They are
// PATH_RADIUS-gated (10 tiles), so a static further out reports neither and gets
// no adjustment — correct for every non-surface object at any range, and beyond
// the reach of every harvest/spell target anyway; a surface static past 10 tiles
// is the one case this cannot get right, and only the server can fix that.
function staticTargetZ(st) {
  const z = st.z | 0;
  return ((st.pf | 0) & 2) !== 0 ? z + (st.h | 0) : z;
}

// A left-click landed on a map static (tree, wall, mountain face, house wall).
// Statics have no serial, so this is deliberately NOT `onEntityPointerDown`:
// it answers a target cursor with `targetxy` carrying the static's own graphic
// and z, and single-click floats its name. Everything else a static cannot do
// (double-click use, drag, context menu, attack) is simply absent.
function onStaticPointerDown(sp, e) {
  if (e.button !== 0) return;   // right button still steers (a static has no context menu)
  const st = sp && sp._st;
  if (!st) return;
  // Multi placement and custom-house design own the click while they are up,
  // and both want the GROUND point: the footprint/ghost previews are computed
  // from `groundTileAt`, and answering a house placement with a static would
  // make ServUO validate the tile and cancel the entire target on any mismatch
  // (a `MultiTarget` is still an ordinary 0x6C, so it goes through the same
  // `GetStaticTiles` check). ClassicUO carries `SendMultiTarget`, which forces
  // graphic 0, for exactly this. So fall through to the canvas handler, which
  // already sends graphic 0 — see `setupInput`'s mousedown.
  if (scene && scene.houseDesign && handleHouseDesignStatic(st)) return;
  if (scene && (scene.placement || scene.houseDesign)) return;
  entityClickedAt = performance.now();
  if (inspectPick) { inspectPicked({ x: st.x | 0, y: st.y | 0 }); return; }
  if (scene && scene.target && scene.target.active === 1 && !targetUIHidden) {
    // A static drawn over the avatar — standing under a tree, inside a doorway —
    // must not steal the self-target the canvas handler resolves from that band:
    // the avatar is not a click target, so nothing else would win it back, and
    // every self-cast bandage/heal in a forest would land on the tree. Leave the
    // click alone (no `targetConsumedAt`) so that handler still sees it.
    if (clickIsSelfBand(e.clientX, e.clientY)) return;
    targetConsumedAt = performance.now();
    // The RAW map graphic (`st.g`), never the drawn one (`st.dg`): the seasonal
    // remap and the StaticFilters toggles are client-side art substitutions,
    // while ServUO validates against `map.Tiles.GetStaticTiles(x, y)` — the
    // unremapped ids. (ClassicUO sends `Static.Graphic`, which its own
    // `SetGraphicBySeason` has already overwritten, so a winter tree fails
    // there; `OriginalGraphic` is what it should send and what `st.g` is.)
    // ClassicUO stores the ADJUSTED z here too (`TargetManager.Target`:
    // `z += itemData.Height` then `LastTargetInfo.SetStatic(graphic, x, y, z)`
    // and `TargetPacket` with the same z), so a replay resends identical bytes.
    rememberTargetTile(st.x, st.y, staticTargetZ(st), st.g);
    sendInput(`targetxy:${st.x | 0}:${st.y | 0}:${staticTargetZ(st)}:${st.g | 0}`);
    endTargetUI();
    return;
  }
  showStaticName(sp, st);
}

// ---- single-click name on a map static --------------------------------------
// ClassicUO's `case Static st:` arm of the no-target left-click
// (`GameSceneInputHandler`): float the tile's name over it and put the same line
// in the journal. Its name is `Static.Name`, which IS the tiledata `ItemData.Name`,
// and only when that is empty does it fall back to cliloc `1020000 + graphic`
// (`Clilocs.GetString(1020000 + st.Graphic, st.ItemData.Name)` — note the tiledata
// name is that call's own default too, so the two can only ever disagree when
// tiledata has nothing).
//
// This is the one named thing in the world that cannot come off the scene: a
// static has no serial, so it has no OPL and no `scene.opl` entry, and the
// per-static payload is far too hot to carry a string (a 49x49 window emits
// thousands of them). It is a per-GRAPHIC asset lookup instead, memoized here —
// a forest is a few dozen graphics repeated a thousand times.
const staticNameCache = new Map();   // graphic -> name | null (null = server had none)
function staticTileName(g, cb) {
  const id = g | 0;
  if (staticNameCache.has(id)) { cb(staticNameCache.get(id)); return; }
  fetch("tilename/" + id)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const name = (j && typeof j.name === "string" && j.name) ? j.name : null;
      staticNameCache.set(id, name);
      cb(name);
    })
    .catch(() => { staticNameCache.set(id, null); cb(null); });
}

// Floating static labels currently on screen: { el, x, y, z, top, born, ttl }.
// A list of its own rather than an entry in `overheads` (08-overlays.js) because
// that one anchors every line to an `anim` state — i.e. to a MOBILE — and drops
// any line whose anchor it cannot find. A static is a fixed world point with no
// such entry, so it gets the same container, class and fade with its own pump.
let staticLabels = [];
const STATIC_LABEL_TTL = 3000;   // same linger as a single-clicked mobile name
function showStaticName(sp, st) {
  // Above the ART, not above the tile: statics are foot-anchored at
  // `isoY(x, y, z) + HALF` (see the static pool in syncWorld), so the top of a
  // 20-tall tree is that minus its texture height. Measured HERE, before the
  // name lookup's round trip, because the sprite can be reaped and destroyed
  // while that is in flight — and read once rather than per frame, so the label
  // does not bob along with an animated static's differing frame heights.
  const top = (sp ? sp.height : 0) + 4;
  staticTileName(st.g, (name) => {
    if (!name) return;           // no tiledata/cliloc text — say nothing, don't invent one
    // Journal it too: ClassicUO routes this through `MessageManager.HandleMessage`
    // as a CLIENT Label, so it lands in the journal exactly like a mobile's name.
    addSysMessage(name);
    const el = document.createElement("div");
    el.className = "oh-label oh-name";
    el.textContent = name;
    el.style.color = msgColor(6, 0x03b2);   // ClassicUO's hue for this line
    namesEl().appendChild(el);
    staticLabels.push({ el, x: st.x | 0, y: st.y | 0, z: st.z | 0, top,
                        born: performance.now(), ttl: STATIC_LABEL_TTL });
    while (staticLabels.length > 8) { const o = staticLabels.shift(); o.el.remove(); }
    if (staticLabels.length === 1) requestAnimationFrame(pumpStaticLabels);
  });
}
// Keep each label pinned over its world point while the camera pans, fade it out
// at the end of its life, then reap it. Same screen math as `drawOverheads`: the
// canvas is CSS-stretched from a capped renderer buffer, so renderer px must be
// scaled back into client px (fx/fy) after the camera + zoom transform.
function pumpStaticLabels() {
  if (!staticLabels.length) return;
  const now = performance.now();
  const fx = window.innerWidth / app.renderer.width, fy = window.innerHeight / app.renderer.height;
  for (let i = staticLabels.length - 1; i >= 0; i--) {
    const o = staticLabels[i];
    const age = now - o.born;
    if (age >= o.ttl) { o.el.remove(); staticLabels.splice(i, 1); continue; }
    o.el.style.left = ((app.stage.x + isoX(o.x, o.y) * camZoom) * fx) + "px";
    o.el.style.top = ((app.stage.y + (isoY(o.x, o.y, o.z) + HALF - o.top) * camZoom) * fy) + "px";
    o.el.style.opacity = age > o.ttl - 600 ? String((o.ttl - age) / 600) : "1";
  }
  if (staticLabels.length) requestAnimationFrame(pumpStaticLabels);
}

// Invert the iso projection at the player's z to get the world tile under a click
// (renderer-space global coords minus the camera offset). Matches the forward
// projection isoX/isoY with HALF/ZSTEP; z is assumed to be the player's z.
function groundTileAt(gx, gy) {
  const z = scene && scene.player ? (scene.player.z | 0) : 0;
  // app.stage is scaled by camZoom (mouse-wheel zoom), so undo that scale to get
  // back to unscaled world-iso pixels before inverting the projection.
  const sx = (gx - app.stage.position.x) / camZoom, sy = (gy - app.stage.position.y) / camZoom;
  const a = sx / HALF, b = (sy + z * ZSTEP) / HALF;
  return { x: Math.round((a + b) / 2), y: Math.round((b - a) / 2), z };
}
// Brief destination marker for click-to-walk: a fading diamond on the target tile.
// Added to `world` so it pans with the map; self-destroys after a short fade.
let walkMarker = null;
function showWalkMarker(x, y, z) {
  if (walkMarker) { world.removeChild(walkMarker); walkMarker.destroy(); walkMarker = null; }
  const g = new PIXI.Graphics();
  g.moveTo(0, -HALF / 2).lineTo(HALF, 0).lineTo(0, HALF / 2).lineTo(-HALF, 0).closePath();
  g.fill({ color: 0x66ddff, alpha: 0.35 });
  g.stroke({ color: 0xaaf0ff, width: 2, alpha: 0.9 });
  g.x = isoX(x, y); g.y = isoY(x, y, z); g.zIndex = depthZ(x, y, z, 9);
  world.addChild(g);
  walkMarker = g;
  const t0 = performance.now();
  const tick = () => {
    if (walkMarker !== g) return;            // replaced by a newer click
    const a = 1 - (performance.now() - t0) / 700;
    if (a <= 0) { world.removeChild(g); g.destroy(); walkMarker = null; markDirty(); return; }
    g.alpha = a; markDirty();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
// Multi placement preview: draws the house/boat footprint under the cursor
// while the server has a pending placement target (`scene.placement` — absent
// otherwise, so this is a no-op against an older server that never sends it).
// Placing a large building blind, with only a plain target cursor, is the
// problem this solves. ClassicUO's GameScene derives the multi's origin from
// the hovered world tile (hx,hy) as originX = hx - xOff, originY = hy - yOff,
// then draws each footprint offset at (originX+dx, originY+dy) — mirrored
// below. Each footprint tile is its own diamond, a direct child of `world`
// (not one shared container) so its own zIndex sorts against terrain/statics
// individually — exactly like showWalkMarker's single diamond, just tiled.
// On top of the outline we also draw the actual house art (walls/roof/doors)
// from `scene.placement.parts` — the flat footprint alone tells you WHERE a
// house will sit but not what it looks like or how tall it is, which matters
// a lot when you're choosing a spot for a specific building. `parts`/`tiles`
// share one lifecycle (one list, one clear, one rebuild guard) since they're
// really the same preview, just two layers of it.
let placementHoverX = null, placementHoverY = null; // world tile under the cursor
let placementTiles = [];  // footprint diamonds + house-art sprites currently in `world`
let placementKey = null;  // last (placement, hovered tile) drawn — dedups rebuilds
let placementPartsPending = false; // true if the last rebuild skipped a part still awaiting its texture
function clearPlacementPreview() {
  for (const g of placementTiles) { world.removeChild(g); g.destroy(); }
  placementTiles = [];
  placementKey = null;
  placementPartsPending = false;
}
// Rebuilds the footprint only when the placement or the hovered TILE actually
// changed (mousemove fires far more often than the tile does, and a house
// footprint can be a few hundred tiles — see the mousemove handler in
// setupInput that maintains placementHoverX/Y). Called both from poll() (to
// pick up a fresh/cleared scene.placement) and from that mousemove handler.
function updatePlacementPreview() {
  const p = scene && scene.placement;
  if (!p || placementHoverX == null) {
    if (placementTiles.length) { clearPlacementPreview(); markDirty(); }
    return;
  }
  const key = p.multiId + "/" + p.xOff + "/" + p.yOff + "/" + p.zOff + "/" +
              (p.tiles ? p.tiles.length : 0) + "/" + (p.parts ? p.parts.length : 0) +
              "@" + placementHoverX + "," + placementHoverY;
  // Same (placement, hovered tile) normally means nothing changed — EXCEPT
  // when the previous pass skipped a house-art part because texFor() hadn't
  // loaded its texture yet. That load resolves in the background and calls
  // markDirty() when it does, but markDirty() alone just repaints the current
  // (incomplete) sprite list; without also busting the key here, the next
  // poll()'s call would see an unchanged key and bail before ever drawing the
  // now-ready part, silently losing it instead of catching up on a later pass.
  if (key === placementKey && !placementPartsPending) return;
  placementKey = key;
  for (const g of placementTiles) { world.removeChild(g); g.destroy(); }
  placementTiles = [];
  const originX = placementHoverX - (p.xOff | 0), originY = placementHoverY - (p.yOff | 0);
  const fallbackZ = (tileSZ(placementHoverX, placementHoverY) ?? (scene.player ? scene.player.z | 0 : 0)) + (p.zOff | 0);
  // Ground footprint diamonds are only a FALLBACK now: once the translucent
  // house itself is drawn (below) the grid under the cursor is just noise, so
  // it appears solely when there is no art to draw — an older server that sends
  // no `parts`, or a multi we couldn't resolve components for.
  const tiles = (p.parts && p.parts.length)
    ? []
    : (p.tiles || []).slice(0, 4096); // match the server's footprint cap
  for (const [dx, dy] of tiles) {
    const tx = originX + dx, ty = originY + dy;
    const z = tileSZ(tx, ty);
    const gz = z != null ? z : fallbackZ;
    const g = new PIXI.Graphics();
    g.moveTo(0, -HALF / 2).lineTo(HALF, 0).lineTo(0, HALF / 2).lineTo(-HALF, 0).closePath();
    g.fill({ color: 0x66ddff, alpha: 0.25 });
    g.stroke({ color: 0xaaf0ff, width: 2, alpha: 0.9 });
    g.x = isoX(tx, ty); g.y = isoY(tx, ty, gz); g.zIndex = depthZ(tx, ty, gz, 9);
    world.addChild(g);
    placementTiles.push(g);
  }
  // House art itself, drawn ABOVE the outline: one sprite per multi COMPONENT
  // (not deduped — a multi-story wall stack needs every floor drawn), offset
  // from the same origin as the tiles above. Every part shares one ground
  // Z (`baseZ`) rather than each looking up its own tileSZ, so the building
  // stays a rigid shape instead of shearing across sloped/uneven terrain —
  // ClassicUO's own multi-preview (GameScene) computes the same way:
  // z = groundZ - ZOff, then each component sits at baseZ + its own dz.
  const groundZ = tileSZ(placementHoverX, placementHoverY) ?? (scene.player ? scene.player.z | 0 : 0);
  const baseZ = groundZ - (p.zOff | 0);
  // Hued art is requested by appending ?hue=<hue> to the art URL (see e.g. the
  // container/paperdoll icons elsewhere in this file) — same convention here.
  const hueQ = (p.hue | 0) ? ("?hue=" + (p.hue | 0)) : "";
  const parts = (p.parts || []).slice(0, 2000); // cap, matching the server's own part cap
  placementPartsPending = false;
  for (const [dx, dy, dz, gph] of parts) {
    const tex = texFor(`art/static/${gph}.png${hueQ}`);
    // Not loaded yet: texFor() already kicked off the load and will markDirty()
    // when it resolves — skip this part for now rather than block, and flag
    // the rebuild-guard override above so a later poll() picks it up instead
    // of it being lost until the placement/hovered tile happens to change.
    if (!tex) { placementPartsPending = true; continue; }
    const tx = originX + dx, ty = originY + dy, tz = baseZ + dz;
    const sp = new PIXI.Sprite(tex);
    sp.anchor.set(0.5, 1.0); // foot-anchored, exactly like the static pool in syncWorld
    sp.x = isoX(tx, ty);
    sp.y = isoY(tx, ty, tz) + HALF;
    sp.zIndex = depthZ(tx, ty, tz, 4); // same bias as real statics — interleaves with terrain naturally
    sp.alpha = 0.6; // preview, not a real building
    world.addChild(sp);
    placementTiles.push(sp);
  }
  markDirty();
}
// House-design placement ghost: the same idea as the multi-placement preview
// just above, scaled down to one tile — while a design session is open
// (scene.houseDesign) AND a catalog piece is selected (hdesignPiece), show
// that piece translucent at the hovered tile so a click's result is never a
// surprise (a design click is otherwise a plain target cursor with no sense
// of where/what will land — the server also drops a bad placement silently,
// see HDESIGN_MAX_GRAPHIC's doc, so a confident preview matters even more
// here). No ghost while erasing (there's nothing being placed to preview) or
// once nothing is selected. Single sprite, not a list — a design piece is one
// tile, never a multi-tile footprint — but otherwise foot-anchored/depth-
// sorted/alpha exactly like the footprint sprites above, and rebuilt only
// when the (piece, hovered tile) pair actually changes, same guard shape.
let hdesignHoverX = null, hdesignHoverY = null; // world tile under the cursor (design mode only)
let hdesignGhost = null;     // the single translucent PIXI.Sprite currently shown, or null
let hdesignGhostKey = null;  // last (piece, tile) drawn — dedups rebuilds
let hdesignGhostPending = false; // true if the last attempt skipped for want of a loaded texture
function clearHouseDesignGhost() {
  if (hdesignGhost) { world.removeChild(hdesignGhost); hdesignGhost.destroy(); hdesignGhost = null; }
  hdesignGhostKey = null;
  hdesignGhostPending = false;
}
// Called from poll() (to react to a fresh session, a piece pick, or the
// session/panel ending) and from the mousemove handler below (to react to the
// hovered tile changing) — same split responsibility as updatePlacementPreview.
function updateHouseDesignGhost() {
  const hd = scene && scene.houseDesign;
  if (!hd || !hdesignPiece || hdesignEraser || hdesignHoverX == null) {
    if (hdesignGhost) clearHouseDesignGhost();
    return;
  }
  const key = [hdesignPiece.graphic, hdesignHoverX, hdesignHoverY, hd.floorZ, hdesignRoofZ].join(":");
  if (key === hdesignGhostKey && !hdesignGhostPending) return; // nothing changed
  const tex = texFor(`art/static/${hdesignPiece.art || hdesignPiece.graphic}.png`);
  if (!tex) { hdesignGhostPending = true; return; } // texFor() will markDirty() once it loads; caught on a later poll
  hdesignGhostKey = key;
  hdesignGhostPending = false;
  if (hdesignGhost) { world.removeChild(hdesignGhost); hdesignGhost.destroy(); hdesignGhost = null; }
  const z = hd.z + (hd.floorZ ?? 7) + (hdesignPiece.mode === "roof" ? hdesignRoofZ : 0);
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(0.5, 1.0); // foot-anchored, exactly like the static pool / multi preview above
  sp.x = isoX(hdesignHoverX, hdesignHoverY);
  sp.y = isoY(hdesignHoverX, hdesignHoverY, z) + HALF;
  sp.zIndex = depthZ(hdesignHoverX, hdesignHoverY, z, 4);
  sp.alpha = 0.6; // preview, not a placed piece
  world.addChild(sp);
  hdesignGhost = sp;
  markDirty();
}
// CSS/client pixels → renderer (global) pixels: the canvas is CSS-stretched from a
// capped internal buffer, so screen px ≠ renderer px (PIXI events use renderer px).
function clientToGlobal(clientX, clientY) {
  const r = app.canvas.getBoundingClientRect();
  return {
    x: (clientX - r.left) / r.width * app.renderer.width,
    y: (clientY - r.top) / r.height * app.renderer.height,
  };
}
// Crosshair + banner while the server waits for a target; Esc/answer hide it.
function endTargetUI() { targetUIHidden = true; updateTargetUI(); }
// ---- UO-style mouse cursors ------------------------------------------------
// Drawn to an offscreen canvas → PNG data URI, so there's no dependency on cursor
// gump art the play server doesn't ship. PIXI owns the canvas cursor (it swaps to
// `cursorStyles[mode]` as you hover entities), so we drive it through cursorStyles
// rather than fighting it with a raw style.cursor that PIXI would overwrite.
let CURSOR_ARROW = "auto", CURSOR_TARGET = "crosshair", CURSOR_TARGET_WAR = "crosshair",
    CURSOR_TARGET_GOOD = "crosshair";
function cursorFromCanvas(size, hotx, hoty, paint) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"); paint(g);
  return `url("${c.toDataURL("image/png")}") ${hotx} ${hoty}, auto`;
}
function buildGameCursors() {
  // Gold arrow pointer — hotspot at the tip (1,1); dark outline reads on any terrain.
  CURSOR_ARROW = cursorFromCanvas(28, 1, 1, (g) => {
    const pts = [[1,1],[1,20],[6,15],[10,23],[13,22],[9,14],[16,14]];
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.lineJoin = "round";
    g.lineWidth = 3; g.strokeStyle = "#1a1206"; g.stroke();   // dark halo
    g.fillStyle = "#f0d27a"; g.fill();                        // gold body
    g.lineWidth = 1; g.strokeStyle = "#8a6a1e"; g.stroke();   // rim
  });
  const reticle = (color) => cursorFromCanvas(32, 16, 16, (g) => {
    g.translate(16, 16); g.lineCap = "round";
    for (const [w, col] of [[3.5, "#12100a"], [1.6, color]]) { // dark halo, then colour
      g.lineWidth = w; g.strokeStyle = col; g.fillStyle = col;
      g.beginPath(); g.arc(0, 0, 9, 0, Math.PI * 2); g.stroke();            // ring
      for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {                 // ticks + centre gap
        g.beginPath(); g.moveTo(dx*4, dy*4); g.lineTo(dx*13, dy*13); g.stroke();
      }
      g.beginPath(); g.arc(0, 0, 1.4, 0, Math.PI * 2); g.fill();            // centre dot
    }
  });
  // ClassicUO tints the target aura by the 0x6C cursor type (GameCursor.cs:361-379):
  // Neutral hue 0x03b2, Harmful 0x0023 (red), Beneficial 0x005A (blue).
  CURSOR_TARGET = reticle("#ffd23f");      // amber reticle — neutral target
  CURSOR_TARGET_WAR = reticle("#ff4d4d");  // red reticle — harmful target (or war, pre-`flag`)
  CURSOR_TARGET_GOOD = reticle("#6cb8ff"); // blue reticle — beneficial target
  applyCursorMode();
}
// Point the canvas cursor at the arrow, or the target reticle while a target cursor
// is up (red in war mode). Updates PIXI's cursorStyles so it survives entity hovers,
// and sets the style directly for an immediate switch (PIXI only re-applies on move).
// The 0x6C cursor type of the pending target — ClassicUO's `TargetType`:
// 0 neutral, 1 harmful, 2 beneficial (3 = cancel never arrives; it clears the
// cursor in the core instead). `null` when the scene predates the field, which
// is the only case the war-mode guess below is still used for.
function targetCursorFlag() {
  const t = scene && scene.target;
  return t && typeof t.flag === "number" ? t.flag | 0 : null;
}
// Which reticle the pending target deserves. This is the whole point of
// carrying the flag: out of war mode an offensive spell used to show the same
// amber reticle a heal did, so nothing on screen distinguished "this will flag
// you criminal" from "this will cure you".
function targetReticle() {
  const f = targetCursorFlag();
  if (f == null) return (scene && scene.war) ? CURSOR_TARGET_WAR : CURSOR_TARGET;
  if (f === 1) return CURSOR_TARGET_WAR;
  if (f === 2) return CURSOR_TARGET_GOOD;
  return CURSOR_TARGET;
}
function applyCursorMode() {
  if (!app || !app.renderer) return;
  const targeting = !!(scene && scene.target && scene.target.active === 1 && !targetUIHidden);
  const base = targeting ? targetReticle() : CURSOR_ARROW;
  const cs = app.renderer.events && app.renderer.events.cursorStyles;
  if (cs) { cs.default = base; cs.pointer = targeting ? base : CURSOR_ARROW; }
  if (app.canvas) app.canvas.style.cursor = base;
}

function updateTargetUI() {
  const active = !!(scene && scene.target && scene.target.active === 1);
  if (active && !prevTargetActive) targetUIHidden = false; // fresh request → show again
  prevTargetActive = active;
  const show = active && !targetUIHidden;
  applyCursorMode();               // arrow ↔ target reticle, coloured by cursor type
  const hint = document.getElementById("targethint");
  if (hint) {
    hint.style.display = show ? "block" : "none";
    // Same information as the reticle colour, in words — a reticle tint is easy
    // to miss mid-fight and the consequence of missing it is a criminal flag.
    const f = show ? targetCursorFlag() : null;
    hint.className = f === 1 ? "harmful" : f === 2 ? "beneficial" : "";
    hint.textContent = (f === 1 ? "Select a HARMFUL target…" : f === 2 ? "Select a BENEFICIAL target…"
                                                             : "Select a target…")
      + "   ( Esc to cancel · F last · V self )";
  }
  if (!show) { clearTargetHighlight(); hideCriminalConfirm(); }   // resolved/cancelled → drop highlight + any confirm
}
// While a target cursor is active, the entity (mobile or world item) under the cursor
// is tinted gold so the player can see exactly what they're about to target. Only one
// at a time; restored on pointer-out or when targeting ends.
let targetHL = null;   // { sp, tint } of the currently-highlighted sprite
const TARGET_HL_TINT = 0xffd24a;
function targetingActive() {
  return !!(scene && scene.target && scene.target.active === 1 && !targetUIHidden);
}
function clearTargetHighlight() {
  if (targetHL && targetHL.sp) { try { targetHL.sp.tint = targetHL.tint; } catch (_) {} markDirty(); }
  targetHL = null;
}
function targetHighlightOn(sp) {
  if (!targetingActive() || !sp || (targetHL && targetHL.sp === sp)) return;
  clearTargetHighlight();
  targetHL = { sp, tint: sp.tint };
  sp.tint = TARGET_HL_TINT;
  markDirty();
}
function targetHighlightOff(sp) {
  if (targetHL && targetHL.sp === sp) clearTargetHighlight();
}


// ---- last target · target verbs · follow mode -------------------------------
//
// ClassicUO keeps a `LastTargetInfo` (TargetManager.cs:115) updated by every
// resolved target and replays it into the *current* cursor with `TargetLast()`
// (:466); the same manager exposes target-self / bandage-self / bandage-target /
// attack-last as macro types (MacroManager.cs:2294-2329). None of that was
// reachable here: a cursor could only be answered by clicking a moving sprite.
//
// The store has ClassicUO's three shapes — an entity, a map static, or a land
// tile — because the 0x6C reply differs between them (`target:` vs `targetxy:`),
// and a replay has to resend the same bytes the original click did.
let lastTargetInfo = null;   // { serial } | { g, x, y, z } | null

// ClassicUO deliberately does NOT record yourself (TargetManager.cs:262:
// `if (entity != _world.Player) LastTargetInfo.SetEntity(serial)`) — a self-cast
// must not overwrite the mob you were fighting.
function rememberTargetEntity(serial) {
  const me = scene && scene.player;
  if (me && (serial >>> 0) === (me.serial >>> 0)) return;
  lastTargetInfo = { serial: serial >>> 0 };
}
// A static (graphic != 0) or a land tile (graphic 0) — ClassicUO's SetStatic /
// SetLand, which differ only in whether a graphic is carried.
function rememberTargetTile(x, y, z, g) {
  lastTargetInfo = { g: g | 0, x: x | 0, y: y | 0, z: z | 0 };
}
// The single place an object-target cursor is answered from a click or a hotkey.
function resolveObjectTarget(serial) {
  rememberTargetEntity(serial);
  sendInput("target:" + (serial >>> 0));
  endTargetUI();
}

// ClassicUO `TargetManager.TargetLast()` (:466): only meaningful while a cursor
// is actually up — with none open it returns silently, and so do we. With a
// cursor open but nothing remembered ClassicUO would send its cleared buffer
// (serial 0, graphic 0xFFFF); we say so in the journal instead of putting a
// junk reply on the wire.
function targetLast() {
  if (!targetingActive()) return;
  if (!lastTargetInfo) { addSysMessage("No last target."); return; }
  targetConsumedAt = performance.now();
  if (lastTargetInfo.serial != null) { resolveObjectTarget(lastTargetInfo.serial); return; }
  const t = lastTargetInfo;
  sendInput(`targetxy:${t.x}:${t.y}:${t.z}:${t.g}`);
  endTargetUI();
}
// ClassicUO MacroType.TargetSelf — answer the open cursor with our own serial.
// Same reply the centre-band click in setupInput sends, without needing the body
// to be un-occluded and clickable.
function targetSelf() {
  if (!targetingActive() || !(scene && scene.player)) return;
  targetConsumedAt = performance.now();
  sendInput("target:" + (scene.player.serial >>> 0));   // never recorded as last target
  endTargetUI();
}

// ClassicUO `PlayerMobile.FindBandage()` (PlayerMobile.cs:107): the FIRST clean
// bandage (0x0E21) sitting directly in the backpack — not recursive, and bloody
// bandages (0x0E20) don't count. `scene.contItems` only carries a container the
// server has actually pushed contents for, so this can legitimately come up
// empty until the backpack has been opened once; say so rather than no-op.
// Both entry points — this hotkey and the `bandageself` macro verb — go through
// the ONE search, `cbFind` (07-hud.js), which walks everything carried rather
// than only the backpack's direct children and picks the plainest hue as
// ClassicUO's FindItem does. They were briefly two implementations, with two
// top-level constants of the same name that made the page a SyntaxError; the
// constant now lives in 00-state.js and the macro path is the one that was
// verified live (a real bandage stack going 10 to 9), so the hotkey inherits
// the evidence rather than carrying a second, untested copy.
function findBandage() {
  const it = cbFind(BANDAGE_GRAPHIC, null);
  return it ? (it.serial >>> 0) : 0;
}
// ClassicUO MacroType.BandageSelf / BandageTarget on a modern client
// (MacroManager.cs:1324-1337): `Send_TargetSelectedObject(bandage, target)` —
// one 0xBF/0x2C packet, no cursor round trip. `bandage:<item>[:<target>]` is
// exactly that packet (target 0 = ourselves, resolved by the driver).
function bandageSelf() {
  const b = findBandage();
  if (!b) { addSysMessage("You have no bandages."); return; }
  sendInput("bandage:" + b);
}
function bandageLastTarget() {
  if (!lastTargetInfo || lastTargetInfo.serial == null) { addSysMessage("No last target."); return; }
  const b = findBandage();
  if (!b) { addSysMessage("You have no bandages."); return; }
  sendInput("bandage:" + b + ":" + lastTargetInfo.serial);
}
// ClassicUO MacroType.AttackSelectedTarget. Our own remembered target is the
// closer analogue of ClassicUO's `SelectedTarget` than the server's `attacklast`
// is: that one replays `World::last_attack` — the serial we last sent an *attack*
// for — which is a different thing from the last target a cursor resolved onto.
// Fall back to it when nothing has been targeted this session.
function attackLastTarget() {
  if (lastTargetInfo && lastTargetInfo.serial != null) { sendInput("attack:" + lastTargetInfo.serial); return; }
  sendInput("attacklast");
}

// ---- criminal-action confirmation (ClassicUO TargetManager.cs:263-300) -------
// A harmful cursor landing on an Innocent is how a blue character goes criminal
// (guard-whacked in town, and on a Felucca ruleset the first step toward red),
// so ClassicUO puts a QuestionGump in front of it. The mirror case — a
// beneficial cursor on a criminal/murderer/gray — flags you too, and is off by
// default there (Profile.cs:106-107), so it is off by default here.
let crimConfirm = null;   // { serial } while the modal is up, else null
function confirmCriminalTarget(serial, isItem) {
  if (isItem) return true;                       // `SerialHelper.IsMobile` — items never flag
  const me = scene && scene.player;
  if (!me || (serial >>> 0) === (me.serial >>> 0)) return true;   // ClassicUO's `serial != Player`
  // ClassicUO gates on OUR OWN notoriety being Innocent(1) or Ally(2). Ours can
  // be 0/Unknown — 08-overlays.js leans on that when it colours your own name
  // blue — but do NOT read that as "always 0": measured live against ServUO it
  // was 3 (gray) for a GM character, and ServUO's 0x22 MovementAck does carry
  // `Notoriety.Compute(m, m)` on every accepted step (Packets.cs:4521), which
  // the core simply doesn't keep. So branch on the value and treat only the
  // unknown 0 as Innocent — the safe side, since that is the one that still
  // warns.
  if ((me.noto | 0) > 2) return true;            // already gray/criminal/red — nothing left to warn about
  const m = ((scene && scene.mobiles) || []).find((x) => (x.serial >>> 0) === (serial >>> 0));
  if (!m) return true;
  const flag = targetCursorFlag(), noto = m.noto | 0;
  // NotorietyFlag: 1 Innocent · 2 Ally · 3 Gray · 4 Criminal · 5 Enemy · 6 Murderer.
  const harmful = flag === 1 && settings.criminalQuery && noto === 1;
  const beneficial = flag === 2 && settings.beneficialCriminalQuery && (noto === 3 || noto === 4 || noto === 6);
  if (!harmful && !beneficial) return true;
  showCriminalConfirm(serial, m.name);
  return false;
}
function hideCriminalConfirm() {
  crimConfirm = null;
  const el = document.getElementById("crimconfirm");
  if (el) el.style.display = "none";
}
let crimConfirmWired = false;
function showCriminalConfirm(serial, name) {
  const el = document.getElementById("crimconfirm");
  if (!el) { resolveObjectTarget(serial); return; }   // no markup → don't silently eat the click
  crimConfirm = { serial: serial >>> 0 };
  const who = document.getElementById("crimconfirm-who");
  if (who) who.textContent = name ? "Target: " + name : "";
  if (!crimConfirmWired) {
    crimConfirmWired = true;
    // Yes still has to answer the cursor the click was for; the cursor stays open
    // on No, exactly as ClassicUO's QuestionGump leaves it.
    document.getElementById("crimconfirm-yes").addEventListener("click", () => {
      const c = crimConfirm; hideCriminalConfirm();
      if (c && targetingActive()) resolveObjectTarget(c.serial);
    });
    document.getElementById("crimconfirm-no").addEventListener("click", hideCriminalConfirm);
  }
  el.style.display = "block";
}

// ---- follow mode (ClassicUO GameSceneInputHandler.cs:717-728 / GameScene.cs:736-759) ----
// Alt + left-click a mobile and the walker trails it until a right-click. Purely
// client-side there and here: it is a repeated pathfind request, not a protocol
// verb. ClassicUO drives its own `Pathfinder.WalkTo(x, y, z, 1)`; ours drives the
// play server's `walkto` route, which is the same A* one tick behind.
let followTarget = 0;       // serial we're trailing, 0 = not following
let followSentAt = 0;       // perf-ms of the last walkto we issued
let followSentTile = null;  // "x,y" that walkto was aimed at (null = no route of ours is live)
const FOLLOW_DIST = 3;          // ClassicUO GameScene.cs:750 re-paths only while `distance > 3`
const FOLLOW_REPATH_MS = 400;   // one route per walk cadence; a new walkto resets the server's
                                // denied-tile blacklist, so re-issuing faster than it can step is wasteful
const FOLLOW_REFRESH_MS = 2000; // re-issue the same goal this often, so a route the server
                                // abandoned (blocked, runaway guard) doesn't strand us
function startFollowing(serial) {
  serial = serial >>> 0;
  const me = scene && scene.player;
  if (!me || serial === (me.serial >>> 0)) return;
  // ClassicUO's arm is `ent is Mobile` — you cannot follow an item.
  if (!((scene.mobiles || []).some((m) => (m.serial >>> 0) === serial))) return;
  followTarget = serial;
  followSentAt = 0; followSentTile = null;
  addSysMessage("Now following.");     // ClassicUO ResGeneral.NowFollowing
}
function stopFollowing() {
  if (!followTarget) return;
  const hadRoute = followSentTile != null;
  followTarget = 0; followSentAt = 0; followSentTile = null;
  // ClassicUO's StopFollowing also calls `Pathfinder.StopAutoWalk()`; without
  // that the character keeps walking the rest of the route after you've said
  // stop. The play server has no "cancel route" verb — only a manual `walk` or
  // a fresh `walkto` clears `auto_goal` — so re-aim the route at the tile we're
  // already on, which `prepare_walkto` resolves to an empty path and a stop. It
  // costs one "walkto (x,y): already there" System line in the journal, which
  // is much cheaper than walking on unasked; only sent when a route was live.
  if (hadRoute && scene && scene.player) sendInput(`walkto:${scene.player.x | 0},${scene.player.y | 0}`);
  addSysMessage("Stopped following.");  // ClassicUO ResGeneral.StoppedFollowing
}
// Called once per rendered frame from `activeMove`, and only when nothing else
// wants to move us — a held key or RMB steering returns before this, which is
// what lets manual walking suspend follow the way ClassicUO's
// `!Pathfinder.AutoWalking` gate does (and the server drops `auto_goal` on any
// manual `walk`, so the two agree).
function followTick() {
  if (!followTarget) return;
  const me = scene && scene.player;
  if (!me) return;
  const m = ((scene.mobiles) || []).find((x) => (x.serial >>> 0) === followTarget);
  // ClassicUO stops when the mobile is gone or past ClientViewRange; anything
  // out of our view range is already absent from `scene.mobiles`, so the two
  // conditions collapse into one here.
  if (!m) { stopFollowing(); return; }
  // UO "Distance" is Chebyshev — a diagonal is one tile.
  const d = Math.max(Math.abs((m.x | 0) - (me.x | 0)), Math.abs((m.y | 0) - (me.y | 0)));
  if (d <= FOLLOW_DIST) return;
  const now = performance.now();
  if (now - followSentAt < FOLLOW_REPATH_MS) return;
  const tile = (m.x | 0) + "," + (m.y | 0);
  if (tile === followSentTile && now - followSentAt < FOLLOW_REFRESH_MS) return;
  followSentTile = tile; followSentAt = now;
  sendInput("walkto:" + tile);
}

// ---- built-in target hotkeys ------------------------------------------------
// ClassicUO ships these as macro types with no default key, because its macro
// editor can bind anything; ours are fixed keys documented in the HUD legend.
// Registered at file scope (like 01-audio.js's unlock listeners) rather than in
// `setupInput`, which lives in 13-macros.js — and deliberately BEFORE it in
// listener order, so `macroFor` is consulted here first: a user macro bound to
// one of these combos wins, and none of these codes is one setupInput handles.
window.addEventListener("keydown", (e) => {
  if (chatting || e.repeat) return;
  if (isTypingTarget(e.target)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;    // plain / Shift only
  if (typeof macroFor === "function" && macroFor(e)) return;  // a user macro owns this combo
  switch (e.code) {
    case "KeyF": e.preventDefault(); e.shiftKey ? attackLastTarget() : targetLast(); return;
    case "KeyV": if (e.shiftKey) return; e.preventDefault(); targetSelf(); return;
    case "KeyX": e.preventDefault(); e.shiftKey ? bandageLastTarget() : bandageSelf(); return;
  }
});
