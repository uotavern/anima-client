// ---- overhead speech (ClassicUO MessageManager / overhead text) ----
const OVERHEAD_HEAD = 68;   // px above the feet anchor — clears the head (incl. hats/hair)

// Client-side system messages (skill gains, etc.) that aren't in the server journal.
// They render after the server's journal lines in `hud()`. Capped FIFO so old notices
// don't pile up forever at the bottom.
const localJournal = [];           // { text } — newest last
const LOCAL_JOURNAL_MAX = 40;
// Monotonic counter, bumped on every addSysMessage — NOT derived from length or
// newest-text. Once localJournal is at its cap, pushing another line no longer
// changes .length, and a new line whose text happens to repeat the previous one
// wouldn't change "newest text" either; either alone would make hud()'s journal
// change-signature miss a real append and silently drop the line from the DOM.
let localJournalSeq = 0;
function addSysMessage(text) {
  localJournal.push({ text });
  localJournalSeq++;
  while (localJournal.length > LOCAL_JOURNAL_MAX) localJournal.shift();
}
// Server chat system (0xB2): show each new line in the journal once.
//
// `scene.chat.lines` is a seq-stamped ring, not a delta — the same contract as
// sounds/damage — so the cursor is what makes a line appear exactly once even
// though the whole ring is re-sent every poll. Primed on the first scene like
// `primeSeqRings`, so a reload does not replay the backlog.
//
// A line with an empty `sender` is server status text (the 0xB2 commands with
// no template table behind them — see `chat_message`'s default arm), so it is
// printed bare rather than as "': text".
//
// Two cosmetics are cleaned up HERE and not in the scene, because the raw
// values carry information a consumer may want and the tidying is display
// policy:
//   * ServUO builds a chat username as `String.Format("<{0}>{1}", serial,
//     name)` (`ChatUser.Username`), so the speaker's serial rides in the
//     sender. `scene.chat.lines[].sender` keeps it — that is how a brain links
//     a chat line to a mobile — and only the journal drops it.
//   * The text arrives with a leading space, left behind when the colour tag
//     `{...}` in front of it is removed (the core does that strip, matching
//     ClassicUO).
// ClassicUO prints `$"{username}: {msgSent}"` and therefore shows both warts;
// this is a deliberate, cosmetic-only departure.
let lastChatSeq = 0;           // highest chat line seq we've already printed
function ingestChat(s) {
  const lines = (s.chat && s.chat.lines) || [];
  for (const l of lines) {
    const seq = l.seq | 0;
    if (seq <= lastChatSeq) continue;
    lastChatSeq = seq;
    const who = (l.sender || "").replace(/^<\d+>/, "");
    const text = (l.text || "").trim();
    if (!text) continue;
    addSysMessage(who ? `[chat] ${who}: ${text}` : `[chat] ${text}`);
  }
}
// Scan the journal for new lines and float each above its speaker once.
let journalPrimed = false;
function ingestSpeech(s) {
  const now = performance.now();
  const pserial = s.player ? (s.player.serial >>> 0) : 0;
  // On the FIRST scene after a (re)load, don't replay the journal backlog as floating
  // overheads — just advance the seq cursor so only genuinely NEW lines float after.
  if (!journalPrimed) {
    journalPrimed = true;
    for (const j of s.journal || []) lastJournalSeq = Math.max(lastJournalSeq, j.seq | 0);
    return;
  }
  for (const j of s.journal || []) {
    const seq = j.seq | 0;
    if (seq <= lastJournalSeq) continue;
    lastJournalSeq = seq;
    const text = (j.text || "").trim();
    // Cliloc lines now arrive pre-resolved to real text (play.rs), so float them
    // too — only truly-empty lines are skipped.
    if (!text) continue;
    const serial = (j.serial >>> 0);
    if (!serial || serial === 0xffffffff) continue;     // system message → not overhead
    if (isIgnoredLine(j)) continue;                     // ClassicUO: MessageManager's ignore check
    const id = serial === pserial ? "self" : "m" + serial;
    if (!anim.has(id)) continue;                         // speaker not in view
    addOverhead(id, text, j.type | 0, j.hue | 0, now);
  }
}

function addOverhead(id, text, type, hue, now) {
  // DOM label (crisp), not PIXI text — see the note in drawBars about the canvas
  // being pixel-upscaled. On T2A even single-click names arrive as overhead text.
  const el = document.createElement("div");
  el.className = "oh-label" + (MSG_CLASS[type] ? " " + MSG_CLASS[type] : "");
  paintUoFont(el, text);
  namesEl().appendChild(el);
  // Linger longer for longer lines (ClassicUO scales with length), then fade.
  const ttl = Math.min(8000, 3000 + text.length * 70);
  const o = { id, text, type, hue, born: now, ttl, el, _c: null };
  applyOverheadColor(o); // server-hue → type-default; re-applied each frame if late
  overheads.push(o);
  while (overheads.length > 40) { const x = overheads.shift(); if (x.el) x.el.remove(); }
}
// Set the overhead's color (only writes the DOM when it actually changes, so a
// late-arriving hue from the async hue table recolors it on a later frame).
function applyOverheadColor(o) {
  const c = o.fc || msgColor(o.type, o.hue); // fc = a forced colour (e.g. notoriety name)
  if (o._c !== c) {
    if (o.el.classList.contains("uo")) o.el.style.backgroundColor = c;
    else o.el.style.color = c;
    o._c = c;
  }
}

// Rasterize `text` with the shard's `unifont*.mul` (ClassicUO overhead path).
// 1-bit glyphs are white; we CSS-mask them so `background-color` is the hue.
// A 404 (fonts not loaded) falls back to the system font already on the label.
function paintUoFont(el, text) {
  const src = "font/text.png?font=1&uni=1&t=" + encodeURIComponent(text);
  if (el._fontSrc === src) return;
  el._fontSrc = src;
  const img = new Image();
  img.onload = () => {
    if (el._fontSrc !== src) return;
    el.classList.add("uo");
    el.textContent = "";
    el.style.width = img.naturalWidth + "px";
    el.style.height = img.naturalHeight + "px";
    el.style.webkitMaskImage = `url("${src}")`;
    el.style.maskImage = `url("${src}")`;
    if (el.style.color) el.style.backgroundColor = el.style.color;
    el._w = img.naturalWidth;
    el._h = img.naturalHeight;
    el._measure = true;
  };
  img.onerror = () => {
    if (el._fontSrc !== src) return;
    el.classList.remove("uo");
    el.style.webkitMaskImage = "";
    el.style.maskImage = "";
    el.style.width = "";
    el.style.height = "";
    el.textContent = text;
    el._w = el._h = undefined;
    el._measure = true;
  };
  img.src = src;
}

// Float a mobile's name above its head in its notoriety colour (single-click, like
// ClassicUO). Works for yourself too (scene.player carries `noto`); for others the
// name/notoriety come from the mobile (or its OPL if the name hasn't loaded yet).
function showNameOverhead(serial, tries) {
  if (!scene) return;
  const sv = serial >>> 0;
  const isSelf = scene.player && sv === (scene.player.serial >>> 0);
  let name, noto;
  // ServUO DOES send your own notoriety, and this comment used to say it does not.
  // 0x22 MovementAck carries `Notoriety.Compute(m, m)` on every accepted step
  // (`Packets.cs:4521`) and 0x77 MobileMoving is sent to your own state with the
  // same value (`Mobile.cs:11398`) — which is why `mobiles.rs` captures notoriety
  // for self as well, and why `scene.player.noto` reads 3 on a gray GM rather than
  // 0. Measured live before this comment was rewritten.
  //
  // The `|| 1` is therefore a FALLBACK for a shard that genuinely sends nothing,
  // not the normal path: a real 0 means "unknown", and Innocent blue is the
  // classic colour for your own name.
  if (isSelf) { name = scene.player.name; noto = (scene.player.noto | 0) || 1; }
  else {
    const m = (scene.mobiles || []).find((x) => (x.serial >>> 0) === sv);
    if (!m) return;
    name = m.name || (scene.opl && scene.opl[sv] && scene.opl[sv][0]) || "";
    noto = m.noto | 0;
  }
  if (!name) {                       // name not loaded yet — the server click fetches its
    if ((tries | 0) < 2) setTimeout(() => showNameOverhead(sv, (tries | 0) + 1), 400); // OPL; retry
    return;
  }
  name = name.replace(/\s+/g, " ").trim(); // OPL names can carry tabs ("Carl\tthe tailor")
  // A single-click name is a server Label message in ClassicUO, so its ignore
  // filter covers it; ours is built client-side and has to check for itself.
  if (isIgnoredName(name)) return;
  const id = isSelf ? "self" : "m" + sv;
  if (!anim.has(id)) return;         // not in view
  const el = document.createElement("div");
  el.className = "oh-label oh-name";
  el.textContent = name;
  namesEl().appendChild(el);
  const o = { id, text: name, type: 6, hue: 0, born: performance.now(), ttl: 3000, el, _c: null,
              fc: cssColor(notoColor(noto)) };
  applyOverheadColor(o);
  overheads.push(o);
  while (overheads.length > 40) { const x = overheads.shift(); if (x.el) x.el.remove(); }
}

// Position each floating line above its speaker (screen coords = camera + canvas→CSS
// stretch), stack multiples upward, fade out near end of life, reap expired ones.
function drawOverheads(now) {
  const stack = new Map();   // entity id → accumulated CSS height already placed
  const fx = window.innerWidth / app.renderer.width, fy = window.innerHeight / app.renderer.height;
  for (let i = overheads.length - 1; i >= 0; i--) {
    const o = overheads[i];
    const age = now - o.born;
    if (age >= o.ttl) { if (o.el) o.el.remove(); overheads.splice(i, 1); continue; }
    const st = anim.get(o.id);
    if (!st) { if (o.el) o.el.style.display = "none"; continue; } // speaker left view
    o.el.style.display = "block";
    applyOverheadColor(o);   // pick up a server hue that resolved after creation
    const up = stack.get(o.id) || 0;
    o.el.style.left = ((app.stage.x + isoX(st.rx, st.ry) * camZoom) * fx) + "px";
    o.el.style.top = ((app.stage.y + (isoY(st.rx, st.ry, st.rz ?? st.z) - OVERHEAD_HEAD) * camZoom) * fy - up) + "px";
    stack.set(o.id, up + (o.el.offsetHeight || 16) + 2);
    const left = o.ttl - age;
    o.el.style.opacity = left < 700 ? Math.max(0, left / 700) : 1;
  }
}

// Float a red (orange when it's us) damage number over each newly-hit entity.
// Play new character-animation events (0x6E): a transient action (combat swing, bow,
// get-hit) on a mobile. We stash it on the entity's anim state; drawMobs plays group
// `act` once over its frames, then reverts to the idle/walk pose.
function ingestAnims(s) {
  if (!s || !s.anims) return;
  const now = performance.now();
  const pserial = s.player ? (s.player.serial >>> 0) : 0;
  for (const ev of s.anims) {
    const seq = ev.seq | 0;
    if (seq <= lastAnimSeq) continue;
    lastAnimSeq = seq;
    const serial = ev.serial >>> 0;
    const id = serial === pserial ? "self" : "m" + serial;
    const st = anim.get(id);
    if (!st) continue;                               // actor not in view
    st.act = { group: ev.act | 0, fwd: ev.fwd !== false, startMs: now,
               frameMs: CHAR_ANIM_FRAME_MS + (ev.delay | 0) * 10 };
    markDirty();
  }
}

// Play new *typed* animation events (0xE2): an emote/gesture/alert/… on a mobile.
// Unlike 0x6E, `typ`/`act` aren't a raw animation group — resolveTypedAnimGroup()
// (called from drawMobs, where the body/mount state is known) converts them.
// ClassicUO never uses the wire "delay" as a timing value here (SetAnimation is
// called with the default interval), so — unlike ingestAnims — we don't stretch
// frameMs by it; it's kept only as `mode` for the per-body group resolver.
function ingestTypedAnims(s) {
  if (!s || !s.tanims) return;
  const now = performance.now();
  const pserial = s.player ? (s.player.serial >>> 0) : 0;
  for (const ev of s.tanims) {
    const seq = ev.seq | 0;
    if (seq <= lastTypedAnimSeq) continue;
    lastTypedAnimSeq = seq;
    const serial = ev.serial >>> 0;
    const id = serial === pserial ? "self" : "m" + serial;
    const st = anim.get(id);
    if (!st) continue;                               // actor not in view
    st.act = { typed: true, typ: ev.typ | 0, action: ev.act | 0, mode: ev.mode | 0,
               fwd: true, startMs: now, frameMs: CHAR_ANIM_FRAME_MS };
    markDirty();
  }
}

function ingestDamage(s) {
  if (!s || !s.damage) return;
  const now = performance.now();
  const pserial = s.player ? (s.player.serial >>> 0) : 0;
  for (const ev of s.damage) {
    const seq = ev.seq | 0;
    if (seq <= lastDamageSeq) continue;
    lastDamageSeq = seq;
    const serial = ev.serial >>> 0;
    const isSelf = serial === pserial;
    const id = isSelf ? "self" : "m" + serial;
    if (!anim.has(id)) continue;                     // target not in view
    addDamageFloater(id, ev.amt | 0, isSelf, now);
  }
}

function addDamageFloater(id, amt, isSelf, now) {
  if (!settings.damage) return;            // damage numbers disabled in Options
  const el = document.createElement("div");
  el.className = "dmg-label" + (isSelf ? " self" : "");
  el.textContent = "-" + amt;
  namesEl().appendChild(el);
  damageFloaters.push({ id, el, born: now, ttl: DAMAGE_TTL });
  while (damageFloaters.length > 40) { const o = damageFloaters.shift(); if (o.el) o.el.remove(); }
}

// Position each damage number over its target, rising and fading over its life.
function drawDamage(now) {
  const fx = window.innerWidth / app.renderer.width, fy = window.innerHeight / app.renderer.height;
  for (let i = damageFloaters.length - 1; i >= 0; i--) {
    const o = damageFloaters[i];
    const age = now - o.born;
    if (age >= o.ttl) { if (o.el) o.el.remove(); damageFloaters.splice(i, 1); continue; }
    const st = anim.get(o.id);
    if (!st) { if (o.el) o.el.style.display = "none"; continue; } // target left view
    o.el.style.display = "block";
    const t = age / o.ttl;                            // 0..1 through its life
    o.el.style.left = ((app.stage.x + isoX(st.rx, st.ry) * camZoom) * fx) + "px";
    o.el.style.top = ((app.stage.y + (isoY(st.rx, st.ry, st.rz ?? st.z) - OVERHEAD_HEAD - 18 - t * DAMAGE_RISE) * camZoom) * fy) + "px";
    o.el.style.opacity = t > 0.5 ? Math.max(0, 1 - (t - 0.5) * 2) : 1; // fade over the back half
  }
}

// ---- graphical effects (0x70/0xC0/0xC7) ----------------------------------
// Resolve a world-tile position for an effect endpoint: prefer a live entity (so
// a fixed/target effect tracks it as it moves), else null (caller falls back to
// the packet's tile coords).
function fxEntityPos(serial, pserial) {
  serial = serial >>> 0;
  if (!serial) return null;
  const id = serial === pserial ? "self" : "m" + serial;
  const st = anim.get(id);
  if (!st) return null;
  return { x: st.rx, y: st.ry, z: st.rz ?? st.z ?? 0 };
}

// Spawn an animated sprite for each effect newer than the last we saw.
function ingestEffects(s) {
  if (!s || !s.effects) return;
  const now = performance.now();
  for (const ev of s.effects) {
    const seq = ev.seq | 0;
    if (seq <= lastEffectSeq) continue;
    lastEffectSeq = seq;
    spawnEffect(ev, now);
  }
}

function ingestDragAnims(s) {
  if (!s || !s.dragAnims) return;
  const now = performance.now();
  for (const ev of s.dragAnims) {
    const seq = ev.seq | 0;
    if (seq <= lastDragAnimSeq) continue;
    lastDragAnimSeq = seq;
    spawnDragAnim(ev, now);
  }
}

// ClassicUO `GraphicEffectBlendMode` (0xC0/0xC7 renderMode % 7). Lightning
// (kind 1) stays additive regardless — it is a gump flash, not this table.
// Modes 4–6 have no exact PIXI equivalent; the nearest named blend is used.
function effectBlendMode(mode, kind) {
  if ((kind | 0) === 1) return "add";
  switch (mode | 0) {
    case 1: return "multiply";
    case 2:
    case 3: return "screen";
    case 4: return "color-burn";
    case 5: return "multiply";
    case 6: return "difference";
    default: return "normal";
  }
}

// The server refused our last pickup (0x27 LiftRej): the item never left its
// source, so just clear the held drag-ghost locally — NOT a drop (nothing ever
// moved, so sending one would wrongly ask the server to place an item it never
// gave us) — and surface the reason as a system journal line, for each `seq`
// newer than the last we handled.
function ingestLiftRejects(s) {
  if (!s || !s.liftRejects) return;
  for (const ev of s.liftRejects) {
    const seq = ev.seq | 0;
    if (seq <= lastLiftRejectSeq) continue;
    lastLiftRejectSeq = seq;
    if (cursorItem) clearCursorItem();
    const reason = ev.reason | 0;
    addSysMessage(LIFT_REJECT_MSG[reason] || LIFT_REJECT_MSG[LIFT_REJECT_MSG.length - 1]);
  }
}

// Reconcile the two legacy server acknowledgements that make ClassicUO release
// its held-item cursor. Our placement UI is optimistic: it clears the ghost as
// soon as it sends drop/equip, so pendingPlacements identifies acknowledgements
// for those already-finished operations. In that case we consume the pending
// entry without touching a newer item the user may now be holding. With no
// pending placement, the server is explicitly ending the active drag and we
// mirror ClassicUO by clearing it.
function ingestDragCompletions(s) {
  if (!s || !s.dragCompletions) return;
  for (const ev of s.dragCompletions) {
    const seq = ev.seq | 0;
    if (seq <= lastDragCompletionSeq) continue;
    lastDragCompletionSeq = seq;

    let pendingIndex = -1;
    if ((ev.packet | 0) === 0x28 && ev.token != null) {
      const token = ev.token >>> 0;
      pendingIndex = pendingPlacements.indexOf(token);
    }
    if (pendingIndex < 0 && pendingPlacements.length) pendingIndex = 0;
    if (pendingIndex >= 0) {
      pendingPlacements.splice(pendingIndex, 1);
    } else if (cursorItem) {
      clearCursorItem();
    }
  }
}

// The server itself opened a container we did NOT double-click ourselves (0x24
// DrawContainer — a banker's "bank" speech, a GM `[bank`, a snoop pick, …).
// Reuses the same openContainer() window our own double-clicks build.
function ingestContainerOpens(s) {
  if (!s || !s.containerOpens) return;
  for (const ev of s.containerOpens) {
    const seq = ev.seq | 0;
    if (seq <= lastContainerOpenSeq) continue;
    lastContainerOpenSeq = seq;
    openContainer(ev.serial >>> 0);
  }
}

// The 8-direction (dx,dy sign) -> UO facing lookup, inverting DIR_DELTA. `dx`/`dy`
// MUST be integer TILE deltas (like ClassicUO's own facing math) — feeding it eased
// render-position deltas (`rx`/`ry`) is wrong: sub-tile easing residue (e.g. rx a
// hair ahead of ry while both are converging on the same tile) makes `Math.sign`
// see a nonzero component on an axis that's actually settled, turning a true
// cardinal facing into a diagonal.
function dirToward(dx, dy) {
  const sx = Math.sign(dx), sy = Math.sign(dy);
  if (!sx && !sy) return null;
  const d = DIR_DELTA.findIndex(([ddx, ddy]) => ddx === sx && ddy === sy);
  return d < 0 ? null : d;
}

// Integer TILE coordinates for an anim-map id, for facing math (see `dirToward`'s
// doc) — never the eased render position. "self" has no `tx`/`ty` on its anim
// entry (only `pred` tracks its committed base tile; see `updateAnimStates`);
// every other entity's anim entry carries the server's current tile as `tx`/`ty`.
function tileOf(id) {
  if (id === "self") return pred ? { x: pred.x, y: pred.y } : null;
  const st = anim.get(id);
  return st ? { x: st.tx, y: st.ty } : null;
}

// The server just told us `attacker` swung at `defender` (0x2F Swing) — purely
// cosmetic feedback: briefly face the attacker toward the defender via a
// render-layer-only override (see `drawMobs`'s `faceOverride` handling). Never
// write `st.dir`/`pred.dir` here — those belong exclusively to the committed
// walk stream (server confirms / local prediction), and `enqueueSteps`' turn-
// vs-move split (mirroring anima-core `Walker::step`'s `is_turn = facing !=
// dir`) reads `pred.dir` as "the player's actual current facing". Stomping it
// with a combat-facing flash desyncs that split from the server's real state,
// causing a one-tile mispredict (a phantom turn-then-move) the instant you walk
// right after swinging — the server's real position then arrives and the
// client rubber-bands to correct it.
function ingestSwings(s) {
  if (!s || !s.swings) return;
  const now = performance.now();
  const pserial = s.player ? (s.player.serial >>> 0) : 0;
  for (const ev of s.swings) {
    const seq = ev.seq | 0;
    if (seq <= lastSwingSeq) continue;
    lastSwingSeq = seq;
    const attacker = ev.attacker >>> 0, defender = ev.defender >>> 0;
    const isSelf = attacker === pserial;
    const aId = isSelf ? "self" : "m" + attacker;
    const dId = defender === pserial ? "self" : "m" + defender;
    const a = anim.get(aId);
    if (!a) continue;                               // attacker isn't in view
    const at = tileOf(aId), dt = tileOf(dId);
    if (!at || !dt) continue;                        // either lacks a known tile yet
    const dir = dirToward(dt.x - at.x, dt.y - at.y);
    if (dir == null) continue;
    a.faceOverride = { dir, until: now + 350 }; // ~350ms flash; drawMobs expires/clears it
  }
}

// The server just told us to show a paperdoll (0x88 DisplayPaperdoll) — sent on
// every double-click of a mobile (ours or another's), even a re-click of the
// same one after we'd closed its window; `seq` never repeats, so each request
// (re)opens/refreshes regardless of local dismiss state. Prefer this over the
// client-side body-range guess in onEntityPointerDown (kept as a fallback for
// a shard that never sends this at all) — it's authoritative and carries the
// real title line.
function ingestPaperdoll(s) {
  const p = s && s.paperdoll;
  if (!p) return;
  const seq = p.seq | 0;
  if (seq <= lastPaperdollSeq) return;
  lastPaperdollSeq = seq;
  const serial = p.serial >>> 0;
  const pserial = s.player ? (s.player.serial >>> 0) : 0;
  pdServerInfo = { serial, title: p.title || "", canLift: !!p.canLift };
  pdTarget = serial === pserial ? null : serial;
  paperdollOn = true;
  const pd = document.getElementById("paperdoll");
  pd.classList.add("on"); pd._sig = null;
  refreshPaperdoll();
}

// Effects live in `world`, not on top of it. ClassicUO gives them their own
// render list but draws every list through the SAME depth buffer, with
// `GameEffectView.Draw` overriding depth to `Source.CalculateDepthZ() + 1f` — so
// an effect occludes, and is occluded by, exactly what a mobile on its tile
// would. Ours used to sit in `overLayer` with no zIndex at all, which painted
// bolts over walls, roofs and trees; worse, a bolt aimed at someone behind a
// wall drew over the wall and so revealed a target the roof rule deliberately
// hides. `mobDepthZ` is the mobile key, so an effect on a mobile clears the
// statics sharing its tile the same way the mobile itself does; the +1 is
// ClassicUO's own tie-break, putting the effect just above its source.
const fxDepthZ = (x, y, z) => mobDepthZ(x, y, z) + 1;
function fxAdd(sprite) {
  sprite.eventMode = "none"; // never a click target — `world` children can be
  world.addChild(sprite);
}
function fxRemove(sprite) {
  world.removeChild(sprite);
  sprite.destroy();
}

function spawnEffect(ev, now) {
  let frames = (ev.frames && ev.frames.length) ? ev.frames : [ev.g | 0];
  const hue = ev.hue | 0;
  // animdata interval is a small tick count; clamp to a lively per-frame range.
  let fm = (ev.interval | 0) > 0 ? Math.min(150, Math.max(50, (ev.interval | 0) * 50)) : 80;
  // Lightning (kind 1) has no ART animation — its graphic arrives as 0. ClassicUO
  // draws it as the 10-frame lightning GUMP strip (0x4E20..0x4E29, ~50ms/frame,
  // additive); mirror that instead of drawing art tile 0 (the "UNUSED" placeholder).
  if ((ev.kind | 0) === 1) {
    frames = [20000, 20001, 20002, 20003, 20004, 20005, 20006, 20007, 20008, 20009];
    fm = 50;
  }
  const cycleMs = frames.length * fm;
  const pserial = (scene && scene.player) ? (scene.player.serial >>> 0) : 0;

  // Endpoints: a live entity if we can see it, else the packet's tile coords.
  const srcPos = fxEntityPos(ev.src, pserial) || { x: ev.sx, y: ev.sy, z: ev.sz | 0 };
  const tgtPos = fxEntityPos(ev.tgt, pserial) || { x: ev.tx, y: ev.ty, z: ev.tz | 0 };

  let totalMs;
  if (ev.kind === 0) {
    // Moving projectile: lifetime = travel time, scaled by distance + speed
    // (an approximation of ClassicUO's MovingEffect pacing).
    const dist = Math.hypot(tgtPos.x - srcPos.x, tgtPos.y - srcPos.y);
    totalMs = Math.min(2000, Math.max(150, dist * (40 + (ev.speed | 0) * 8)));
  } else if (ev.kind === 1) {
    totalMs = Math.max(250, cycleMs); // lightning: one quick flash at the target
  } else {
    // Fixed (2 FixedXYZ / 3 FixedFrom): loop for `dur` repeats, bounded so it
    // always cleans up.
    const reps = (ev.dur | 0) > 0 ? (ev.dur | 0) : 1;
    totalMs = Math.min(2500, Math.max(cycleMs, reps * fm));
  }

  const sprite = new PIXI.Sprite();
  sprite.anchor.set(0.5, 1.0); // foot-anchored like statics; hue baked via ?hue=
  sprite.blendMode = effectBlendMode(ev.blend, ev.kind);
  // Moving projectile: rotate toward the target in screen space, ClassicUO
  // `AngleToTarget = atan2(-dY, -dX)` on the iso delta. Pivot at the art
  // center so the bolt spins around itself rather than its feet.
  if ((ev.kind | 0) === 0) {
    sprite.anchor.set(0.5, 0.5);
    const dx = isoX(tgtPos.x, tgtPos.y) - isoX(srcPos.x, srcPos.y);
    const dy = isoY(tgtPos.x, tgtPos.y, tgtPos.z | 0) - isoY(srcPos.x, srcPos.y, srcPos.z | 0);
    sprite.rotation = Math.atan2(-dy, -dx);
  }
  fxAdd(sprite);
  sprite.zIndex = fxDepthZ(srcPos.x, srcPos.y, srcPos.z | 0); // until drawEffects runs
  fxEffects.push({ kind: ev.kind | 0, src: ev.src >>> 0, tgt: ev.tgt >>> 0,
    frames, fm, hue, born: now, totalMs, sprite, srcPos, tgtPos, pserial,
    // Kept for the impact burst below; `exFrames` only arrives when it is due.
    explodes: !!ev.explodes, blend: ev.blend | 0,
    exFrames: ev.exFrames, exInterval: ev.exInterval | 0 });
  // Bound the pool so a burst of effects can't leak sprites.
  while (fxEffects.length > 48) { const o = fxEffects.shift(); fxRemove(o.sprite); }
  markDirty();
}

function spawnDragAnim(ev, now) {
  const hue = ev.hue | 0;
  const pserial = (scene && scene.player) ? (scene.player.serial >>> 0) : 0;
  const srcPos = fxEntityPos(ev.src, pserial) || { x: ev.sx, y: ev.sy, z: ev.sz | 0 };
  const tgtPos = fxEntityPos(ev.tgt, pserial) || { x: ev.tx, y: ev.ty, z: ev.tz | 0 };
  const dist = Math.hypot(tgtPos.x - srcPos.x, tgtPos.y - srcPos.y);
  const totalMs = Math.min(2000, Math.max(200, dist * 80));
  const sprite = new PIXI.Sprite();
  sprite.anchor.set(0.5, 1.0);
  fxAdd(sprite);
  sprite.zIndex = fxDepthZ(srcPos.x, srcPos.y, srcPos.z | 0);
  fxEffects.push({
    kind: 0, src: ev.src >>> 0, tgt: ev.tgt >>> 0,
    frames: [ev.g | 0], fm: 80, hue, born: now, totalMs, sprite,
    srcPos, tgtPos, pserial, drag: true
  });
  while (fxEffects.length > 48) { const o = fxEffects.shift(); fxRemove(o.sprite); }
  markDirty();
}

// The impact burst for an `explode` moving effect. Fixed at the target for
// ClassicUO's 400 ms, drawn as a kind-2 (FixedXYZ) entry so `drawEffects` keeps
// it pinned to `srcPos` — which for the burst *is* the impact point.
const FX_EXPLODE_MS = 400;
function spawnImpactBurst(o, now) {
  const frames = (o.exFrames && o.exFrames.length) ? o.exFrames : [0x36CB];
  const fm = (o.exInterval | 0) > 0 ? Math.min(150, Math.max(50, (o.exInterval | 0) * 50)) : 80;
  const sprite = new PIXI.Sprite();
  sprite.anchor.set(0.5, 1.0);
  sprite.blendMode = effectBlendMode(o.blend | 0, 2);
  fxAdd(sprite);
  sprite.zIndex = fxDepthZ(o.tgtPos.x, o.tgtPos.y, o.tgtPos.z | 0);
  fxEffects.push({
    kind: 2, src: o.src, tgt: o.tgt, frames, fm, hue: o.hue, born: now,
    totalMs: Math.max(FX_EXPLODE_MS, frames.length * fm), sprite,
    srcPos: o.tgtPos, tgtPos: o.tgtPos, pserial: o.pserial
  });
  while (fxEffects.length > 48) { const x = fxEffects.shift(); fxRemove(x.sprite); }
  markDirty();
}

// Animate + position each active effect; expire (and free) when its life ends.
function drawEffects(now) {
  for (let i = fxEffects.length - 1; i >= 0; i--) {
    const o = fxEffects[i];
    const age = now - o.born;
    if (age >= o.totalMs) {
      fxRemove(o.sprite); fxEffects.splice(i, 1);
      // A moving effect that carried the packet's `explode` byte bursts where it
      // landed. ClassicUO does exactly this in `MovingEffect.RemoveMe` → a second
      // `FixedEffect(0x36CB, Hue, 400, 0)` at the target, inheriting the blend —
      // so the burst is our own follow-up to one packet, not a second packet.
      if (o.kind === 0 && o.explodes && !o.drag) spawnImpactBurst(o, now);
      continue;
    }

    let px, py, pz;
    if (o.kind === 0) {
      // Moving: interpolate source → target over the travel time.
      const t = Math.min(1, age / o.totalMs);
      px = o.srcPos.x + (o.tgtPos.x - o.srcPos.x) * t;
      py = o.srcPos.y + (o.tgtPos.y - o.srcPos.y) * t;
      pz = o.srcPos.z + (o.tgtPos.z - o.srcPos.z) * t;
    } else if (o.kind === 3) {
      // FixedFrom: follow the target entity, else the source, else its tile.
      const p = fxEntityPos(o.tgt, o.pserial) || fxEntityPos(o.src, o.pserial) || o.tgtPos;
      px = p.x; py = p.y; pz = p.z;
    } else if (o.kind === 1) {
      px = o.tgtPos.x; py = o.tgtPos.y; pz = o.tgtPos.z; // lightning at target
    } else {
      px = o.srcPos.x; py = o.srcPos.y; pz = o.srcPos.z; // FixedXYZ at source
    }

    // Cycle the resolved ART frame list (hue baked server-side via ?hue=).
    const g = o.frames[Math.floor(age / o.fm) % o.frames.length] | 0;
    // Lightning frames are GUMP art (0x4E20 strip); everything else is ART tiles.
    const base = o.kind === 1 ? `gump/${g}.png` : `art/static/${g}.png`;
    // `fx=1`: hue effect art the way ClassicUO's EFFECT_HUED shader branch does,
    // indexing the ramp by GREEN rather than red (`IsometricWorld.fx:161-164`
    // vs `:119`). Effect art is mostly coloured rather than greyscale, so the
    // two channels disagree and the wrong one lands on a different step of the
    // ramp — a hued fireball at the wrong brightness. Lightning is GUMP art and
    // is drawn unhued, so it never needs the flag.
    const tex = texFor(base + (o.hue ? `?hue=${o.hue}&fx=1` : ""));
    if (tex && o.sprite.texture !== tex) o.sprite.texture = tex;
    o.sprite.visible = !!o.sprite.texture && o.sprite.texture !== PIXI.Texture.EMPTY;

    o.sprite.x = isoX(px, py);
    o.sprite.y = isoY(px, py, pz) + HALF;
    o.sprite.zIndex = fxDepthZ(px, py, pz | 0);
    const t = age / o.totalMs;
    o.sprite.alpha = t > 0.66 ? Math.max(0, 1 - (t - 0.66) * 3) : 1; // fade out the tail
  }
}

// ---- overhead name + HP bar (ClassicUO health-bar-over-head) ----
const nameDivs = new Map(); // id -> DOM div (crisp name label, pruned on leave)
function namesEl() {
  let el = document.getElementById("names");
  if (!el) { el = document.createElement("div"); el.id = "names"; document.body.appendChild(el); }
  return el;
}
const hpBars = new Map();    // id -> PIXI.Graphics
const tgtMarkers = new Map(); // id -> PIXI.Graphics (current attack-target marker)
const BAR_W = 30, BAR_H = 4; // health bar size
const BAR_HEAD = 40;         // px above the feet anchor for the bar (below the speech)
const BAR_FONT = 'ui-monospace, Menlo, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
// Fill color by remaining health fraction (green → yellow → red), ClassicUO-style.
function hpColor(f) { return f > 0.5 ? 0x46a758 : f > 0.25 ? 0xd9a441 : 0xe5484d; }
// Poison overrides the fraction color entirely: in UO the health bar turns a
// distinct bright green while poisoned, independent of remaining HP, so it
// reads as "poisoned" rather than "healthy" even at a glance. Deliberately a
// cleaner/brighter green than the >50% healthy green (0x46a758) so the two
// don't get confused.
const POISON_COLOR = 0x2fd44a;

// Greedy vertical de-collide for floating name labels — the same greedy-AABB
// idea as the world map's POI label declutter (wmPlaceLabel: an AABB per label,
// skip/keep against everything already placed this pass), except here we NUDGE
// a colliding label straight up instead of hiding it — 2+ named mobiles standing
// close together would otherwise render illegible stacked/overlapping text.
// `boxes` accumulates this pass's already-placed labels (fresh array per
// drawBars() call); returns the (possibly nudged) CSS y to use as the label's
// bottom anchor (labels are positioned bottom-center via
// `transform: translate(-50%,-100%)` — see `.nm-label` in index.html).
function placeNameLabel(boxes, cx, bottom, w, h) {
  const pad = 2;
  let top = bottom - h, moved = true, guard = 0;
  while (moved && guard++ < 16) {
    moved = false;
    for (const b of boxes) {
      if (cx - w / 2 < b.r && cx + w / 2 > b.l && top < b.b + pad && bottom > b.t - pad) {
        bottom = b.t - pad; top = bottom - h; moved = true; // push above whatever it collided with
      }
    }
  }
  boxes.push({ l: cx - w / 2, r: cx + w / 2, t: top, b: bottom });
  return bottom;
}

// ---- name plates / "object handles" (ClassicUO's NameOverHeadManager) -------
//
// Hold Ctrl+Shift, or latch it on, and every entity in view gets a client-side
// name plate: `useObjectHandles = NameOverHeadManager.IsToggled || Keyboard.Ctrl
// && Keyboard.Shift` (GameScene.cs:571), applied per object at
// GameSceneDrawingSorting.cs:831 for mobiles and :892 for ITEMS. A filter picks
// All / Mobiles only / Items only / Mobiles+Corpses
// (NameOverHeadManager.IsAllowed, NameOverHeadHandlerGump.cs:38-125).
//
// The item half is the point: mobile names we already draw whenever the server
// has told us one, but nothing in this client has ever named a thing on the
// ground except by hovering it one at a time.
const plateMods = { ctrl: false, shift: false };
// Tracked here rather than reusing `shiftHeld` (13-macros.js) because that one
// is only maintained while the game keydown handler runs — it early-returns
// while chatting or while a form field has focus, and a plate mode that got
// stuck on because you tabbed away is worse than none.
window.addEventListener("keydown", (e) => { plateMods.ctrl = e.ctrlKey; plateMods.shift = e.shiftKey; });
window.addEventListener("keyup", (e) => { plateMods.ctrl = e.ctrlKey; plateMods.shift = e.shiftKey; });
window.addEventListener("blur", () => { plateMods.ctrl = plateMods.shift = false; });
function platesActive() { return !!settings.namePlates || (plateMods.ctrl && plateMods.shift); }
// ClassicUO MacroType.NamesOnOff → `NameOverHeadManager.ToggleOverheads()`.
function toggleNamePlates() {
  settings.namePlates = !settings.namePlates;
  saveSettings();
  renderOptions();
  setStatus("Name plates " + (settings.namePlates ? "on" : "off"));
  markDirty();
}
// `NameOverHeadManager.IsAllowed`, for the four filters the handler gump offers.
function plateAllowed(isMobile, isCorpse) {
  switch (settings.plateFilter) {
    case "mobiles": return isMobile;
    case "items": return !isMobile;
    case "mobcorpses": return isMobile || isCorpse;
    default: return true;   // "all"
  }
}
const itemPlateDivs = new Map();   // item serial -> DOM div
const platePending = new Set();    // graphics whose /tilename lookup is in flight
// How many ground items get a plate at once. ClassicUO has no such cap, but each
// of ours is a DOM node laid out every frame, and a looted battlefield can put
// hundreds of items in view. The nearest N to the player win; the rest are
// simply not labelled (they still hover-tooltip as before).
const PLATE_ITEM_MAX = 60;

// ClassicUO `NameOverheadGump.SetName` for an item (:61, :70-95): the OPL name if we
// already have one; otherwise an amount prefix for a non-corpse stack, then the
// tiledata name, then cliloc `1020000 + graphic`.
//
// Those last two are exactly what the play server's `/tilename/<graphic>` route
// resolves (`tile_name_json` — tiledata first, cliloc second), so they cost one
// memoized lookup per distinct GRAPHIC rather than a wire request per item.
// Deliberately NO `oplreq` burst here: an OPL we already hold is free, but
// asking for sixty of them the moment Ctrl+Shift goes down is a wire storm the
// user did not ask for, and the tiledata name is what ClassicUO would fall back
// to anyway.
//
// Returns "" while the lookup is in flight or when neither source names it —
// ClassicUO likewise returns false from `SetName` and shows nothing.
function itemPlateName(it) {
  const serial = it.serial >>> 0;
  const opl = oplName(serial);
  if (opl) return opl;
  const g = it.g | 0;
  if (!staticNameCache.has(g)) {
    // `staticTileName` has no in-flight guard of its own (it is written for a
    // one-off click), so the guard lives here — without it every frame would
    // fire another fetch for the same graphic until the first one landed.
    if (!platePending.has(g)) {
      platePending.add(g);
      staticTileName(g, () => { platePending.delete(g); markDirty(); });
    }
    return "";
  }
  const nm = staticNameCache.get(g);
  if (!nm) return "";
  const amt = it.amount | 0;
  return (g !== 0x2006 && amt > 1) ? amt + " " + nm : nm;
}
// A plate is clickable, unlike the passive name labels. ClassicUO gives it three
// gestures and we give it the same three:
//   • a single click ANSWERS A TARGET CURSOR and does nothing otherwise
//     (NameOverheadGump.OnMouseUp, :314-361 — the no-cursor branch only handles
//     dropping a held item, which is the drag-drop layer's job here);
//   • a double click attacks in war mode, else uses/opens (`OnMouseDoubleClick`, :274-301);
//   • dragging a MOBILE's plate off pins a health bar (`DoDrag`, :199-260).
//   • dragging an ITEM's plate picks the item up (`DoDrag`'s `else if (entity
//     != null)` arm → `GameActions.PickUp`, :265).
function wirePlate(el, serial, isMobile) {
  el.addEventListener("mouseup", (e) => {
    // `cursorItem` as well as `_dragged`: a drag that promoted lifted the item on
    // a window listener, and this element's own mouseup still fires afterwards.
    if (e.button !== 0 || el._dragged || cursorItem) { el._dragged = false; return; }
    if (!(scene && scene.target && scene.target.active === 1) || targetUIHidden) return;
    sendInput("target:" + serial);
    endTargetUI();
  });
  el.addEventListener("dblclick", (e) => {
    e.preventDefault();
    const war = !!(scene && scene.war);
    if (isMobile && war) { sendInput("attack:" + serial); return; }
    sendInput("use:" + serial);
    // A container/corpse also needs its loot window opened locally — `use:` alone
    // is only the wire half, exactly as the sprite double-click path does it.
    const it = isMobile ? null : (scene && scene.items || []).find((x) => (x.serial >>> 0) === serial);
    if (it && it.c) openContainer(serial);
  });
  if (!isMobile) {
    // ITEM plate: arm the SAME `groundDrag` the world-sprite path arms rather
    // than lifting here. Everything that hangs off it then comes along
    // unchanged — the stack-split dialog, the locked-item refusal, the
    // one-motion place-on-release — instead of being a second implementation
    // that drifts from the first.
    //
    // `rect` is passed because a plate IS a real on-screen element, so it gets
    // the container-cell rule (leaving the box promotes) rather than the world
    // sprite's hold-time heuristic. On a label this small that is also what
    // stops a double-click's drift from lifting the item.
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || cursorItem) return;
      const it = ((scene && scene.items) || []).find((x) => (x.serial >>> 0) === serial);
      if (!it) return;
      e.preventDefault();
      el._dragged = false;
      groundDrag = {
        serial, g: it.g | 0, amount: (it.amount | 0) || 1,
        st: !!it.st, hue: it.hue | 0,
        sx: e.clientX, sy: e.clientY, started: false, t: performance.now(),
        rect: el.getBoundingClientRect(),
      };
    });
    return;
  }
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Cleared HERE, not in the mouseup below: a drag that ends off the label
    // never fires that handler, and a stale flag would swallow the next click.
    el._dragged = false;
    const sx = e.clientX, sy = e.clientY;
    const move = (ev) => {
      if (Math.abs(ev.clientX - sx) <= 4 && Math.abs(ev.clientY - sy) <= 4) return;
      done();
      el._dragged = true;
      pinHealthBar(serial, ev.clientX - 60, ev.clientY - 20);
    };
    const done = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", done); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", done);
  });
}
// One pass over the ground items, pushing a label job per plate. Shares
// `nameJobs` with the mobile labels so the de-collide pass below sees both.
function collectItemPlates(nameJobs, seenItems) {
  const px = scene.player ? scene.player.x | 0 : 0, py = scene.player ? scene.player.y | 0 : 0;
  const cands = [];
  for (const it of scene.items || []) {
    if (it.serial === undefined || !it.g) continue;
    if (it.nd || it.fh) continue;                       // never-drawn / seasonally culled
    if (!plateAllowed(false, (it.g | 0) === 0x2006)) continue;
    const e = itemPool.get(it.serial);
    if (!e || !e.sp || !e.sp.visible || e.sp.alpha < 0.05) continue;   // no art yet, or under a roof
    const d = Math.abs((it.x | 0) - px) + Math.abs((it.y | 0) - py);
    cands.push({ it, sp: e.sp, d });
  }
  // Only worth ordering when the cap will actually bite.
  if (cands.length > PLATE_ITEM_MAX) cands.sort((a, b) => a.d - b.d);
  const fx = window.innerWidth / app.renderer.width, fy = window.innerHeight / app.renderer.height;
  for (let i = 0; i < cands.length && i < PLATE_ITEM_MAX; i++) {
    const { it, sp } = cands[i];
    const nm = itemPlateName(it);
    if (!nm) continue;                                   // unnamed or still loading
    const serial = it.serial >>> 0;
    const id = "i" + serial;
    seenItems.add(id);
    let d = itemPlateDivs.get(id);
    if (!d) {
      d = document.createElement("div");
      d.className = "nm-label np-plate";
      namesEl().appendChild(d);
      itemPlateDivs.set(id, d);
      wirePlate(d, serial, false);
    }
    if (d._t !== nm) { d.textContent = nm; d._t = nm; d._measure = true; }
    // Anchor to the top of the ART, not the tile: a ground item is foot-anchored
    // at `isoY(x, y, z) + HALF` (05-poll.js's item pool) but a corpse drawn as a
    // resolved death pose is anchored at its draw-centre instead, so the sprite's
    // own anchor is what decides where its top edge is.
    const cx = (app.stage.x + (sp.x + (0.5 - sp.anchor.x) * sp.width) * camZoom) * fx;
    const top = sp.y - sp.anchor.y * sp.height - 2;
    nameJobs.push({ d, serial, cx, naturalBottom: (app.stage.y + top * camZoom) * fy, nm });
  }
}

// Draw a name + HP bar above each OTHER mobile, anchored to its interpolated iso
// position (like the overhead speech). Objects are cached per serial and only
// redrawn when their value/notoriety changes; pruned when the mobile leaves view.
function drawBars(now) {
  if (!scene) return;
  const seen = new Set();
  const seenItems = new Set(); // …and the same for the item plates' own div map
  // Ctrl+Shift (or the latched setting) turns on the plate mode; it can only ADD
  // labels, never take away one `settings.names` already asked for.
  const plates = platesActive();
  const plateMobiles = plates && plateAllowed(true, false);
  const nameBoxes = []; // this pass's placed name-label boxes, for placeNameLabel()
  const nameJobs = []; // {d, serial, cx, naturalBottom, nm} — laid out after the loop, once, in a deterministic order
  let changed = false;
  const lastAttack = (scene.lastAttack | 0) >>> 0; // current auto-attack target (0 = none)
  // The server's authoritative combat opponent (0xAA ChangeCombatant) — usually
  // the same mobile as lastAttack, but the server can retarget on its own (e.g. a
  // pet defending itself), so it's tracked + highlighted separately.
  const combatant = (scene.combatant | 0) >>> 0;
  for (const m of scene.mobiles || []) {
    if (m.so) {
      // Hidden by HasSurfaceOverhead — no sprite, so no bar/name either.
      // Leave `seen` alone so the prune below drops any leftover objects.
      continue;
    }
    const id = "m" + m.serial;
    const st = anim.get(id);
    if (!st) continue;                       // not yet interpolated / left view
    const x = isoX(st.rx, st.ry);
    const feetY = isoY(st.rx, st.ry, st.rz ?? st.z);
    const topY = feetY - BAR_HEAD;       // name + target marker: above the head
    const barY = feetY + 2;              // HP bar: down at the feet (ClassicUO-style)
    // Is this the current attack target (ours or the server's combatant)?
    // Highlight its bar + draw a marker.
    const serial = m.serial >>> 0;
    const tgt = (lastAttack !== 0 && serial === lastAttack) || (combatant !== 0 && serial === combatant);
    // --- HP bar (only when the server gave us hits/hitsMax) ---
    if (settings.bars && (m.hitsMax | 0) > 0) {
      seen.add(id);
      let g = hpBars.get(id);
      if (!g) { g = new PIXI.Graphics(); barLayer.addChild(g); hpBars.set(id, g); changed = true; }
      const frac = Math.max(0, Math.min(1, m.hits / m.hitsMax));
      const poisoned = !!m.poisoned;
      if (g._frac !== frac || g._noto !== m.noto || g._tgt !== tgt || g._poisoned !== poisoned) {
        g.clear();
        // dark backing + notoriety-tinted border, then the health fill. The current
        // target gets a thicker bright-red border so it stands out.
        g.rect(-BAR_W / 2 - 1, -1, BAR_W + 2, BAR_H + 2).fill({ color: 0x000000, alpha: 0.6 })
         .stroke({ color: tgt ? 0xff2d2d : notoColor(m.noto), width: tgt ? 2 : 1 });
        // Bar length still reflects the real HP fraction — only the color signals
        // poison (a poisoned mobile at 20% HP still shows a short bar, just green).
        if (frac > 0) g.rect(-BAR_W / 2, 0, BAR_W * frac, BAR_H).fill(poisoned ? POISON_COLOR : hpColor(frac));
        g._frac = frac; g._noto = m.noto; g._tgt = tgt; g._poisoned = poisoned;
        changed = true;
      }
      g.x = x; g.y = barY; g.visible = true;
    } else {
      const g = hpBars.get(id); if (g) g.visible = false;
    }
    // --- target marker (red diamond above the target; works even with no HP bar) ---
    if (tgt) {
      seen.add(id);
      let mk = tgtMarkers.get(id);
      if (!mk) {
        mk = new PIXI.Graphics();
        mk.poly([0, -5, 5, 0, 0, 5, -5, 0]).fill(0xff2d2d).stroke({ color: 0x000000, width: 1 });
        barLayer.addChild(mk); tgtMarkers.set(id, mk); changed = true;
      }
      mk.x = x; mk.y = topY - 14; mk.visible = true;
    } else {
      const mk = tgtMarkers.get(id); if (mk) mk.visible = false;
    }
    // --- name: a DOM label, NOT PIXI text. The game canvas renders at a capped
    // internal resolution and is nearest-neighbour upscaled to fill the window, so
    // any in-canvas text comes out enlarged/blocky. A DOM overlay is always crisp at
    // the native display resolution. We place it at the entity's *screen* position
    // (camera transform + the canvas→CSS stretch). "no draw" placeholders are skipped.
    // The server's name if it has told us one; otherwise the OPL's first line,
    // the same fallback `showNameOverhead` uses. ClassicUO instead fires a 0x98
    // NameRequest per mobile the moment a handle opens (Entity.Update, :131-143);
    // ours deliberately does not — our nearest equivalent, `allnames`, is a burst
    // of up to 60 single-clicks whose replies arrive as overhead speech and
    // journal lines, which is not a thing to do silently on a keychord. Bind the
    // `all names` macro (or press G) to fill the gaps.
    const nm = (m.name || (plateMobiles ? oplName(serial) : "") || "").trim();
    if (nm && !/^no\s*draw$/i.test(nm) && (settings.names || plateMobiles)) {
      seen.add(id);
      let d = nameDivs.get(id);
      if (!d) {
        d = document.createElement("div"); d.className = "nm-label";
        namesEl().appendChild(d); nameDivs.set(id, d);
        wirePlate(d, serial, true);
      }
      // Only a plate takes clicks: the passive name label has always been
      // decoration and must keep letting clicks through to the sprite under it.
      if (d._plate !== plateMobiles) { d.classList.toggle("np-plate", plateMobiles); d._plate = plateMobiles; }
      // Only a text change invalidates the cached size — mark it for the read
      // phase below instead of measuring inline (that would force a reflow per
      // label per frame, since the loop just dirtied this div's layout).
      if (d._t !== nm) { paintUoFont(d, nm); d._t = nm; d._measure = true; }
      if (d._noto !== m.noto) {
        const c = cssColor(notoColor(m.noto));
        if (d.classList.contains("uo")) d.style.backgroundColor = c;
        else d.style.color = c;
        d._noto = m.noto;
      }
      const fx = window.innerWidth / app.renderer.width, fy = window.innerHeight / app.renderer.height;
      const cx = (app.stage.x + x * camZoom) * fx;
      const naturalBottom = (app.stage.y + (topY - 2) * camZoom) * fy;
      nameJobs.push({ d, serial, cx, naturalBottom, nm });
    } else {
      const d = nameDivs.get(id); if (d) d.style.display = "none";
    }
  }
  // Ground items never get a name from the server the way a mobile does, so the
  // plate mode is the only thing that ever labels one — collected here so both
  // kinds share one de-collide pass and cannot overlap each other.
  // (`collectItemPlates` re-tests each item against the filter — corpses pass in
  // "mobiles + corpses", ordinary items don't — so this only asks whether ANY
  // item could qualify.)
  if (plates && settings.plateFilter !== "mobiles") collectItemPlates(nameJobs, seenItems);
  // Read phase: only labels whose text changed this frame (d._measure, set
  // above) need a fresh offsetWidth/Height — that's the only thing that can
  // actually change a label's size, so steady state (no text changes) reads
  // nothing and forces zero reflows.
  for (const { d, nm } of nameJobs) {
    if (d._measure) {
      // A generous estimate covers the very first frame, before the div has
      // ever been laid out (offsetWidth/Height are 0 pre-layout).
      d._w = d.offsetWidth || (nm.length * 7 + 10);
      d._h = d.offsetHeight || 15;
      d._measure = false;
    }
  }
  // Write phase: sort deterministically (by on-screen bottom, then serial) so
  // the greedy de-collide pass below always visits labels in the same order
  // regardless of scene.mobiles' iteration order (a Rust HashMap — unordered,
  // so it can reshuffle frame-to-frame as mobiles enter/leave view). Without
  // this, which label gets nudged out of a collision could swap arbitrarily.
  nameJobs.sort((a, b) => a.naturalBottom - b.naturalBottom || a.serial - b.serial);
  for (const { d, cx, naturalBottom } of nameJobs) {
    const bottom = placeNameLabel(nameBoxes, cx, naturalBottom, d._w, d._h);
    d.style.left = cx + "px";
    d.style.top = bottom + "px";
    d.style.display = "block";
  }
  // Prune name/bar objects whose mobile left view (don't leak PIXI objects / DOM).
  for (const [id, g] of hpBars) if (!seen.has(id)) { barLayer.removeChild(g); g.destroy(); hpBars.delete(id); changed = true; }
  for (const [id, d] of nameDivs) if (!seen.has(id)) { d.remove(); nameDivs.delete(id); }
  for (const [id, d] of itemPlateDivs) if (!seenItems.has(id)) { d.remove(); itemPlateDivs.delete(id); }
  for (const [id, mk] of tgtMarkers) if (!seen.has(id)) { barLayer.removeChild(mk); mk.destroy(); tgtMarkers.delete(id); changed = true; }
  if (changed) markDirty(); // first appearance / value change → repaint once
}

// Movement/Z debug overlay (Options → "Movement debug", settings.debugMove).
// Diagnoses: (a) a walkto that silently failed server-side — the server pushes
// a "System: walkto ..." journal line on rejection/abandonment, which this
// surfaces prominently; (b) stair/Z-transition weirdness — shows the
// server-authoritative (x,y,z) next to the eased client-predicted (rx,ry,rz)
// so a mismatch/lag is visible. Runs off the existing ~150ms poll cycle (not
// per animation frame) and is a pure no-op when the setting is off.
function updateMoveDebug(s) {
  const el = document.getElementById("movedbg");
  if (!el) return;
  if (!settings.debugMove || !s || !s.player) { el.style.display = "none"; return; }
  el.style.display = "block";
  const p = s.player;
  const self = anim.get("self"); // eased predicted state (see updateAnimStates)
  const fmt = (v) => (typeof v === "number" ? v.toFixed(1) : "-");
  const notes = (s.journal || [])
    .filter((j) => j.name === "System" && (j.text || "").startsWith("walkto"))
    .slice(-3);
  let html = `<div>server (${p.x}, ${p.y}, ${p.z})</div>`
    + `<div>eased (${fmt(self && self.rx)}, ${fmt(self && self.ry)}, ${fmt(self && self.rz)})</div>`;
  for (const n of notes) html += `<div class="mdbg-note">${n.text}</div>`;
  el.innerHTML = html;
}
// ---- journal tabs, colour and timestamps ----
//
// Message types are ClassicUO's `MessageType` (0 Regular, 1 System, 2 Emote,
// 3 Limit3Spell, 6 Label, 7 Focus, 8 Whisper, 9 Yell, 10 Spell, 13 Guild,
// 14 Alliance, 15 Command). Two notes before editing these sets:
//   * **7 is Focus on the wire but party speech here** — `parse_party` in the
//     core stamps party lines with 7 because 6 would be read as a name label.
//     ServUO never sends a real Focus line (no `MessageType.Focus` anywhere in
//     its tree), so the overload is unambiguous against it; ClassicUO instead
//     uses a client-only 0xFF for party.
//   * Client-side notices (skill gains, our own warnings) have no wire type at
//     all, so they get one of their own, outside the byte the server can send.
const JRNL_LOCAL_TYPE = 256;
const JRNL_TABS = [
  { key: "all", label: "All" },
  { key: "speech", label: "Speech" },
  { key: "guild", label: "Guild" },
  { key: "system", label: "System" },
];
let journalTab = preferenceStorage.getItem("anima.journalTab") || "all";
// Which tab a line belongs to — a port of ClassicUO's `TextType` decision
// (`PacketHandlers.cs`, the 0x1C/0xAE handlers), NOT a filter on the message
// type alone.
//
// The type by itself gets this wrong, and visibly: ServUO sends "Welcome,
// FoundryGM!" and "The page queue is empty." as MessageType **Regular** with
// the speaker serial set to 0xFFFFFFFF and the name "System" — so a type-only
// filter files them under Speech and leaves the System tab empty, which is
// exactly what the first cut did. ClassicUO decides SYSTEM on
// `type == System || serial == 0xFFFFFFFF || serial == 0 ||
// (name == "system" && no entity)`, and OBJECT only when a real speaker
// exists. That is the rule here.
function journalClass(line, local) {
  if (local) return "system";                       // our own client notices
  const type = line.type | 0;
  const serial = line.serial >>> 0;
  if (type === 13 || type === 14 || type === 7) return "guild"; // Guild/Alliance/party
  if (type === 1 || serial === 0xFFFFFFFF || serial === 0) return "system";
  if ((line.name || "").toLowerCase() === "system") return "system";
  return "speech";
}
function journalTabAccepts(key, line, local) {
  return key === "all" || journalClass(line, local) === key;
}
// Arrival time, stamped locally the first time a line is seen.
//
// Nothing on the wire carries one — UO simply does not send it — so this is
// when the client learnt of the line, which is also what ClassicUO shows. Keyed
// by `seq` so a re-render never re-stamps, and bounded by the same ring the
// journal itself is.
const journalTimes = new Map();
function journalStamp(line) {
  const key = line.seq != null ? line.seq : line.text;
  let t = journalTimes.get(key);
  if (t == null) {
    t = new Date();
    journalTimes.set(key, t);
    if (journalTimes.size > 400) journalTimes.delete(journalTimes.keys().next().value);
  }
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")} `;
}
function buildJournalTabs() {
  const bar = document.getElementById("jrnl-tabs");
  if (!bar || bar.childElementCount) return;
  for (const t of JRNL_TABS) {
    const b = document.createElement("span");
    b.className = "jrnl-tab" + (t.key === journalTab ? " sel" : "");
    b.textContent = t.label;
    b.dataset.key = t.key;
    b.addEventListener("click", () => {
      journalTab = t.key;
      preferenceStorage.setItem("anima.journalTab", journalTab);
      for (const x of bar.children) x.classList.toggle("sel", x.dataset.key === journalTab);
      const j = document.getElementById("journal");
      if (j) j._sig = null;              // force a rebuild under the new filter
      if (scene) hud(scene);
    });
    bar.appendChild(b);
  }
}

// ---- ignore list (ClassicUO's IgnoreManager) -------------------------------
//
// A set of character NAMES whose talk this client drops. ClassicUO keys on the
// name and not the serial, and so does this: the serial of the player who
// followed you around Britain shouting is not the thing you want to remember,
// and it changes nothing to them anyway.
//
// The two filter sites are ClassicUO's, both in `MessageManager.HandleMessage`
// (floating overheads) and the journal gumps: drop a line whose speaker is on
// the list, unless its type is Spell. That exemption is deliberate there and
// kept here — the mantra a mage shouts is combat information, not conversation,
// and losing it to a grudge would cost you the fight.
//
// Two departures, both forced by what the server actually sends.
//
// **Names are keyed on the part before the tab.** 0x98 UpdateName carries the
// title with the name — this shard answers a single-click on a young player
// with "Anima\t (Young)", and an NPC with "Carl\tthe tailor" — while the
// 30-byte name field on a speech packet carries the bare "Anima". ClassicUO
// stores the former (`AddIgnoredTarget` takes `m.Name`) and then filters with
// *both*: the overhead check reads the entity's name and matches, the journal
// check reads the packet's name (`entry.Name`) and does not. So on this server
// ClassicUO would silence a titled player's floating text and keep printing
// their journal lines — and a player who ages out of Young walks off the list
// entirely, since the stored string no longer describes them. Keying on the
// bare name makes the two sites agree and survives the title changing.
//
// **Case-insensitive**, where ClassicUO's ordinal `HashSet<string>` is not.
// This list has a type-a-name field ClassicUO has no equivalent of (it can only
// add whoever you click), and a typed name that silently does nothing is worse
// than a rule one shade too broad.
const MSG_SPELL = 10;
// Bare character name, without the tab-separated title and without case.
function ignoreKey(name) {
  return String(name == null ? "" : name).split("\t")[0].trim().toLowerCase();
}
function ignoreLabel(name) {
  return String(name == null ? "" : name).split("\t")[0].trim();
}
let ignoredNames = new Map();      // lowercased name → the name as it was added
try {
  const saved = JSON.parse(preferenceStorage.getItem("anima.ignoreList") || "[]");
  if (Array.isArray(saved)) for (const n of saved) ignoredNames.set(ignoreKey(n), ignoreLabel(n));
} catch (e) {}
// Bumped on every change so the journal's render signature notices — otherwise
// ignoring someone would only take effect on their next line.
let ignoreSeq = 0;
function saveIgnoreList() {
  preferenceStorage.setItem("anima.ignoreList", JSON.stringify([...ignoredNames.values()]));
  ignoreSeq++;
  renderIgnoreList();
  invalidateJournal();
}
function isIgnoredName(name) {
  const n = ignoreKey(name);
  return !!n && ignoredNames.has(n);
}
// A journal line (or the overhead built from one) we should not show.
function isIgnoredLine(line) {
  return (line.type | 0) !== MSG_SPELL && isIgnoredName(line.name);
}
// ClassicUO `IgnoreManager.AddIgnoredTarget`, guards and messages included: a
// mobile, not yourself, and not one with a yellow health bar — ServUO raises
// that for `Blessed || YellowHealthbar`, so it means invulnerable, and putting
// a GM or a quest NPC on an ignore list is never what you meant.
function ignoreMobile(serial) {
  serial = serial >>> 0;
  const me = (scene && scene.player && scene.player.serial) >>> 0;
  const m = ((scene && scene.mobiles) || []).find((x) => (x.serial >>> 0) === serial);
  if (!m || serial === me) { addSysMessage("This is not a player."); return false; }
  if (m.yellow) { addSysMessage("This is not a player."); return false; }
  // A mobile we have never single-clicked has no name yet; ignoring "" would
  // silence every nameless mobile at once.
  const name = ignoreLabel(m.name);
  if (!name) { addSysMessage("Their name is not known yet — click them first."); return false; }
  return ignoreName(name);
}
function ignoreName(name) {
  name = ignoreLabel(name);
  if (!name) return false;
  if (ignoredNames.has(ignoreKey(name))) {
    addSysMessage(`Character ${name} already exist in a list.`);
    return false;
  }
  ignoredNames.set(ignoreKey(name), name);
  saveIgnoreList();
  addSysMessage(`Added ${name} to ignore list.`);
  return true;
}
function unignoreName(name) {
  ignoredNames.delete(ignoreKey(name));
  saveIgnoreList();
}
let ignoreListOn = preferenceStorage.getItem("anima.ignoreListOn") === "1";
function toggleIgnoreList() {
  ignoreListOn = !ignoreListOn;
  document.getElementById("ignorelist").classList.toggle("on", ignoreListOn);
  preferenceStorage.setItem("anima.ignoreListOn", ignoreListOn ? "1" : "0");
  if (ignoreListOn) renderIgnoreList(); else armIgnorePick(false);
}
// The pick mode ClassicUO reaches through its own target cursor
// (`CursorTarget.IgnorePlayerTarget`): a purely client-side arm — no packet
// leaves — that spends itself on the next mobile clicked.
let ignorePick = false;
function armIgnorePick(on) {
  ignorePick = !!on;
  const b = document.getElementById("ig-pick");
  if (b) {
    b.classList.toggle("arm", ignorePick);
    b.textContent = ignorePick ? "click a player…" : "Ignore a player…";
  }
}
function renderIgnoreList() {
  const host = document.getElementById("ig-names");
  if (!host) return;
  host.innerHTML = "";
  if (!ignoredNames.size) {
    const d = document.createElement("div");
    d.className = "ig-none"; d.textContent = "(nobody)";
    host.appendChild(d);
    return;
  }
  for (const name of [...ignoredNames.values()].sort((a, b) => a.localeCompare(b))) {
    const row = document.createElement("div");
    row.className = "ig-row";
    const label = document.createElement("span");
    label.textContent = name;
    const x = document.createElement("span");
    x.className = "ig-x"; x.textContent = "×"; x.title = "stop ignoring";
    x.addEventListener("click", () => unignoreName(name));
    row.appendChild(label); row.appendChild(x);
    host.appendChild(row);
  }
}

// Force the next `hud()` to rebuild the log. Used when something the render
// depends on resolved asynchronously — the hue table, chiefly.
function invalidateJournal() {
  const j = document.getElementById("journal");
  if (j) j._sig = null;
}
// The journal is its own window: draggable, resizable in BOTH directions, and
// remembering its size and position like every other resizable window here (the
// framework persists both, keyed by the window's class — `journal-win` is unique
// to it, so its geometry is its own). This replaces the old bespoke
// `resize: vertical` + `anima.journalH` on the log element, so there is exactly
// one resize handle instead of two.
//
// The SAME `#jrnl-tabs` / `#journal` nodes are re-parented into the frame, ids
// intact: every consumer (the hud() render, the tab bar builder, the filters,
// timestamps and colours) addresses them by id, so the whole pipeline is
// unchanged — only the container and who owns the sizing move.
let journalWin = null;
function buildJournalWindow() {
  if (journalWin) return;
  const tabs = document.getElementById("jrnl-tabs");
  const log = document.getElementById("journal");
  if (!tabs || !log) return;
  const { el, body } = makeWindowFrame({
    cls: "journal-win", title: "JOURNAL", bodyCls: "jrnl-body", resizable: true,
    // ✕ goes through the same toggle the J key uses, so the remembered
    // open/closed state stays in step however it was closed.
    onClose: () => { if (!journalHidden) toggleJournal(); },
  });
  body.appendChild(tabs);
  body.appendChild(log);
  journalWin = el;
  // First run only: seat it where the journal used to sit (under the HUD) at a
  // usable default. A remembered geometry is applied by the framework and wins.
  if (!body.style.width) { body.style.width = "330px"; body.style.height = "34vh"; }
  if (!el.style.left) { el.style.left = "calc(100vw - 372px)"; el.style.top = "300px"; }
  clampWindow(el);
  applyJournalVisibility();
}
function applyJournalVisibility() {
  if (journalWin) journalWin.style.display = journalHidden ? "none" : "";
}

function hud(s) {
  const p = s.player;
  // Show the *predicted* tile (what the avatar is visually standing on) so the
  // coordinate readout matches the on-screen position instead of the server pos,
  // which lags ~poll+confirm behind during movement.
  const lx = pred ? Math.round(pred.rx) : p.x, ly = pred ? Math.round(pred.ry) : p.y;
  set("pname", p.name || "(unnamed)"); set("ppos", `(${lx}, ${ly}, ${p.z})`);
  bar("hp", p.hits, p.hitsMax); bar("mana", p.mana, p.manaMax); bar("stam", p.stam, p.stamMax);
  set("stats", `${p.str} / ${p.dex} / ${p.int}`); set("gold", p.gold);
  // War-mode indicator (Tab toggles): reflect the server's authoritative flag.
  const wi = document.getElementById("warind");
  if (wi) {
    const war = !!s.war;
    wi.textContent = war ? "WAR" : "PEACE";
    wi.className = war ? "war" : "peace";
  }
  const j = document.getElementById("journal");
  // Signature-skip (same pattern as the paperdoll/skills/party panels, `_sig`
  // stashed on the element): hud() runs every ~150ms poll, but the journal itself
  // usually hasn't grown since the last one — rebuilding its whole DOM unchanged
  // is pure waste.
  //
  // Server half: the interactive play server stamps every line with a monotonic
  // `seq` (anima-net/src/bin/play_server.rs), so the newest line's seq is a cheap,
  // reliable change signal there. A feed without `seq` (the old scene-bin file
  // mode, removed 2026-09-29, did this; the WASM and replay feeds build their own
  // journals) can also cap it at 12 lines — a seq-or-length-only signature would stop changing forever the
  // moment that cap is first hit, even as lines keep rotating through, freezing
  // the panel. So: use seq when the newest line actually has one, else fall back
  // to a full-content signature (cheap here — that mode's array is ≤12 long).
  const jSrc = s.journal || [];
  const jLen = jSrc.length;
  const jLastLine = jLen ? jSrc[jLen - 1] : null;
  const jTail = jLastLine && jLastLine.seq != null
    ? jLastLine.seq
    : jSrc.map((l) => (l.name || "") + "" + (l.text || "")).join("");
  // Local half: a monotonic counter (bumped in addSysMessage, not derived from
  // length/newest-text) so a repeated-text line, or the ring hitting its own cap,
  // still registers as a change.
  const jSig = `${jLen}:${jTail}:${localJournalSeq}:${journalTab}:${ignoreSeq}`;
  if (j._sig !== jSig) {
    j._sig = jSig;
    // Keep following the newest line only if already scrolled to the bottom (don't
    // yank the view while the user is reading back).
    const atBottom = j.scrollHeight - j.scrollTop - j.clientHeight < 24;
    j.innerHTML = "";
    const put = (line, local) => {
      const type = local ? JRNL_LOCAL_TYPE : (line.type | 0);
      if (!journalTabAccepts(journalTab, line, local)) return;
      if (!local && isIgnoredLine(line)) return;   // ClassicUO: JournalGump's ignore check
      const d = document.createElement("div");
      const cls = MSG_CLASS[type];
      if (cls) d.className = cls;
      // Same rule the floating overheads use: the server's hue wins, the
      // per-type default fills in when it sent 0. The journal was the one
      // surface still painting every line the same grey.
      d.style.color = local ? "" : msgColor(type, line.hue | 0);
      if (local) d.classList.add("jrnl-sys");
      const stamp = document.createElement("span");
      stamp.className = "jrnl-time";
      stamp.textContent = journalStamp(line);
      d.appendChild(stamp);
      d.appendChild(document.createTextNode(
        line.name ? `${line.name}: ${line.text}` : line.text));
      j.appendChild(d);
    };
    for (const line of jSrc) { if (line.text) put(line, false); }
    // Client-side system notices (skill gains/losses) after the server lines.
    for (const line of localJournal) put(line, true);
    if (!j.childElementCount) {
      const d = document.createElement("div");
      d.className = "jrnl-none";
      d.textContent = "(nothing on this tab)";
      j.appendChild(d);
    }
    if (atBottom) j.scrollTop = j.scrollHeight;
  }
  refreshStatus(s);   // keep the pull-out status bar live (if open)
  refreshHealthBars(s); // …and every pinned per-entity health bar (07-hud.js)
}
function updateDiag() {
  set("diag", `fps ${diag.fps} · poll ${diag.poll.toFixed(0)}ms · sync ${diag.sync.toFixed(1)}ms · sprites ${diag.tiles} · ents ${diag.ents} · worst ${diag.worstFrame.toFixed(0)}ms`);
  diag.worstFrame = 0;
}
function bar(id, c, m) { document.getElementById(id).style.width = (m > 0 ? Math.round((c / m) * 100) : 0) + "%"; }
function set(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function setStatus(t) { set("status", t); }


// ---- death animation (ClassicUO's DisplayDeath + CorpseManager) -------------
//
// 0xAF says "this mobile just died". The server then deletes the mobile and
// drops a corpse item in its place, so by the time the next poll lands there is
// nothing left to animate — which is why the body used to vanish and a corpse
// blink into existence.
//
// ClassicUO keeps the dying body alive locally under `serial | 0x80000000`,
// plays its death group once, and holds the corpse item back (`CorpseManager`)
// until that finishes. Same here: the entity's animation state and last known
// scene record are kept for the length of the animation, and the item loop
// skips drawing that corpse while it runs.
const dyingMobs = new Map();      // "m<serial>" -> { mob, corpse, endsAt, done }
// Upper bound on how long a body may lie mid-fall. ClassicUO ends it when the
// animation runs out of frames and immediately if the frames never load; this
// is the second half of that — without it, art that 404s would leave a body
// standing over its own corpse forever.
const DEATH_MAX_MS = 2000;
let lastDeathSeq = 0;
function ingestDeaths(s) {
  const now = performance.now();
  for (const d of s.deaths || []) {
    const seq = d.seq | 0;
    if (seq <= lastDeathSeq) continue;
    lastDeathSeq = seq;
    const id = "m" + (d.serial >>> 0);
    const st = anim.get(id);
    // The record from the last poll that still listed it — `scene.mobiles` lost
    // it the moment it died. Nothing rendered for it at all (it died out of
    // view, or before we ever saw it) means there is no body to fall, so let
    // the corpse draw immediately.
    const mob = st && st.mobRec;
    if (!st || !mob) continue;
    st.death = { dg: d.dg | 0, startMs: now };
    dyingMobs.set(id, { mob, corpse: d.corpse >>> 0, endsAt: now + DEATH_MAX_MS, done: false });
  }
}
// Corpse serials whose own sprite is still being stood in for by a falling body.
function corpseIsDying(serial) {
  serial = serial >>> 0;
  for (const d of dyingMobs.values()) if (d.corpse === serial) return true;
  return false;
}
