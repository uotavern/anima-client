// Replay owns a simulation clock and never opens a shard session.
const REPLAY_MODE = new URLSearchParams(location.search).has("replay");
let replayClockMs = 1000;
function visualNow() { return REPLAY_MODE ? replayClockMs : performance.now(); }
// anima-client renderer — isometric, real UO sprites, smooth (interpolated) camera.
//
// Tiles/statics live in ABSOLUTE world-iso coordinates in a persistent pool: as
// the player walks we only add/remove the edge tiles entering/leaving the view —
// never a full rebuild. The camera (stage offset) follows the player's *eased*
// position every frame, so movement scrolls smoothly. Entities are redrawn each
// frame at their interpolated positions with walk/idle animation frames.

const HALF = 22, ZSTEP = 4;
// `/?wasm=1` (and `/wasm.html` → that URL): protocol in anima-wasm, map from /terrain.json.
const WASM_MODE = (function () {
  try {
    const u = new URL(location.href);
    if (u.searchParams.get("wasm") === "1") return true;
    return /(?:^|\/)wasm\.html$/i.test(u.pathname);
  } catch (e) {
    return false;
  }
})();
// Resting alpha for a `TileFlag.Translucent` static/item (scene field `tr`).
// ClassicUO eases such an object's AlphaHue to 178 and the shader consumes it as
// `AlphaHue / 255f` (GameSceneDrawingSorting.cs:371, StaticView.cs:63,
// ItemView.cs:49) — so 0.698, not a half. (ClassicUO's 0.5 lives at
// GameEffectView.cs:118, a different mechanism on the effects path.)
const A_TRANSLUCENT = 178 / 255;
// Shared filter for statics drawn in the grayed-out beyond-view ring (see
// syncWorld's statics loop): grayscale + a brightness lift so it reads as a
// light gray matching the lifted land-tile gray below, rather than a dim/dark
// desaturation. desaturate()/brightness() aren't chainable in this PIXI build
// (neither returns `this`), so they're called on their own lines.
const STATIC_GRAY = new PIXI.ColorMatrixFilter();
STATIC_GRAY.desaturate();
STATIC_GRAY.brightness(1.1, true);
// ClassicUO people animation groups (`PeopleAnimationGroup`)
const WALK = 0, WALK_ARMED = 1, RUN_UNARMED = 2, RUN_ARMED = 3, STAND = 4;
// War-mode idle stance: PAG_STAND_ONEHANDED_ATTACK (the combat-ready pose a person
// holds while standing in war mode). ClassicUO swaps the plain Stand (4) for this.
const PEOPLE_COMBAT_STAND = 7;
const WALK_WARMODE = 15; // walking in war mode (not running)
const ONMOUNT_WALK = 23, ONMOUNT_RUN = 24, ONMOUNT_STAND = 25;
const CHAR_ANIM_DELAY = 80; // ClassicUO Constants.CHARACTER_ANIMATION_DELAY (ms/frame)
// Animation GROUP NUMBERS differ by body type (ClassicUO): monster Walk=0/Stand=1,
// animal Walk=0/Run=1/Stand=2, people Walk=0/Run=2/Stand=4. `atype` (0 monster /
// 1 animal / 2 people) comes from the server (mobtypes.txt), which is authoritative
// over the raw body-range guess (fallback when `atype` is absent). Using the wrong
// type showed an attack pose while idle (the "cat → alligator when idle" bug).
function bodyType(body, atype) {
  return atype != null ? atype : body < 200 ? 0 : body < 400 ? 1 : 2;
}
function animGroup(moving, running, mounted, body, war, atype, armed) {
  if (mounted) return moving ? (running ? ONMOUNT_RUN : ONMOUNT_WALK) : ONMOUNT_STAND;
  const t = bodyType(body, atype);
  if (t === 0) return moving ? 0 : 1;                  // monster: no separate run
  if (t === 1) return moving ? (running ? 1 : 0) : 2;  // animal
  // people: ClassicUO `GetGroupForAnimation` (MobileAnimation.cs). Two-handed
  // (layer 2) swaps Walk/Run for the armed groups so the body pose matches the
  // weapon overlay; war-mode walking uses WalkWarmode rather than the idle walk.
  if (!moving) return war ? PEOPLE_COMBAT_STAND : STAND;
  if (war && !running) return WALK_WARMODE;
  if (running) return armed ? RUN_ARMED : RUN_UNARMED;
  return armed ? WALK_ARMED : WALK;
}

// People animation groups (ClassicUO PeopleAnimationGroup): 16 = CastDirected,
// 17 = CastArea. UO spell casts are sent (0x6E) with the SpellInfo.Action code,
// not a direct group — those live in the ~200+ range and must fold onto the cast
// gesture. Map a 0x6E `action` to the body's real animation group.
const PEOPLE_CAST_DIRECTED = 16;
function resolveActionGroup(action, body, atype) {
  action = action | 0;
  if (bodyType(body, atype) === 2) { // people / humanoid
    if (action >= 200) return PEOPLE_CAST_DIRECTED; // spell cast gesture
    if (action >= 35) return action % 35;           // other out-of-range → fold in
    return action;                                  // direct people group (combat swings, etc.)
  }
  return action;                     // monsters/animals: action indexes their own group set
}

// Convert an 0xE2 NewMobileAnimation's `(typ, action, mode)` to a real per-body
// animation group, following ClassicUO `Mobile.GetObjectNewAnimation` /
// `GetObjectNewAnimationType_*` exactly. `typ` is the wire `AnimationType`
// (Server/Mobile.cs): 0 Attack, 1 Parry, 2 Block, 3 Die, 4 Impact, 5 Fidget,
// 6 Eat, 7 Emote, 8 Alert, 9 TakeOff, 10 Land, 11 Spell, 14 Pillage (12
// StartCombat/13 EndCombat/15 Spawn aren't special-cased upstream either — they
// fall through to group 0, same as here). `mode` is the wire "delay" byte,
// which ClassicUO uses only as a `mode % 2/3/4` seed to pick between a few
// cosmetically-equivalent variants of the same action (NOT a timing value).
// ClassicUO keys off the body's 5-way AnimationGroupsType (Monster/SeaMonster/
// Animal/Human/Equipment); our server only hands us the 3-way `atype`
// (0 monster+sea_monster / 1 animal / 2 people+equipment, see anima-assets
// mobtypes parsing + resolveActionGroup above), so the rare true-SeaMonster
// case plays the Monster variant here instead of ClassicUO's differing (often
// "no animation") one — a small, deliberate loss of fidelity consistent with
// the same collapse `resolveActionGroup`/`bodyType` already make for 0x6E.
// Likewise gargoyle-only flight variants (e.g. Emote-while-flying) aren't
// modeled — those fall back to the grounded/human variant. Returns `null` when
// ClassicUO's own mapping is "don't animate" (its `0xFF` sentinel), e.g. an
// Attack/Parry/Block/Impact/Alert/Spell sent to a mounted person.
function resolveTypedAnimGroup(typ, action, mode, body, atype, mounted) {
  const t = bodyType(body, atype); // 0 monster(+sea_monster), 1 animal, 2 people(+equipment)
  const monster = t === 0, animal = t === 1; // people/equipment: else
  switch (typ) {
    case 0: // Attack
      if (action > 10) return 0; // CUO GetObjectNewAnimationType_0: out-of-range action still plays group 0, not "no animation"
      if (monster) return mode % 4 === 1 ? 5 : mode % 4 === 2 ? 6 : 4;
      if (animal) return mode % 2 !== 0 ? 6 : 5;
      if (mounted) return action > 0 ? (action === 1 ? 27 : action === 2 ? 28 : 26) : 29;
      switch (action) {
        case 1: return 18;
        case 2: return 19;
        case 6: return 12;
        case 7: return 13;
        case 8: return 14;
        case 3: return 11;
        case 4: return 9;
        case 5: return 10;
        default: return 31;
      }
    case 1: case 2: // Parry / Block
      if (monster) return mode % 2 !== 0 ? 15 : 16;
      if (animal || mounted) return null;
      return 30;
    case 3: // Die
      if (monster) return mode % 2 !== 0 ? 2 : 3;
      if (animal) return mode % 2 !== 0 ? 21 : 22;
      return mode % 2 !== 0 ? 8 : 12;
    case 4: // Impact
      if (monster) return 10;
      if (animal) return 7;
      return mounted ? null : 20;
    case 5: // Fidget
      if (monster) return mode % 2 !== 0 ? 18 : 17;
      if (animal) return mode % 3 === 1 ? 10 : mode % 3 === 2 ? 3 : 9;
      return mounted ? null : (mode % 2 !== 0 ? 6 : 5);
    case 6: case 14: // Eat / Pillage
      if (monster) return 11;
      if (animal) return 3;
      return mounted ? null : 34;
    case 7: // Emote (e.g. .bow / .salute)
      if (mounted) return null;
      return action === 0 ? 32 : action === 1 ? 33 : 0;
    case 8: // Alert
      if (monster) return 11;
      if (animal) return 9;
      return mounted ? null : 33;
    case 9: // TakeOff
    case 10: // Land
      return monster ? 20 : null; // non-gargoyle person/animal: no anim (matches CUO)
    case 11: // Spell
      if (monster) return 12;
      if (mounted) return null;
      return action === 1 || action === 2 ? 17 : 16;
    default: // 12 StartCombat, 13 EndCombat, 15 Spawn, anything else
      return 0;
  }
}
let app, world, entLayer, mobs, overLayer, barLayer, itemLayer, guardLineLayer;
let scene = null;
// Mouse-wheel camera zoom: scales app.stage (world sprites auto-scale as its
// children); world-anchored HTML/2D-canvas overlays fold camZoom into their
// manual (stage + worldIso) math — see drawOverheads/drawDamage/drawBars/fxFrame.
let camZoom = 1;
const ZOOM_MIN = 0.6, ZOOM_MAX = 2.6;
// Wheel/trackpad zoom rate: camZoom *= exp(-deltaY * K). At K=0.001 a clamped
// mouse notch (|deltaY|→100) is ~10% per notch (the old fixed-factor feel), while
// a trackpad's many tiny deltas accumulate smoothly instead of compounding.
const ZOOM_WHEEL_K = 0.001;
// Render-on-demand: only re-draw the canvas when the scene changed. markDirty()
// requests one redraw; movement/animation/polls set it. Starts true (first draw).
let dirty = true;
const markDirty = () => { dirty = true; };

// ---- overhead speech (ClassicUO-style floating text above the speaker) ----
const overheads = [];          // { id, text, color, born, ttl, sprite }
let lastJournalSeq = 0;

// ---- floating combat damage numbers (0x0B) ----
const damageFloaters = [];     // { id, sprite, born, ttl }
let lastDamageSeq = 0;         // highest damage event seq we've already floated
let lastAnimSeq = 0;           // highest character-animation (0x6E) event we've played
let lastTypedAnimSeq = 0;      // highest typed-animation (0xE2) event we've played
// Map a 0x6E `action` to the animation group for this body. For people (>=400) the
// action IS the people group (9=1H attack, 12-14=2H, 18/19=bow, 20=get-hit, …); for
// monsters/animals the action indexes their own group set — pass it through either way.
const CHAR_ANIM_FRAME_MS = 110; // per-frame time of a one-shot action (≈ClassicUO)
const DAMAGE_TTL = 1000;       // ms a number lives (rises + fades over this)
const DAMAGE_RISE = 20;        // px it rises over its life

// ---- graphical effects (0x70/0xC0/0xC7): spell bolts, hit sparkles, explosions,
// fields. Each scene effect spawns a short-lived animated sprite in `world`
// (above the world; no world re-sort). Frames + interval are baked server-side
// from animdata.mul; we just cycle them, tint by hue, and position per kind. ----
const fxEffects = [];          // { seq, kind, frames[], fm, born, totalMs, sprite, hue, anchors… }
let lastEffectSeq = 0;         // highest effect event seq we've already spawned
let lastDragAnimSeq = 0;       // highest 0x23 DragAnimation seq we've spawned

// ---- lift-rejection events (0x27 LiftRej) ----
let lastLiftRejectSeq = 0;     // highest lift-reject event seq we've already handled

// ---- item-drag completion events (0x28 EndDraggingItem / 0x29 accepted) ----
let lastDragCompletionSeq = 0; // highest drag-completion event seq we've handled

// ---- death-screen events (0x2C; actual dead state remains body-derived) ----
let lastDeathScreenSeq = 0;
let deathBannerUntil = 0;
let deathBannerTimer = null;

// ---- server-initiated container opens (0x24 DrawContainer) ----
let lastContainerOpenSeq = 0;  // highest container-open event seq we've already handled

// ---- Swing events (0x2F): briefly face the attacker toward the defender ----
let lastSwingSeq = 0;          // highest swing event seq we've already handled

// ---- server-initiated paperdoll open/refresh (0x88 DisplayPaperdoll) ----
let lastPaperdollSeq = 0;      // highest paperdoll-signal seq we've already handled
// ---- validated server external-URL requests (0xA5 OpenUrl) ----
let lastOpenUrlSeq = 0;
const openUrlQueue = [];
let openUrlWin = null;
// ---- server Tip/Notice windows (0xA6 ScrollMessage) ----
let lastTipNoticeSeq = 0;
const tipNoticeWindows = new Map(); // seq -> live DOM window
// ---- legacy modal text-entry dialogs (0xAB) ----
// ---- character profile windows (0xB8) ----
// ---- server-authorized logout (0xD1) ----
let lastLogoutAckSeq = 0;
let logoutPending = false;
// ---- High Seas smooth boat movement (0xF6) ----
let lastBoatMoveSeq = 0;
const boatGlides = new Map(); // entity serial -> queued rigid movement segments
// { serial, title, canLift } for whichever target the LAST server signal named —
// read by refreshPaperdoll() to show the real title line instead of the plain
// mobile name, when it matches the currently-displayed doll.
let pdServerInfo = null;
// ---- treasure/decoration map windows (0x90/0xF5 DisplayMap(New) + 0x56
// MapCommand) — one window per serial (unlike the paperdoll's single slot),
// so this is a per-serial seq gate, not one global counter. See
// `refreshMapWindows`'s doc for the open-vs-refresh split.
// ClassicUO ServerErrorMessages._pickUpErrors, indexed by the wire reason byte;
// any reason >= 4 (including the "generic/Inspecific" 5) reads the same message
// as 4 (ClassicUO clamps `code >= 5` to `code = 4`).
const LIFT_REJECT_MSG = [
  "You can't pick that up.",           // 0 CannotLift
  "That is too far away.",             // 1 OutOfRange
  "That is out of sight.",             // 2 OutOfSight
  "That item does not belong to you.", // 3 BelongsToAnother
  "You are already holding an item.",  // 4 AlreadyHolding / generic fallback
];

// ---- user settings (persisted to localStorage; edited via the Options panel) ----
const SETTINGS_KEY = "anima.settings";
// Bandages. ClassicUO `PlayerMobile.FindBandage()` looks for graphic 0x0E21
// (PlayerMobile.cs:107-118); 0x0E20 is the *bloody* one and does not count.
// Lives here because two features need it — the bandage hotkeys in 12-input.js
// and the bandageself macro verb in 13-macros.js — and two top-level `const`s of
// one name across two script tags is a SyntaxError that kills the later file
// outright. That very collision happened while both were being written; see
// scripts/check-web-globals.mjs, which now catches it.
const BANDAGE_GRAPHIC = 0x0E21;

const SETTINGS_DEFAULTS = {
  sfx: true, sfxVol: 0.4,        // sound effects on/off + volume
  footsteps: true,               // ClassicUO EnableFootstepsSound (default true there too)
  music: true, musicVol: 0.3,    // background music on/off + volume
  tooltips: true,                // OPL hover tooltips
  bars: true,                    // overhead HP bars
  damage: true,                  // floating damage numbers
  names: true,                   // overhead name labels
  abilities: true,               // weapon special-ability bar (also needs server AOS)
  guardZones: false,             // guard-zone (guard line) boundary overlay — off by default
  debugMove: false,               // movement/Z debug HUD (WalkTo rejects, predicted vs server pos)
  autoOpenDoors: true,            // walking into a closed door opens it (ClassicUO TryOpenDoors) — on by default
  autoOpenCorpses: false,         // ClassicUO AutoOpenCorpses — a nearby new corpse double-clicks itself
  autoOpenCorpseRange: 2,         // ClassicUO AutoOpenCorpseRange (its own default)
  skipEmptyCorpse: false,         // ClassicUO SkipEmptyCorpse — hide an auto-opened corpse that has nothing in it
  criminalQuery: true,            // ClassicUO EnabledCriminalActionQuery — confirm a harmful target on an innocent
  beneficialCriminalQuery: false, // ClassicUO EnabledBeneficialCriminalActionQuery (off there too)
  gridLoot: true,                 // corpses open a click-to-loot grid instead of the authentic corpse gump
  gridContainers: false,          // ALL containers as a titled grid (icon+name) vs the authentic gump art (default)
  // ClassicUO ContainersScale (OptionsGump, 50–200, default 100). Applied to
  // authentic container gumps (not chess/backgammon, which ClassicUO leaves at 1).
  containerScale: 100,
  shadows: true,                  // mobile shadows (ClassicUO's ShadowsEnabled, on by default there too)
  // Terrain shading strength — ClassicUO's TerrainShadowsLevel (Profile.cs:237,
  // default 15, slider 5..25 per Constants.cs:27-28). The shader multiplies by
  // `Brightlight = level * 0.1`; at 10 every stretched tile is lit flat.
  terrainShadows: 15,
  shadowsStatics: true,           // …and on trees/foliage/rocks (ClassicUO's ShadowsStatics)
  treeStumps: false,              // draw trees as stumps and drop their canopy (ClassicUO TreeToStumps)
  hideVegetation: false,          // don't draw vegetation at all (ClassicUO HideVegetation)
  // ClassicUO DrawRoofs (Profile.cs, default true). Off → every roof graphic
  // hides even outdoors (`_noDrawRoofs = !DrawRoofs` at UpdateMaxDrawZ start).
  drawRoofs: true,
  alwaysRun: false,            // ClassicUO AlwaysRun — keyboard walks run without Shift
  alwaysRunUnlessHidden: true, // ClassicUO AlwaysRunUnlessHidden — walk while hidden
  // ---- name plates (ClassicUO NameOverHeadManager) ----
  namePlates: false,           // "stay active": plates without holding Ctrl+Shift (NameOverheadToggled)
  plateFilter: "all",          // NameOverheadTypeAllowed: all | mobiles | items | mobcorpses
  // ---- drag-select → pinned health bars (ClassicUO EnableDragSelect) ----
  dragSelect: true,            // sweep a rectangle over a crowd to pin one bar per mobile
  dragSelectMod: "shift",      // DragSelectModifierKey: none | ctrl | shift
  dragSelectHumanoids: false,  // DragSelectHumanoidsOnly
  dragSelectHostile: false,    // DragSelectHostileOnly (skips ally/innocent/invulnerable)
};
let settings = Object.assign({}, SETTINGS_DEFAULTS);
let savedSettingsView = null;
function saveSettings() {
  const previous = JSON.parse(preferenceStorage.getItem(SETTINGS_KEY) || "{}");
  const changes = Object.fromEntries(Object.entries(settings).filter(([k, value]) => value !== savedSettingsView?.[k]));
  const saved = preferenceStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...previous, ...changes }));
  savedSettingsView = { ...settings }; return saved;
}

// ---- the options schema -----------------------------------------------------
// One table describes every option: what it is, where it lives, and what has to
// happen when it changes. `renderOptions` builds the DOM from it and the change
// dispatcher in 13-macros.js reads the same rows, so adding an option is a
// default plus a descriptor — one file — instead of the three hand-synced sites
// it used to be (defaults, the markup string, and a side-effect if-chain).
//
// ClassicUO's own OptionsGump has a left nav of categories; this mirrors it.
const OPTION_CATEGORIES = [
  { key: "audio", label: "Audio" },
  { key: "video", label: "Video" },
  { key: "interface", label: "Interface" },
  { key: "gameplay", label: "Gameplay" },
  { key: "windows", label: "Windows" },
  { key: "session", label: "Session" },
  { key: "data", label: "Settings data" },
];
let optCat = "audio";
// `onChange` is ALWAYS an arrow wrapper, never a bare function reference: this
// array is evaluated while 00-state.js runs — the FIRST script — long before
// rebuildStatics/refreshAbilities/… exist. The arrow defers the name lookup to
// click time, by which point every script has loaded.
//
// `kind`: checkbox | range (0..1, shown ×100) | intRange (real units) | button
// (a launcher/logout with no setting — its click stays in the existing handler,
// matched by `cls`).
const OPTIONS = [
  { key: "sfx", kind: "checkbox", cat: "audio", label: "Sound effects", onChange: () => applyAudioSettings() },
  { key: "sfxVol", kind: "range", cat: "audio", label: "SFX volume", onChange: () => applyAudioSettings() },
  { key: "footsteps", kind: "checkbox", cat: "audio", label: "Footstep sounds" },
  { key: "music", kind: "checkbox", cat: "audio", label: "Music", onChange: () => applyAudioSettings() },
  { key: "musicVol", kind: "range", cat: "audio", label: "Music volume", onChange: () => applyAudioSettings() },

  { key: "shadows", kind: "checkbox", cat: "video", label: "Character shadows", onChange: () => rebuildStatics() },
  { key: "shadowsStatics", kind: "checkbox", cat: "video", label: "Tree & rock shadows", onChange: () => rebuildStatics() },
  { key: "treeStumps", kind: "checkbox", cat: "video", label: "Trees as stumps", onChange: () => rebuildStatics() },
  { key: "hideVegetation", kind: "checkbox", cat: "video", label: "Hide vegetation", onChange: () => rebuildStatics() },
  { key: "drawRoofs", kind: "checkbox", cat: "video", label: "Draw roofs",
    onChange: () => { rebuildStatics(); rebuildItems(); } },
  // The light is baked into each tile's vertices when the sprite is built, so
  // changing it has to throw the tile pool away (not the static pool).
  { key: "terrainShadows", kind: "intRange", cat: "video", label: "Terrain shading", min: 5, max: 25, onChange: () => rebuildTiles() },

  { key: "tooltips", kind: "checkbox", cat: "interface", label: "Item tooltips (OPL)",
    onChange: () => { if (!settings.tooltips) { tipSerial = null; hideTip(); } } },
  { key: "names", kind: "checkbox", cat: "interface", label: "Overhead names" },
  { key: "bars", kind: "checkbox", cat: "interface", label: "HP bars" },
  { key: "damage", kind: "checkbox", cat: "interface", label: "Damage numbers" },
  { key: "namePlates", kind: "checkbox", cat: "interface", label: "Name plates stay on" },
  { key: "plateFilter", kind: "select", cat: "interface", label: "Name plates show",
    opts: [["all", "everything"], ["mobiles", "mobiles only"], ["items", "items only"], ["mobcorpses", "mobiles + corpses"]] },
  { key: "dragSelect", kind: "checkbox", cat: "interface", label: "Drag-select health bars" },
  { key: "dragSelectMod", kind: "select", cat: "interface", label: "Drag-select modifier",
    opts: [["none", "none"], ["ctrl", "Ctrl"], ["shift", "Shift"]] },
  { key: "dragSelectHumanoids", kind: "checkbox", cat: "interface", label: "…humanoids only" },
  { key: "dragSelectHostile", kind: "checkbox", cat: "interface", label: "…hostiles only" },
  { key: "guardZones", kind: "checkbox", cat: "interface", label: "Guard-zone lines (R)", onChange: () => updateGuardZones(scene) },
  { key: "debugMove", kind: "checkbox", cat: "interface", label: "Movement debug" },

  { key: "abilities", kind: "checkbox", cat: "gameplay", label: "Weapon abilities", onChange: () => refreshAbilities(true) },
  { key: "autoOpenDoors", kind: "checkbox", cat: "gameplay", label: "Auto-open doors" },
  { key: "autoOpenCorpses", kind: "checkbox", cat: "gameplay", label: "Auto-open corpses" },
  { key: "autoOpenCorpseRange", kind: "intRange", cat: "gameplay", label: "…within tiles", min: 1, max: 5 },
  { key: "skipEmptyCorpse", kind: "checkbox", cat: "gameplay", label: "…skip empty ones", onChange: () => refreshOpenContainers() },
  { key: "criminalQuery", kind: "checkbox", cat: "gameplay", label: "Confirm criminal actions" },
  { key: "beneficialCriminalQuery", kind: "checkbox", cat: "gameplay", label: "…and helping criminals" },
  { key: "alwaysRun", kind: "checkbox", cat: "gameplay", label: "Always run" },
  { key: "alwaysRunUnlessHidden", kind: "checkbox", cat: "gameplay", label: "Walk while hidden" },
  { key: "gridLoot", kind: "checkbox", cat: "gameplay", label: "Click-to-loot corpses", onChange: () => refreshOpenContainers() },
  { key: "gridContainers", kind: "checkbox", cat: "gameplay", label: "Grid container view", onChange: () => refreshOpenContainers() },
  { key: "containerScale", kind: "intRange", cat: "gameplay", label: "Container scale %", min: 50, max: 200, onChange: () => refreshOpenContainers() },

  { kind: "button", cat: "windows", label: "Journal", cls: "opt-journal" },
  { kind: "button", cat: "windows", label: "Info bar", cls: "opt-infobar" },
  { kind: "button", cat: "windows", label: "Counter bar", cls: "opt-counterbar" },
  { kind: "button", cat: "windows", label: "Ignore list", cls: "opt-ignorelist" },
  { kind: "button", cat: "windows", label: "Combat book", cls: "opt-combatbook" },
  { kind: "button", cat: "windows", label: "Racial abilities", cls: "opt-racialbook" },
  { kind: "button", cat: "windows", label: "Network", cls: "opt-netstats" },
  { kind: "button", cat: "windows", label: "Inspector", cls: "opt-inspector" },
];
preferenceStorage.json(SETTINGS_KEY, value => {
  if (!prefObject(value)) return null;
  const clean = { ...value };
  for (const key of ["__proto__", "constructor", "prototype"]) delete clean[key];
  for (const option of OPTIONS) {
    const key = option.key;
    if (!key || !Object.hasOwn(clean, key)) continue;
    const v = clean[key];
    const valid = option.kind === "checkbox" ? typeof v === "boolean"
      : option.kind === "range" ? prefNumber(v, 0, 1)
      : option.kind === "intRange" ? prefInteger(v, option.min, option.max)
      : option.kind === "select" && option.opts.some(([choice]) => choice === v);
    if (!valid) delete clean[key];
  }
  return clean;
});
{
  const saved = JSON.parse(preferenceStorage.getItem(SETTINGS_KEY) || "{}");
  for (const key of Object.keys(SETTINGS_DEFAULTS)) if (Object.hasOwn(saved, key)) settings[key] = saved[key];
  savedSettingsView = { ...settings };
}
// Build the Options panel from the OPTIONS schema: a category rail on the left,
// and only the ACTIVE category's rows in the body. Only-active-in-DOM keeps the
// panel short and keeps tab order equal to what you can see.
//
// The per-control markup is deliberately identical to what this used to emit by
// hand — `id="opt-KEY"`, `data-k="KEY"`, the `optv-KEY` value span, the `.opt-*`
// button classes — because the delegated listeners in 13-macros.js bind by those
// and nothing else. Regrouping changes where a row appears, never how it works.
function renderOptions() {
  const body = document.getElementById("opt-body");
  const tabs = document.getElementById("opt-tabs");
  if (!body) return;
  if (tabs) {
    tabs.innerHTML = OPTION_CATEGORIES.map((c) =>
      `<button type="button" class="opt-tab${c.key === optCat ? " sel" : ""}" data-cat="${c.key}">${c.label}</button>`
    ).join("");
  }
  const cb = (o) => `<div class="opt-row"><label for="opt-${o.key}">${o.label}</label>`
    + `<input type="checkbox" id="opt-${o.key}" data-k="${o.key}"${settings[o.key] ? " checked" : ""}></div>`;
  // 0..1 value shown ×100 (the volume sliders).
  const sl = (o) => `<div class="opt-row"><label for="opt-${o.key}">${o.label}</label>`
    + `<input type="range" id="opt-${o.key}" data-k="${o.key}" min="0" max="100" value="${Math.round(settings[o.key] * 100)}">`
    + `<span class="opt-val" id="optv-${o.key}">${Math.round(settings[o.key] * 100)}</span></div>`;
  // A real range in real units (ClassicUO's terrain-shadow strength is 5..25).
  const sli = (o) => `<div class="opt-row"><label for="opt-${o.key}">${o.label}</label>`
    + `<input type="range" id="opt-${o.key}" data-k="${o.key}" data-int="1" min="${o.min}" max="${o.max}" value="${settings[o.key] | 0}">`
    + `<span class="opt-val" id="optv-${o.key}">${settings[o.key] | 0}</span></div>`;
  // A fixed set of named choices (ClassicUO's radio-button groups — the name-plate
  // type filter, the drag-select modifier). `data-k` + the `change` dispatcher are
  // the same as a checkbox's; only the value read differs (string, not boolean).
  const sel = (o) => `<div class="opt-row"><label for="opt-${o.key}">${o.label}</label>`
    + `<select id="opt-${o.key}" data-k="${o.key}" class="opt-sel">`
    + o.opts.map(([v, t]) => `<option value="${v}"${settings[o.key] === v ? " selected" : ""}>${t}</option>`).join("")
    + `</select></div>`;
  const btn = (o) => `<label class="opt-row"><button type="button" class="dlg-btn ${o.cls}">${o.label}</button></label>`;
  let html = OPTIONS.filter((o) => o.cat === optCat).map((o) => {
    if (o.kind === "checkbox") return cb(o);
    if (o.kind === "range") return sl(o);
    if (o.kind === "intRange") return sli(o);
    if (o.kind === "select") return sel(o);
    return btn(o);
  }).join("");
  // Logout keeps its own rendering: it is the one control whose LABEL changes
  // with state, and `setLogoutButtonsPending` finds it by `.opt-logout`.
  if (optCat === "session") {
    html += `<button type="button" class="dlg-btn opt-logout"${logoutPending ? " disabled" : ""}>`
      + (logoutPending ? "LOGGING OUT…" : "LOG OUT") + "</button>";
  }
  if (optCat === "data") html = '<p class="opt-data-help">Keep a copy of your options, macros, map markers and layout.</p><button type="button" class="dlg-btn opt-settings-data">Backups & recovery</button>';
  body.innerHTML = html;
}
// Show/hide the Options panel (force=true open, false close, omitted = toggle).
function toggleOptions(force) {
  const el = document.getElementById("options");
  if (!el) return;
  const on = force != null ? force : !el.classList.contains("on");
  if (on) { renderOptions(); el.classList.add("on"); } else el.classList.remove("on");
}
