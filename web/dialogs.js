// ── dialog window lifecycle ────────────────────────────────────────────────
// One implementation of "keep a set of windows in sync with the current scene
// snapshot", shared by every server-driven dialog family (generic gumps, legacy
// menus, hue pickers, trades, maps, containers, book, shop, popup, prompt,
// text-entry, profiles, the house-design panel).
//
// Why this exists rather than a refresh function per family: the snapshot in
// `scene` is POLLED, so one that was BUILT BEFORE our reply reached the server
// still lists a dialog the player just answered. Every family therefore has to
// remember what it dismissed and skip it until the server catches up, or the
// window visibly pops back for one poll before closing for good. That's four
// steps (record on close, skip while dismissed, drop the record once the item
// leaves the snapshot, and don't confuse a genuinely new dialog for the
// dismissed one) repeated once per family — and two of the thirteen copies were
// missing them, which is exactly the bug this replaced. Declaring a family here
// gets all four for free; forgetting them is no longer possible.
//
// A family is declared with registerDialog() and never calls its own refresh:
// syncDialogs(scene) drives all of them once per poll, in registration order.

// Every registered family, in registration order (windows layer in that order
// on a poll that opens several at once).
const dialogFamilies = [];

// How a family decides WHICH windows should exist:
//   "list"   the snapshot's list IS the window set — open what appears, close
//            what disappears. The default, and what most dialogs are.
//   "seq"    the item carries a monotonic open-counter; a window opens only when
//            that counter ADVANCES, so closing one locally doesn't reopen it
//            while the item lingers in the snapshot. Still auto-closes when the
//            item leaves. (Treasure maps: the server re-sends the same map item
//            on every update, and only a fresh 0x90/0xF5 bumps `openSeq`.)
//   "local"  app code owns opening and closing (a double-click, a 0x24 event);
//            the snapshot only supplies CONTENT. Never auto-opens, never
//            auto-closes. (Containers.)
const OPEN_POLICIES = new Set(["list", "seq", "local"]);

// How a family suppresses a window the player closed, until the server agrees:
//   "content"  remember key → signature; skip while the snapshot still shows
//              that exact content. If the server sends DIFFERENT content under
//              the same key that's a real new dialog, so it opens. Needed
//              wherever the transport can reuse a key (World::add_gump upserts
//              gumps by serial).
//   "session"  remember the key alone; skip until the key leaves the snapshot.
//              For dialogs whose content keeps changing right up until the
//              server tears them down — a trade's items and offered gold move
//              after the player hits cancel, and a content-keyed guard would let
//              one of those updates reopen the window.
//   "none"     nothing closes locally; the window only ever goes away because
//              the server dropped the item. (The house-design panel: its ✕ asks
//              the server to end the session and waits for that to land.)
const DISMISS_POLICIES = new Set(["content", "session", "none"]);

// Declare a dialog family. Fields:
//   id       name, for errors and debugging
//   source   (scene) => items[]. A singleton dialog returns [] or [theOne];
//            that's the whole reason singletons need no special case here.
//            Omitted for open:"local" (there is no server-side list).
//   key      (item) => stable identity (serial, seq, composite string, …).
//            Windows are kept in a Map under this.
//   sig      (item, scene) => string, the content signature: what "changed"
//            means. `scene` is there for families whose content lives outside
//            their own item (a trade's goods are in scene.contItems). For
//            open:"local" it takes (scene, key) instead, since there is no item.
//            Omit when content never changes after build.
//   seq      (item) => number. Required for open:"seq".
//   build    (item, ctx) => win, where win is at least { el }. ctx is
//            {key, sig, scene, previous}; `previous` is the window being replaced on a
//            rebuild (else undefined), so a family can carry LOCAL ui state
//            across server-driven content changes — the selected page of a
//            multi-page gump, say, which the server's refresh shouldn't reset.
//   update   (win, item, ctx) => void. Optional. WITH it, a signature change
//            updates the window in place; WITHOUT it, a signature change tears
//            the window down and rebuilds it (right for gumps/menus, whose
//            layout is server-authored and can change wholesale).
//   close    (win, key) => void. Optional teardown; defaults to removing win.el.
//            Use it for families that hold state beyond the element.
//   reopen   (win, item) => void. open:"seq" only: the server re-issued a dialog
//            that is ALREADY open (the counter advanced but the window never
//            went away) — raise it, rather than silently doing nothing.
function registerDialog(spec) {
  const open = spec.open || "list";
  const dismiss = spec.dismiss || "none";
  if (!OPEN_POLICIES.has(open)) throw new Error(`dialog ${spec.id}: bad open policy ${open}`);
  if (!DISMISS_POLICIES.has(dismiss)) throw new Error(`dialog ${spec.id}: bad dismiss policy ${dismiss}`);
  if (open === "seq" && !spec.seq) throw new Error(`dialog ${spec.id}: open:"seq" needs seq()`);
  if (open === "local" && dismiss !== "none") {
    // Nothing re-opens a "local" window from the snapshot, so there is nothing
    // for a guard to protect against — asking for one means the family was
    // modelled wrong.
    throw new Error(`dialog ${spec.id}: open:"local" cannot use a dismiss guard`);
  }
  const family = {
    ...spec,
    open,
    dismiss,
    wins: new Map(),       // key -> win
    dismissed: new Map(),  // key -> signature ("content") or true ("session")
    seqSeen: new Map(),    // key -> highest seq we've opened for (open:"seq")
  };
  dialogFamilies.push(family);
  return family;
}

function dialogFamily(id) {
  const family = dialogFamilies.find((f) => f.id === id);
  if (!family) throw new Error(`no dialog family ${id}`);
  return family;
}

// The window for `key`, or undefined. Lets app code reach into a family it
// declared (a click handler needing its own window's inputs, say).
function dialogWindow(id, key) {
  return dialogFamily(id).wins.get(key);
}
function dialogWindows(id) {
  return dialogFamily(id).wins;
}

// Tear a window down without recording a dismissal — for closes the SERVER
// initiated, and for app code that manages its own "local" windows.
function closeDialog(id, key) {
  const family = dialogFamily(id);
  const win = family.wins.get(key);
  if (!win) return;
  family.wins.delete(key);
  if (family.close) family.close(win, key);
  else if (win.el) win.el.remove();
}

// The player closed/answered this window: tear it down NOW (no waiting a poll
// for the server's echo) and remember it, so a snapshot built before the reply
// landed can't rebuild it. This is the call every ✕ / Cancel / submit path
// should make; see the DISMISS_POLICIES note for what gets remembered.
function dismissDialog(id, key) {
  const family = dialogFamily(id);
  const win = family.wins.get(key);
  if (family.dismiss === "content") family.dismissed.set(key, win ? win._sig : null);
  else if (family.dismiss === "session") family.dismissed.set(key, true);
  closeDialog(id, key);
}

// The player explicitly asked for this dialog again (re-right-clicked the same
// mobile, say). Drop the guard so it can reopen even though the server still has
// the identical item in the snapshot and would otherwise stay suppressed.
function undismissDialog(id, key) {
  dialogFamily(id).dismissed.delete(key);
}

// True while `key` is being suppressed for this snapshot's content.
function isDialogDismissed(family, key, sig) {
  if (!family.dismissed.has(key)) return false;
  if (family.dismiss === "session") return true;
  if (family.dismissed.get(key) === sig) return true;
  // Same key, different content — a genuinely new dialog. Stop suppressing.
  family.dismissed.delete(key);
  return false;
}

// Reconcile one family against the snapshot.
function syncDialogFamily(family, scene) {
  // "local": the window set is app-owned, so there's nothing to open or close
  // here — only content to push into whatever is already on screen.
  if (family.open === "local") {
    for (const [key, win] of [...family.wins]) {
      const sig = family.sig ? family.sig(scene, key) : null;
      if (sig !== null && win._sig === sig) continue;
      win._sig = sig;
      if (family.update) family.update(win, scene, { key, sig, scene });
    }
    return;
  }

  const items = family.source(scene) || [];
  const seen = new Set();
  for (const item of items) {
    const key = family.key(item);
    seen.add(key);
    const sig = family.sig ? family.sig(item, scene) : null;
    if (isDialogDismissed(family, key, sig)) continue;

    let win = family.wins.get(key);
    if (!win) {
      // A "seq" family opens only on a counter it hasn't seen yet; note the
      // counter either way so a window closed later doesn't spring back.
      if (family.open === "seq") {
        const seq = family.seq(item) | 0;
        const highest = family.seqSeen.get(key) | 0;
        family.seqSeen.set(key, Math.max(highest, seq));
        if (seq <= highest) continue;
      }
      win = family.build(item, { key, sig, scene });
      if (!win) continue;                // build declined (nothing to show yet)
      win._sig = sig;
      family.wins.set(key, win);
      if (family.update) family.update(win, item, { key, sig, scene });
      continue;
    }
    if (family.open === "seq") {
      const seq = family.seq(item) | 0;
      const highest = family.seqSeen.get(key) | 0;
      family.seqSeen.set(key, Math.max(highest, seq));
      if (seq > highest && family.reopen) family.reopen(win, item);
    }
    if (sig !== null && win._sig === sig) continue;   // unchanged
    if (family.update) {
      win._sig = sig;
      family.update(win, item, { key, sig, scene });
    } else if (sig === null) {
      // Omitted sig means "content never changes after build". The check above
      // only skips when `sig !== null`, so a missing sig used to fall through
      // and rebuild every poll — the right-click popup flickered open/closed.
      continue;
    } else {
      // No in-place update: the layout is server-authored, so rebuild it — but
      // hand the outgoing window to build() so local ui state can survive.
      const previous = win;
      closeDialog(family.id, key);
      const rebuilt = family.build(item, { key, sig, scene, previous });
      if (rebuilt) { rebuilt._sig = sig; family.wins.set(key, rebuilt); }
    }
  }

  // Gone from the snapshot → the server closed it.
  for (const key of [...family.wins.keys()]) {
    if (!seen.has(key)) closeDialog(family.id, key);
  }
  // …and once it's gone, stop suppressing it, so a later dialog reusing the key
  // isn't swallowed and the guard map can't grow without bound.
  for (const key of [...family.dismissed.keys()]) {
    if (!seen.has(key)) family.dismissed.delete(key);
  }
  // Same for the open-counter high-water marks.
  for (const key of [...family.seqSeen.keys()]) {
    if (!seen.has(key)) family.seqSeen.delete(key);
  }
}

// Adopt the snapshot's open-counters WITHOUT opening anything — the open:"seq"
// half of main.js's `primeSeqRings`. Call once, on the first snapshot after page
// load, or every dialog the world still happens to be carrying (a treasure map
// opened before a refresh) would pop open as if the server had just sent it.
function primeDialogSeqs(scene) {
  for (const family of dialogFamilies) {
    if (family.open !== "seq") continue;
    for (const item of family.source(scene) || []) {
      family.seqSeen.set(family.key(item), family.seq(item) | 0);
    }
  }
}

// Drive every family. Call once per poll, after `scene` is swapped in.
function syncDialogs(scene) {
  for (const family of dialogFamilies) syncDialogFamily(family, scene);
}

// ── shared window chrome ───────────────────────────────────────────────────
// The dark title bar + ✕ + draggable body that every dialog wears. Returns the
// pieces a family needs; the family fills `body` with its own content.
//
// `cascade` staggers successive windows of the same family so they don't stack
// exactly on top of each other; pass the family's own counter object. `pos`
// overrides it outright (a remembered per-kind position, say).
// ---- window geometry: remembered, resizable, kept on screen ----
//
// Keyed by the window's CLASS, not by the serial it happens to be showing. A
// serial is per-corpse, per-bag, per-gump and never comes back, so a
// serial-keyed memory would remember nothing you could ever see again; keying
// by class means "the next container opens where I put the last one", which is
// what a person actually wants and what ClassicUO's per-type defaults do.
const WIN_GEOM_KEY = "anima.winGeom";
function normalizeWindowGeometry(value) {
  if (!prefObject(value) || Object.keys(value).length > 512) return null;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[#.][a-z0-9_-]{1,128}$/i.test(key) || !prefObject(entry)) continue;
    const geometry = { ...entry };
    for (const [first, second, min, max] of [["left", "top", -100000, 100000], ["w", "h", 1, 16384]]) {
      if (Object.hasOwn(entry, first) || Object.hasOwn(entry, second)) {
        if (!prefNumber(entry[first], min, max) || !prefNumber(entry[second], min, max)) {
          delete geometry[first]; delete geometry[second];
        }
      }
    }
    result[key] = geometry;
  }
  return result;
}
preferenceStorage.json(WIN_GEOM_KEY, normalizeWindowGeometry, { adoptLegacy: true });
const CHARACTER_GEOM_KEY = "anima.characterWinGeom";
function normalizeCharacterGeometry(value) {
  if (!prefObject(value) || Object.keys(value).length > 128) return null;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-f0-9]{64}$/.test(key)) continue;
    const normalized = normalizeWindowGeometry(entry);
    if (normalized) result[key] = normalized;
  }
  return result;
}
preferenceStorage.json(CHARACTER_GEOM_KEY, normalizeCharacterGeometry);
let characterGeometryKey = null, characterGeometryIdentity = null;
const windowDefaultPositions = new WeakMap();
const windowDefaultSizes = new WeakMap();
function readCharacterGeometry() { return JSON.parse(preferenceStorage.getItem(CHARACTER_GEOM_KEY) || "{}"); }
function readWindowGeometry() {
  const common = JSON.parse(preferenceStorage.getItem(WIN_GEOM_KEY) || "{}");
  if (!characterGeometryKey) return common;
  return readCharacterGeometry()[characterGeometryKey] || common;
}
async function bindCharacterGeometry(nextScene) {
  const serial = nextScene?.player?.serial, identity = nextScene?.layoutIdentity;
  if (typeof identity !== "string" || !identity || identity.length > 4096 || !Number.isInteger(serial) || serial <= 0 || serial > 0xffffffff) return;
  const combined = JSON.stringify([identity, serial]);
  if (characterGeometryIdentity === combined) return;
  // No account names or endpoint strings enter the settings backup. If Web
  // Crypto is unavailable, keep the existing common layout for this session.
  if (!globalThis.crypto?.subtle) return;
  let digest;
  try { digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(combined)); }
  catch (_) { return; }
  characterGeometryKey = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("");
  characterGeometryIdentity = combined;
  // Static panels were initialized before login. Replace those common
  // positions before the first world frame; dynamic windows restore on open.
  for (const el of document.querySelectorAll(".gump-win")) {
    const defaults = windowDefaultPositions.get(el);
    if (defaults) { Object.assign(el.style, defaults); restoreWinPos(el); }
    restoreWinSize(el);
  }
}
function restoreWinSize(el) {
  const defaults = windowDefaultSizes.get(el);
  if (!defaults) return;
  const saved = readWindowGeometry()[winKey(el)];
  defaults.body.style.width = saved?.w ? saved.w + "px" : defaults.width;
  defaults.body.style.height = saved?.h ? saved.h + "px" : defaults.height;
}
let winGeom = readWindowGeometry();
function saveWinGeom(key, g) {
  if (!key) return;
  // Another tab can move a different window while this one is open. Read the
  // latest group and change only this window's position/size fields.
  const latest = readWindowGeometry();
  const next = { ...latest, [key]: { ...latest[key], ...g } };
  const checked = normalizeWindowGeometry(next);
  if (!checked || JSON.stringify(checked) !== JSON.stringify(next)) return;
  winGeom = next;
  if (characterGeometryKey) {
    const profiles = readCharacterGeometry();
    preferenceStorage.setItem(CHARACTER_GEOM_KEY, JSON.stringify({ ...profiles, [characterGeometryKey]: winGeom }));
  } else preferenceStorage.setItem(WIN_GEOM_KEY, JSON.stringify(winGeom));
}
// A window's identity for the geometry store: its element id when it has one
// (the static panels), otherwise its own class (the dynamic windows). Never the
// serial — see the note above.
function winKey(el) {
  if (el.dataset.windowGeometryKey) return el.dataset.windowGeometryKey;
  if (el.id) return "#" + el.id;
  const cls = [...el.classList].find((c) => c !== "gump-win" && c !== "on");
  return cls ? "." + cls : null;
}
// Where a window effectively is. A hidden panel measures as all zeros — the
// paperdoll and friends are `display: none` until their key is pressed — so
// the rect alone is not enough; fall back to the inline position it will take
// when shown. Both the clamp and the save go through this, because getting it
// right in only one of them stores a corner position for a window that is
// visibly somewhere else.
function winPos(el) {
  const r = el.getBoundingClientRect();
  if (r.width !== 0 || r.height !== 0) return { x: r.left, y: r.top };
  const x = parseFloat(el.style.left), y = parseFloat(el.style.top);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}
function saveWinPos(el) {
  const p = winPos(el);
  if (p) saveWinGeom(winKey(el), { left: Math.round(p.x), top: Math.round(p.y) });
}
function restoreWinPos(el) {
  if (!windowDefaultPositions.has(el)) {
    windowDefaultPositions.set(el, Object.fromEntries(["left", "top", "right", "bottom"].map(k => [k, el.style[k] || ""])));
  }
  winGeom = readWindowGeometry();
  const g = winGeom[winKey(el)];
  if (!g || g.left == null) return;
  el.style.left = g.left + "px";
  el.style.top = g.top + "px";
  el.style.right = "auto";      // the static panels are right-anchored by CSS
  el.style.bottom = "auto";
  // Write the clamped position back, so a geometry saved on a bigger screen
  // heals itself instead of being re-clamped on every open forever.
  if (clampWindow(el)) saveWinPos(el);
}
// Pull a window fully back into view. Runs on restore AND whenever the browser
// window changes size, because a position saved on a wide monitor is off-screen
// on a laptop and a window you cannot see is a window you cannot close. Keeps
// the same margins the drag clamp uses so the two cannot disagree.
function clampWindow(el) {
  // Measured live before `winPos` existed: a position planted at (5000, 4000)
  // survived into a 756-wide viewport, because clamping a hidden panel's
  // zero-rect is a no-op that leaves the real inline position untouched.
  const p = winPos(el);
  if (!p) return false;
  const curX = p.x, curY = p.y;
  const x = Math.max(0, Math.min(window.innerWidth - 40, curX));
  const y = Math.max(0, Math.min(window.innerHeight - 24, curY));
  if (x === curX && y === curY) return false;
  el.style.left = x + "px";
  el.style.top = y + "px";
  return true;
}
function clampAllWindows() {
  for (const el of document.querySelectorAll(".gump-win")) clampWindow(el);
}
window.addEventListener("resize", clampAllWindows);

function makeWindowFrame({
  cls, title, bodyCls, cascade, pos, onClose, draggable = true,
  resizable = false, geometryKey,
}) {
  const el = document.createElement("div");
  el.className = "gump-win" + (cls ? " " + cls : "");
  // Assign before restore/observation: distinct server dialog kinds must not
  // inherit a small previous dialog's size. Legacy shared settings stay stored.
  if (geometryKey && /^[#.][a-z0-9_-]{1,128}$/i.test(geometryKey)) el.dataset.windowGeometryKey = geometryKey;
  // Position: `pos`/`cascade` set the default. A remembered position, if there
  // is one, is applied later by `makeDraggable` and wins — the user put it
  // there on purpose.
  if (pos) {
    el.style.left = pos.left + "px";
    el.style.top = pos.top + "px";
  } else if (cascade) {
    const off = (cascade.n++ % (cascade.wrap || 8)) * (cascade.step || 22);
    el.style.left = (cascade.left + off) + "px";
    el.style.top = (cascade.top + off) + "px";
  }
  const bar = document.createElement("div");
  bar.className = "gump-title";
  const label = document.createElement("span");
  label.textContent = title || "";
  const closer = document.createElement("span");
  closer.className = "gump-close";
  closer.textContent = "✕";
  bar.appendChild(label);
  bar.appendChild(closer);
  const body = document.createElement("div");
  body.className = "gump-body" + (bodyCls ? " " + bodyCls : "");
  el.appendChild(bar);
  el.appendChild(body);
  document.body.appendChild(el);
  if (onClose) closer.addEventListener("click", onClose);
  if (draggable) makeDraggable(el, bar);   // restores + persists, keyed by class
  if (resizable) {
    body.classList.add("win-resizable");
    // One key per window for both halves of its geometry — `winKey`, the same
    // one `makeDraggable` persists the position under.
    const key = winKey(el);
    windowDefaultSizes.set(el, { body, width: body.style.width || "", height: body.style.height || "" });
    restoreWinSize(el);
    // The resize drag is the browser's own, so there is no event of ours to
    // hang this on — the same reason the journal watches itself this way.
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => {
        if (body.offsetWidth > 0) saveWinGeom(key, { w: body.offsetWidth, h: body.offsetHeight });
      }).observe(body);
    }
  }
  clampWindow(el);
  return { el, bar, body, label, closer };
}
