// ---- seq-ring priming (skip a stale backlog replay on page reload) ----
// Every event "ring" above (character anims 0x6E/0xE2, damage 0x0B, effects
// 0x70/0xC0/0xC7, lift-rejects 0x27, container-opens 0x24, swings 0x2F,
// paperdoll 0x88, external URLs 0xA5, tips/notices 0xA6, sounds 0x54,
// server-chat lines 0xB2) is keyed
// by a monotonic `seq` that lives in the
// anima-net play server's `World`, NOT on this page: reloading the browser
// resets every `lastXSeq` variable above to 0, but the live ServUO session
// (and its already-fired backlog under those seqs) keeps running underneath —
// it's tied to the server connection, not the tab. Left unprimed, the very
// first poll after a reload would treat that whole backlog as "new": stale
// animations/damage numbers/sounds replay once, and — worse — *sticky*
// signals like the paperdoll and the last container-open pop their windows
// back open even though nothing just happened.
//
// Fix: on the FIRST scene ingest after page load, bump every ring's last-seen
// seq up to its current max WITHOUT running the per-event handler, then flip
// `seqPrimed`. Every later poll runs ingestX()/playSounds() as normal, so a
// genuinely new event (seq beyond this baseline) still fires immediately.
let seqPrimed = false;
let wasInWorld = false;
let sceneSessionId = null, sceneReloading = false;
function reloadForSessionChange() {
  if (sceneReloading) return;
  sceneReloading = true;
  // Block old input before clearing latches (which can themselves send stop).
  if (typeof setSceneTransport === "function") setSceneTransport(false);
  if (typeof updateMusic === "function") updateMusic(null);
  window.location.reload();
}
function maxSeq(arr) {
  let m = 0;
  if (arr) for (const ev of arr) { const sq = ev.seq | 0; if (sq > m) m = sq; }
  return m;
}
function primeSeqRings(s) {
  lastAnimSeq = Math.max(lastAnimSeq, maxSeq(s.anims));
  lastTypedAnimSeq = Math.max(lastTypedAnimSeq, maxSeq(s.tanims));
  lastDamageSeq = Math.max(lastDamageSeq, maxSeq(s.damage));
  lastEffectSeq = Math.max(lastEffectSeq, maxSeq(s.effects));
  lastDragAnimSeq = Math.max(lastDragAnimSeq, maxSeq(s.dragAnims));
  lastLiftRejectSeq = Math.max(lastLiftRejectSeq, maxSeq(s.liftRejects));
  lastDragCompletionSeq = Math.max(lastDragCompletionSeq, maxSeq(s.dragCompletions));
  if (s.deathScreen) lastDeathScreenSeq = Math.max(lastDeathScreenSeq, s.deathScreen.seq | 0);
  lastContainerOpenSeq = Math.max(lastContainerOpenSeq, maxSeq(s.containerOpens));
  lastSwingSeq = Math.max(lastSwingSeq, maxSeq(s.swings));
  lastSoundSeq = Math.max(lastSoundSeq, maxSeq(s.sounds));
  if (s.paperdoll) lastPaperdollSeq = Math.max(lastPaperdollSeq, s.paperdoll.seq | 0);
  lastOpenUrlSeq = Math.max(lastOpenUrlSeq, maxSeq(s.openUrls));
  lastTipNoticeSeq = Math.max(lastTipNoticeSeq, maxSeq(s.tips));
  if (s.logoutAck) lastLogoutAckSeq = Math.max(lastLogoutAckSeq, s.logoutAck.seq | 0);
  lastBoatMoveSeq = Math.max(lastBoatMoveSeq, maxSeq(s.boatMoves));
  lastChatSeq = Math.max(lastChatSeq, maxSeq(s.chat && s.chat.lines));
  lastDeathSeq = Math.max(lastDeathSeq, maxSeq(s.deaths));
  // Per-key open-counters live in the dialog families, not in a ring here.
  primeDialogSeqs(s);
}

let scenePollPending = false, scenePollFailures = 0, scenePollRetryAt = 0;
async function poll(force = false) {
  if (sceneReloading || scenePollPending || (!force && performance.now() < scenePollRetryAt)) return;
  scenePollPending = true;
  let received = false, timer = null;
  const controller = new AbortController();
  const t0 = performance.now();
  try {
    // Keep body decoding inside the deadline too. A timed-out response can
    // resolve later, but must never commit its stale scene.
    const nextScene = await Promise.race([
      (async () => {
        const r = await fetch("scene.json?" + Date.now(), { signal: controller.signal, cache: "no-store" });
        if (!r.ok) throw new Error(r.status);
        const next = await r.json();
        if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("Invalid scene response");
        return next;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Scene request timed out")); }, 5000); }),
    ]);
    received = true; scenePollFailures = 0; scenePollRetryAt = 0;
    // A native connection belongs to the backend, not the page. Polling may
    // miss the whole login phase, and two servers can reuse player serials.
    // Do not assign the new world to old dialogs/targeting/event cursors, even
    // while a reload is pending.
    if (wasInWorld && (nextScene.auth || (nextScene.sessionId || null) !== sceneSessionId)) {
      reloadForSessionChange();
      return;
    }
    scene = nextScene;
    if (typeof setSceneTransport === "function") setSceneTransport(true);
    // Not in world yet (login-page mode): show the login form instead of rendering.
    if (scene && scene.auth) {
      showLogin(scene.auth, scene.msg, scene.slots, scene.capacity, scene.cities, scene.error, scene);
      return;
    }
    // Auto-login briefly serves {} before a connection exists. It must not
    // prime cursors or turn a following login/error scene into a reload loop.
    if (!scene.player) return;
    if (typeof bindCharacterGeometry === "function") await bindCharacterGeometry(scene);
    wasInWorld = true;
    sceneSessionId = scene.sessionId || null;
    hideLogin();
    if (!seqPrimed) { primeSeqRings(scene); seqPrimed = true; }
    ingestBoatMoves(scene);
    // Before updateAnimStates, deliberately: the server deletes a mobile in the
    // same breath as the death cue, so by this poll it is already out of
    // `scene.mobiles` and the prune below is about to drop its animation state
    // too. This is the last moment both still exist.
    ingestDeaths(scene); // start a death animation for each new 0xAF cue
    updateAnimStates(scene);
    const ts = performance.now();
    syncWorld(scene); // diffs only — no full rebuild
    diag.sync = performance.now() - ts;
    markDirty(); // a fresh poll may change tiles/entities → redraw once
    ingestSpeech(scene); // float new speech above its speaker
    ingestChat(scene); // print new server-chat lines (0xB2) into the journal
    ingestAnims(scene); // play new character animations (0x6E: combat swings, bows…)
    ingestTypedAnims(scene); // play new typed animations (0xE2: emotes, gestures, alerts…)
    ingestDamage(scene); // float new combat damage numbers (0x0B)
    ingestEffects(scene); // spawn new graphical effects (0x70/0xC0/0xC7)
    ingestDragAnims(scene); // spawn new 0x23 item-flight sprites
    ingestLiftRejects(scene); // clear the held item + show a message (0x27 LiftRej)
    ingestDragCompletions(scene); // reconcile held-item cursor acknowledgements (0x28/0x29)
    ingestDeathScreen(scene); // start ClassicUO's short death banner timer (0x2C)
    ingestContainerOpens(scene); // open a window for each server-initiated container open (0x24)
    ingestOpenUrls(scene); // ask before opening each validated external URL (0xA5)
    ingestSwings(scene); // briefly face the attacker toward the defender (0x2F Swing)
    ingestPaperdoll(scene); // open/refresh a paperdoll the server told us to show (0x88)
    // Every server-driven dialog window in one pass — generic gumps, legacy
    // menus, hue pickers, trades, treasure maps, containers, the book reader,
    // the vendor window, the context menu, text-entry, profiles, the text
    // prompt and the house-design panel. See web/dialogs.js; each family is
    // declared with registerDialog() next to the code that builds it.
    syncDialogs(scene);
    refreshTip(); // update the hover tooltip if its OPL just arrived/changed
    drawMinimap(scene);
    updateGuardZones(scene); // guard-zone overlay: refetch on facet change, redraw clipped to view
    refreshBuffs(scene); // reconcile the buff/debuff bar with scene.buffs
    syncArmedAbility(); // adopt the server's arm (0xBF/0x21 clears it after every use)
    refreshAbilities(); // keep the weapon special-ability bar in sync with the equipped weapon
    renderCombatBook();  // and the combat book's "what you're holding" header (ClassicUO CombatBookGump)
    renderRacialBook();  // race can change under us (ghost body, polymorph) — cheap and signature-gated
    refreshNetStats();   // link latency + traffic (ClassicUO NetworkStatsGump)
    if (wmOn) drawWorldmap();  // keep the open world map tracking the player
    if (scene.player) hud(scene);
    refreshInfoBar(scene);   // user-chosen readouts (ClassicUO InfoBarManager)
    refreshCounterBar();     // carried-item counts (ClassicUO CounterBarGump)
    updateMoveDebug(scene); // movement/Z debug HUD (Options → "Movement debug")
    refreshPaperdoll();   // keep the paperdoll live (equip/stats change)
    if (spellbookOn) { refreshSpellMana(); refreshSpellbookContent(); refreshActiveSpells(); } // keep the spellbook live (mana + book content + active stances)
    if (skillsOn) refreshSkills();  // keep the skills window live (values/locks change)
    checkSkillGains(scene);  // announce skill base changes as journal system messages
    if (scene.bboard) requestMissingBBSummaries(scene, scene.bboard); // 0x71 headers
    refreshParty();   // keep the party panel live + surface incoming invites (0xBF/0x06)
    refreshTipNotices(scene); // pageable tips / close-only notices (0xA6)
    refreshLogoutAck(scene); // restore UI if the server denied a 0xD1 logout
    autoOpenCorpses(scene); // ClassicUO TryOpenCorpses — double-click a new corpse in range for the player
    updateTargetUI(); // reflect the server's target-cursor state (crosshair + banner)
    updatePlacementPreview(); // rebuild/clear the house-footprint preview if scene.placement changed
    updateHouseDesignGhost(); // rebuild/clear the design-piece ghost if the session/selection changed
    updateDeathUI(scene); // grayscale + "You are dead" banner while the player is a ghost
    playSounds(scene);   // play new sound effects (0x54)
    updateMusic(scene);  // sync background music (0x6D)
    setStatus("live · " + new Date().toLocaleTimeString());
  } catch (e) {
    if (!received) {
      scenePollFailures++;
      scenePollRetryAt = performance.now() + Math.min(1000 * 2 ** Math.min(scenePollFailures - 1, 3), 5000);
      if (typeof setSceneTransport === "function") setSceneTransport(false);
      setStatus("Client connection interrupted — retrying…");
    } else {
      console.error("Scene display update failed", e);
      setStatus("Display update failed. Retrying…");
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
    scenePollPending = false;
  }
  diag.poll = performance.now() - t0;
  if (diag.poll > 150) console.warn(`[diag] slow poll ${diag.poll.toFixed(0)}ms`);
}

// 0x2C is a one-shot screen effect, while `player.dead` is authoritative state
// derived from ServUO's complete ghost-body set. ClassicUO keeps the grayscale
// effect for the whole ghost lifetime but shows “You are dead” for only 1.5s.
function ingestDeathScreen(s) {
  const ev = s && s.deathScreen;
  if (!ev) return;
  const seq = ev.seq | 0;
  if (seq <= lastDeathScreenSeq) return;
  lastDeathScreenSeq = seq;
  deathBannerUntil = performance.now() + 1500;
  if (deathBannerTimer != null) clearTimeout(deathBannerTimer);
  deathBannerTimer = setTimeout(() => {
    deathBannerTimer = null;
    deathBannerUntil = 0;
    updateDeathUI(scene);
  }, 1500);
}

// The body fallback keeps this renderer compatible with an older scene producer.
// Both clear on resurrection when the body reverts to a living id.
function updateDeathUI(s) {
  const p = s && s.player;
  const dead = !!(p && (typeof p.dead === "boolean" ? p.dead : isGhostBody(p.body)));
  const map = document.getElementById("map");
  if (map) map.classList.toggle("dead", dead);
  const banner = document.getElementById("deadbanner");
  if (banner) banner.style.display = dead && performance.now() < deathBannerUntil ? "block" : "none";
}

// ClassicUO BoatMovingManager velocity table. A segment starts when its 0xF6
// reaches this renderer; bursts are queued instead of collapsing intermediate
// tiles, keeping the hull and every passenger on one rigid timeline.
function boatMoveDuration(speed) {
  speed |= 0;
  if (speed === 2) return 1000;
  if (speed === 3) return 500;
  if (speed === 4) return 250;
  if (speed > 4) return speed * 10;
  return 500;
}

function queueBoatGlide(serial, from, to, duration, now) {
  serial >>>= 0;
  let queue = boatGlides.get(serial);
  if (!queue) { queue = []; boatGlides.set(serial, queue); }
  while (queue.length && now >= queue[0].end) queue.shift();
  const previous = queue.length ? queue[queue.length - 1] : null;
  const start = previous ? previous.end : now;
  const source = previous ? previous.to : from;
  queue.push({
    from: { x: Number(source.x), y: Number(source.y), z: Number(source.z || 0) },
    to: { x: Number(to.x), y: Number(to.y), z: Number(to.z || 0) },
    start,
    end: start + duration,
  });
  // A background tab can receive a short burst when it wakes. Keep enough
  // segments to preserve those intermediate tiles instead of jumping ahead.
  if (queue.length > 32) {
    const first = queue[0], latest = queue[queue.length - 1];
    const t = now <= first.start ? 0 : Math.min(1, (now - first.start) / (first.end - first.start));
    const current = {
      x: first.from.x + (first.to.x - first.from.x) * t,
      y: first.from.y + (first.to.y - first.from.y) * t,
      z: first.from.z + (first.to.z - first.from.z) * t,
    };
    queue.splice(0, queue.length, { from: current, to: latest.to, start: now, end: now + duration });
  }
}

function boatVisual(serial, fallback, now) {
  const queue = boatGlides.get(serial >>> 0);
  if (!queue) return { ...fallback, active: false };
  while (queue.length && now >= queue[0].end) queue.shift();
  if (!queue.length) {
    boatGlides.delete(serial >>> 0);
    return { ...fallback, active: false };
  }
  const segment = queue[0];
  const t = now <= segment.start ? 0 : Math.min(1, (now - segment.start) / (segment.end - segment.start));
  return {
    x: segment.from.x + (segment.to.x - segment.from.x) * t,
    y: segment.from.y + (segment.to.y - segment.from.y) * t,
    z: segment.from.z + (segment.to.z - segment.from.z) * t,
    active: true,
  };
}

function ingestBoatMoves(s) {
  const now = performance.now();
  for (const movement of (s && s.boatMoves) || []) {
    const seq = Number(movement.seq) || 0;
    if (!seq || seq <= lastBoatMoveSeq) continue;
    lastBoatMoveSeq = seq;
    const duration = boatMoveDuration(movement.speed);
    for (const entity of movement.entities || []) {
      if (!entity.from || !entity.to) continue;
      queueBoatGlide(entity.serial, entity.from, entity.to, duration, now);
    }
  }
}

// Drop every static sprite so the next poll rebuilds them under the current
// filters. Cheap enough to be a toggle handler: the pool is rebuilt from the
// scene the client already has, with no server round trip.
// Drop every land sprite so the next poll rebuilds it. Needed when something
// baked into a tile's vertices changes — the terrain-shading strength is baked
// at build time exactly as ClassicUO bakes it into its vertex normals' shader
// uniform, and nothing about the scene changed to trigger the usual rebuild.
function rebuildTiles() {
  for (const e of tilePool.values()) { world.removeChild(e.sp); e.sp.destroy(); }
  tilePool.clear();
  markDirty();
}

function rebuildStatics() {
  for (const sp of staticPool.values()) { animatedStatics.delete(sp); world.removeChild(sp); sp.destroy({ children: true }); }
  staticPool.clear();
  markDirty();
}

function rebuildItems() {
  for (const e of itemPool.values()) {
    animatedStatics.delete(e.sp); world.removeChild(e.sp); e.sp.destroy();
  }
  itemPool.clear();
  markDirty();
}

// ClassicUO ProcessAlpha: hide at/above `_maxZ`, else hide if `_noDrawRoofs && IsRoof`.
// The server already set `hz` for the first clause and for cover-driven roofs;
// `drawRoofs` is the Options toggle that forces every remaining roof graphic off.
function ceilHidden(rec) {
  return !!(rec && (rec.hz || (!settings.drawRoofs && rec.rf)));
}

// ClassicUO `_maxGroundZ` picking gate (`PushToRenderQueue`: `obj.Z <= _maxGroundZ`).
function maxGroundZ() {
  const z = scene && scene.map && scene.map.maxGroundZ;
  return z == null ? 127 : (z | 0);
}
function aboveGroundZ(z) { return (z | 0) > maxGroundZ(); }

// Can this static sprite be clicked (targeted / named)? Same three gates the
// dynamic-item loop applies, plus the gray beyond-view ring:
//   * ceiling-hidden — it is drawn at alpha 0, and ClassicUO's
//     `PushToRenderQueue` never even enqueues an object at AlphaHue 0, so it
//     is not in the pick list either;
//   * above `_maxGroundZ` — ClassicUO's picking gate (`obj.Z <= _maxGroundZ`);
//   * beyond the view range — the server sends those only so the ring can be
//     drawn grayed out; ClassicUO has no objects out there at all, and every
//     server-side target is range-checked anyway.
// Re-applied every poll (not just at creation) because all three flip while the
// sprite's pool identity stays the same — walking under a roof, or past `VR`.
// Only writes when the answer actually flips, unlike the item loop's inline
// version: this runs for EVERY static every poll (a crowded window is thousands
// of them, against a few dozen items), and `eventMode` is a setter that pokes
// PIXI's interaction bookkeeping.
function setStaticClickable(sp, st, beyondView) {
  const click = !sp._hz && !beyondView && !aboveGroundZ(st.z);
  if (sp._click === click) return;
  sp._click = click;
  sp.eventMode = click ? "static" : "none";
  sp.cursor = click ? "pointer" : "default";
}

function updateAnimStates(s) {
  const now = performance.now();
  const seen = new Set();
  // The chair we're seated on disappeared/moved/changed graphic (someone else used
  // it, a GM deleted it, …) — stand up rather than leave the avatar seated on thin
  // air. Cheap: once per poll (~150ms), not per rendered frame.
  if (sitting) {
    const onItem = (s.items || []).some((it) => (it.x | 0) === sitting.x && (it.y | 0) === sitting.y && (it.g | 0) === sitting.graphic);
    const onStatic = (staticsAt(sitting.x, sitting.y) || []).some((st) => (st.g | 0) === sitting.graphic && Math.abs((st.z | 0) - sitting.z) <= 1);
    if (!onItem && !onStatic) standUp();
  }
  const touch = (id, x, y, z, dir, body, fb) => {
    seen.add(id);
    let st = anim.get(id);
    if (!st) { st = { rx: x, ry: y, stepDur: 300 }; anim.set(id, st); }
    if (st.tx !== x || st.ty !== y) {
      st.moveUntil = now + 650;
      // Measure this entity's real step cadence so we can glide one tile over
      // exactly that time → continuous motion (no walk-one-tile-then-pause).
      if (st.prevMoveT) st.stepDur = Math.min(600, Math.max(120, now - st.prevMoveT));
      st.prevMoveT = now;
      // A real committed step is always more authoritative than a cosmetic
      // Swing-flash facing (see `ingestSwings`/`drawMobs`) — drop it now
      // rather than waiting out its ~350ms timer.
      st.faceOverride = null;
    }
    Object.assign(st, { tx: x, ty: y, z, dir, body, fallback: fb });
  };
  for (const m of s.mobiles || []) {
    touch("m" + m.serial, m.x, m.y, m.z ?? 0, m.dir ?? 4, m.body, notoColor(m.noto));
    // Stash the scene record itself: when this mobile dies it leaves
    // `scene.mobiles` immediately, and the falling body still needs its hue and
    // its equipment to be drawn (see `ingestDeaths`).
    anim.get("m" + m.serial).mobRec = m;
  }
  // The player is rendered from the predicted position (set in renderFrame); here
  // we just seed/reconcile prediction against the authoritative server position.
  const p = s.player;
  if (p) {
    if (!pred) {
      pred = {
        x: p.x, y: p.y, z: p.z ?? 0, dir: p.dir ?? 4,
        steps: [], t0: 0, lastEnq: 0, enqGate: 0, moving: false,
        rx: p.x, ry: p.y, rz: p.z ?? 0,
        sx: p.x, sy: p.y, sz: p.z ?? 0, psx: p.x, psy: p.y,
      };
    }
    // Has the authoritative position settled (unchanged since the previous poll)?
    const serverStable = pred.psx === p.x && pred.psy === p.y;
    pred.psx = p.x; pred.psy = p.y;
    pred.sx = p.x; pred.sy = p.y; pred.sz = p.z ?? pred.sz; // server pos (lags ~poll)
    const denies = s.stats?.denies ?? 0;
    const denied = denies > lastDenies;
    lastDenies = denies;
    const off = cheby(pred.x - p.x, pred.y - p.y); // base vs authoritative
    if (off > SNAP_DIST) {
      // Real desync/teleport (gate, recall, big shove): jump everything instantly.
      pred.steps.length = 0; pred.t0 = 0;
      pred.x = p.x; pred.y = p.y; pred.z = p.z ?? pred.z; pred.dir = p.dir ?? pred.dir;
      pred.rx = p.x; pred.ry = p.y; pred.rz = p.z ?? pred.rz;
    } else if (denied) {
      // ClassicUO DenyWalk→Reset: drop the queue, set base to the server position;
      // the render *eases* there (processSteps), so a 1-tile correction glides in.
      pred.steps.length = 0; pred.t0 = 0;
      pred.x = p.x; pred.y = p.y; pred.z = p.z ?? pred.z; pred.dir = p.dir ?? pred.dir;
    } else if (!moveIntent && pred.steps.length === 0 && serverStable && off > 0
               && performance.now() - lastWalkSentAt > RECONCILE_HOLDOFF) {
      // Idle, queue drained, and the server has been settled at a DIFFERENT tile for
      // long enough that it isn't just the last walk's confirm still in flight — a
      // genuine divergence (shove, short teleport, drift). Converge the base. The
      // holdoff is what kills the "뒤로갔다 앞으로" yank: right after you stop, the
      // server momentarily looks settled one tile back (its confirm lagging a poll),
      // and snapping to it then re-snapping forward is exactly the artifact CUO never
      // shows. Prediction is 1:1 with the server, so inside the window we just trust it.
      pred.x = p.x; pred.y = p.y; pred.z = p.z ?? pred.z; pred.dir = p.dir ?? pred.dir;
    } else if (!moveIntent && pred.steps.length === 0 && serverStable && off === 0) {
      // Keep Z authoritative at rest (server-forced Z changes on the tile we're
      // already standing on). `off === 0` is load-bearing: Z belongs to a TILE,
      // so adopting the server's Z while it still reports a DIFFERENT tile
      // paints a foreign tile's height onto ours. That is the height bob on
      // slopes — stop walking, the server is momentarily one tile behind (its
      // confirm lagging a poll, inside RECONCILE_HOLDOFF so the x/y branch above
      // correctly declines to converge), and this branch used to take its Z
      // anyway: the avatar dropped/rose to the old tile's height and then
      // snapped back when the server caught up. Measured live near (1484,1603):
      // 9 foreign-Z adoptions per ~40s of walking, 0 after this guard. When the
      // server genuinely IS on another tile, the branch above converges x, y and
      // Z together once the holdoff proves it's a real divergence.
      pred.z = p.z ?? pred.z;
    }
    const boatPos = boatVisual(p.serial, { x: p.x, y: p.y, z: p.z ?? 0 }, now);
    if (boatPos.active) {
      pred.steps.length = 0; pred.t0 = 0;
      pred.x = p.x; pred.y = p.y; pred.z = p.z ?? pred.z; pred.dir = p.dir ?? pred.dir;
      pred.rx = boatPos.x; pred.ry = boatPos.y; pred.rz = boatPos.z; pred.moving = true;
    }
    if (!anim.has("self")) anim.set("self", { rx: pred.rx, ry: pred.ry, rz: pred.rz, stepDur: 400, fallback: 0xffffff });
    seen.add("self");
  }
  // A mobile that just died is gone from `s.mobiles` — the server deleted it —
  // but its body is still falling over. Keep it out of the prune until the
  // animation is done, which is ClassicUO holding the same entity under
  // `serial | 0x80000000` for exactly as long.
  for (const [id, d] of [...dyingMobs]) {
    if (d.done || now >= d.endsAt) { dyingMobs.delete(id); const st = anim.get(id); if (st) st.death = null; }
    else seen.add(id);
  }
  for (const id of [...anim.keys()]) if (!seen.has(id)) anim.delete(id);
}

// add/remove only the tiles/statics that entered/left the view
function syncWorld(s) {
  // Keep the calculateNewZ static index in step with the scene the rest of
  // this function is about to render (once per poll — see its own doc).
  rebuildStaticIndex(s.statics);
  rebuildItemIndex(s.items);
  const m = s.map || { radius: 14, tiles: [], cx: 0, cy: 0 };
  const span = 2 * m.radius + 1;
  // Beyond this Chebyshev distance from the player, `m.tiles` is the grayed-out
  // land-only context ring (server sends land but no statics out there — see
  // scene.rs's `beyond_view`). Older/degraded scenes without `viewRange` treat
  // the whole window as "in view" (no ring), matching the old behaviour.
  const viewRange = (m.viewRange != null) ? m.viewRange : m.radius;
  const seenT = new Set(), seenS = new Set();

  // height of a tile in the window (for corner slopes); null if outside
  const zAt = (x, y) => {
    const col = x - m.cx + m.radius, row = y - m.cy + m.radius;
    if (col < 0 || col >= span || row < 0 || row >= span) return null;
    const t = m.tiles[row * span + col];
    return t ? (t.z | 0) : null;
  };
  for (let row = 0; row < span; row++) {
    for (let col = 0; col < span; col++) {
      const t = m.tiles[row * span + col];
      // Land graphics 0–2 are UO's "no draw"/void tiles (their art is a literal
      // "NO DRAW" placeholder bitmap). They appear under building floors / off-map;
      // ClassicUO never draws them, so neither do we (drop any stale sprite too).
      const x = m.cx + (col - m.radius), y = m.cy + (row - m.radius);
      const key = x + "," + y;
      // Grayed-out context ring past the player's actual view range (ClassicUO-
      // style "you remember the land is there"): land only, dimmed/desaturated,
      // no art/texmap loads — see the render branch below and its `gray` pool flag.
      const beyondView = Math.max(Math.abs(col - m.radius), Math.abs(row - m.radius)) > viewRange;
      // Seasonal draw graphic. The scene emits the remap as a SIBLING `dg` and
      // never touches `g`, because `g` is a pathing input on this side too (the
      // no-draw gate in createItemList). Everything below that decides a PIXEL
      // reads `dg`; everything that decides a STEP keeps reading `g`.
      const dg = t ? (t.dg ?? t.g) : 0;
      // ClassicUO's `AllowedToDraw` is `Graphic > 2` on the REMAPPED id (Land.cs).
      if (!t || !t.g || dg <= 2) {
        const e = tilePool.get(key);
        if (e) { world.removeChild(e.sp); e.sp.destroy(); tilePool.delete(key); }
        continue;
      }
      // Hidden by the Z ceiling (e.g. surface terrain over a basement): drop any
      // existing sprite and don't draw, so the floor below is revealed.
      if (t.h) {
        const e = tilePool.get(key);
        if (e) { world.removeChild(e.sp); e.sp.destroy(); tilePool.delete(key); }
        continue;
      }
      seenT.add(key);
      const z0 = t.z | 0;
      const e = tilePool.get(key);
      // Unchanged: nothing to rebuild. (LRU freshness for every pool entry —
      // including tiles this loop never revisits, e.g. pruneFar's hysteresis
      // ring — is stamped once per poll in one blanket pass; see
      // forEachLiveTexUrl()/touchTex() at the end of this function.)
      // Unchanged real tile: nothing to rebuild. A colour-fallback tile is re-evaluated
      // so it can upgrade to real art — but only rebuild it once the texture actually
      // arrives; while it's still pending (or the art is missing) keep the existing
      // placeholder instead of re-creating an identical Graphics every poll. A gray
      // beyond-view tile (below) never has real art to upgrade to, so it's pooled
      // with `fallback: false` and skips this re-check entirely — UNLESS `beyondView`
      // itself flipped since the last poll (the player crossed the draw-distance
      // boundary for this tile), which must force a rebuild into/out of grayscale.
      // Keyed on `dg`, NOT `t.g`: with the remap in a sibling field `t.g` is
      // identical across seasons, so comparing it would make this check never
      // fire on a season change and freeze the land art at whatever season was
      // live when the sprite was built.
      if (e && e.g === dg && e.z === z0 && !!e.gray === beyondView) {
        if (!e.fallback) continue;
        if (texFor(e.url) == null) continue;
      }
      // corner heights (ClassicUO: top=this, right=(x+1,y), bottom=(x+1,y+1), left=(x,y+1)).
      // At the window's SE edge a neighbour falls outside the grid (null); rather than
      // skip the tile — which flashes the black page background at the diamond's rim —
      // fall back to this tile's own Z so it still renders (flat).
      const z1 = zAt(x + 1, y) ?? z0, z2 = zAt(x + 1, y + 1) ?? z0, z3 = zAt(x, y + 1) ?? z0;
      // ClassicUO's `IsStretched` is the OR of the four corner normals being
      // non-flat (Land.cs:158-161), and each corner looks one tile FURTHER OUT
      // than the diamond does. That is wider than "this tile's own four corners
      // differ", which is what this used to test: a tile whose corners are level
      // but which sits beside a step is stretched and shaded by ClassicUO, and
      // was drawn flat here. Measured on this map: 350 extra tiles in a 49×49
      // window at (1420,1702), 15% of it.
      const sloped = !(cornerFlat(x, y) && cornerFlat(x + 1, y)
                    && cornerFlat(x + 1, y + 1) && cornerFlat(x, y + 1));

      // Until the art/texmap PNG has streamed in, draw a flat diamond in the tile's
      // server-provided average colour instead of `continue`-ing (which would leave the
      // black page background showing through). The `fallback` flag makes the unchanged-
      // check above re-evaluate it every poll until the real texture resolves.
      // The four corner lights, in the vertex order makeStretchedTile uses:
      // top (x,y), right (x+1,y), bottom (x+1,y+1), left (x,y+1). A pure
      // function of map Z, so it never has to be recomputed for a pooled tile.
      const light = [cornerLight(x, y), cornerLight(x + 1, y),
                     cornerLight(x + 1, y + 1), cornerLight(x, y + 1)];
      let sp, texUrl, fallback = false;
      if (beyondView) {
        // Grayscale, dimmed diamond — no textured art or statics ever load for
        // this ring (the server never sends them out here; see scene.rs), so
        // this branch never touches texFor and never sets `fallback`.
        // Not lit: ClassicUO leaves the un-stretched/context land on SHADER_NONE
        // (LandView.cs:52-54), and this ring is already a flat grey memory.
        const L = Math.min(255, Math.round((0.3 * t.c[0] + 0.59 * t.c[1] + 0.11 * t.c[2]) * 0.65 + 50));
        sp = makeColorTile(x, y, z0, z1, z2, z3, [L, L, L]);
      } else if (!sloped || !(t.tx > 0)) {
        // Flat 44x44 diamond at this tile's own Z — either the ground really is
        // level, or there is no texmap and ClassicUO refuses to stretch at all.
        // `Land.ApplyStretch` bails the moment the texmap entry is empty and
        // sets `AverageZ = MinZ = z`, so such a tile is drawn flat however the
        // ground around it stands, seams and all. We used to stretch the tile's
        // own 44x44 art onto the quad instead, which is seamless but smears the
        // diamond over a steep slope — the reason texmaps exist. Measured
        // against the real tiledata this is 23 of 2724 land graphics and every
        // one of them is Wet, i.e. the whole footprint is water at a shoreline,
        // which ClassicUO deliberately never stretches (`IsStretched` is
        // pre-seeded to `TexID == 0 && IsWet` purely to refuse it).
        texUrl = `art/land/${dg}.png`;
        const tex = texFor(texUrl);
        // Also unlit, for the same reason: a tile ClassicUO refuses to stretch
        // draws from its own 44×44 art with no shading at all.
        if (tex) sp = makeFlatTile(x, y, z0, tex);
        else { sp = makeColorTile(x, y, z0, z0, z0, z0, t.c); fallback = true; }
      } else {
        texUrl = `texmap/${t.tx}.png`; // seamless texture for slopes
        const tex = texFor(texUrl);
        if (tex) sp = makeStretchedTile(x, y, z0, z1, z2, z3, tex, light);
        else { sp = makeColorTile(x, y, z0, z1, z2, z3, t.c, light); fallback = true; }
      }
      if (e) { world.removeChild(e.sp); e.sp.destroy(); }
      world.addChild(sp);
      tilePool.set(key, { sp, g: dg, z: z0, url: texUrl, fallback, gray: beyondView });
    }
  }
  // Server now sends statics across the whole land window, including the
  // grayed-out beyond-view ring — gray those to match the land tiles there
  // (see STATIC_GRAY above). `beyondView` is per-static, re-evaluated every
  // poll so a static flips gray/color as the player walks past `VR`.
  const P = s.player || { x: 0, y: 0 };
  const VR = (s.map && s.map.viewRange != null) ? s.map.viewRange : (s.map ? s.map.radius : 18);
  for (const st of s.statics || []) {
    // ClassicUO's StaticFilters, applied where it applies them — at draw time,
    // not in the scene: the toggles are the player's and the server has no
    // business knowing about them. `null` = this static is not drawn at all.
    // Winter/desolation don't fade leafy foliage, they delete it (ClassicUO
    // `IsFoliageVisibleAtSeason`). A DRAW skip only — the static is still in
    // `s.statics`, so `calculate_new_z` and the blocker checks still see it.
    if (st.fh) continue;
    // Never-drawn: a pathing-only record (an invisible multi piece, a tiledata
    // "nodraw" static, or one past the draw budget). A DRAW skip only — the
    // record is still in `s.statics`, which `rebuildStaticIndex` has already
    // indexed, so `createItemList`/`calculateNewZ` and the blocker checks still
    // see it. Must sit ABOVE the pool key below: a never-drawn record entering
    // the `x,y,g,z` key space could collide with a real sprite's key and keep a
    // stale sprite alive through the reaper.
    if (st.nd) continue;
    // Seasonal substitution first, then the player's own StaticFilters on top of
    // the result — the filters classify by what is DRAWN (a winter-bare tree is
    // still a tree), and reading `st.g` here would silently regress them.
    const sg = st.dg ?? st.g;
    const drawG = filterStatic(sg, st.f);
    if (drawG === null) continue;
    // The key carries the DRAWN graphic so flipping "trees as stumps" rebuilds
    // the sprite instead of leaving the old tree art in place.
    const iHue = st.hue | 0;
    const hueQ = hueQuery(iHue);
    // Hue is part of identity: two same-graphic statics on one tile can
    // differ only by dye (a stained-glass pane next to a clear one).
    const key = `${st.x},${st.y},${drawG},${st.z},${iHue}`;
    seenS.add(key);
    const beyondView = Math.max(Math.abs(st.x - P.x), Math.abs(st.y - P.y)) > VR;
    if (staticPool.has(key)) {
      // Unchanged sprite identity, but the player may have crossed the view
      // boundary since the last poll — flip its filter without rebuilding it.
      const ex = staticPool.get(key);
      if (ex && ex._gray !== beyondView) {
        ex.filters = beyondView ? [STATIC_GRAY] : null;
        ex._gray = beyondView;
      }
      // Ceiling state can flip on an existing sprite without changing its
      // identity — walking under a roof, or out from under one. Flip the fade
      // source in place; `easeAlphas` does the rest. This is the whole reason
      // the server now sends the object instead of dropping it: there is a
      // sprite here to ease.
      const hzNow = ceilHidden(st) ? 1 : 0;
      if (ex && ex._hz !== hzNow) {
        setAlphaSource(ex, "ceil", hzNow ? 0 : null);
        ex._hz = hzNow;
      }
      // Re-stamp the record the click handlers read (see the creation branch).
      // Not an optimization to skip: the pool key is (x,y,drawG,z,hue), which
      // cannot see `h`/`pf` appearing — those are PATH_RADIUS-gated server-side,
      // so a static that streamed in from 15 tiles away carries NEITHER until
      // the player walks within 10, and the sprite is never rebuilt in between.
      // Targeting a surface static needs both (see `staticTargetZ`).
      if (ex) { ex._st = st; setStaticClickable(ex, st, beyondView); }
      continue; // unchanged; see the blanket LRU-touch note above
    }
    const texUrl = `art/static/${drawG}.png${hueQ}`;
    const tex = texFor(texUrl);
    if (!tex) continue;
    const sp = new PIXI.Sprite(tex);
    sp.anchor.set(0.5, 1.0);
    sp.x = isoX(st.x, st.y); sp.y = isoY(st.x, st.y, st.z) + HALF;
    sp.zIndex = depthZ(st.x, st.y, st.pz ?? st.z, 4);
    sp._gray = beyondView;
    sp.filters = beyondView ? [STATIC_GRAY] : null;
    if (st.ms != null) {
      sp._boatSerial = st.ms >>> 0;
      sp._boatBaseX = st.x; sp._boatBaseY = st.y; sp._boatBaseZ = st.z;
      sp._boatBaseSpriteX = sp.x; sp._boatBaseSpriteY = sp.y;
      sp._boatPzOffset = (st.pz ?? st.z) - st.z; sp._boatDepthBias = 4;
    }
    // Tile + foliage flag for the transparency pass (circle-of-transparency / foliage fade).
    sp._tx = st.x; sp._ty = st.y; sp._foliage = !!st.f;
    // Resting alpha (see the alpha model above `easeAlphas`). Stamped at
    // CREATION rather than pushed through a fade source, because the occlusion
    // producer only ever visits sprites that overlap the avatar — a spiderweb
    // the player never walks behind would otherwise stay opaque forever.
    //
    // Safe to latch once, for two reasons worth writing down. (1) The pool key
    // above carries the DRAWN graphic, so a graphic change — season remap or a
    // StaticFilters toggle — mints a new sprite instead of mutating this one.
    // (2) An animated static swaps `sp.texture` between frames but keeps this
    // value, which is what ClassicUO does: `AnimatedStaticsManager` writes the
    // ART entry's AnimOffset, never `Static.Graphic`, so translucency follows
    // the base graphic for the whole cycle. That matters for 46 of the 272
    // translucent graphics, including all 40 ocean waves.
    sp._baseAlpha = st.tr ? A_TRANSLUCENT : 1;
    if (sp._baseAlpha !== 1) sp.alpha = sp._baseAlpha;
    // Born under a ceiling: start at 0 and hidden, so a roof that was already
    // over you when the sprite streamed in doesn't fade IN from nowhere.
    sp._hz = ceilHidden(st) ? 1 : 0;
    if (sp._hz) { sp.alpha = 0; sp.visible = false; setAlphaSource(sp, "ceil", 0); }
    sp._texUrl = texUrl; // so the "still on screen" branch above can keep it LRU-fresh
    // Animated static (flames/fountains/water wheels): the server baked the ART
    // tile-id frame sequence (`a`) + per-frame interval ms (`ai`). Prefetch each
    // frame's texture and store them so the animation pass can swap sp.texture.
    if (Array.isArray(st.a) && st.a.length > 1) {
      const frameUrls = st.a.map((id) => `art/static/${id}.png${hueQ}`);
      sp._frames = frameUrls.map((u) => texFor(u));
      sp._frameUrls = frameUrls;   // so tickAnimatedStatics/touch can re-resolve/re-stamp by url
      sp._afids = st.a;            // keep ids so late-loading frames can be resolved
      sp._ai = st.ai || 200;
      sp._fbase = performance.now();
      sp._fidx = -1;
      animatedStatics.add(sp);
    }
    // Tree/foliage/rock shadow — the half of ClassicUO's shadow support that
    // was waiting on this classification. A child of the static so it inherits
    // position and depth; same transform and colour as a mobile's.
    if (staticCastsShadow(sg, st.f)) attachStaticShadow(sp, tex);
    // Clickable, exactly like the dynamic-item loop below — until this, map
    // statics were drawn and nothing else, so a target cursor always fell
    // through to the canvas handler and answered with the LAND tile (graphic 0).
    // That is why an axe could not be aimed at a tree: ServUO branches on the
    // reply's graphic (`PacketHandlers.TargetResponse`) and only a non-zero one
    // becomes the `StaticTarget` the harvest system reads its tile id from.
    // The whole record rides on the sprite so the handlers can answer with the
    // static's OWN graphic and z instead of the player's.
    sp._st = st;
    // Per-pixel hit-testing, same closure shape (and same reason) as the item
    // loop's: an animated static's texture is swapped under it by
    // `tickAnimatedStatics`, so the mask must follow the CURRENT frame or a
    // click on a tall flame falls through to whatever is behind it.
    sp.hitArea = pixelHitArea(sp, () =>
      (sp._frameUrls && sp._fidx >= 0 ? sp._frameUrls[sp._fidx] : sp._texUrl));
    setStaticClickable(sp, st, beyondView);
    sp.on("pointerdown", (ev) => onStaticPointerDown(sp, ev));
    sp.on("pointerover", () => targetHighlightOn(sp));
    sp.on("pointerout", () => targetHighlightOff(sp));
    world.addChild(sp);
    staticPool.set(key, sp);
  }

  // Dynamic world items (doors, furniture, signs, corpses…): draw their REAL art
  // like statics, depth-sorted, instead of as dots. Persistent pool keyed by serial
  // (items move/open/disappear → re-create when graphic or position changes).
  const seenI = new Set();
  for (const it of s.items || []) {
    if (it.serial === undefined || !it.g) continue;
    if (it.fh) continue; // seasonal foliage cull, same rule as statics above
    if (it.nd) continue; // never-drawn pathing record — see the statics loop
    const key = it.serial;
    seenI.add(key);
    const iz = it.z | 0;
    // A corpse (graphic 0x2006) carries the dead creature's Corpse.def-remapped
    // body, facing and death-pose group from the server (see scene.rs). Once that
    // anim's frame count AND the last frame's texture have both loaded, draw the
    // held death-pose frame instead of the generic corpse art; until then (or if
    // the anim is absent) `corpseUrl` stays null and we fall through to the static
    // art below, same as any other item.
    let corpseUrl = null, corpseFrame = -1, corpseTex = null;
    // A corpse whose owner is mid-fall is not drawn yet: the animating body is
    // standing in for it (ClassicUO `DrawCorpse`'s first line, the
    // `CorpseManager.Exists` check). It appears on the poll after the animation
    // ends — the item loop runs every poll, so nothing else is needed.
    if (it.g === 0x2006 && corpseIsDying(it.serial)) continue;
    if (it.g === 0x2006 && it.body != null) {
      const dir = it.dir & 7, dg = it.dg | 0;
      framesFor(it.body, dg, dir); // kick the animinfo (frame-count/centers) load
      const fk = `${it.body}/${dg}/${dir}`;
      const loaded = frameCount.has(fk) ? frameCount.get(fk) : 0;
      if (loaded > 0) {
        corpseFrame = loaded - 1; // the death pose's final (held) frame
        const url = `anim/${it.body}/${dg}/${dir}/${corpseFrame}.png` + (it.hue ? `?hue=${it.hue}` : "");
        const t = texFor(url);
        if (t) { corpseUrl = url; corpseTex = t; }
      }
    }
    const e = itemPool.get(key);
    // A stack on the GROUND has to pick its amount-tiered art too, exactly like the
    // container/paperdoll icons do — otherwise 60,000 gold lying at your feet draws
    // as a single coin (the OPL correctly said 60,000, but the sprite didn't).
    // Comparing the RESOLVED graphic below is what makes a growing/shrinking pile
    // re-texture: `it.g` never changes when only the amount does.
    const stackG = corpseUrl ? (it.g | 0) : stackGraphic(it.g, it.amount | 0);
    // Dye hue: the server bakes the recolor into the art (`?hue=`, PartialHue
    // already folded into bit 0x8000 — see scene.rs `item_art_hue`). It has to be
    // in the change key below for the same reason `stackG` is: a `[set Hue` leaves
    // the graphic and position identical, so without it a dyed item keeps its old
    // colour until it happens to move.
    // Never for a corpse: scene.rs excludes 0x2006 from `item_art_hue` because its
    // `hue` is the Corpse.def-remapped BODY hue, not an art dye. Keying off
    // `corpseUrl` instead of the graphic tinted the generic corpse tile on every
    // poll before the death-pose animinfo resolved — and forever when that fetch
    // came back with frameCount 0.
    const iHue = it.g === 0x2006 ? 0 : (it.hue | 0);
    const hueQ = hueQuery(iHue);
    // A corpse's worn layers change as it is looted — every item taken leaves
    // the CorpseEquip list, and the sprite has to lose that layer with it. So
    // the equipment is part of the change key, not just the body frame.
    const corpseEquipSig = corpseUrl ? corpseLayerSig(it) : "";
    // `pl` (see below) is in the change key because it flips on `amount` alone:
    // dropping a second arrow onto a single one changes neither the graphic nor
    // the position, and the sprite has to grow its second copy anyway.
    const pile = !!it.pl;
    if (e && e.g === stackG && e.hue === iHue && e.x === it.x && e.y === it.y && e.z === iz
        && e.corpseUrl === corpseUrl && e.equipSig === corpseEquipSig && e.pile === pile) {
      // Ceiling state is deliberately NOT in the change key above: it must flip
      // the fade source on the LIVING sprite, not rebuild it — rebuilding is
      // what popped. Same shape as the statics loop.
      const hzNow = ceilHidden(it) ? 1 : 0;
      if (e.sp && e.sp._hz !== hzNow) {
        setAlphaSource(e.sp, "ceil", hzNow ? 0 : null);
        e.sp._hz = hzNow;
      }
      if (e.sp) {
        const click = !hzNow && !aboveGroundZ(iz);
        e.sp.eventMode = click ? "static" : "none";
        e.sp.cursor = click ? "pointer" : "default";
      }
      continue; // unchanged; see the blanket LRU-touch note above
    }
    const itemTexUrl = corpseUrl || `art/static/${stackG}.png${hueQ}`;
    const tex = corpseTex || texFor(itemTexUrl);
    if (!tex) continue; // await art, retry next poll
    if (e) { animatedStatics.delete(e.sp); world.removeChild(e.sp); e.sp.destroy(); }
    const sp = new PIXI.Sprite(tex);
    const x = isoX(it.x, it.y), y = isoY(it.x, it.y, iz);
    // A resolved death-pose frame anchors by its draw-center, same as a mobile's
    // anim frames (see drawMobs' `part()`); otherwise (loading, or a non-corpse
    // item) foot-anchor like any static.
    const c = corpseUrl ? centerFor(it.body, it.dg | 0, it.dir & 7, corpseFrame) : null;
    if (c) {
      sp.anchor.set(0, 0);
      sp.x = x - c[0]; sp.y = (y - 3) - tex.height - c[1];
    } else {
      sp.anchor.set(0.5, 1.0);
      sp.x = x; sp.y = y + HALF;
    }
    // A ground stack of more than one draws as a HEAP. ClassicUO `ItemView.Draw`
    // (`:137-151`) draws the same art twice, the second copy at `(-5, -5)`, when
    // `!IsMulti && !IsCoin && Amount > 1 && ItemData.IsStackable` — the server
    // evaluates all four and ships the verdict as `pl` (coins are excluded
    // because they carry amount-tiered art instead). 200 arrows or a spilled
    // corpse's ingots used to be pixel-identical to a single one.
    //
    // A CHILD of the item sprite rather than a second pooled sprite, so it
    // inherits position, depth, the alpha passes and the pool's own teardown for
    // free. PIXI draws a child after its parent, where ClassicUO draws the
    // offset copy first — with two copies of one texture at one alpha the
    // composite is identical either way, and the un-offset copy stays the click
    // target because the child takes no pointer events.
    if (pile && !corpseUrl) {
      const heap = new PIXI.Sprite(tex);
      heap.anchor.set(0.5, 1.0);
      heap.x = -5; heap.y = -5;
      heap.eventMode = "none";
      sp.addChild(heap);
      sp._pile = heap; // followed by tickAnimatedStatics' frame swap
    }
    // WORN LAYERS over the death pose, in the same per-direction order and with
    // the same per-frame draw-centers a living mobile's clothes use — this is
    // ClassicUO's `DrawCorpse`, which walks `LayerOrder.UsedLayers` and draws
    // each layer's own AnimID at the body's group/frame/direction.
    //
    // Parented to the body sprite rather than added to `world` separately, so
    // they inherit its position, depth and the boat/transparency passes for
    // free; only the offset between the two draw-centers is ours to compute.
    const layersDone = (corpseUrl && c) ? attachCorpseLayers(sp, it, corpseFrame, tex.height, c) : true;
    sp.zIndex = depthZ(it.x, it.y, it.pz ?? iz, 5); // bias 5: just above same-tile statics
    sp._boatSerial = it.serial >>> 0;
    sp._boatBaseX = it.x; sp._boatBaseY = it.y; sp._boatBaseZ = iz;
    sp._boatBaseSpriteX = sp.x; sp._boatBaseSpriteY = sp.y;
    sp._boatPzOffset = (it.pz ?? iz) - iz; sp._boatDepthBias = 5;
    // Tile + foliage flag for the transparency pass (circle-of-transparency / foliage fade).
    sp._tx = it.x; sp._ty = it.y; sp._foliage = !!it.f;
    // Same resting alpha as a static (see that stamp for why it latches once).
    // The item pool destroys and rebuilds the sprite on any graphic change, so
    // this cannot outlive the graphic it was derived from.
    // `hid` is the item-flags 0x80 bit: ServUO sends invisible items only to
    // staff, and ClassicUO draws them translucent rather than dropping them, so
    // a GM can see what they are standing on. Same treatment as a `tr` item.
    sp._baseAlpha = (it.tr || it.hid) ? A_TRANSLUCENT : 1;
    if (sp._baseAlpha !== 1) sp.alpha = sp._baseAlpha;
    sp._hz = ceilHidden(it) ? 1 : 0;
    if (sp._hz) { sp.alpha = 0; sp.visible = false; setAlphaSource(sp, "ceil", 0); }
    const click = !sp._hz && !aboveGroundZ(iz);
    sp.eventMode = click ? "static" : "none"; sp.cursor = click ? "pointer" : "default";
    // Per-pixel hit-testing (see pixelHitArea above). The closure re-reads the
    // CURRENT frame because an animated item's texture is swapped under it by
    // `tickAnimatedStatics` — testing a campfire's click against frame 0 while a
    // taller flame is drawn makes the click fall through to whatever is behind it.
    // `pixelHitArea` calls `getUrl()` on every `contains`, so following `_fidx`
    // costs nothing for the still items that keep `_frameUrls` undefined.
    sp.hitArea = pixelHitArea(sp, () =>
      (sp._frameUrls && sp._fidx >= 0 ? sp._frameUrls[sp._fidx] : itemTexUrl));
    const serial = it.serial;
    sp.on("pointerdown", (ev) => onEntityPointerDown(serial, ev, true)); // world item → loot on dbl-click
    sp.on("pointerover", () => { hoverEntity(serial); targetHighlightOn(sp); });
    sp.on("pointerout", () => { hoverOut(serial); targetHighlightOff(sp); });
    // Animated dynamic item (campfire, spell field, brazier): the server bakes the
    // same animdata frame list statics get (`a`/`ai`, see scene.rs `anim_frames`),
    // so hand it to the very same tick pass — a spawned campfire has to flicker
    // exactly like a mapped one. Skipped for a corpse, whose texture is an anim
    // frame this pass must not swap out from under.
    if (!corpseUrl && Array.isArray(it.a) && it.a.length > 1) {
      const frameUrls = it.a.map((id) => `art/static/${id}.png${hueQ}`);
      sp._frames = frameUrls.map((u) => texFor(u));
      sp._frameUrls = frameUrls;
      sp._afids = it.a;
      sp._ai = it.ai || 200;
      sp._fidx = -1;
      animatedStatics.add(sp);
    }
    world.addChild(sp);
    // A corpse whose layer art is still loading stores no signature, so the next
    // poll rebuilds it with the frames that have since arrived.
    itemPool.set(key, { sp, g: stackG, hue: iHue, x: it.x, y: it.y, z: iz, corpseUrl, url: itemTexUrl,
                        pile, equipSig: layersDone ? corpseEquipSig : null });
    markDirty();
  }
  for (const [k, e] of itemPool) {
    if (!seenI.has(k)) { animatedStatics.delete(e.sp); world.removeChild(e.sp); e.sp.destroy(); itemPool.delete(k); markDirty(); }
  }

  // Tiles: keep once drawn — only drop them when they're well outside the
  // window (hysteresis), so sliding the camera never re-creates visible tiles.
  pruneFar(tilePool, m.cx, m.cy, m.radius + 4);
  // Statics: seen-based — a roof the server stops sending (player under cover)
  // must be removed so the interior shows.
  prune(staticPool, seenS, (e) => e);
  diag.tiles = tilePool.size + staticPool.size;
  // Stamp EVERY texture a live sprite/anim-part could currently be showing as
  // "just used", once per poll — not only the ones this function's own diff
  // loops happen to touch. Two real escapes found live, both live sprites the
  // window loops above never revisit: (1) pruneFar's hysteresis-ring tiles
  // (kept in tilePool at Chebyshev radius+1..+4 — on stage/screen for camera-
  // slide hysteresis — but outside the span×span window loop that walks
  // m.tiles); (2) a mobile's st.partTex last-good fallback (drawMobs reuses an
  // old, already-drawn texture the instant a frame's current url hasn't
  // resolved yet, without going through texFor/touchTex for THAT texture's own
  // url). Left stale past TEX_IDLE_MS, either could get destroyed out from
  // under an on-stage sprite by sweepTexCache → app.render() throws → the rAF
  // loop dies (see frame()'s own resilience fix). ~1.3k Map.set calls at a
  // typical view radius — trivial next to the rest of this function.
  forEachLiveTexUrl(touchTex);
  // A load-time sweep can find only recent/live textures. Retry as the world
  // changes, even if no further image finishes loading after leaving a town.
  sweepTexCache();
}
// Every texture url currently referenced by a live, on-stage sprite or a
// mobile's per-part fallback (drawMobs's st.partTex — see part() below for why
// it stores {tex,url} pairs, not just the texture). Two call sites: (1) a
// per-poll touchTex sweep (syncWorld, above) so none of these ever look "idle"
// to sweepTexCache's LRU scan; (2) sweepTexCache's own belt-and-braces
// exclude-list, so even a url this pass fails to touch can never be evicted
// while still referenced live.
function forEachLiveTexUrl(fn) {
  for (const e of tilePool.values()) fn(e.url);
  for (const sp of staticPool.values()) {
    fn(sp._texUrl);
    if (sp._frameUrls) for (const u of sp._frameUrls) fn(u);
  }
  for (const e of itemPool.values()) {
    fn(e.url);
    if (e.sp._frameUrls) for (const u of e.sp._frameUrls) fn(u); // animated item's other frames
  }
  for (const st of anim.values()) {
    if (st.partTex) for (const e of st.partTex.values()) fn(e.url);
  }
}
function prune(pool, seen, getSp) {
  for (const [key, e] of pool) {
    if (!seen.has(key)) {
      const sp = getSp(e);
      animatedStatics.delete(sp); // drop from the animation set before destroy
      world.removeChild(sp); sp.destroy(); pool.delete(key);
    }
  }
}
function pruneFar(pool, cx, cy, maxDist) {
  for (const [key, e] of pool) {
    const i = key.indexOf(",");
    const x = +key.slice(0, i), y = +key.slice(i + 1);
    if (Math.abs(x - cx) > maxDist || Math.abs(y - cy) > maxDist) {
      world.removeChild(e.sp); e.sp.destroy(); pool.delete(key);
    }
  }
}

// A flat land tile: the 44×44 diamond art as a centered sprite.
function makeFlatTile(x, y, z, tex) {
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(0.5, 0.5);
  sp.x = isoX(x, y); sp.y = isoY(x, y, z); sp.zIndex = depthZ(x, y, z - 2, 0);
  return sp;
}

// A sloped land tile: a 4-corner quad whose vertices follow the corner heights
// (top=this, right=(x+1,y), bottom=(x+1,y+1), left=(x,y+1)), per ClassicUO.
//
// The texture is always a seamless texmap, so the UVs are the unit square
// mapped corner to corner — ClassicUO's `_cornerOffsetX/Y` identity in
// `DrawStretchedLand`. There is no land-art variant: a tile without a texmap is
// never stretched at all (see the caller), which is exactly why one texture
// source suffices here.
//
// No half-texel inset on those UVs, deliberately. The inset ClassicUO applies
// in `CalculateHalfPixelUVs` exists because its terrain lives in an atlas, so a
// vertex at the region's edge samples the first texel of whatever was packed
// next door — a fringe of foreign terrain. Every texmap here is loaded as its
// own standalone texture (`PIXI.Assets.load` per URL, no Spritesheet anywhere),
// so there is no neighbour to bleed in and clamping handles the edge.
// ---- directional lighting on stretched land (ClassicUO Land.cs + IsometricWorld.fx) ----
//
// ClassicUO shades a stretched land tile per VERTEX from a surface normal, and
// those normals belong to the map's corner POINTS, not to tiles: `ApplyStretch`
// (Land.cs:158-161) calls `CalculateNormal` four times, once per corner of the
// diamond — top (x,y), right (x+1,y), bottom (x+1,y+1), left (x,y+1) — each
// time with that point's own Z and its four axis neighbours. Neighbouring tiles
// therefore share a corner's light, and the shading is continuous across the
// terrain rather than per-tile flat.
//
// `CalculateNormal` (Land.cs:164-238) sums four cross products of edge vectors
// (±22, ±22, (neighbourZ - z) * 4). That sum has a closed form:
//
//     n ∝ (left + bottom - right - top,  left + top - bottom - right,  22)
//
// — the corner's own Z cancels out entirely. Checked against a literal port of
// the four-cross-product code over 200,005 cases (including the all-equal
// early-out and ±127 extremes): worst component difference 2.2e-16.
const LAND_LIGHT_FLAT = 0.85355339; // the light of a level corner; see cornerLight
// Land Z anywhere in the sent window, or null outside it. Module-scope (rather
// than syncWorld's own `zAt`) so the tile inspector can print the same numbers
// this shades with — that readout is the oracle the port was checked against.
function landZAt(x, y) {
  const m = scene && scene.map;
  if (!m) return null;
  const span = 2 * m.radius + 1;
  const col = x - m.cx + m.radius, row = y - m.cy + m.radius;
  if (col < 0 || col >= span || row < 0 || row >= span) return null;
  const t = m.tiles[row * span + col];
  return t ? (t.z | 0) : null;
}
// ClassicUO's early-out: all five Z's equal → normal (0,0,1) and "not stretched".
// A null neighbour (outside the sent window) counts as level — it can only happen
// in the two outermost rings, which are the grey context ring we never light.
function cornerFlat(cx, cy) {
  const c = landZAt(cx, cy);
  if (c == null) return true;
  const t = landZAt(cx, cy - 1), r = landZAt(cx + 1, cy), b = landZAt(cx, cy + 1), l = landZAt(cx - 1, cy);
  return (t == null || t === c) && (r == null || r === c)
      && (b == null || b === c) && (l == null || l === c);
}
// `get_light` from IsometricWorld.fx:58-67 with its compile-time
// LIGHT_DIRECTION = (0, 1, 1) (fx:14), which never rotates because UO's camera
// never does:
//     base  = max(dot(n̂, L̂), 0) / 2 + 0.5
//     light = base + (Brightlight - 1) * (base - 0.85355339)
// 0.85355339 is (cos 45° / 2) + 0.5 — the light a flat corner gets, and the
// fixed point of the second line, so level ground is lit identically at every
// Brightlight. `Brightlight = TerrainShadowsLevel * 0.1` (GameScene.cs:928),
// default 15 → 1.5 (Profile.cs:237), slider 5..25 (Constants.cs:27-28).
function cornerLight(cx, cy) {
  const c = landZAt(cx, cy);
  let base = LAND_LIGHT_FLAT;
  if (c != null) {
    const t = landZAt(cx, cy - 1) ?? c, r = landZAt(cx + 1, cy) ?? c,
          b = landZAt(cx, cy + 1) ?? c, l = landZAt(cx - 1, cy) ?? c;
    if (!(t === c && r === c && b === c && l === c)) {
      const nx = l + b - r - t, ny = l + t - b - r, nz = 22;
      const inv = 1 / Math.hypot(nx, ny, nz);
      base = Math.max((ny + nz) * inv * Math.SQRT1_2, 0) / 2 + 0.5;
    }
  }
  const bright = (settings.terrainShadows | 0) * 0.1;
  return base + ((bright * (base - LAND_LIGHT_FLAT)) - (base - LAND_LIGHT_FLAT));
}

// The land shader: ClassicUO's `IsometricWorld.fx` mode LAND, which is one line
// — `color.rgb *= get_light(IN.Normal)` (fx:137) — with the light interpolated
// across the quad from the four vertex normals. Here the light itself is
// interpolated instead of the normal, which is the same gouraud result for a
// linear function and keeps all the trigonometry on the CPU where it runs once
// per corner rather than once per fragment.
//
// A custom shader would normally cost batching, but these tiles are built from a
// plain `PIXI.Geometry` rather than a `MeshGeometry`, and PIXI only batches the
// latter — every stretched tile is already its own draw call, so this is free.
// `uProjectionMatrix`/`uWorldTransformMatrix` (global uniform group) and
// `uTransformMatrix`/`uColor` (the mesh pipe's local group) are bound
// automatically; only `uTexture` is ours to supply, so the shaders are cached
// per texmap texture — a handful per view, not one per tile.
const landShaders = new Map();   // TextureSource uid -> PIXI.Shader
let landShaderBroken = false;    // set if the GPU refuses it; falls back to flat tinting
function landShaderFor(tex) {
  if (landShaderBroken) return null;
  const src = tex.source;
  const hit = landShaders.get(src.uid);
  if (hit) return hit;
  try {
    const shader = PIXI.Shader.from({
      gl: {
        vertex: `
          in vec2 aPosition;
          in vec2 aUV;
          in float aLight;
          out vec2 vUV;
          out float vLight;
          uniform mat3 uProjectionMatrix;
          uniform mat3 uWorldTransformMatrix;
          uniform mat3 uTransformMatrix;
          void main() {
            mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
            gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
            vUV = aUV;
            vLight = aLight;
          }
        `,
        fragment: `
          in vec2 vUV;
          in float vLight;
          out vec4 finalColor;
          uniform sampler2D uTexture;
          uniform vec4 uColor;
          void main() {
            vec4 c = texture(uTexture, vUV);
            finalColor = vec4(c.rgb * vLight, c.a) * uColor;
          }
        `,
      },
      resources: { uTexture: src },
    });
    landShaders.set(src.uid, shader);
    return shader;
  } catch (err) {
    // No custom shader (old GPU, context loss, a PIXI build without it): fall
    // back to flat per-tile tinting for the rest of the session rather than
    // losing the terrain. Faceted on a tile whose corners disagree, right on
    // the rest.
    console.warn("land shader unavailable, falling back to flat tinting:", err);
    landShaderBroken = true;
    return null;
  }
}

function makeStretchedTile(x, y, z0, z1, z2, z3, tex, light) {
  const Bx = (x - y) * HALF, By = (x + y) * HALF;
  const aPosition = [
    Bx,        By - HALF - z0 * ZSTEP, // top
    Bx + HALF, By        - z1 * ZSTEP, // right
    Bx,        By + HALF - z2 * ZSTEP, // bottom
    Bx - HALF, By        - z3 * ZSTEP, // left
  ];
  const aUV = [0, 0, 1, 0, 1, 1, 0, 1];
  // One light per vertex, in the same top/right/bottom/left order as the
  // positions above. Declared in full rather than as a bare array: PIXI infers
  // `float32x2` for an untyped attribute, which would silently pair the corners
  // up and light the tile from two of its four values.
  const shader = landShaderFor(tex);
  const attributes = { aPosition, aUV };
  if (shader) {
    attributes.aLight = {
      buffer: new Float32Array(light), format: "float32", stride: 4, offset: 0,
    };
  }
  const geometry = new PIXI.Geometry({ attributes, indexBuffer: [0, 1, 2, 0, 2, 3] });
  const mesh = new PIXI.Mesh(shader ? { geometry, texture: tex, shader } : { geometry, texture: tex });
  if (!shader) {
    // Flat fallback: the tile's mean light as a grey tint. Clamped at 1 because
    // a tint cannot brighten, and ClassicUO's light does reach 1.07 on a slope
    // facing the light.
    const v = Math.round(Math.min(1, (light[0] + light[1] + light[2] + light[3]) / 4) * 255);
    mesh.tint = (v << 16) | (v << 8) | v;
  }
  // Sort a sloped tile by its AverageZ (ClassicUO Land.CalculateAverageZ: the mean
  // of whichever diagonal corner-pair differs less), NOT the top corner — otherwise
  // a slope whose top corner is high sorts in front of taller statics (e.g. stairs)
  // that sit behind it and wrongly covers them. (top=z0, right=z1, bottom=z2, left=z3)
  const avgZ = Math.abs(z0 - z2) <= Math.abs(z3 - z1) ? (z0 + z2) >> 1 : (z3 + z1) >> 1;
  mesh.zIndex = depthZ(x, y, avgZ - 2, 0);
  return mesh;
}

// A flat-colour diamond placeholder for a land tile whose art/texmap PNG hasn't
// streamed in yet (or a window-edge tile with no neighbour to slope against). Uses
// the server-provided average colour `c` so terrain never flashes the black page
// background during load/scroll; replaced by the textured tile on a later poll once
// texFor() resolves. Corner heights follow the same layout as makeStretchedTile.
function makeColorTile(x, y, z0, z1, z2, z3, c, light) {
  const Bx = (x - y) * HALF, By = (x + y) * HALF;
  const g = new PIXI.Graphics();
  // Shade the placeholder by the same mean light as the tile that will replace
  // it, so a slope doesn't flash bright and then darken when its texmap lands.
  const lm = light ? Math.min(1, (light[0] + light[1] + light[2] + light[3]) / 4) : 1;
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * lm)));
  g.poly([
    Bx,        By - HALF - z0 * ZSTEP, // top
    Bx + HALF, By        - z1 * ZSTEP, // right
    Bx,        By + HALF - z2 * ZSTEP, // bottom
    Bx - HALF, By        - z3 * ZSTEP, // left
  ]).fill(Array.isArray(c) && c.length === 3 ? ((ch(c[0]) << 16) | (ch(c[1]) << 8) | ch(c[2])) : 0x101418);
  const avgZ = Math.abs(z0 - z2) <= Math.abs(z3 - z1) ? (z0 + z2) >> 1 : (z3 + z1) >> 1;
  g.zIndex = depthZ(x, y, avgZ - 2, 0);
  return g;
}

// Is world tile (x,y) walkable per the latest scene? (outside the window → assume yes)
function tileWalkable(x, y) {
  const m = scene && scene.map;
  if (!m) return true;
  const span = 2 * m.radius + 1;
  const col = x - m.cx + m.radius, row = y - m.cy + m.radius;
  if (col < 0 || col >= span || row < 0 || row >= span) return true;
  const t = m.tiles[row * span + col];
  return t ? t.w === 1 : true;
}

// Predicted standing Z for stepping onto (x,y) — the server's per-tile `sz`
// (CalculateNewZ). null when outside the window. Lets prediction raise/lower Z
// together with the step so stairs glide instead of popping.
function tileSZ(x, y) {
  const m = scene && scene.map;
  if (!m) return null;
  const span = 2 * m.radius + 1;
  const col = x - m.cx + m.radius, row = y - m.cy + m.radius;
  if (col < 0 || col >= span || row < 0 || row >= span) return null;
  const t = m.tiles[row * span + col];
  if (!t) return null;
  return t.sz !== undefined ? (t.sz | 0) : (t.z | 0);
}

// Serial of the closed door blocking (x,y), if any — the optional `dr` field the
// server attaches to a land tile ONLY when it's blocked SOLELY by an openable
// closed door (a tile blocked by a door AND e.g. a crate does not get it). null
// when there's no door, (x,y) is outside the client's map window, or the server
// predates this field — all three cases are indistinguishable and all correctly
// mean "nothing to auto-open here". Feeds tryAutoOpenDoor() near canWalk().
function tileDoor(x, y) {
  const m = scene && scene.map;
  if (!m) return null;
  const span = 2 * m.radius + 1;
  const col = x - m.cx + m.radius, row = y - m.cy + m.radius;
  if (col < 0 || col >= span || row < 0 || row >= span) return null;
  const t = m.tiles[row * span + col];
  return t && t.dr !== undefined ? (t.dr >>> 0) : null;
}
