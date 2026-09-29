// ---- user macros / hotkeys (client-only; persisted in localStorage) ----
// A macro is
//   { id, key, button, wheel, ctrl, alt, shift, actions: [ {t, …}, … ] }
// bound to ONE trigger — a keyboard `e.code` (`key`), an extra mouse button
// (`button`, a DOM `MouseEvent.button`: 1 middle / 3 back / 4 forward) or a
// wheel direction (`wheel`: "up" | "down") — running its `actions` IN ORDER.
// That is ClassicUO's model: a `Macro` is a linked list of `MacroObject`s
// (MacroManager.Update/Process, MacroManager.cs:360-399) and bindings are not
// keyboard-only — `FindMacro(MouseButtonType…)` and `FindMacro(bool wheelUp…)`
// (:304, :321) are looked up from `OnExtraMouseDown` (Middle/XButton1/XButton2,
// GameSceneInputHandler.cs:280-290, :916) and `OnMouseWheel` (:973).
//
// `delay` and `waitTarget` are ordinary steps in that list, exactly as
// `MacroType.Delay` / `MacroType.WaitForTarget` are — which is what makes
// "cast → wait for the cursor → answer it" one keypress.
//
// Every verb lives in ONE descriptor in MACRO_VERBS below (label, editor
// controls, summary line, and what it does) instead of the four hand-synced
// sites it used to take — a `<select>` option in index.html, `mcBuildParam`,
// the Add-button if-chain, and the old `runMacroAction` switch. Execution is
// still nothing but
// `sendInput(...)` commands the server already accepts plus local window
// toggles, so this stays a purely client-side layer.
const MACRO_KEY = "anima.macros";
let macros = [];
let macrosOn = false;
let warOn = 0;                  // local guess of war stance, for { t:"war", on:"toggle" }
let mcPending = null;           // trigger captured in the editor's key field, pending "Add"
let mcSteps = [];               // steps staged in the editor, pending "Add"
let mcEditing = null;          // id being edited; saved only when Save is pressed
let mcRowUsed = false;          // the visible verb row has already been staged as a step

// Keys macros may NOT override: movement (KEY_DIR) + the bound window/chat/editor
// keys. This list must contain EVERY code the game keydown handles with a
// `return` before it reaches `macroFor` — a code handled there but missing here
// is worse than a rejection, because the editor accepts the binding and it then
// silently never fires. (Found exactly that live: R, and the four zoom keys, had
// been added to the handler without being added here.)
const RESERVED_CODES = new Set([
  ...Object.keys(KEY_DIR),
  "KeyT", "Enter", "NumpadEnter",
  "KeyM", "KeyB", "KeyP", "KeyI", "KeyK", "KeyL", "KeyN", "KeyO", "KeyY", "KeyG", "KeyH", "KeyU", "KeyJ",
  "KeyR",                                          // guard-zone lines
  "Equal", "NumpadAdd", "Minus", "NumpadSubtract", // camera zoom in/out
  "Escape",
  "Tab", "Space", // war-mode toggle / auto-attack (handled in the game keydown)
]);
// Mouse buttons a macro may bind. Left is the world click and right is the steer
// (and both are load-bearing here), so this is exactly ClassicUO's set: middle
// and the two thumb buttons.
const MOUSE_LABEL = { 1: "MouseMid", 3: "MouseBack", 4: "MouseFwd" };
const OPEN_FNS = {
  paperdoll: () => togglePaperdoll(),
  backpack: () => openBackpack(),
  spellbook: () => toggleSpellbook(),
  skills: () => toggleSkills(),
  minimap: () => toggleMinimap(),
  worldmap: () => toggleWorldmap(),
  status: () => toggleStatus(),
};
// ---- the verb schema -------------------------------------------------------
// `params` (omitted = the verb takes none) is the list of editor controls, each
// { kind: "text" | "int" | "select", … }; `build(vals)` turns their values into
// the stored action or returns null to reject; `text(a)` is the one-line summary
// in the macro list; `run(a, rt)` executes one step and returns ClassicUO's
// `Process()` result — 0 "step done, advance" or 1 "not done, come back to this
// same step" (its MRC_BREAK_PARSER). Only waitTarget ever returns 1.
const MACRO_VERBS = [
  { t: "say", label: "say", params: [{ kind: "text", ph: "text to say", max: 128 }],
    build: ([v]) => (v.trim() ? { t: "say", text: v.trim() } : null),
    text: (a) => `say "${a.text}"`,
    run: (a) => { if (a.text) sendInput("say:" + a.text); return 0; } },
  { t: "emote", label: "emote", params: [{ kind: "text", ph: "bow, salute, …", max: 32 }],
    build: ([v]) => (v.trim() ? { t: "emote", text: v.trim() } : null),
    text: (a) => `emote ${a.text}`,
    run: (a) => { if (a.text) sendInput("animate:" + a.text); return 0; } },
  { t: "cast", label: "cast spell", params: [{ kind: "select", opts: MAGERY_PAIRS.map(([id, name]) => [String(id), name]) }],
    build: ([v]) => ({ t: "cast", id: +v }), text: (a) => `cast ${MAGERY_SPELLS[a.id - 1] || "#" + a.id}`,
    run: (a) => { castSpell(a.id); return 0; } },
  { t: "castself", label: "cast on self", params: [{ kind: "select", opts: MAGERY_PAIRS.map(([id, name]) => [String(id), name]) }],
    build: ([v]) => ({ t: "castself", id: +v }), text: a => `self: ${MAGERY_SPELLS[a.id - 1] || a.id}`,
    run: a => { sendInput("tspell:" + a.id + ":0"); return 0; } },
  { t: "potion", label: "drink potion", params: [{ kind: "select", opts: [[String(0x0F0C), "Heal"], [String(0x0F07), "Cure"], [String(0x0F0B), "Refresh"]] }],
    build: ([v]) => ({ t: "potion", graphic: +v }), text: a => "drink " + ({[0x0F0C]: "heal", [0x0F07]: "cure", [0x0F0B]: "refresh"}[a.graphic] || "potion"),
    run: a => { const item = cbFind(a.graphic, null); if (item) sendInput("use:" + (item.serial >>> 0)); else setStatus("No matching potion in your backpack."); return 0; } },
  { t: "skill", label: "use skill", params: [{ kind: "int", ph: "skill id" }],
    build: ([v]) => ({ t: "skill", id: v }), text: (a) => `use skill #${a.id}`,
    run: (a) => { sendInput("useskill:" + a.id); return 0; } },
  { t: "ability", label: "weapon ability", params: [{ kind: "int", ph: "ability id" }],
    build: ([v]) => ({ t: "ability", id: v }), text: (a) => `ability #${a.id}`,
    run: (a) => { sendInput("ability:" + a.id); return 0; } },
  { t: "virtue", label: "invoke virtue", params: [{ kind: "int", ph: "virtue id" }],
    build: ([v]) => ({ t: "virtue", id: v }), text: (a) => `virtue #${a.id}`,
    run: (a) => { sendInput("virtue:" + a.id); return 0; } },
  { t: "war", label: "war mode",
    params: [{ kind: "select", opts: [["toggle", "toggle"], ["1", "on"], ["0", "off"]] }],
    build: ([v]) => ({ t: "war", on: v === "toggle" ? "toggle" : (v === "1" ? 1 : 0) }),
    text: (a) => `war ${a.on}`,
    run: (a) => {
      let on = a.on;
      if (on === "toggle") { warOn = warOn ? 0 : 1; on = warOn; }
      else { on = a.on ? 1 : 0; warOn = on; }
      sendInput("war:" + on);
      return 0;
    } },
  { t: "open", label: "open window",
    params: [{ kind: "select", opts: [["paperdoll", "paperdoll"], ["backpack", "backpack"],
      ["spellbook", "spellbook"], ["skills", "skills"], ["minimap", "minimap"],
      ["worldmap", "worldmap"], ["status", "status"]] }],
    build: ([v]) => ({ t: "open", win: v }), text: (a) => `open ${a.win}`,
    run: (a) => { const fn = OPEN_FNS[a.win]; if (fn) fn(); return 0; } },
  { t: "opendoor", label: "open door", text: () => "open door",
    run: () => { sendInput("opendoor"); return 0; } },
  { t: "lastweapon", label: "equip last weapon", text: () => "equip last weapon",
    run: () => { sendInput("lastweapon"); return 0; } },
  { t: "allnames", label: "all names", text: () => "all names",
    run: () => { sendInput("allnames"); return 0; } },
  { t: "lasttarget", label: "target last", text: () => "target last",
    run: () => { targetLast(); return 0; } },
  { t: "attacklast", label: "attack last target", text: () => "attack last target",
    run: () => { sendInput("attacklast"); return 0; } },
  // ClassicUO `MacroType.BandageSelf` on a 5.0.2.0+ client: find the bandages and
  // send 0xBF/0x2C with them and the target already chosen, no cursor round trip
  // (MacroManager.cs:1325-1338). Target 0 is our command layer's "myself" sentinel.
  { t: "bandageself", label: "bandage self", text: () => "bandage self",
    run: () => {
      const b = cbFind(BANDAGE_GRAPHIC, null);
      if (b) sendInput("bandage:" + (b.serial >>> 0) + ":0");
      else setStatus("No bandages.");
      return 0;
    } },
  { t: "statlock", label: "set stat lock",
    params: [{ kind: "select", opts: [["0", "strength"], ["1", "dexterity"], ["2", "intelligence"]] },
             { kind: "select", opts: [["0", "up"], ["1", "down"], ["2", "locked"]] }],
    build: ([s, l]) => ({ t: "statlock", stat: +s, lock: +l }),
    text: (a) => `${["str", "dex", "int"][a.stat] || a.stat} lock ${["up", "down", "locked"][a.lock] || a.lock}`,
    run: (a) => { sendInput(`statlock:${a.stat | 0}:${a.lock | 0}`); return 0; } },
  { t: "disarm", label: "disarm (wrestling)", text: () => "disarm",
    run: () => { sendInput("disarm"); return 0; } },
  { t: "stun", label: "stun (wrestling)", text: () => "stun",
    run: () => { sendInput("stun"); return 0; } },
  { t: "flying", label: "toggle gargoyle flight", text: () => "toggle flying",
    run: () => { sendInput("flying"); return 0; } },
  { t: "statusreq", label: "request own status", text: () => "request status",
    run: () => { sendInput("statusreq"); return 0; } },
  { t: "help", label: "help request", text: () => "help request",
    run: () => { sendInput("help"); return 0; } },
  { t: "guildmenu", label: "guild menu", text: () => "guild menu",
    run: () => { sendInput("guildmenu"); return 0; } },
  { t: "questmenu", label: "quest menu", text: () => "quest menu",
    run: () => { sendInput("questmenu"); return 0; } },
  { t: "uostore", label: "UO store", text: () => "UO store",
    run: () => { sendInput("uostore"); return 0; } },
  // ---- sequencing steps (ClassicUO MacroType.Delay / WaitForTarget) ----
  { t: "delay", label: "· wait (ms)", params: [{ kind: "int", ph: "milliseconds" }],
    build: ([v]) => ({ t: "delay", ms: v }), text: (a) => `wait ${a.ms}ms`,
    // ClassicUO's Delay sets the macro-wide `_nextTimer` and still advances, so
    // the pause lands BEFORE the following step, not on this one
    // (MacroManager.cs:1167-1175 + the `_nextTimer <= Ticks` gate at :389).
    run: (a, rt) => { if (rt) rt.nextAt = performance.now() + Math.max(0, a.ms | 0); return 0; } },
  { t: "waittarget", label: "· wait for target cursor", text: () => "wait for target cursor",
    // ClassicUO MacroType.WaitForTarget (MacroManager.cs:1129-1146): arm a
    // deadline on first visit, then hold this step until either the cursor is up
    // or the deadline passes — it never fails the macro, it just stops waiting.
    run: (a, rt) => {
      if (!rt) return 0;
      if (!rt.waitUntil) rt.waitUntil = performance.now() + MACRO_WAIT_TARGET_MS;
      const up = !!(scene && scene.target && scene.target.active === 1);
      if (up || performance.now() > rt.waitUntil) { rt.waitUntil = 0; return 0; }
      return 1;
    } },
  // ---- client-only toggles (ClassicUO's NamesOnOff / CloseAllHealthBars /
  // AlwaysRun / ToggleDrawRoofs / ToggleTreeStumps / ToggleVegetation) ----
  { t: "plates", label: "toggle name plates", text: () => "toggle name plates",
    run: () => { toggleNamePlates(); return 0; } },
  { t: "closebars", label: "close all health bars", text: () => "close all health bars",
    run: () => { closeAllHealthBars(); return 0; } },
  { t: "alwaysrun", label: "toggle always-run", text: () => "toggle always-run",
    run: () => { settings.alwaysRun = !settings.alwaysRun; saveSettings(); renderOptions(); return 0; } },
  { t: "drawroofs", label: "toggle draw roofs", text: () => "toggle draw roofs",
    run: () => { settings.drawRoofs = !settings.drawRoofs; saveSettings(); renderOptions(); rebuildStatics(); rebuildItems(); return 0; } },
  { t: "treestumps", label: "toggle tree stumps", text: () => "toggle tree stumps",
    run: () => { settings.treeStumps = !settings.treeStumps; saveSettings(); renderOptions(); rebuildStatics(); return 0; } },
  { t: "vegetation", label: "toggle vegetation", text: () => "toggle vegetation",
    run: () => { settings.hideVegetation = !settings.hideVegetation; saveSettings(); renderOptions(); rebuildStatics(); return 0; } },
  // The escape hatch: send any `/input` command verbatim. ClassicUO has no
  // equivalent, but every verb above is one of these with a form around it, and
  // without it a command the server already accepts is unreachable from a macro
  // until someone adds a descriptor for it.
  { t: "send", label: "raw command (advanced)", params: [{ kind: "text", ph: "e.g. targetcancel", max: 128 }],
    build: ([v]) => (v.trim() ? { t: "send", cmd: v.trim() } : null),
    text: (a) => `send "${a.cmd}"`,
    run: (a) => { if (a.cmd) sendInput(a.cmd); return 0; } },
];
const MACRO_VERB = new Map(MACRO_VERBS.map((v) => [v.t, v]));

function validSavedMacroAction(a) {
  if (!prefObject(a) || !prefText(a.t, 64)) return false;
  switch (a.t) {
    case "say": return prefText(a.text, 128);
    case "emote": return prefText(a.text, 32);
    case "send": return prefText(a.cmd, 128);
    case "castself": return prefInteger(a.id, 1, 64);
    case "potion": return [0x0F0C, 0x0F07, 0x0F0B].includes(a.graphic);
    case "cast": case "skill": case "ability": case "virtue": return prefInteger(a.id);
    case "war": return ["toggle", 0, 1].includes(a.on);
    case "open": return Object.hasOwn(OPEN_FNS, a.win);
    case "statlock": return prefInteger(a.stat, 0, 2) && prefInteger(a.lock, 0, 2);
    case "delay": return prefInteger(a.ms, 0, 2147483647);
    default: return true; // unknown future verbs remain stored and are skipped
  }
}
preferenceStorage.json(MACRO_KEY, v => prefArray(v, m => {
  if (!prefObject(m) || (!prefText(m.id, 128) && !prefInteger(m.id, 0, Number.MAX_SAFE_INTEGER))) return false;
  if (m.name !== undefined && !prefText(m.name, 64)) return false;
  if (m.enabled !== undefined && typeof m.enabled !== "boolean") return false;
  const triggers = [prefText(m.key, 64) && !!m.key, [1, 3, 4].includes(m.button), ["up", "down"].includes(m.wheel)];
  if (triggers.filter(Boolean).length !== 1 || ["ctrl", "alt", "shift"].some(k => m[k] !== undefined && typeof m[k] !== "boolean")) return false;
  if (Object.hasOwn(m, "actions") && !Array.isArray(m.actions)) return false;
  if (Object.hasOwn(m, "action") && !validSavedMacroAction(m.action)) return false;
  const actions = macroActions(m);
  return actions.length <= 256 && actions.every(validSavedMacroAction);
}, 256));

function loadMacros() {
  try { const raw = preferenceStorage.getItem(MACRO_KEY); if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) macros = a; } } catch {}
}
function saveMacros() {
  try { preferenceStorage.setItem(MACRO_KEY, JSON.stringify(macros)); } catch {}
}
// A macro saved before sequences existed stored its single step as `action`.
// Read both shapes rather than migrating on load, so an old blob keeps its key
// bindings even if this build never gets as far as saving.
function macroActions(m) {
  return Array.isArray(m.actions) ? m.actions : (m.action ? [m.action] : []);
}
function codeLabel(code) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num" + code.slice(6);
  return code;
}
function triggerLabel(m) {
  const p = [];
  if (m.ctrl) p.push("Ctrl"); if (m.alt) p.push("Alt"); if (m.shift) p.push("Shift");
  if (m.wheel) p.push(m.wheel === "up" ? "Wheel↑" : "Wheel↓");
  else if (m.button != null) p.push(MOUSE_LABEL[m.button] || "Mouse" + m.button);
  else p.push(codeLabel(m.key || ""));
  return p.join("+");
}
function actionSummary(a) {
  const v = MACRO_VERB.get(a.t);
  return v ? v.text(a) : a.t;
}
function macroSummary(m) {
  const acts = macroActions(m);
  return acts.map(actionSummary).join(" → ") || "(empty)";
}
// Modifiers must match exactly, as ClassicUO's FindMacro does (`obj.Alt == alt
// && obj.Ctrl == ctrl && obj.Shift == shift`).
function modsMatch(m, e) {
  return !e.metaKey && !!m.ctrl === e.ctrlKey && !!m.alt === e.altKey && !!m.shift === e.shiftKey;
}
// Find a macro matching this keydown (reserved keys never match).
function macroFor(e) {
  if (e.metaKey || RESERVED_CODES.has(e.code)) return null;
  for (const m of macros) if (m.enabled !== false && !m.wheel && m.button == null && m.key === e.code && modsMatch(m, e)) return m;
  return null;
}
function macroForButton(button, e) {
  for (const m of macros) if (m.enabled !== false && m.button === button && modsMatch(m, e)) return m;
  return null;
}
function macroForWheel(up, e) {
  const w = up ? "up" : "down";
  for (const m of macros) if (m.enabled !== false && m.wheel === w && modsMatch(m, e)) return m;
  return null;
}

// ---- the runner ------------------------------------------------------------
// ClassicUO drives a macro from the game loop: `Process()` answers 0 (advance),
// 1 (break the parser — retry this step later) or 2 (stop), and ONE `_nextTimer`
// gates the whole macro, which is why `Delay` doesn't stall the step it sits on
// (MacroManager.cs:360-399: `Update` at :360, `Process` at :381). Same machine here, pumped by setTimeout rather than
// a frame hook. One macro runs at a time and a fresh trigger replaces it, as
// `SetMacroToExecute` does (MacroManager.cs:355, called from
// GameSceneInputHandler.ExecuteMacro:1522-1526).
const MACRO_TICK_MS = 50;
const MACRO_WAIT_TARGET_MS = 5000;   // ClassicUO Constants.WAIT_FOR_TARGET_DELAY
const MACRO_STEPS_MAX = 32;          // editor cap; also bounds a runaway saved blob
let macroRun = null;                 // { actions, i, nextAt, waitUntil } | null
let macroTimer = 0;

function stopMacro() {
  macroRun = null;
  if (macroTimer) { clearTimeout(macroTimer); macroTimer = 0; }
}
function runMacro(m) {
  if (typeof sceneTransportAvailable !== "undefined" && !sceneTransportAvailable) return;
  const actions = macroActions(m);
  stopMacro();
  if (!actions.length) return;
  macroRun = { actions, i: 0, nextAt: 0, waitUntil: 0 };
  pumpMacro();
}
function macroSleep(ms) {
  macroTimer = setTimeout(() => { macroTimer = 0; pumpMacro(); }, Math.max(0, ms));
}
function pumpMacro() {
  while (macroRun) {
    const now = performance.now();
    if (now < macroRun.nextAt) { macroSleep(macroRun.nextAt - now); return; }
    if (macroRun.i >= macroRun.actions.length) { macroRun = null; return; }
    const a = macroRun.actions[macroRun.i];
    const v = MACRO_VERB.get(a && a.t);
    // An unknown verb (a blob saved by a newer build) is skipped, not fatal —
    // the rest of the sequence still runs.
    if (!v) { macroRun.i++; continue; }
    if (v.run(a, macroRun) === 1) { macroSleep(MACRO_TICK_MS); return; }
    macroRun.i++;
  }
}
function toggleMacros() {
  macrosOn = !macrosOn;
  const w = document.getElementById("macros");
  w.classList.toggle("on", macrosOn);
  if (macrosOn) { bringToFront(w); renderMacroList(); renderMacroSteps(); document.getElementById("mc-key").focus(); }
}
function closeMacros() { macrosOn = false; document.getElementById("macros").classList.remove("on"); }
function sameMacroTrigger(a, b) {
  return (a.key || null) === (b.key || null) && (a.button ?? null) === (b.button ?? null)
    && (a.wheel || null) === (b.wheel || null) && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift;
}
function macroConflict(trigger, exceptId = null) {
  return macros.find(m => m.id !== exceptId && m.enabled !== false && sameMacroTrigger(m, trigger));
}
function resetMacroDraft() {
  mcEditing = null; mcPending = null; mcSteps = []; mcRowUsed = false;
  document.getElementById("mc-key").value = "";
  document.getElementById("mc-name").value = "";
  document.getElementById("mc-add-btn").textContent = "Add macro";
  document.getElementById("mc-cancel-btn").hidden = true;
  renderMacroSteps();
}
function editMacro(m) {
  mcEditing = m.id;
  mcPending = { key: m.key, button: m.button, wheel: m.wheel, ctrl: !!m.ctrl, alt: !!m.alt, shift: !!m.shift };
  mcSteps = macroActions(m).map(a => ({ ...a })); mcRowUsed = true;
  document.getElementById("mc-name").value = m.name || "";
  document.getElementById("mc-key").value = triggerLabel(m);
  document.getElementById("mc-add-btn").textContent = "Save changes";
  document.getElementById("mc-cancel-btn").hidden = false;
  document.getElementById("mc-msg").textContent = "Editing " + (m.name || triggerLabel(m)) + ". Changes apply when saved.";
  renderMacroSteps();
}
function renderMacroList() {
  const list = document.getElementById("mc-list");
  if (!macros.length) { list.innerHTML = '<div class="mc-empty">no macros yet — add one below</div>'; return; }
  list.innerHTML = "";
  const query = (document.getElementById("mc-search")?.value || "").toLowerCase();
  const shown = macros.filter(m => [m.name || "", triggerLabel(m), macroSummary(m)].join(" ").toLowerCase().includes(query));
  if (!shown.length) { list.textContent = "No matching hotkeys."; return; }
  for (const m of shown) {
    const row = document.createElement("div");
    row.className = "mc-row";
    const combo = document.createElement("span"); combo.className = "mc-combo"; combo.textContent = triggerLabel(m);
    const act = document.createElement("span"); act.className = "mc-act"; act.textContent = (m.name ? m.name + " · " : "") + macroSummary(m); act.title = act.textContent;
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "mc-del"; edit.textContent = "Edit";
    edit.addEventListener("click", () => editMacro(m));
    const enabled = document.createElement("button"); enabled.type = "button"; enabled.className = "mc-del";
    enabled.textContent = m.enabled === false ? "Off" : "On"; enabled.setAttribute("aria-pressed", String(m.enabled !== false));
    enabled.addEventListener("click", () => {
      const conflict = macroConflict(m, m.id);
      if (m.enabled === false && conflict) { document.getElementById("mc-msg").textContent = "Already bound: " + triggerLabel(conflict); return; }
      m.enabled = m.enabled === false; stopMacro(); saveMacros(); renderMacroList();
    });
    const del = document.createElement("button"); del.type = "button"; del.className = "mc-del"; del.textContent = "✕"; del.title = "delete";
    del.addEventListener("click", () => { macros = macros.filter((x) => x.id !== m.id); if (mcEditing === m.id) resetMacroDraft(); stopMacro(); saveMacros(); renderMacroList(); });
    row.append(combo, act, edit, enabled, del);
    list.appendChild(row);
  }
}
// The steps staged for the macro being built. Empty renders nothing at all, so
// the editor looks exactly as it did for the one-step case.
function renderMacroSteps() {
  const el = document.getElementById("mc-steps");
  if (!el) return;
  if (!mcSteps.length) { el.innerHTML = ""; return; }
  el.innerHTML = "";
  mcSteps.forEach((a, i) => {
    const row = document.createElement("div");
    row.className = "mc-step";
    const n = document.createElement("span"); n.className = "mc-stepn"; n.textContent = (i + 1) + ".";
    const t = document.createElement("span"); t.className = "mc-act"; t.textContent = actionSummary(a);
    const del = document.createElement("button"); del.type = "button"; del.className = "mc-del"; del.textContent = "✕"; del.title = "remove step";
    del.addEventListener("click", () => { mcSteps.splice(i, 1); renderMacroSteps(); });
    const up = document.createElement("button"); up.type = "button"; up.className = "mc-del"; up.textContent = "↑"; up.title = "Move step up";
    up.disabled = i === 0;
    up.addEventListener("click", () => { if (i > 0) { [mcSteps[i - 1], mcSteps[i]] = [mcSteps[i], mcSteps[i - 1]]; renderMacroSteps(); } });
    row.append(n, t, up, del);
    el.appendChild(row);
  });
}
// Build the parameter controls for the selected verb from its descriptor.
function mcBuildParam() {
  const v = MACRO_VERB.get(document.getElementById("mc-type").value);
  const p = document.getElementById("mc-param");
  const params = (v && v.params) || [];
  p.innerHTML = params.map((c, i) => {
    const id = `mc-pv${i}`;
    if (c.kind === "text") return `<input id="${id}" class="mc-input mc-pv" type="text" maxlength="${c.max || 64}" placeholder="${c.ph || ""}" />`;
    if (c.kind === "int") return `<input id="${id}" class="mc-input mc-pv" type="number" min="${c.min != null ? c.min : 0}" placeholder="${c.ph || "id"}" />`;
    return `<select id="${id}" class="mc-input mc-pv">`
      + c.opts.map(([val, label]) => `<option value="${val}">${label}</option>`).join("") + `</select>`;
  }).join(" ");
}
// Read the parameter controls and build the action, or return null with `msg`
// set — one place for the whole verb table instead of a per-verb if-chain.
function mcReadAction(msg) {
  const v = MACRO_VERB.get(document.getElementById("mc-type").value);
  if (!v) return null;
  const params = v.params || [];
  if (!params.length) return { t: v.t };
  const vals = [];
  for (let i = 0; i < params.length; i++) {
    const el = document.getElementById("mc-pv" + i);
    const raw = el ? el.value : "";
    if (params[i].kind === "int") {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < (params[i].min != null ? params[i].min : 0)) {
        msg.textContent = `Enter a valid number for "${v.label}".`;
        return null;
      }
      vals.push(n);
    } else vals.push(raw);
  }
  const a = v.build(vals);
  if (!a) msg.textContent = `Enter a value for "${v.label}".`;
  return a;
}
function setupMacroEditor() {
  const win = document.getElementById("macros");
  const keyInput = document.getElementById("mc-key");
  const typeSel = document.getElementById("mc-type");
  const addBtn = document.getElementById("mc-add-btn");
  const stepBtn = document.getElementById("mc-step-btn");
  const msg = document.getElementById("mc-msg");
  // The verb list comes from MACRO_VERBS, so index.html never has to know it.
  typeSel.innerHTML = MACRO_VERBS.map((v) => `<option value="${v.t}">${v.label}</option>`).join("");
  // Keep all editor typing out of the game-input handler (it lives on window).
  win.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.code === "Escape") { e.preventDefault(); closeMacros(); }
  });
  // Trigger-capture field: focus it and press a key, an extra mouse button, or
  // the wheel → record it plus the modifiers held at that moment.
  keyInput.addEventListener("keydown", (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.code === "Escape") { mcPending = null; keyInput.value = ""; return; }
    if (/^(Control|Alt|Shift|Meta)/.test(e.code)) return;   // ignore bare modifier presses
    if (e.metaKey) { msg.textContent = "Command/Meta shortcuts belong to the app. Use Control, Option/Alt or Shift."; return; }
    mcPending = { key: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
    keyInput.value = triggerLabel(mcPending);
    const conflict = macroConflict(mcPending, mcEditing);
    msg.textContent = RESERVED_CODES.has(e.code) ? codeLabel(e.code) + " is reserved for movement or a window. Try F1–F8 or 1–8."
      : conflict ? "Already bound to " + (conflict.name || macroSummary(conflict)) + ". Edit that binding or choose another key." : "";
  });
  keyInput.addEventListener("mousedown", (e) => {
    if (!(e.button in MOUSE_LABEL)) return;                 // left/right stay the world's
    e.preventDefault(); e.stopPropagation();
    if (e.metaKey) { msg.textContent = "Use Control, Option/Alt or Shift instead of Command/Meta."; return; }
    mcPending = { button: e.button, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
    keyInput.value = triggerLabel(mcPending);
  });
  keyInput.addEventListener("wheel", (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!e.deltaY) return;
    if (e.metaKey) { msg.textContent = "Use Control, Option/Alt or Shift instead of Command/Meta."; return; }
    mcPending = { wheel: e.deltaY < 0 ? "up" : "down", ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
    keyInput.value = triggerLabel(mcPending);
  }, { passive: false });
  // Touching the verb or its parameters makes the visible row live again, so
  // "Add macro" picks it up as the last step (see the Add handler).
  typeSel.addEventListener("change", () => { mcRowUsed = false; mcBuildParam(); });
  document.getElementById("mc-param").addEventListener("input", () => { mcRowUsed = false; });
  mcBuildParam();
  // "Add step" stages the current verb; "Add macro" binds everything staged
  // (plus whatever verb is showing, so the one-step case is still one click).
  stepBtn.addEventListener("click", () => {
    msg.textContent = "";
    if (mcSteps.length >= MACRO_STEPS_MAX) { msg.textContent = `A macro is capped at ${MACRO_STEPS_MAX} steps.`; return; }
    const a = mcReadAction(msg);
    if (!a) return;
    mcSteps.push(a);
    mcRowUsed = true;
    renderMacroSteps();
    for (const el of document.querySelectorAll("#mc-param .mc-pv")) if (el.tagName === "INPUT") el.value = "";
  });
  addBtn.addEventListener("click", () => {
    msg.textContent = "";
    if (!mcPending) { msg.textContent = "Click the Key field, then press a key / mouse button / wheel."; return; }
    if (mcPending.key && RESERVED_CODES.has(mcPending.key)) {
      msg.textContent = codeLabel(mcPending.key) + " is reserved — pick another key."; return;
    }
    const conflict = macroConflict(mcPending, mcEditing);
    if (conflict) { msg.textContent = triggerLabel(mcPending) + " is already bound to " + (conflict.name || macroSummary(conflict)) + "."; return; }
    const actions = mcSteps.slice();
    // Anything still showing in the param row is the last (or only) step — unless
    // "Add step" already took it, which is the only way a parameterless verb
    // (nothing to clear) would otherwise be staged twice.
    const trailing = mcRowUsed ? null : mcReadAction(msg);
    if (trailing) actions.push(trailing);
    else if (!actions.length) return;         // nothing staged AND nothing valid showing
    else msg.textContent = "";                // staged steps are enough; ignore the empty row
    if (!actions.length || actions.length > MACRO_STEPS_MAX) { msg.textContent = `Use 1–${MACRO_STEPS_MAX} steps.`; return; }
    if (mcEditing === null && macros.length >= 256) { msg.textContent = "A maximum of 256 macros can be stored."; return; }
    const id = mcEditing ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const updated = { id, name: document.getElementById("mc-name").value.trim().slice(0, 64), enabled: true, key: mcPending.key, button: mcPending.button, wheel: mcPending.wheel,
                  ctrl: mcPending.ctrl, alt: mcPending.alt, shift: mcPending.shift, actions };
    if (mcEditing !== null) macros = macros.map(m => m.id === mcEditing ? updated : m);
    else macros.push(updated);
    stopMacro(); saveMacros(); resetMacroDraft();
    msg.textContent = "Saved. Close this window and press " + triggerLabel(updated) + " in the game.";
    for (const el of document.querySelectorAll("#mc-param .mc-pv")) if (el.tagName === "INPUT") el.value = "";
    renderMacroList();
  });
  document.getElementById("mc-search").addEventListener("input", renderMacroList);
  document.getElementById("mc-cancel-btn").addEventListener("click", () => { resetMacroDraft(); msg.textContent = "Changes cancelled."; });
  document.getElementById("mc-preset").addEventListener("change", renderMacroPreset);
  document.getElementById("mc-preset-apply").addEventListener("click", installMacroPreset);
  document.getElementById("mc-backup").addEventListener("click", () => { closeMacros(); openPreferencePanel(); });
  renderMacroPreset();
  document.getElementById("mc-close").addEventListener("click", closeMacros);
  makeDraggable(win, document.getElementById("mc-title"));
}
// Presets add only free triggers, never replace a player's existing bindings.
const ARENA_MACRO_PRESETS = {
  mage: [
    ["F1", "Greater Heal self", [{ t: "castself", id: 29 }]],
    ["F2", "Cure self", [{ t: "castself", id: 11 }]],
    ["F3", "Energy Bolt", [{ t: "cast", id: 42 }]],
    ["F4", "Explosion", [{ t: "cast", id: 43 }]],
    ["F5", "Magic Arrow", [{ t: "cast", id: 5 }]],
    ["F6", "Meditation", [{ t: "skill", id: 46 }]],
    ["F7", "Target last", [{ t: "lasttarget" }]],
    ["F8", "Arena menu", [{ t: "say", text: "[Arena" }]],
  ],
  warrior: [
    ["F1", "Bandage self", [{ t: "bandageself" }]],
    ["F2", "Attack last", [{ t: "attacklast" }]],
    ["F3", "Equip last weapon", [{ t: "lastweapon" }]],
    ["F4", "Target last", [{ t: "lasttarget" }]],
    ["F5", "Heal potion (practice)", [{ t: "potion", graphic: 0x0F0C }]],
    ["F6", "Cure potion (practice)", [{ t: "potion", graphic: 0x0F07 }]],
    ["F7", "Refresh potion (practice)", [{ t: "potion", graphic: 0x0F0B }]],
    ["F8", "Arena menu", [{ t: "say", text: "[Arena" }]],
  ],
};
function renderMacroPreset() {
  const rows = ARENA_MACRO_PRESETS[document.getElementById("mc-preset").value] || [];
  document.getElementById("mc-preset-preview").textContent = rows.map(([key, name]) => key + " " + name).join(" · ")
    + " — Occupied keys will be skipped. On macOS, hold Fn if the function keys control media.";
}
function installMacroPreset() {
  const rows = ARENA_MACRO_PRESETS[document.getElementById("mc-preset").value] || [];
  let added = 0; const skipped = [];
  for (const [key, name, actions] of rows) {
    if (macroConflict({ key }) || macros.length >= 256) { skipped.push(key); continue; }
    macros.push({ id: "arena-" + Date.now().toString(36) + "-" + key, name, key, enabled: true,
      ctrl: false, alt: false, shift: false, actions: actions.map(a => ({ ...a })) });
    added++;
  }
  saveMacros(); renderMacroList();
  document.getElementById("mc-msg").textContent = added + " hotkeys added." + (skipped.length ? " Kept existing bindings: " + skipped.join(", ") + "." : "");
}

// Spell quick-cast chord: press K, then a circle digit (1-8), then a spell digit
// (1-8) → cast that Magery spell by position. E.g. K 1 1 = Clumsy, K 1 2 = Create
// Food, K 8 8 = Water Elemental. Active for ~1.5s after each key.
let spellChord = null;          // { circle: number|null, t: perf-ms } | null
const SPELL_CHORD_MS = 1500;
function chordDigit(code) {
  const m = /^Digit([1-8])$/.exec(code) || /^Numpad([1-8])$/.exec(code);
  return m ? +m[1] : null;
}
function armSpellChord() { spellChord = { circle: null, t: performance.now() }; setStatus("Spell: circle 1-8…"); }

// ---- fixed HUD panel drag persistence (localStorage) ----
function loadPanelPos(key) {
  try { const p = JSON.parse(preferenceStorage.getItem(key)); if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p; } catch (e) {}
  return null;
}
function savePanelPos(key, x, y) { try { preferenceStorage.setItem(key, JSON.stringify({ x, y })); } catch (e) {} }
// Clamp a saved/target position into the current viewport (matches makeDraggable's clamp).
function clampPanel(x, y) {
  return { x: Math.max(0, Math.min(window.innerWidth - 40, x)), y: Math.max(0, Math.min(window.innerHeight - 24, y)) };
}

function setupInput() {
  loadMacros();
  setupMacroEditor();
  window.addEventListener("keydown", (e) => {
    shiftHeld = e.shiftKey;
    if (chatting) return;
    // A form field has focus (login form, etc.) → let it receive the keystroke;
    // don't steal movement/hotkey letters (a, w, s, d, m, b, t…) from typing.
    if (isTypingTarget(e.target)) return;
    // Spell chord capture (after K): consume circle/spell digits and cast.
    if (spellChord) {
      if (performance.now() - spellChord.t > SPELL_CHORD_MS) {
        spellChord = null;                       // timed out
      } else {
        const d = chordDigit(e.code);
        if (d != null) {
          e.preventDefault();
          if (spellChord.circle == null) { spellChord.circle = d; spellChord.t = performance.now(); setStatus(`Spell ${d}-_`); }
          else {
            const id = (spellChord.circle - 1) * 8 + d;   // Magery spell 1..64
            castSpell(id);
            setStatus(`cast ${spellChord.circle}-${d} (${MAGERY_SPELLS[id - 1] || "spell " + id})`);
            spellChord = null;
          }
          return;
        }
        spellChord = null;                       // any non-digit cancels; fall through
      }
    }
    if (e.code === "KeyT" || e.code === "Enter") { e.preventDefault(); openChat(); return; }
    if (e.code === "KeyM") { e.preventDefault(); toggleMinimap(); return; }
    if (e.code === "KeyB") { e.preventDefault(); toggleWorldmap(); return; }
    if (e.code === "KeyP") { e.preventDefault(); togglePaperdoll(); return; }   // P = paperdoll
    if (e.code === "KeyI") { e.preventDefault(); openBackpack(); return; }       // I = backpack
    if (e.code === "KeyK") { e.preventDefault(); toggleSpellbook(); armSpellChord(); return; } // K = spellbook (+ spell chord)
    if (e.code === "KeyL") { e.preventDefault(); toggleSkills(); return; }         // L = skills
    if (e.code === "KeyN") { e.preventDefault(); toggleMute(); return; }
    if (e.code === "KeyO") { e.preventDefault(); toggleMacros(); return; }        // O = macro editor
    if (e.code === "KeyY") { e.preventDefault(); toggleParty(); return; }          // Y = party panel
    if (e.code === "KeyG") { e.preventDefault(); requestAllNames(); return; }      // G = show all names
    if (e.code === "KeyH") { e.preventDefault(); toggleStatus(); return; }          // H = status bar
    if (e.code === "KeyU") { e.preventDefault(); toggleHud(); return; }              // U = hide/show HUD status panel
    if (e.code === "KeyJ") { e.preventDefault(); toggleJournal(); return; }          // J = hide/show journal
    if (e.code === "KeyR") { e.preventDefault(); toggleGuardZones(); return; }        // R = guard-zone lines
    // +/- (and numpad +/-) = camera zoom in/out, same step as the mouse wheel.
    if (e.code === "Equal" || e.code === "NumpadAdd") {
      e.preventDefault(); camZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, camZoom * 1.1)); markDirty(); return;
    }
    if (e.code === "Minus" || e.code === "NumpadSubtract") {
      e.preventDefault(); camZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, camZoom / 1.1)); markDirty(); return;
    }
    // Esc while holding an item on the cursor → return it (backpack, else ground).
    // Takes priority over closing windows so a held item is never silently lost.
    if (e.code === "Escape" && cursorItem) { e.preventDefault(); returnCursorItem(); return; }
    // Belt-and-braces: the dialog's own keydown listener (stopPropagation) already
    // handles Esc while it has focus; this only catches it somehow losing focus.
    if (e.code === "Escape" && splitWin) { e.preventDefault(); closeSplitDialog(); return; }
    if (e.code === "Escape" && partyOn) { e.preventDefault(); closeParty(); return; }
    if (e.code === "Escape" && macrosOn) { e.preventDefault(); closeMacros(); return; }
    if (e.code === "Escape" && wmOn) { e.preventDefault(); closeWorldmap(); return; }
    if (e.code === "Escape" && paperdollOn) { e.preventDefault(); closePaperdoll(); return; }
    if (e.code === "Escape" && spellbookOn) { e.preventDefault(); closeSpellbook(); return; }
    if (e.code === "Escape" && skillsOn) { e.preventDefault(); closeSkills(); return; }
    if (e.code === "Escape" && shopWin) { e.preventDefault(); dismissDialog("shop", SHOP_KEY); return; }
    if (e.code === "Escape" && dialogWindows("legacyMenus").size) {
      e.preventDefault();
      const serial = [...dialogWindows("legacyMenus").keys()].pop();
      answerLegacyMenu(serial, 0);
      return;
    }
    if (e.code === "Escape" && popupEl) { e.preventDefault(); hidePopup(true); return; }
    if (e.code === "Escape" && bookWin) { e.preventDefault(); closeBook(); return; }
    // Esc cancels targeting: tell the SERVER to drop the cursor (so the spell/skill
    // waiting for a target is aborted, not left hanging) and hide the local UI.
    if (e.code === "Escape" && scene && scene.target && scene.target.active === 1 && !targetUIHidden) {
      e.preventDefault(); sendInput("targetcancel"); endTargetUI(); return;
    }
    // Tab = toggle war mode (ClassicUO default). preventDefault so it never moves
    // focus; send the opposite of the server's authoritative `scene.war`.
    if (e.code === "Tab") {
      e.preventDefault();
      const war = !!(scene && scene.war);
      sendInput("war:" + (war ? "0" : "1"));
      return;
    }
    // Space = auto-attack the nearest hostile (last target if still valid).
    // preventDefault so it never scrolls the page / triggers a focused button.
    if (e.code === "Space") {
      e.preventDefault();
      sendInput("autoattack");
      return;
    }
    // User macros: a non-reserved key+modifier combo runs its bound action.
    const mac = macroFor(e);
    if (mac) { e.preventDefault(); runMacro(mac); return; }
    if (e.code in KEY_DIR) {
      const d = KEY_DIR[e.code];
      // No direct send here: the prediction (enqueueSteps/processSteps) drives the
      // server now — it sends one walk per committed step. Just record the held key.
      if (!held.has(d)) trace(`KD dir=${d} run=${shiftHeld ? 1 : 0}`);
      held.add(d); e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    shiftHeld = e.shiftKey;
    // Always drop a walk key, even if focus has moved into a text field —
    // `isTypingTarget` on keyup is what left W/↑ latched and walking north.
    if (e.code in KEY_DIR) { held.delete(KEY_DIR[e.code]); if (!held.size) trace("KU"); }
  });
  window.addEventListener("blur", releaseMoveKeys);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseMoveKeys();
  });
  // Extra-mouse-button and wheel macro bindings (ClassicUO `OnExtraMouseDown`
  // for Middle/XButton1/XButton2 and `OnMouseWheel`). Both listen in the CAPTURE
  // phase on `window`, NOT on the canvas: the camera's wheel-zoom listener is
  // bound to the canvas itself (04-boot.js), and capture on an ancestor is
  // dispatched before anything on the target, which is the only ordering that
  // does not depend on which file happened to register first.
  // `stopPropagation` then keeps the zoom out of a wheel the user has bound —
  // the same precedence ClassicUO gives it (its macro lookup precedes the zoom,
  // GameSceneInputHandler.cs:991-1004).
  const macroGate = (e) => !chatting && !isTypingTarget(e.target) && e.target === app.canvas;
  window.addEventListener("mousedown", (e) => {
    if (!(e.button in MOUSE_LABEL) || !macroGate(e)) return;
    const m = macroForButton(e.button, e);
    if (!m) return;
    // …and preventDefault so the thumb buttons don't navigate history and the
    // middle button doesn't start the browser's autoscroll.
    e.preventDefault(); e.stopPropagation();
    runMacro(m);
  }, true);
  // Chrome fires the history navigation off the click, not the mousedown, so the
  // bound button has to be swallowed there too.
  window.addEventListener("auxclick", (e) => {
    if (!(e.button in MOUSE_LABEL) || !macroGate(e)) return;
    if (macroForButton(e.button, e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener("wheel", (e) => {
    if (!e.deltaY || !macroGate(e)) return;
    const m = macroForWheel(e.deltaY < 0, e);
    if (!m) return;
    e.preventDefault(); e.stopPropagation();
    runMacro(m);
  }, { capture: true, passive: false });
  // Right-button movement: suppress the context menu, track the cursor, and hold
  // state. Position is tracked window-wide so dragging off-canvas still steers.
  const canvas = app.canvas;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  const track = (e) => {
    const r = canvas.getBoundingClientRect(); mouseX = e.clientX - r.left; mouseY = e.clientY - r.top;
    lastMenuX = e.clientX; lastMenuY = e.clientY;
    // A pending entity-RMB that drags past a few px is a steer, not a context menu.
    if (rmbEntity && !rmbEntity.steering &&
        (Math.abs(e.clientX - rmbEntity.x) > 6 || Math.abs(e.clientY - rmbEntity.y) > 6)) {
      promoteRmbSteer();
    }
  };
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 2) return;
    track(e); e.preventDefault();
    // RMB on an entity defers steering (the PIXI pointerdown set `rmbEntity` first):
    // a quick tap opens its menu, a hold/drag promotes to steering. RMB on empty
    // ground steers immediately.
    if (rmbEntity && !rmbEntity.steering) return;
    rightDown = true;
  });
  // Left-click on empty ground while a target cursor is active → answer with a
  // tile (targetxy). Clicks that hit a mobile/item are handled by their PIXI
  // pointerdown first (which fires before this DOM mousedown) and set
  // targetConsumedAt, so we skip those here to avoid a double-resolve.
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    // Custom house design takes priority over everything below while a session is
    // open (scene.houseDesign) — see handleHouseDesignClick's doc comment above. It
    // returns false whenever there's no session, so ordinary target-cursor/steering
    // clicks are completely unaffected — this is a pure no-op against an older
    // server that never sends scene.houseDesign.
    if (handleHouseDesignClick(e)) return;
    if (inspectPick) {
      const gl = clientToGlobal(e.clientX, e.clientY);
      const t = groundTileAt(gl.x, gl.y);
      inspectPicked({ x: t.x, y: t.y });
      return;
    }
    if (!(scene && scene.target && scene.target.active === 1) || targetUIHidden) return;
    if (performance.now() - targetConsumedAt < 200) return; // a mob/item already answered
    // During a target cursor, a click on the avatar's centre band IS self —
    // answer with target:<self> so bandages / beneficial spells work on us. The
    // band test lives in 12-input.js because the static click path defers to it
    // too (a tree drawn over the avatar must not steal the self-target).
    if (clickIsSelfBand(e.clientX, e.clientY)) {
      sendInput("target:" + (scene.player.serial >>> 0));
      endTargetUI();
      return;
    }
    const g = clientToGlobal(e.clientX, e.clientY);
    const t = groundTileAt(g.x, g.y);
    rememberTargetTile(t.x, t.y, t.z, 0);   // ClassicUO LastTargetInfo.SetLand — replayed by the F hotkey
    sendInput(`targetxy:${t.x}:${t.y}:${t.z}:0`);
    endTargetUI();
  });
  // ---- drag-select → pinned health bars (ClassicUO EnableDragSelect) ----
  // Sweep a rectangle over a crowd with the modifier held and every mobile inside
  // it gets its own pinned bar, auto-tiled down the left of the screen
  // (GameSceneInputHandler.cs:126-278). Refused while Ctrl+Shift is down, because
  // that chord is the name-plate gesture — upstream refuses for exactly that
  // reason and cites the issue it came from (`DragSelectModifierActive`, :99-107).
  //
  // ClassicUO starts a selection only over nothing / a static / land / a multi /
  // a locked item (`CanDragSelectOnObject`, :90-97). The equivalent test here is
  // `!groundDrag && !cursorItem`: a press that landed on a draggable world item
  // has already armed the item drag from PIXI's pointerdown, which runs before
  // this DOM mousedown, and both are cleared on release.
  let dragSel = null;                       // { x, y } start point, client px
  const dragSelModOk = (e) => {
    if (e.ctrlKey && e.shiftKey) return false;
    const k = settings.dragSelectMod;
    return k === "none" ? true : k === "ctrl" ? !!e.ctrlKey : !!e.shiftKey;
  };
  const dragSelBox = () => document.getElementById("dragsel");
  const dragSelPaint = (x2, y2) => {
    const el = dragSelBox();
    if (!el || !dragSel) return;
    el.style.left = Math.min(dragSel.x, x2) + "px";
    el.style.top = Math.min(dragSel.y, y2) + "px";
    el.style.width = Math.abs(x2 - dragSel.x) + "px";
    el.style.height = Math.abs(y2 - dragSel.y) + "px";
    el.classList.add("on");
  };
  const dragSelEnd = () => { dragSel = null; const el = dragSelBox(); if (el) el.classList.remove("on"); };
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !settings.dragSelect || !dragSelModOk(e)) return;
    if (groundDrag || cursorItem) return;                       // an item press owns this drag
    if (scene && scene.target && scene.target.active === 1 && !targetUIHidden) return;
    if (scene && scene.houseDesign) return;
    e.preventDefault();                                         // no text selection while sweeping
    dragSel = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("mousemove", (e) => { if (dragSel) dragSelPaint(e.clientX, e.clientY); });
  window.addEventListener("mouseup", (e) => {
    if (!dragSel || e.button !== 0) return;
    const start = dragSel;
    dragSelEnd();
    // A press that never moved is an ordinary click, not a sweep (:399-402).
    if (Math.abs(e.clientX - start.x) < 4 && Math.abs(e.clientY - start.y) < 4) return;
    doDragSelect(start.x, start.y, e.clientX, e.clientY);
  });
  // A release the window never sees (dragged out of the tab, an OS gesture) would
  // otherwise leave the rubber band painted on screen with nothing to end it.
  window.addEventListener("blur", dragSelEnd);
  window.addEventListener("pointercancel", dragSelEnd);
  // (Click-to-walk removed per user request — left-click on empty ground no longer
  // pathfinds/auto-walks. The server-side `walkto` route + pathfinder remain.)
  window.addEventListener("mousemove", track);
  // Multi placement preview: recompute the hovered tile while a placement
  // target is pending (scene.placement) — a plain target cursor gives no sense
  // of where a house will land or how big it is, so we track the tile here and
  // let updatePlacementPreview draw the footprint under it. Cheap early-out
  // when no placement is pending, which is every ordinary mousemove.
  canvas.addEventListener("mousemove", (e) => {
    if (!(scene && scene.placement)) return;
    const g = clientToGlobal(e.clientX, e.clientY);
    const t = groundTileAt(g.x, g.y);
    if (t.x === placementHoverX && t.y === placementHoverY) return; // same tile → no rebuild
    placementHoverX = t.x; placementHoverY = t.y;
    updatePlacementPreview();
  });
  // House-design ghost: same idea, while a design session is open — track the
  // hovered tile so updateHouseDesignGhost can show the selected piece there.
  // Cheap early-out when there's no session, which is every ordinary mousemove
  // against an older server (or outside design mode entirely).
  canvas.addEventListener("mousemove", (e) => {
    if (!(scene && scene.houseDesign)) return;
    const g = clientToGlobal(e.clientX, e.clientY);
    const t = groundTileAt(g.x, g.y);
    if (t.x === hdesignHoverX && t.y === hdesignHoverY) return; // same tile → no rebuild
    hdesignHoverX = t.x; hdesignHoverY = t.y;
    updateHouseDesignGhost();
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button !== 2) return;
    endRightMouse(e.clientX, e.clientY);
  });
  // Same release path as mouseup: a cancelled pointerdown (PIXI drag) never
  // emits mouseup, which latched RMB-steer and ran the character unattended.
  window.addEventListener("pointerup", (e) => {
    if (e.button !== 2) return;
    endRightMouse(e.clientX, e.clientY);
  });
  window.addEventListener("pointercancel", releaseMoveKeys);
  // Click anywhere outside an open context menu dismisses it (row clicks stop
  // propagation and dismiss themselves before this fires).
  window.addEventListener("mousedown", (e) => {
    if (popupEl && !popupEl.contains(e.target)) hidePopup(true);
  }, true);
  // While the cursor is over a DOM gump/panel (paperdoll, shop, dialog, worldmap…)
  // the canvas stops receiving mousemove, so PIXI never fires the entity pointerout
  // that would hide the world OPL tooltip — it'd otherwise stay stuck over the gump.
  // Clear the world tooltip on entering any panel. The paperdoll's own equip-icon
  // tooltip (pdTipEl, set by the icon's mouseover which bubbles first) is preserved.
  document.addEventListener("mouseover", (e) => {
    // Inventory/container item under the cursor → show its OPL tooltip (same flow
    // as world items). This must come BEFORE the panel-suppression below, since a
    // container window IS a gump and would otherwise hide the tooltip.
    const cell = e.target.closest && e.target.closest(".cont-item[data-serial], .cb-slot[data-serial]");
    if (cell) { hoverEntity((+cell.dataset.serial) >>> 0); return; }
    const overPanel = e.target.closest && e.target.closest(".gump-win, #worldmap, #paperdoll, .popup-menu");
    if (overPanel && pdTipEl == null && tipSerial != null) { tipSerial = null; hideTip(); }
  });
  // (Movement is no longer sent on a timer — the prediction sends one walk per
  // committed step in processSteps. `activeMove()` only drives the local prediction.)
  // In-game chat bar: Enter sends, Esc cancels. stopPropagation so typed keys never
  // reach the game-input handler (it also early-returns while `chatting`).
  const bar = document.getElementById("chatbar");
  bar.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.code === "Enter" || e.code === "NumpadEnter") { e.preventDefault(); submitChat(); }
    else if (e.code === "Escape") { e.preventDefault(); clearChatMode(); closeChat(); }
    // History recall. ClassicUO binds this to Ctrl+Q / Ctrl+W
    // (SystemChatControl.cs:605, :635) — Ctrl+W closes the browser tab and is not
    // interceptable from a page, so the bar uses the arrow keys a text field has
    // no other use for. Ctrl+Q is kept as the authentic alias for "older".
    else if (e.code === "ArrowUp" || (e.code === "KeyQ" && e.ctrlKey)) { e.preventDefault(); chatRecall(-1); }
    else if (e.code === "ArrowDown") { e.preventDefault(); chatRecall(1); }
    // Backspace on an empty line drops the latched channel, exactly as upstream
    // does (`SDLK_BACKSPACE when … string.IsNullOrEmpty` → Mode = Default, :705).
    else if (e.code === "Backspace" && !bar.value && chatMode) { e.preventDefault(); clearChatMode(); }
  });
  // The prefix latch runs off every keystroke, the way ClassicUO's runs off every
  // frame — so the mode flips the moment the prefix is complete, not on send.
  bar.addEventListener("input", chatLatchCheck);
  bar.addEventListener("blur", () => { if (chatting) closeChat(); });
  // World map: drag to pan, wheel to zoom, ✕/label to open/close.
  const wmc = document.getElementById("wmcanvas");
  let wmDrag = null;
  wmc.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const r = wmc.getBoundingClientRect();
    if (e.shiftKey) { wmRemoveMarkerNear(e.clientX - r.left, e.clientY - r.top, wmc.clientWidth, wmc.clientHeight); return; }
    wmDrag = { x: e.clientX, y: e.clientY };
  });
  wmc.addEventListener("dblclick", (e) => {
    const r = wmc.getBoundingClientRect();
    wmAddMarkerAt(e.clientX - r.left, e.clientY - r.top, wmc.clientWidth, wmc.clientHeight);
  });
  window.addEventListener("mousemove", (e) => {
    if (wmOn) { const r = wmc.getBoundingClientRect(); wmMouse = { x: e.clientX - r.left, y: e.clientY - r.top }; }
    if (!wmDrag) { if (wmOn) drawWorldmap(); return; }
    wmPan.x += e.clientX - wmDrag.x; wmPan.y += e.clientY - wmDrag.y;
    wmDrag = { x: e.clientX, y: e.clientY }; drawWorldmap();
  });
  window.addEventListener("mouseup", () => { wmDrag = null; });
  wmc.addEventListener("mouseleave", () => { wmMouse = null; if (wmOn) drawWorldmap(); });
  wmc.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = wmc.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
    // Zoom proportional to the actual wheel delta (gentle, consistent for mouse vs
    // trackpad which fires many small events), and clamp the per-event step so a big
    // delta can't jump scale; range kept moderate.
    const f = Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * 0.0011);
    const ns = Math.min(8, Math.max(0.5, wmScale * f));
    const ratio = ns / wmScale;                      // keep the point under the cursor fixed
    wmPan.x = (cx - wmc.clientWidth / 2) * (1 - ratio) + ratio * wmPan.x;
    wmPan.y = (cy - wmc.clientHeight / 2) * (1 - ratio) + ratio * wmPan.y;
    wmScale = ns; drawWorldmap();
  }, { passive: false });
  document.getElementById("wmclose").addEventListener("click", closeWorldmap);
  document.getElementById("minilabel").addEventListener("click", openWorldmap);
  document.getElementById("mutebtn")?.addEventListener("click", toggleMute);
  document.getElementById("logoutbtn")?.addEventListener("click", () => requestLogout());
  // Options panel: button toggles, ✕ closes, title bar drags. Changes persist
  // immediately and apply live (audio volume now; display toggles next repaint).
  const optEl = document.getElementById("options");
  document.getElementById("optbtn")?.addEventListener("click", () => toggleOptions());
  document.getElementById("opt-close")?.addEventListener("click", () => toggleOptions(false));
  makeDraggable(optEl, optEl.querySelector(".gump-title"));
  const optBody = document.getElementById("opt-body");
  // The category rail: switching tabs just re-renders the body.
  document.getElementById("opt-tabs")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    optCat = b.dataset.cat;
    renderOptions();
  });
  // One dispatcher per EVENT KIND, not one for both. A checkbox click fires
  // `input` THEN `change`, and a range fires `input` on every move plus `change`
  // on release — so a single listener bound to both would run each option's
  // onChange twice (a double `rebuildStatics()` on every toggle, which is a
  // visible hitch). Checkboxes therefore listen on `change` only, ranges on
  // `input` only, each ignoring anything whose descriptor is the other kind.
  const optDesc = (k) => OPTIONS.find((o) => o.key === k);
  optBody.addEventListener("change", (e) => {
    const k = e.target.dataset.k; if (!k) return;
    const o = optDesc(k); if (!o || (o.kind !== "checkbox" && o.kind !== "select")) return;
    settings[k] = o.kind === "select" ? e.target.value : e.target.checked;
    saveSettings();
    if (o.onChange) o.onChange();
    markDirty();
  });
  optBody.addEventListener("input", (e) => {
    const k = e.target.dataset.k; if (!k) return;
    const o = optDesc(k); if (!o || (o.kind !== "range" && o.kind !== "intRange")) return;
    // `intRange` carries its own units; `range` is a 0..1 value shown ×100.
    settings[k] = o.kind === "intRange" ? +e.target.value : (+e.target.value) / 100;
    const span = document.getElementById("optv-" + k);
    if (span) span.textContent = e.target.value;
    saveSettings();
    if (o.onChange) o.onChange();
    markDirty();
  });
  optBody.addEventListener("click", (e) => {
    if (e.target.closest(".opt-settings-data")) { openPreferencePanel(); return; }
    if (e.target.closest(".opt-journal")) { toggleJournal(); return; }
    if (e.target.closest(".opt-infobar")) { toggleInfoBar(); return; }
    if (e.target.closest(".opt-counterbar")) { toggleCounterBar(); return; }
    if (e.target.closest(".opt-ignorelist")) { toggleIgnoreList(); return; }
    if (e.target.closest(".opt-combatbook")) { toggleCombatBook(); return; }
    if (e.target.closest(".opt-racialbook")) { toggleRacialBook(); return; }
    if (e.target.closest(".opt-netstats")) { toggleNetStats(); return; }
    if (e.target.closest(".opt-inspector")) { toggleInspector(); return; }
    if (!e.target.closest(".opt-logout")) return;
    requestLogout();
  });
  // Paperdoll: ✕ closes, title bar drags, clicking the Backpack row opens it.
  document.getElementById("pd-close").addEventListener("click", closePaperdoll);
  makeDraggable(document.getElementById("paperdoll"), document.getElementById("pd-title"));
  document.getElementById("sb-close").addEventListener("click", closeSpellbook);
  makeDraggable(document.getElementById("spellbook"), document.getElementById("sb-title"));
  document.getElementById("sk-close").addEventListener("click", closeSkills);
  makeDraggable(document.getElementById("skills"), document.getElementById("sk-title"));
  // Status bar: ✕ closes, title drags; remember the dragged position across sessions.
  const stEl = document.getElementById("statusbar"), stTitle = document.getElementById("st-title");
  document.getElementById("st-close").addEventListener("click", closeStatus);
  makeDraggable(stEl, stTitle);
  try {
    const sp = JSON.parse(preferenceStorage.getItem("anima.statusPos") || "null");
    if (sp && sp.left) { const p = clampPanel(parseFloat(sp.left), parseFloat(sp.top)); stEl.style.left = p.x + "px"; stEl.style.top = p.y + "px"; stEl.style.right = "auto"; }
  } catch (_) { /* ignore bad/missing saved position */ }
  stTitle.addEventListener("mouseup", () => {
    if (stEl.style.left) preferenceStorage.setItem("anima.statusPos", JSON.stringify({ left: stEl.style.left, top: stEl.style.top }));
  });
  // Clicking the HUD name "pulls out" the movable status bar.
  const pn = document.getElementById("pname");
  if (pn) { pn.style.cursor = "pointer"; pn.title = "Open status bar (H)"; pn.addEventListener("click", toggleStatus); }
  loadHudVisibility();   // restore hidden HUD/journal state (U / J toggles)
  wireSkills();
  loadSkillButtons();   // restore any skill buttons the user pulled out previously
  loadSpellButtons();   // restore any spell quick-cast buttons dragged out earlier
  document.getElementById("pt-close").addEventListener("click", closeParty);
  makeDraggable(document.getElementById("party"), document.getElementById("pt-title"));
  wireParty();
  wireStatLocks();
  // HUD panel: draggable by its title (also carries #status, which lives inside it).
  const hudEl = document.getElementById("hud");
  const hudTitle = hudEl.querySelector("h1");
  makeDraggable(hudEl, hudTitle, (x, y) => savePanelPos("anima.hudPos", x, y));
  {
    const p = loadPanelPos("anima.hudPos");
    if (p) { const c = clampPanel(p.x, p.y); hudEl.style.left = c.x + "px"; hudEl.style.top = c.y + "px"; hudEl.style.right = "auto"; }
  }
  // Minimap cluster: minimap canvas is the drag handle; #minilabel and #buffs
  // (neither has a safe handle of their own — the label has a click handler, the
  // buff bar is pointer-events:none) follow it by their fixed default-CSS offsets.
  const miniEl = document.getElementById("minimap");
  const labelEl = document.getElementById("minilabel");
  const buffsEl = document.getElementById("buffs");
  const mr = miniEl.getBoundingClientRect(), lr = labelEl.getBoundingClientRect(), br = buffsEl.getBoundingClientRect();
  const dLabel = { x: lr.left - mr.left, y: lr.top - mr.top };
  const dBuffs = { x: br.left - mr.left, y: br.top - mr.top };
  const placeCluster = (x, y) => {
    miniEl.style.left = x + "px"; miniEl.style.top = y + "px"; miniEl.style.right = "auto";
    labelEl.style.left = (x + dLabel.x) + "px"; labelEl.style.top = (y + dLabel.y) + "px";
    buffsEl.style.left = (x + dBuffs.x) + "px"; buffsEl.style.top = (y + dBuffs.y) + "px";
  };
  makeDraggable(miniEl, miniEl, (x, y) => { placeCluster(x, y); savePanelPos("anima.miniPos", x, y); });
  {
    const p = loadPanelPos("anima.miniPos");
    if (p) { const c = clampPanel(p.x, p.y); placeCluster(c.x, c.y); }
  }
  // Trade windows are wired at build time (buildTradeWindow), one per session
  // — there's no static #trade element to wire once at startup anymore.
  const pdb = document.getElementById("pd-body");
  pdb.addEventListener("click", (e) => {
    const profile = e.target.closest(".pd-profile[data-profile]");
    if (profile) {
      const serial = (+profile.dataset.profile) >>> 0;
      const existing = [...dialogWindows("profiles").values()].find((w) => w.el._serial === serial);
      if (existing) bringToFront(existing.el);
      else sendInput("profile:" + serial);
      return;
    }
    const row = e.target.closest(".eq-row");
    if (!row) return;
    if (row.dataset.bp === "1") openBackpack();
    else if (row.dataset.snoop === "1") {                 // another's pack → snoop
      const ic = row.querySelector(".eq-icon[data-serial]");
      if (ic) snoopBackpack((+ic.dataset.serial) >>> 0);
    }
  });
  // Hover an equipped item → show its OPL (name/weight/AR/properties). Hair & beard
  // have no OPL, so we show their slot name + dye-colour swatch instead.
  pdb.addEventListener("mouseover", (e) => {
    const ic = e.target.closest && e.target.closest(".eq-icon[data-serial]");
    if (ic) showEquipTip(ic);
  });
  pdb.addEventListener("mouseout", (e) => {
    const ic = e.target.closest && e.target.closest(".eq-icon[data-serial]");
    if (ic) { pdTipEl = null; hideTip(); }
  });
  // Hover the DOLL figure itself: per-pixel hit-test resolves the worn item/accessory
  // directly under the cursor (the intuitive UO way), in addition to the list below.
  pdb.addEventListener("mousemove", (e) => {
    if (e.target.closest && e.target.closest("#pd-doll")) dollHitTest(e);
  });
  // Drag a worn item OFF the figure: per-pixel hit-test picks the item under the
  // cursor (not just the topmost layer), then arms the shared pointer-drag — release
  // over a bag/ground unequips it there; over the doll re-equips. Self doll only.
  pdb.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || pdTarget != null) return;        // left only, our own doll
    if (cursorItem || performance.now() - placedAt < 250) return; // holding / just placed → don't re-arm
    if (!(e.target.closest && e.target.closest("#pd-doll"))) return;
    const img = dollImgAt(e);
    if (!img) return;
    e.preventDefault();
    groundDrag = { serial: (+img.dataset.serial) >>> 0, g: +img.dataset.g | 0,
                   amount: 1, hue: +img.dataset.hue | 0,
                   sx: e.clientX, sy: e.clientY, started: false };
  });
  pdb.addEventListener("mouseleave", () => {
    if (pdTipEl && pdTipEl.closest && pdTipEl.closest("#pd-doll")) { pdTipEl = null; hideTip(); }
  });
}
// In-game chat bar (replaces window.prompt). Enter opens it; type and Enter sends;
// Up/Down walk the history; Esc cancels the line AND drops any latched channel.
// A leading prefix routes the channel (or latches it — see `latch` below);
// anything else is normal in-game speech.
//
// Each entry maps a set of typed prefixes to the `/input` command that carries
// it. Party is its own packet (0xBF/0x06); the rest are ordinary speech with a
// different MessageType byte, which the server routes — see
// `anima_core::agent::SpeechMode`.
//
// `latch` marks the ones that are real SPEECH CHANNELS, so typing the prefix
// LATCHES the bar into that channel for every following line instead of routing
// one — ClassicUO's persistent `SystemChatControl.Mode` (SystemChatControl.cs:
// 479-552, and the Mode setter at :228-296 which strips the prefix and shows a
// label). The channel-management verbs below take an argument or none at all and
// would be nonsense as a mode, so they stay one-shot.
const CHAT_PREFIXES = [
  { keys: ["p", "party"], cmd: "party", latch: true },
  { keys: ["w", "whisper"], cmd: "whisper", latch: true },
  { keys: ["y", "yell", "shout"], cmd: "yell", latch: true },
  { keys: ["e", "em", "emote", "me"], cmd: "emote", latch: true },
  { keys: ["g", "guild"], cmd: "guild", latch: true },
  { keys: ["a", "alliance", "ally"], cmd: "alliance", latch: true },
  // Server chat system (0xB2). `/c hello` talks in the joined channel; the
  // channel verbs take a name. `chatopen` first — see `parse_command`.
  { keys: ["c", "chat"], cmd: "chatsay", latch: true },
  { keys: ["cjoin", "chatjoin"], cmd: "chatjoin" },
  { keys: ["ccreate", "chatcreate"], cmd: "chatcreate" },
];
// The same table for verbs that take NO argument: `submitChat`'s pattern
// requires a trailing word, so these would otherwise be spoken out loud.
const CHAT_BARE_PREFIXES = [
  { keys: ["chatopen"], cmd: "chatopen" },
  { keys: ["cleave", "chatleave"], cmd: "chatleave" },
];
// ClassicUO's single-character mode latches (SystemChatControl.cs:486-547).
// `space: true` means the character only latches when the NEXT one is a space,
// exactly as upstream requires for `:`/`;`/`!`.
//
// ClassicUO's seventh is `/` → Party. We deliberately do not take it: `/` already
// opens this client's own `/<word> <text>` routing (`/p`, `/w`, `/g`, …), which
// is typed far more often here, and latching on the bare slash would eat the
// first keystroke of every one of those. `/p ` latches Party instead — see
// `chatLatchCheck`.
const CHAT_CHAR_MODES = [
  { ch: "\\", cmd: "guild" },
  { ch: "|", cmd: "alliance" },
  { ch: ",", cmd: "chatsay" },
  { ch: ";", cmd: "whisper", space: true },
  { ch: ":", cmd: "emote", space: true },
  { ch: "!", cmd: "yell", space: true },
];
const CHAT_MODE_LABEL = {
  party: "Party", whisper: "Whisper", yell: "Yell", emote: "Emote",
  guild: "Guild", alliance: "Alliance", chatsay: "Chat",
};
// A pending `partytell` target: the chat bar's next line goes to this member
// privately instead of being spoken. ClassicUO opens a dedicated one-line prompt
// for this; we reuse the chat bar so a private message is typed exactly where
// every other line is typed, with the target shown in the placeholder.
let chatTellTarget = 0;
// The latched channel (a CHAT_PREFIXES `cmd`), or "" for ordinary speech.
// ClassicUO keeps this across sends and across closing the bar, and so do we.
let chatMode = "";
// ClassicUO's `_messageHistory` — (mode, text) pairs, and an index that walks
// them; both are static there, i.e. per session and not persisted, so ours are
// plain module state too (SystemChatControl.cs:41-42, :821-822).
const chatHistory = [];
const CHAT_HISTORY_MAX = 50;
let chatHistoryIdx = 0;

function startPartyTell(serial, name) {
  chatTellTarget = serial | 0;
  openChat();
  const bar = document.getElementById("chatbar");
  bar.placeholder = "to " + (name || "member") + "…";
}

function chatModeEl() { return document.getElementById("chatmode"); }
// Show/hide the mode label beside the bar. ClassicUO puts the same word
// ("Whisper", "Guild", …) left of the input so a latched channel is never
// invisible (`AppendChatModePrefix`, :397-415).
function paintChatMode() {
  const el = chatModeEl();
  if (!el) return;
  const label = chatTellTarget ? "Tell" : CHAT_MODE_LABEL[chatMode] || "";
  el.textContent = label;
  el.classList.toggle("on", !!label && chatting);
}
function setChatMode(cmd, rest) {
  chatMode = cmd;
  const bar = document.getElementById("chatbar");
  if (rest != null) bar.value = rest;
  paintChatMode();
}
function clearChatMode() { setChatMode("", null); }
// Run after every keystroke, like ClassicUO's per-frame check: a prefix at the
// START of the line latches the channel and is consumed. Only while the bar is
// in plain-speech mode — once latched, the characters are just text, which is
// what makes a latched channel usable at all.
function chatLatchCheck() {
  if (chatMode || chatTellTarget) return;
  const bar = document.getElementById("chatbar");
  const t = bar.value;
  if (!t) return;
  for (const m of CHAT_CHAR_MODES) {
    if (t[0] !== m.ch) continue;
    if (m.space) { if (t.length > 1 && t[1] === " ") setChatMode(m.cmd, t.slice(2)); }
    else setChatMode(m.cmd, t.slice(1));
    return;
  }
  // `/p `, `/whisper `, … — this client's own vocabulary, latching on the space
  // that ends the prefix word. `/p hello` therefore still sends "hello" to the
  // party exactly as it always did; the only change is that the NEXT line goes
  // there too, until Esc or Backspace-on-empty clears it.
  const w = /^\/([a-z]+)\s/i.exec(t);
  if (!w) return;
  const route = CHAT_PREFIXES.find((p) => p.latch && p.keys.includes(w[1].toLowerCase()));
  if (route) setChatMode(route.cmd, t.slice(w[0].length));
}
// Walk the history. `d` is -1 (older) / +1 (newer). ClassicUO restores BOTH the
// text and the mode it was sent in (:629-631, :658-660); so does this. Walking
// past the newest entry clears the line, as its Ctrl+W does (:664-667).
function chatRecall(d) {
  if (!chatHistory.length) return;
  const bar = document.getElementById("chatbar");
  chatHistoryIdx = Math.max(0, Math.min(chatHistory.length, chatHistoryIdx + d));
  if (chatHistoryIdx >= chatHistory.length) {
    bar.value = "";
    setChatMode("", null);
    return;
  }
  const h = chatHistory[chatHistoryIdx];
  setChatMode(h.mode, h.text);
  bar.setSelectionRange(bar.value.length, bar.value.length);
}

function openChat() {
  if (chatting) return;
  chatting = true;
  held.clear();                     // stop walking while typing
  if (wasMoving) { sendInput("stop"); wasMoving = false; }
  const bar = document.getElementById("chatbar");
  bar.value = ""; bar.classList.add("on"); bar.focus();
  chatHistoryIdx = chatHistory.length;   // a fresh line: history starts at the end
  paintChatMode();
}
function closeChat() {
  chatting = false;
  chatTellTarget = 0;
  const bar = document.getElementById("chatbar");
  bar.placeholder = "";
  bar.classList.remove("on"); bar.blur();
  paintChatMode();
}
function submitChat() {
  const bar = document.getElementById("chatbar");
  const text = bar.value.trim();
  // A targeted party message wins over every prefix: the target was chosen by
  // clicking a member, so a leading "/w" in the text is part of the message.
  if (text && chatTellTarget) {
    sendInput("partytell:" + chatTellTarget + ":" + text);
    pushChatHistory("", text);
    closeChat();
    return;
  }
  if (text) {
    pushChatHistory(chatMode, text);
    // A latched channel takes the line verbatim — the prefix characters are not
    // re-read, matching ClassicUO's `if (Mode == ChatMode.Default)` guard around
    // the whole prefix parser. Backspace on an empty line (or Esc) gets you back.
    if (chatMode) sendInput(chatMode + ":" + text);
    else {
      const bare = /^\/([a-z]+)$/i.exec(text);
      const bareRoute = bare && CHAT_BARE_PREFIXES.find((p) => p.keys.includes(bare[1].toLowerCase()));
      const m = /^\/([a-z]+)\s+(.+)$/i.exec(text);
      const route = m && CHAT_PREFIXES.find((p) => p.keys.includes(m[1].toLowerCase()));
      // An unrecognized "/word" is spoken verbatim rather than swallowed — the
      // shard may well define it as a server command (e.g. "/help").
      if (bareRoute) sendInput(bareRoute.cmd);
      else if (route) sendInput(route.cmd + ":" + m[2].trim());
      else sendInput("say:" + text);
    }
  }
  closeChat();
}
// ClassicUO appends on send and parks the index one PAST the end, so the first
// step back lands on the line just sent (:821-822).
function pushChatHistory(mode, text) {
  const last = chatHistory[chatHistory.length - 1];
  if (!last || last.text !== text || last.mode !== mode) chatHistory.push({ mode, text });
  while (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
  chatHistoryIdx = chatHistory.length;
}
function sendInput(cmd) {
  if (REPLAY_MODE) return;
  if (typeof sceneReloading !== "undefined" && sceneReloading) return;
  if (typeof sceneTransportAvailable !== "undefined" && !sceneTransportAvailable) return;
  if (WASM_MODE) wasmSendInput(cmd);
  else {
    const sessionId = scene?.sessionId || "";
    fetch("/input", { method: "POST", headers: { "X-Anima-Session": sessionId }, body: cmd }).then(response => {
      // The backend also validates this ID when draining its queue. Never
      // replay a rejected command against the replacement connection.
      if (response.status === 409 && !sceneReloading && (scene?.sessionId || "") === sessionId) {
        setSceneTransport(false);
        poll(true);
      }
    }).catch(() => {});
  }
}
// ---- movement diagnostic trace (POSTs to /log; server prints with ANIMA_DEBUG) ----
let TRACE = false;
function trace(m) { if (TRACE) fetch("/log", { method: "POST", body: Math.round(performance.now()) + " " + m }).catch(() => {}); }
