// ClassicUO corpse-gump eye (gump 0x45/0x46) blinks every 750ms.
let corpseEyeOn = 0, corpseEyeAt = 0;
function tickCorpseEyes(now) {
  const eyes = document.querySelectorAll(".cont-eye");
  if (!eyes.length) return;
  if (now - corpseEyeAt < 750) return;
  corpseEyeAt = now;
  corpseEyeOn ^= 1;
  const src = "gump/" + (0x45 + corpseEyeOn) + ".png";
  for (const eye of eyes) eye.src = src;
}

async function main() {
  app = new PIXI.Application();
  const rs = renderSize();
  // autoStart:false → no automatic per-frame render. We render ON DEMAND (only when
  // something visibly changed) and cap the redraw rate — see the loop below.
  await app.init({ width: rs.w, height: rs.h, background: 0x05070a, antialias: false, resolution: 1, autoDensity: false, autoStart: false });
  app.canvas.style.width = "100%";
  app.canvas.style.height = "100%";
  app.canvas.style.imageRendering = "pixelated"; // crisp nearest-neighbor upscale
  window.addEventListener("resize", () => { const r = renderSize(); app.renderer.resize(r.w, r.h); markDirty(); });
  document.getElementById("map").appendChild(app.canvas);
  // Mouse-wheel / trackpad camera zoom: the player stays centered (the per-frame
  // camera math re-centers on every frame — see renderFrame), so this only needs
  // to adjust camZoom and request a redraw. The zoom step is PROPORTIONAL to the
  // scroll amount (exp(-Δ·k)), not a fixed factor per event — a mouse notch is one
  // big Δ, but a trackpad fires dozens of tiny Δ's per gesture, and a fixed factor
  // would compound them into a violent jump. Normalize deltaMode (Firefox reports
  // lines/pages) and clamp per event so one accelerated flick can't leap.
  app.canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;            // lines → ~px
    else if (e.deltaMode === 2) dy *= app.screen.height; // pages → ~px
    dy = Math.max(-100, Math.min(100, dy));     // cap a single event to ~10% zoom
    camZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, camZoom * Math.exp(-dy * ZOOM_WHEEL_K)));
    markDirty();
  }, { passive: false });
  buildGameCursors();  // UO-style arrow / target-reticle mouse cursors over the game
  world = new PIXI.Container(); world.sortableChildren = true;
  entLayer = new PIXI.Graphics();
  mobs = new PIXI.Container();
  overLayer = new PIXI.Container(); // floating speech, always on top of the world
  // Names + HP bars (drawn over the world, non-interactive so they never eat clicks).
  barLayer = new PIXI.Container(); barLayer.eventMode = "none";
  // Invisible per-item click targets — kept BELOW `world` so a mobile sharing a
  // tile with an item wins the hit-test (mobiles are the priority).
  itemLayer = new PIXI.Container();
  // Guard-zone (guard line) overlay: above terrain/statics/items (`world`), below
  // everything entity-related (`entLayer`'s fallback dots, `mobs`, `barLayer`,
  // `overLayer`) — see the "guard-zone (guard line) boundary overlay" section.
  guardLineLayer = new PIXI.Graphics();
  app.stage.addChild(itemLayer, world, guardLineLayer, entLayer, mobs, barLayer, overLayer);

  if (REPLAY_MODE) { await replayStart(); return; }

  if (typeof wireConnectionControls === "function") wireConnectionControls();
  poll();
  setInterval(poll, 150);
  if (!WASM_MODE) connectSoundStream(); // SSE: play sounds the instant they fire (no poll wait)
  if (WASM_MODE) {
    wasmPrepareLoginUi();
    showLogin("login");
  }
  setInterval(tickBuffTimers, 1000); // count down the buff-bar timers once a second
  // Render-on-demand loop: renderFrame() advances the prediction/glide every
  // animation frame (so motion stays smooth), but app.render() — the expensive GPU
  // pass — only runs when the scene actually changed (movement, animation, a poll
  // update) and at most ~RENDER_MS apart. Standing still ⇒ ~0 GPU work; walking ⇒
  // a capped redraw rate. This is what kills the "600% CPU" (it was re-drawing the
  // whole world 60×/s unconditionally).
  let lastT = performance.now(), lastDraw = 0;
  const RENDER_MS = 22; // ~45fps redraw ceiling
  function frame(now) {
    renderFrame(now - lastT); lastT = now;
    tickCorpseEyes(now);
    if (dirty && now - lastDraw >= RENDER_MS) {
      // A render throw (e.g. a texture destroyed out from under a still-live
      // sprite — see the texture-cache eviction comments above) must not kill
      // this loop: requestAnimationFrame(frame) below would never run if
      // app.render() threw uncaught, permanently freezing the client on one bad
      // frame. Log it, force a retry next frame (markDirty), and move on.
      try { app.render(); } catch (err) { console.error("app.render() failed, skipping frame:", err); markDirty(); }
      dirty = false; lastDraw = now;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  // The journal window has to exist before `setupInput` restores the saved
  // hidden/shown state (it calls loadHudVisibility → applyJournalVisibility).
  buildJournalWindow(); // re-parents #jrnl-tabs/#journal into their own window
  setupInput();
  buildJournalTabs();   // filter chips above the log (All / Speech / Guild / System)
  buildInfoBarPicker();
  document.getElementById("infobar").classList.toggle("on", infoBarOn);
  makeDraggable(document.getElementById("infobar"), document.getElementById("ib-title"));
  document.getElementById("ib-close").addEventListener("click", toggleInfoBar);
  document.querySelector("#infobar .ib-cfg").addEventListener("click", () => {
    document.getElementById("ib-picker").classList.toggle("on");
  });
  document.getElementById("counterbar").classList.toggle("on", counterBarOn);
  makeDraggable(document.getElementById("counterbar"), document.getElementById("cb-title"));
  document.getElementById("cb-close").addEventListener("click", toggleCounterBar);
  document.querySelector("#counterbar .cb-add").addEventListener("click", addCounterSlot);
  // One delegated pair on the slot host: the cells are rebuilt whenever the set
  // changes, so per-cell listeners would have to be re-hung every time.
  document.getElementById("cb-slots").addEventListener("click", (e) => {
    const cell = e.target.closest(".cb-slot");
    if (!cell) return;
    const i = +cell.dataset.i;
    if (e.target.classList.contains("cb-x")) { removeCounterSlot(i); return; }
    cbSelect(i);
  });
  document.getElementById("cb-slots").addEventListener("dblclick", (e) => {
    const cell = e.target.closest(".cb-slot");
    if (cell) useCounterSlot(+cell.dataset.i);
  });
  renderCounterSlots();
  document.getElementById("ignorelist").classList.toggle("on", ignoreListOn);
  makeDraggable(document.getElementById("ignorelist"), document.getElementById("ig-title"));
  document.getElementById("ig-close").addEventListener("click", toggleIgnoreList);
  document.getElementById("ig-pick").addEventListener("click", () => armIgnorePick(!ignorePick));
  document.getElementById("ig-name").addEventListener("keydown", (e) => {
    e.stopPropagation();               // typed keys must not reach the game input handler
    if (e.code !== "Enter" && e.code !== "NumpadEnter") return;
    if (ignoreName(e.target.value)) e.target.value = "";
  });
  renderIgnoreList();
  document.getElementById("combatbook").classList.toggle("on", cbkOn);
  makeDraggable(document.getElementById("combatbook"), document.getElementById("cbk-title"));
  document.getElementById("cbk-close").addEventListener("click", toggleCombatBook);
  if (cbkOn) loadAbilityText();
  document.getElementById("racialbook").classList.toggle("on", rcbOn);
  makeDraggable(document.getElementById("racialbook"), document.getElementById("rcb-title"));
  document.getElementById("rcb-close").addEventListener("click", toggleRacialBook);
  if (rcbOn) loadAbilityText();
  document.getElementById("netstats").classList.toggle("on", netStatsOn);
  makeDraggable(document.getElementById("netstats"), document.getElementById("ns-title"));
  document.getElementById("ns-close").addEventListener("click", toggleNetStats);
  document.getElementById("inspector").classList.toggle("on", inspectOn);
  makeDraggable(document.getElementById("inspector"), document.getElementById("insp-title"));
  document.getElementById("insp-close").addEventListener("click", toggleInspector);
  document.getElementById("insp-pick").addEventListener("click", () => armInspect(!inspectPick));
  document.getElementById("insp-dump").addEventListener("click", inspectDump);
  renderInspector();
  loadStaticFilters();   // ClassicUO's tree/vegetation/cave tables, tiledata-resolved
  setupItemDnD();
  initFx();
}

// ---- Day/night tint + weather (separate 2D-canvas rAF loop) ----------------
// Drawn on its own <canvas id="fx"> over the game world but UNDER all HUD/UI.
// It runs an INDEPENDENT requestAnimationFrame loop and never calls app.render()
// or markDirty(), so the expensive PIXI world stays render-on-demand even while
// rain/snow animate continuously. Reads only the latest polled `scene`.
let fxCanvas = null, fxCtx = null, fxParticles = [], fxTint = 0, fxKind = -1, fxLastT = 0;
const FX_MAX_PARTICLES = 70; // ClassicUO MAX_WEATHER_EFFECT (Weather.cs:16)
const FX_MAX_NIGHT = 0.6;    // cap on the night tint (see the target calc below)

// ---- weather (0x65) ----------------------------------------------------------
// ClassicUO's four types (`Game/Weather.cs:13-22`). Only 0 and 2 were handled
// here before, so a fierce storm and a brewing one rendered as clear sky.
const WT_RAIN = 0, WT_STORM_APPROACH = 1, WT_SNOW = 2, WT_STORM_BREWING = 3;
const FX_WEATHER_MSG = {
  [WT_RAIN]: "It begins to rain.",
  [WT_STORM_APPROACH]: "A fierce storm approaches.",
  [WT_SNOW]: "It begins to snow.",
  [WT_STORM_BREWING]: "A storm is brewing.",
};
const FX_WEATHER_MS = 6 * 60 * 1000; // ClassicUO WEATHER_TIMER (Constants.cs:97)
const FX_THUNDER = [0x028, 0x206];   // Weather.PlayThunder
const FX_WIND_SFX = [0x014, 0x015, 0x016]; // Weather.PlayWind
const FX_WIND_SWIRL = 20;            // the `range` of ClassicUO's SinOscillate call
let fxWind = 0, fxWindNextT = 0, fxWeatherStartT = 0;

// ClassicUO positions both weather sounds at a random 10-18 tile offset from the
// player on each axis (`Weather.PlaySound`, :207-223) so they never sit exactly
// on top of you.
function fxWeatherSfx(ids) {
  if (typeof playSfx !== "function" || audioMuted || !settings.sfx) return;
  if (!scene || !scene.player) return;
  const off = () => (10 + Math.floor(Math.random() * 9)) * (Math.random() < 0.5 ? -1 : 1);
  playSfx(ids[Math.floor(Math.random() * ids.length)],
          (scene.player.x | 0) + off(), (scene.player.y | 0) + off());
}

// A new weather type: journal line (ClassicUO uses hue 1154 for all four) plus
// the type's opening sound. Rain alone is silent.
function fxWeatherStart(kind, now) {
  fxWeatherStartT = FX_WEATHER_MSG[kind] !== undefined ? now : 0;
  fxWindNextT = 0; // forces a re-roll, which ClassicUO also counts as a change
  const msg = FX_WEATHER_MSG[kind];
  if (msg === undefined) return;
  addSysMessage(msg);
  fxWindSound(kind);
}

function fxWindSound(kind) {
  if (kind === WT_SNOW) fxWeatherSfx(FX_WIND_SFX);
  else if (kind === WT_STORM_APPROACH || kind === WT_STORM_BREWING) fxWeatherSfx(FX_THUNDER);
}

// Wind re-rolls every 13-19 s to a signed 0..4 and cannot reverse in one step —
// ClassicUO forces a sign crossing through 0 first (`Weather.cs:262-295`).
// Returns whether this tick changed it, which is what gates the sound.
function fxTickWind(kind, now) {
  if (fxWeatherStartT === 0 || now < fxWindNextT) return false;
  const first = fxWindNextT === 0;
  fxWindNextT = now + (13 + Math.random() * 6) * 1000;
  const last = fxWind;
  let w = Math.floor(Math.random() * 5);
  if (Math.floor(Math.random() * 3) !== 0) w = -w;
  if (w < 0 && last > 0) w = 0;
  else if (w > 0 && last < 0) w = 0;
  fxWind = w;
  return first || w !== last;
}

// Horizontal speed for a wind-driven particle. ClassicUO turns (Wind, baseVy)
// into an angle + magnitude, adds a per-particle swirl to the angle and converts
// back (`Weather.cs:375-400`). We take the ANGLE from that model but keep our own
// vertical speed, which is tuned for a CSS-pixel canvas rather than a 640x480
// game window — so the lean matches while the fall rate stays right here.
//
// One deliberate divergence: ClassicUO's `SinOscillate` (`:49-54`) computes
// `Math.Sign(ToRadians(angle)) * range`, and radians of a 0..359 value are never
// negative — so it returns a constant +20 and the swirl does not actually swirl.
// The name, the `freq` argument and the unused range all say `Math.Sin` was
// meant; we oscillate for real.
function fxGust(p, baseVy, now) {
  const swirl = FX_WIND_SWIRL * Math.sin((now * 0.4 / 2.7777 + p.phase) * Math.PI / 180);
  const angle = Math.atan2(fxWind, baseVy) + swirl * Math.PI / 180;
  return Math.hypot(fxWind, baseVy) * (p.vy / baseVy) * Math.sin(angle);
}

// Wrap horizontally; recycle at the top. Past WEATHER_TIMER a particle that
// leaves is retired instead, so the weather drains out of view rather than
// snapping off mid-screen (ClassicUO `:320-334`). Returns true if it is gone.
function fxRetire(p, i, W, H, expired, topY) {
  if (p.x < 0) p.x += W; else if (p.x > W) p.x -= W;
  if (p.y <= H) return false;
  if (expired) { fxParticles.splice(i, 1); return true; }
  p.y = topY; p.x = Math.random() * W;
  return false;
}

// Does an ART graphic emit light, and which `light.mul` shape? Only the effect
// pass above asks: every other light in the scene is resolved server-side, but an
// effect's art changes frame by frame and the browser is the only thing that
// knows which frame is up. One `/iteminfo` round trip per graphic, memoized
// forever (there are a few dozen effect graphics in the whole game).
// null = in flight; `{lt, lid}` once it lands.
const fxArtLight = new Map();
function artLightInfo(g) {
  if (fxArtLight.has(g)) return fxArtLight.get(g);
  fxArtLight.set(g, null);
  fetch(`iteminfo/${g}`)
    .then((r) => r.json())
    .then((j) => fxArtLight.set(g, { lt: !!(j && j.lt), lid: (j && j.lid) | 0 }))
    .catch(() => fxArtLight.set(g, { lt: false, lid: 0 }));
  return null;
}

function initFx() {
  fxCanvas = document.getElementById("fx");
  if (!fxCanvas) return;
  fxCtx = fxCanvas.getContext("2d");
  const resize = () => { fxCanvas.width = window.innerWidth; fxCanvas.height = window.innerHeight; };
  resize();
  window.addEventListener("resize", resize);
  requestAnimationFrame(fxFrame);
}

function fxSpawn(W, H, snow) {
  if (snow) {
    return { x: Math.random() * W, y: Math.random() * H,
             vx: (Math.random() - 0.5) * 0.6, vy: 0.6 + Math.random() * 1.3,
             r: 1 + Math.random() * 1.8, phase: Math.random() * 360 };
  }
  // rain: fast, near-vertical light-blue streaks (slight lean). `phase` is the
  // per-particle offset of the wind swirl, which only storm-approach uses.
  return { x: Math.random() * W, y: Math.random() * H,
           vx: -1.0 - Math.random(), vy: 9 + Math.random() * 6, r: 0,
           phase: Math.random() * 360 };
}

function fxFrame(now) {
  const dt = fxLastT ? Math.min(50, now - fxLastT) : 16;
  fxLastT = now;
  const ctx = fxCtx;
  if (!ctx) { requestAnimationFrame(fxFrame); return; }
  const W = fxCanvas.width, H = fxCanvas.height;
  ctx.clearRect(0, 0, W, H);

  // --- night tint: light 0 = full day (no tint) → ~0x1F darkest ---
  const light = scene ? (scene.light || 0) : 0;
  // ClassicUO multiplies the world by a brightness of `1 - light/32`; a near-black
  // overlay at alpha `a` approximates a multiply by `1 - a`, so `light/32` is the
  // authentic opacity. FX_MAX_NIGHT then caps it: we draw far fewer light sources
  // than ClassicUO does, so the darkest dungeon levels would be unreadable.
  const target = Math.min(FX_MAX_NIGHT, light / 32);
  fxTint += (target - fxTint) * Math.min(1, dt / 400); // smooth dawn/dusk glide
  if (fxTint > 0.003) {
    ctx.fillStyle = "rgba(8, 14, 40, " + fxTint.toFixed(3) + ")";
    ctx.fillRect(0, 0, W, H);
    // Per-object light sources: once it's dark enough to notice, erase soft holes
    // in the night overlay at each light (torches/lamps + the player), so the
    // bright game world shows through as a glow. destination-out subtracts the
    // gradient's alpha from the darkness; a radial falloff makes a soft circle.
    // NOT gated on `scene.lights.length`: this block draws the scene's lights AND
    // the live-effect pass below it, and an effect over ground with no light of
    // its own is exactly when a spell should be the thing lighting it. That
    // coupling is latent rather than live today only because `lights_json` always
    // pushes the player's own glow — and that glow is OUR addition, not a
    // ClassicUO port (it has no personal light at all), so the day someone
    // removes it for fidelity the effect lights would go dark with it and
    // nothing would say why.
    if (fxTint > 0.05 && scene && app && app.renderer) {
      const cssX = app.canvas.clientWidth / app.renderer.width;   // renderer→CSS px (x)
      const cssY = app.canvas.clientHeight / app.renderer.height; // renderer→CSS px (y)
      const ox = app.stage.position.x, oy = app.stage.position.y;
      const center = 0.9 * fxTint; // erase strength at the glow's core
      const tinted = [];           // coloured lights, drawn additively after the erase
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      // Erase one light's hole in the veil, centred on screen (sx, sy). Shared by
      // the scene's light list and the live-effect pass after it.
      const punch = (sx, sy, id, colour, r) => {
        // The real shape from light.mul when we have it — every light-emitting
        // graphic names one through its tiledata Quality byte, and they are not
        // circles: a wall torch throws a lopsided cone, a campfire a wide oval.
        // ClassicUO draws these additively into a light buffer; this overlay
        // subtracts instead, so the server hands over the same mask with the
        // intensity in the alpha channel (see anima-assets `lights.rs`).
        const img = lightShape(id, colour);
        if (img) {
          const w = img.width * camZoom * cssX, h = img.height * camZoom * cssY;
          if (sx < -w || sy < -h || sx > W + w || sy > H + h) return;
          ctx.globalAlpha = center;
          ctx.drawImage(img, sx - w / 2, sy - h / 2, w, h);   // centred, as ClassicUO draws it
          ctx.globalAlpha = 1;
          // A coloured light also has to *add* its colour, not just clear the
          // veil — a red brazier should tint what it lights. Queue it for the
          // additive pass below, which is ClassicUO's light buffer: the erase
          // above brightens, this colours.
          if (colour) tinted.push([img, sx, sy, w, h]);
          return;
        }
        // No shape (no light.mul on the server, or an id it has no entry for):
        // the plain radial falloff this pass used before.
        const rad = (r || 3) * 44 * cssX;
        if (sx < -rad || sy < -rad || sx > W + rad || sy > H + rad) return; // off-screen
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
        g.addColorStop(0, "rgba(0,0,0," + center.toFixed(3) + ")");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sx, sy, rad, 0, 6.283);
        ctx.fill();
      };
      for (const L of (scene.lights || [])) {
        // A CARRIED light has three placements in ClassicUO and the branch is
        // decided by whether the item's art was actually drawn on the character:
        //
        //  • drawn  → `MobileView.DrawLayer:841-845` lights it from THAT
        //    sprite's own position, with no per-facing nudge at all. A lit torch
        //    on the one-hand layer is drawn, so this is the branch it takes.
        //  • not drawn → `:429`/`:439` use the body's draw point plus the
        //    per-facing nudge (`worn_light_offset`), which is what `dx`/`dy`
        //    carry.
        //
        // The core cannot tell which applies — it does not know whether the
        // layer produced a sprite this frame — so it sends both and the choice
        // is made here, where the sprite either exists or does not. Using the
        // nudge for a torch that IS drawn put the glow most of a tile below and
        // beside the flame, which is what this branch fixes.
        let wx = isoX(L.x, L.y) + (L.dx | 0);
        let wy = isoY(L.x, L.y, L.z) + (L.dy | 0);
        if (L.hs !== undefined && L.ly) {
          const owner = (scene.player && (L.hs >>> 0) === (scene.player.serial >>> 0))
            ? "self" : ("m" + (L.hs >>> 0));
          const sp = mobSprites.get(owner + "#L" + (L.ly | 0) + "#0");
          const st = anim.get(owner);
          if (sp && sp.visible && sp.texture && st) {
            // The drawn branch lights from the BODY's draw point, not from the
            // flame. `AddLight(owner, entity, mirror ? x + width : x, y)` sits
            // inside `DrawInternal(… int x, int y …)`, and the worn-layer call
            // passes `drawX, drawY` — the same pair the body is drawn from. So
            // the light lands where the character stands, which is the tile
            // point, `-3` for the `posY -= 3` that precedes it. The per-facing
            // nudge belongs to the OTHER branch and is not used here.
            //
            // From the INTERPOLATED position, not the light's tile. ClassicUO's
            // `drawX/drawY` are `posX + Offset.X` and `posY + (Offset.Y -
            // Offset.Z)`, and `Offset` is the walk interpolation — the same term
            // that makes the body glide between tiles. `scene.lights` carries a
            // tile, refreshed on the 150ms poll, so using it made the glow jump
            // tile to tile and trail the character it belongs to. `st.rx/ry/rz`
            // is exactly what the body sprite is drawn from (`drawMobs`), so the
            // light now moves with the person carrying it rather than after them.
            wx = isoX(st.rx, st.ry);
            wy = isoY(st.rx, st.ry, st.rz ?? st.z) - 3;
          }
        }
        const sx = (ox + wx * camZoom) * cssX;
        const sy = (oy + wy * camZoom) * cssY;
        punch(sx, sy, L.id, L.c, L.r);
      }
      // A live EFFECT whose art is a light source lights the ground it passes
      // over — ClassicUO `GameEffectView.Draw` (`:248-251`) adds a light at the
      // effect's own draw position whenever `data.IsLight` and the effect has a
      // Source. It cannot come from `scene.lights`: a bolt's position is
      // interpolated here, 60×/s, between two 150 ms polls. The light's SHAPE is
      // the source's, not the art's — ClassicUO passes `AddLight(Source, Source,
      // …)`, which for a mobile caster lands on the `obj is Mobile` arm and its
      // shape 1. (It also runs `LightColors` on the caster's BODY graphic there;
      // that table is keyed by item/static graphics, so the colour is left white
      // rather than porting a lookup that is meaningless on a body id.)
      for (const o of fxEffects) {
        if (!o.src || o.kind === 1) continue; // no Source → no light; lightning is gump art
        if (!o.sprite || o.sprite.destroyed || !o.sprite.visible) continue;
        const g = o.frames[Math.floor((now - o.born) / o.fm) % o.frames.length] | 0;
        const info = artLightInfo(g);
        if (!info || !info.lt) continue;
        // `drawEffects` foot-anchors the sprite at `isoY + HALF`; a light's
        // anchor is the tile centre, which is that same point less HALF — the
        // relation `scene.lights` already has to an item's sprite.
        punch((ox + o.sprite.x * camZoom) * cssX,
              (oy + (o.sprite.y - HALF) * camZoom) * cssY, 1, 0, 3);
      }
      ctx.restore();
      // The colour half. ClassicUO adds its (coloured) light buffer onto the
      // world, so a red brazier makes what it lights read red. This overlay is
      // subtractive, and adding colour to a veil the pass above has just erased
      // changes almost nothing — measured at 2/255 on a full-strength brazier.
      // What works in this model is to erase *to a colour* instead of to
      // nothing: paint the same mask back over the hole, so the world beneath
      // shows through a thin wash of the light's own colour.
      if (tinted.length) {
        ctx.save();
        ctx.globalAlpha = 0.5 * fxTint;
        for (const [img, sx, sy, w, h] of tinted) ctx.drawImage(img, sx - w / 2, sy - h / 2, w, h);
        ctx.restore();
      }
    }
  }

  // --- season (0xBC): NO tint. This used to paint a faint amber/blue/grey wash
  // here as a stand-in for the graphic remap. The remap is real now (see
  // anima-net scene/season.rs — grass 573 genuinely becomes snow 1861), and
  // ClassicUO has no colour wash at all: a grep of its whole src/ for Season
  // reaches SeasonManager/World/PacketHandlers/Land/Static/Multi and not one of
  // them touches Hue or AlphaHue. Keeping it would double-tint an already
  // substituted world — and it was actively wrong on a ServUO shard, where
  // Felucca registers as season 4 and so every living player was permanently
  // greyed. ---

  // --- weather (0x65). ClassicUO has FOUR types, not two: WT_RAIN 0,
  // WT_STORM_APPROACH 1, WT_SNOW 2, WT_STORM_BREWING 3 (`Game/Weather.cs:13-22`).
  // Rain and storm-approach share the streak branch (`:407-410`); storm-brewing
  // has no draw case at all and is sound only. We used to clear the particle set
  // for 1 and 3, so a fierce storm rendered as perfectly clear sky. ---
  const kind = scene ? scene.weather : 0xFF;
  const snow = kind === WT_SNOW;
  const streaks = kind === WT_RAIN || kind === WT_STORM_APPROACH;
  if (kind !== fxKind) { fxParticles.length = 0; fxKind = kind; fxWeatherStart(kind, now); }
  const windChanged = fxTickWind(kind, now);
  if (windChanged) fxWindSound(kind);
  // Count is scaled to the window against ClassicUO's 640x480 reference
  // (`CalculateScaledCount`, :186-195) and capped at its MAX_WEATHER_EFFECT.
  // Past WEATHER_TIMER the particles are not snapped off: they retire one at a
  // time as they leave the viewport, which is why the drain lives in the update
  // loops below rather than here.
  const raw = scene ? (scene.weatherN | 0) : 0;
  const expired = fxWeatherStartT > 0 && now - fxWeatherStartT > FX_WEATHER_MS;
  const wantN = ((streaks || snow) && raw > 0 && !expired)
    ? Math.min(FX_MAX_PARTICLES, Math.max(1, Math.round(raw * (W * H) / (640 * 480))))
    : 0;
  while (fxParticles.length < wantN) fxParticles.push(fxSpawn(W, H, snow));
  if (fxParticles.length > wantN && !expired) fxParticles.length = wantN;

  if (fxParticles.length > 0 && (streaks || snow)) {
    const f = dt / 16; // normalize step to ~60fps
    if (streaks) {
      ctx.strokeStyle = "rgba(170, 200, 235, 0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      // Plain rain keeps its own fixed lean — ClassicUO gives WT_RAIN a constant
      // `SpeedX = -4.5 - scaleRatio` and never applies Wind to it (:343-346).
      // Storm-approach is the wind-driven one (`SpeedX = Wind`, `SpeedY = 6`).
      for (let i = fxParticles.length - 1; i >= 0; i--) {
        const p = fxParticles[i];
        const vx = kind === WT_STORM_APPROACH ? fxGust(p, 6.0, now) : p.vx;
        p.x += vx * f; p.y += p.vy * f;
        if (fxRetire(p, i, W, H, expired, -10)) continue;
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - vx * 1.6, p.y - p.vy * 1.6);
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      for (let i = fxParticles.length - 1; i >= 0; i--) {
        const p = fxParticles[i];
        p.x += fxGust(p, 1.0, now) * f;
        p.y += p.vy * f;
        if (fxRetire(p, i, W, H, expired, -6)) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, 6.283);
        ctx.fill();
      }
    }
  }

  // --- quest arrow (0xBA): point from screen center toward the target tile.
  // On-screen → the arrow sits on the tile; off-screen → it clamps to the screen
  // edge in that direction so it always tells you which way to go. ---
  const qa = scene && scene.questArrow;
  if (qa && app && app.renderer) {
    const cssX = app.canvas.clientWidth / app.renderer.width;
    const cssY = app.canvas.clientHeight / app.renderer.height;
    const ox = app.stage.position.x, oy = app.stage.position.y;
    const tx = (ox + isoX(qa.x, qa.y) * camZoom) * cssX;
    const ty = (oy + isoY(qa.x, qa.y, 0) * camZoom) * cssY;
    const cx = W / 2, cy = H / 2;
    const margin = 44;
    let ax = tx, ay = ty;
    const onScreen = tx >= 0 && tx <= W && ty >= 0 && ty <= H;
    if (!onScreen) {
      // Clamp along the center→target ray to the screen rect (inset by margin).
      const dx = tx - cx, dy = ty - cy;
      let t = Infinity;
      if (dx > 0) t = Math.min(t, (W - margin - cx) / dx);
      else if (dx < 0) t = Math.min(t, (margin - cx) / dx);
      if (dy > 0) t = Math.min(t, (H - margin - cy) / dy);
      else if (dy < 0) t = Math.min(t, (margin - cy) / dy);
      if (!isFinite(t) || t < 0) t = 0;
      ax = cx + dx * t; ay = cy + dy * t;
    }
    const ang = Math.atan2(ty - cy, tx - cx);
    drawQuestArrow(ctx, ax, ay, ang, now);
  }

  requestAnimationFrame(fxFrame);
}

// Draw a glowing amber quest arrow at (x, y) pointing along `ang` (radians). A
// gentle pulse keeps it noticeable without being distracting.
function drawQuestArrow(ctx, x, y, ang, now) {
  const pulse = 1 + 0.12 * Math.sin(now * 0.006);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.scale(pulse, pulse);
  ctx.shadowColor = "rgba(255, 200, 90, 0.9)";
  ctx.shadowBlur = 12;
  ctx.fillStyle = "#ffcf5a";
  ctx.strokeStyle = "rgba(80, 50, 0, 0.9)";
  ctx.lineWidth = 1.5;
  // Arrow: a shaft + a head, drawn pointing toward +x (the rotation aims it).
  ctx.beginPath();
  ctx.moveTo(18, 0);    // tip
  ctx.lineTo(2, -11);
  ctx.lineTo(2, -4);
  ctx.lineTo(-16, -4);
  ctx.lineTo(-16, 4);
  ctx.lineTo(2, 4);
  ctx.lineTo(2, 11);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// ---- two-stage login page: credentials → server-provided character list ----
let loginWired = false;
let characterStage = false;
let characterListKey = "";
let characterChoiceId = null;
// ---- character-creation wizard state (step 3 skills / step 4 appearance) ----
// Step 3's 4 skill rows live directly in the DOM (read via `readSkillRows()`
// inside wireLogin); `wizAppearance` holds the raw hue/style ids exactly as the
// `character` POST contract wants them (0 = "server default", sent as-is). It
// persists only for the lifetime of one open wizard — resetWizard() zeroes it
// each time the panel opens.
let wizStep = 1;
const WIZ_STEP_TITLES = ["Identity", "Stats", "Skills", "Appearance", "City & Review"];
const wizAppearance = {
  skinHue: 0, hairStyle: 0, hairHue: 0, beardStyle: 0, beardHue: 0, shirtHue: 0, pantsHue: 0,
};
let wizProfession = 0; // 0xF8 profession byte (Prof.txt Desc); 0 = Advanced
// Fallback presets if /professions.json is missing. Prof.txt is 30×4 = 120.
const WIZ_SKILL_PRESETS = {
  warrior: [[40, 50], [27, 50], [1, 0], [0, 0]],
  mage: [[25, 50], [16, 50], [1, 0], [0, 0]],
  ranger: [[31, 50], [27, 50], [1, 0], [0, 0]],
  crafter: [[7, 50], [45, 50], [1, 0], [0, 0]],
};
const WIZ_PRESET_STATS = { warrior: [45, 35, 10], mage: [25, 20, 45], ranger: [35, 40, 15], crafter: [45, 30, 15] };
const WIZ_PRESET_PROFESSION = { warrior: 1, mage: 2, ranger: 3, crafter: 4 };
function wizHueRange(start, end) {
  const hues = [];
  for (let hue = start; hue <= end; hue++) hues.push(hue);
  return hues;
}
const WIZ_SKIN_HUES = wizHueRange(1002, 1058);   // skin-tone hue band
const WIZ_HAIR_HUES = wizHueRange(1102, 1149);   // hair/beard dye band
const WIZ_CLOTH_HUES = Array.from({ length: 120 }, (_, i) => 2 + i * 8); // cloth-dye spread, sampled
// Extended ("special") hair/beard palette: the full dye sweep plus the bright
// 1150–1175 band (blaze/ice/neon special dyes). Safe to offer at creation: this
// shard's CharacterCreation copies HairHue/FacialHairHue verbatim (no
// ClipHairHue — verified in ../servuo Scripts/Misc/CharacterCreation.cs), so
// exotic dyes survive server-side exactly as previewed.
const WIZ_EXT_HUES = [...WIZ_CLOTH_HUES, ...wizHueRange(1150, 1175)];
// Fallback starting-city list for a server that hasn't been updated to send
// `scene.cities` yet (or sends an empty array) — the same two options this
// dropdown used to hardcode, so behavior against an old server is unchanged.
const DEFAULT_CITIES = [
  { index: 3, name: "Britain", building: "" },
  { index: 0, name: "New Haven", building: "" },
];
// The resolved city list currently backing #lg-city (server's `scene.cities`,
// or DEFAULT_CITIES when absent/empty) — kept around so renderCityInfo() can
// look a city up by index without re-deriving the fallback logic.
let wizCityList = DEFAULT_CITIES;
// Facet names, indexed by the server's `map` id (0–5); anything else falls
// back to "Map <n>" rather than guessing.
const FACET_NAMES = ["Felucca", "Trammel", "Ilshenar", "Malas", "Tokuno", "Ter Mur"];

function wireLogin() {
  if (loginWired) return; loginWired = true;
  if (typeof initLauncher === "function") initLauncher();
  if (typeof wireConnectionControls === "function") wireConnectionControls();
  let loginSubmissionPending = false;
  let loginSubmissionGeneration = 0;
  const go = document.getElementById("lg-go");
  let profileBlocked = false;
  window.updateLoginProfileAvailability = () => {
    const blocked = !characterStage && typeof launcherLoginBlocked === "function" && launcherLoginBlocked();
    if (blocked || loginSubmissionPending) go.disabled = true;
    // A profile operation may finish while submit still owns the button.
    // Release only our own block; character actions retain their existing state.
    else if (profileBlocked && !characterStage && !loginSubmissionPending) go.disabled = false;
    profileBlocked = blocked;
  };
  const backButton = document.getElementById("lg-back");
  const deleteButton = document.getElementById("lg-delete");
  const createToggle = document.getElementById("lg-create");
  const createPanel = document.getElementById("lg-create-panel");
  const createToggleRow = document.getElementById("lg-create-toggle");
  const slotRow = document.getElementById("lg-slot-row");
  const charListEl = document.getElementById("lg-char-list");
  // Existing characters, shown as a clickable list (click = select, double-click
  // = play). `selectedSlot` is the slot index the Play/Delete buttons act on.
  let charSlots = [];
  let selectedSlot = null;
  const renderCharList = () => {
    const choiceId = characterChoiceId;
    charListEl.replaceChildren(...charSlots.map((slot) => {
      const row = document.createElement("div");
      row.className = "char-slot-row" + (slot.index === selectedSlot ? " sel" : "");
      const name = document.createElement("span");
      name.textContent = slot.name;
      const slotn = document.createElement("span");
      slotn.className = "slotn";
      slotn.textContent = `slot ${slot.index + 1}`;
      row.append(name, slotn);
      row.addEventListener("click", () => {
        if (!characterStage || choiceId !== characterChoiceId) return;
        selectedSlot = slot.index;
        for (const el of charListEl.children) el.classList.toggle("sel", el === row);
        updateCreation();
      });
      row.addEventListener("dblclick", () => {
        if (!characterStage || choiceId !== characterChoiceId) return;
        selectedSlot = slot.index; submit();
      });
      return row;
    }));
  };
  const accountFields = document.getElementById("lg-account-fields");
  const accountSummary = document.getElementById("lg-account-summary");
  const statInputs = ["lg-str", "lg-dex", "lg-int"].map(id => document.getElementById(id));
  const genderSelect = document.getElementById("lg-gender");
  const citySelect = document.getElementById("lg-city");
  const wizMsg = document.getElementById("wiz-msg");
  const wizStepInd = document.getElementById("wiz-stepind");
  const wizBackBtn = document.getElementById("wiz-back");
  const wizNextBtn = document.getElementById("wiz-next");
  const wizSteps = [...document.querySelectorAll(".wiz-step")];
  const beardGroup = document.getElementById("wiz-beard-group");
  const hairStylesRow = document.getElementById("wiz-hair-styles");
  const beardStylesRow = document.getElementById("wiz-beard-styles");
  const skillRows = [0, 1, 2, 3].map(slot => ({
    select: document.querySelector(`.wiz-skill-id[data-slot="${slot}"]`),
    value: document.querySelector(`.wiz-skill-val[data-slot="${slot}"]`),
  }));
  // Populate the 4 skill-picker <select>s from SKILL_NAMES once (value = id).
  for (const row of skillRows) {
    row.select.replaceChildren(
      new Option("— unused —", ""),
      ...SKILL_NAMES.map((name, id) => new Option(name, String(id))),
    );
  }

  // `city_index` (sent in the `create` payload) is an index into the SERVER's
  // city list, not a fixed enum — shards order it differently (e.g. index 0 is
  // Magincia on a T2A shard, New Haven here), so the dropdown must come from
  // `scene.cities` and can never be hardcoded. Called only when
  // `updateCharacterLoginStage`'s key detects the list actually changed, so an
  // unchanged poll leaves the select (and the user's pick) untouched.
  function populateCityOptions(cities) {
    const list = (cities && cities.length) ? cities : DEFAULT_CITIES;
    wizCityList = list; // remember it so renderCityInfo() can look up the selection
    const previous = citySelect.value;
    citySelect.replaceChildren(...list.map((city) => {
      const label = city.building ? `${city.name} — ${city.building}` : city.name;
      return new Option(label, String(city.index));
    }));
    // Keep the user's existing pick if it's still in the new list; otherwise
    // prefer an entry named "Britain" (a friendlier default than index 0), else
    // just the first entry.
    if (list.some((city) => String(city.index) === previous)) {
      citySelect.value = previous;
    } else {
      const britain = list.find((city) => city.name === "Britain");
      citySelect.value = String((britain || list[0]).index);
    }
    renderCityInfo();
  }

  // Fill #lg-city-info with the selected city's location + description, the
  // same info the real UO client shows on its city-selection gump. `desc` is
  // the server's own cliloc blurb (already stripped to plain text server-side)
  // — it is inserted as TEXT via textContent, NEVER innerHTML, since it's
  // server-controlled data. Hidden entirely for legacy servers / the
  // DEFAULT_CITIES fallback, which carry no coords or desc.
  function renderCityInfo() {
    const info = document.getElementById("lg-city-info");
    const city = wizCityList.find((c) => String(c.index) === citySelect.value);
    const hasLoc = city && city.x !== undefined && city.y !== undefined;
    const hasDesc = city && !!city.desc;
    if (!city || (!hasLoc && !hasDesc)) {
      info.classList.remove("on");
      info.replaceChildren();
      return;
    }
    const parts = [];
    if (hasLoc) {
      const facet = FACET_NAMES[city.map] ?? `Map ${city.map}`;
      const loc = document.createElement("div");
      loc.className = "city-loc";
      loc.textContent = `${facet} · ${city.x}, ${city.y}, ${city.z}`;
      parts.push(loc);
    }
    if (hasDesc) {
      // Blank lines become paragraph spacing; every other line is its own div.
      for (const line of city.desc.split("\n")) {
        const div = document.createElement("div");
        div.textContent = line || " "; // NBSP keeps a blank line's height as a spacer
        parts.push(div);
      }
    }
    info.replaceChildren(...parts);
    info.classList.add("on");
  }

  let createPanelWasOn = false;
  const updateStatTotal = () => {
    const total = statInputs.reduce((sum, input) => sum + (Number(input.value) || 0), 0);
    const totalEl = document.getElementById("lg-stat-total");
    totalEl.textContent = `Total: ${total} / 90`;
    totalEl.style.color = total === 90 ? "#8896a5" : "#e5a04d";
  };
  const updateCreation = () => {
    const isOn = createToggle.checked;
    createPanel.classList.toggle("on", isOn);
    // Wizard open → widen the login box so steps lay out side-by-side (the
    // 320px column squeezed everything into one long vertical strip).
    document.querySelector(".login-box")?.classList.toggle("wiz-wide", characterStage && isOn);
    // No point showing the existing-character list while creating a new one.
    slotRow.style.display = (characterStage && !isOn && charSlots.length > 0) ? "flex" : "none";
    const canDelete = characterStage && !isOn && selectedSlot !== null;
    backButton.style.display = characterStage ? "block" : "none";
    backButton.disabled = !characterStage;
    deleteButton.style.display = canDelete ? "block" : "none";
    deleteButton.disabled = !canDelete;
    // The wizard drives its own Back/Next once it's open; the outer go-button
    // only ever means "play the selected existing slot" from here on.
    go.style.display = (characterStage && isOn) ? "none" : "block";
    if (characterStage) go.textContent = "Play";
    updateStatTotal();
    if (isOn && !createPanelWasOn) resetWizard();
    createPanelWasOn = isOn;
  };
  createToggle.addEventListener("change", updateCreation);
  for (const input of statInputs) input.addEventListener("input", updateStatTotal);
  genderSelect.addEventListener("change", () => {
    beardGroup.style.display = genderSelect.value === "female" ? "none" : "flex";
    if (wizStep === 4) { rebuildWizDoll(); rebuildStyleStrips(); } // hair gumps are gender-offset
  });
  citySelect.addEventListener("change", renderCityInfo);

  // ---- step 3: custom skill picker ----
  const readSkillRows = () => skillRows.map(row => {
    const id = row.select.value === "" ? null : Number(row.select.value);
    const value = Number(row.value.value) || 0;
    return (id === null || value <= 0) ? null : { id, value };
  });
  const updateSkillTotal = () => {
    const filled = readSkillRows().filter(Boolean);
    const total = filled.reduce((sum, s) => sum + s.value, 0);
    const el = document.getElementById("wiz-skill-total");
    el.textContent = `Total: ${total} (need 100 or 120)`;
    el.style.color = (total === 100 || total === 120) ? "#8896a5" : "#e5a04d";
  };
  for (const row of skillRows) {
    row.select.addEventListener("change", updateSkillTotal);
    row.value.addEventListener("input", updateSkillTotal);
  }
  function applyProfession(p) {
    wizProfession = p.profession | 0;
    if (p.str != null) { statInputs[0].value = p.str; statInputs[1].value = p.dex; statInputs[2].value = p.int; updateStatTotal(); }
    const skills = p.skills || [];
    skillRows.forEach((row, slot) => {
      const pick = skills[slot];
      row.select.value = pick ? String(pick.id) : "";
      row.value.value = pick ? String(pick.value) : "0";
    });
    updateSkillTotal();
  }
  function fallbackProfessions() {
    return Object.keys(WIZ_SKILL_PRESETS).map((key) => {
      const stats = WIZ_PRESET_STATS[key] || [60, 20, 10];
      return {
        name: key[0].toUpperCase() + key.slice(1),
        profession: WIZ_PRESET_PROFESSION[key] || 0,
        skills: (WIZ_SKILL_PRESETS[key] || []).filter((pair) => pair[1]).map(([id, value]) => ({ id, value })),
        str: stats[0], dex: stats[1], int: stats[2],
      };
    });
  }
  async function loadProfessions() {
    const host = document.querySelector(".wiz-presets");
    if (!host) return;
    let list = [];
    try {
      const response = await fetch("professions.json");
      if (response.ok) list = await response.json();
    } catch { /* offline — hardcoded fallback below */ }
    if (!Array.isArray(list) || !list.length) list = fallbackProfessions();
    host.replaceChildren();
    for (const p of list) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wiz-preset-btn";
      button.textContent = p.name;
      button.addEventListener("click", () => applyProfession(p));
      host.appendChild(button);
    }
  }
  loadProfessions();

  // ---- step 4: hue-swatch appearance pickers ----
  function buildHueSwatchRow(container, hues, getHue, setHue, withDefault = true) {
    container.replaceChildren();
    const makeSwatch = (hue, isDefault) => {
      const sw = document.createElement("div");
      sw.className = "wiz-hue" + (isDefault ? " wiz-hue-default" : "");
      sw.dataset.hue = String(hue);
      sw.title = isDefault ? "Server default" : ("Hue " + hue);
      if (isDefault) sw.textContent = "0";
      if (hue === getHue()) sw.classList.add("sel");
      sw.addEventListener("click", () => {
        setHue(hue);
        for (const el of container.children) el.classList.toggle("sel", el === sw);
      });
      return sw;
    };
    if (withDefault) container.appendChild(makeSwatch(0, true));
    for (const hue of hues) container.appendChild(makeSwatch(hue, false));
    applyWizHueSwatches();
  }
  // A hue picked in the natural row must unselect in the extended row (and vice
  // versa) — the pair edits the same value.
  function syncHueSel(kind) {
    const value = kind === "hair" ? wizAppearance.hairHue : wizAppearance.beardHue;
    for (const id of [`wiz-${kind}-row`, `wiz-${kind}-ext`]) {
      const container = document.getElementById(id);
      if (!container) continue;
      for (const el of container.children) {
        el.classList.toggle("sel", Number(el.dataset.hue) === value);
      }
    }
  }
  function buildAppearanceStep() {
    buildHueSwatchRow(document.getElementById("wiz-skin-row"), WIZ_SKIN_HUES,
      () => wizAppearance.skinHue, (hue) => { wizAppearance.skinHue = hue; rebuildWizDoll(); });
    const pickHair = (hue) => {
      wizAppearance.hairHue = hue; rebuildWizDoll(); rebuildStyleStrips(); syncHueSel("hair");
    };
    const pickBeard = (hue) => {
      wizAppearance.beardHue = hue; rebuildWizDoll(); rebuildStyleStrips(); syncHueSel("beard");
    };
    buildHueSwatchRow(document.getElementById("wiz-hair-row"), WIZ_HAIR_HUES,
      () => wizAppearance.hairHue, pickHair);
    buildHueSwatchRow(document.getElementById("wiz-beard-row"), WIZ_HAIR_HUES,
      () => wizAppearance.beardHue, pickBeard);
    buildHueSwatchRow(document.getElementById("wiz-hair-ext"), WIZ_EXT_HUES,
      () => wizAppearance.hairHue, pickHair, false);
    buildHueSwatchRow(document.getElementById("wiz-beard-ext"), WIZ_EXT_HUES,
      () => wizAppearance.beardHue, pickBeard, false);
    buildHueSwatchRow(document.getElementById("wiz-shirt-row"), WIZ_CLOTH_HUES,
      () => wizAppearance.shirtHue, (hue) => { wizAppearance.shirtHue = hue; rebuildWizDoll(); });
    buildHueSwatchRow(document.getElementById("wiz-pants-row"), WIZ_CLOTH_HUES,
      () => wizAppearance.pantsHue, (hue) => { wizAppearance.pantsHue = hue; rebuildWizDoll(); });
    rebuildStyleStrips();
    rebuildWizDoll();
  }

  // ---- step 4: hair/beard style strips — every style laid out as a clickable,
  // live-hued thumbnail (the user asked to SEE the options, not a combo box).
  // Thumbnails reuse the doll's iteminfo→gump chain, cropped to the head area. ----
  const WIZ_HAIR_STYLES = [[0, "None"], [8251, "Short"], [8252, "Long"], [8253, "Pony Tail"],
    [8260, "Mohawk"], [8261, "Pageboy"], [8262, "Buns"], [8263, "Afro"], [8264, "Receding"],
    [8265, "Pig Tails"], [8266, "Topknot"]];
  const WIZ_BEARD_STYLES = [[0, "None"], [8254, "Long"], [8255, "Short"], [8256, "Goatee"],
    [8257, "Moustache"], [8267, "Med Short"], [8268, "Med Long"], [8269, "Vandyke"]];
  function buildStyleStrip(container, styles, kind) {
    if (!container) return;
    const female = genderSelect.value === "female";
    const selected = kind === "hair" ? wizAppearance.hairStyle : wizAppearance.beardStyle;
    const hue = kind === "hair" ? wizAppearance.hairHue : wizAppearance.beardHue;
    container.replaceChildren();
    for (const [graphic, label] of styles) {
      const cell = document.createElement("div");
      cell.className = "wiz-style" + (graphic === selected ? " sel" : "");
      cell.title = label;
      const art = document.createElement("div");
      art.className = "wiz-style-art" + (kind === "beard" ? " beard" : "");
      if (!graphic) art.textContent = "∅";
      const lbl = document.createElement("div");
      lbl.className = "wiz-style-lbl";
      lbl.textContent = label;
      cell.append(art, lbl);
      cell.addEventListener("click", () => {
        if (kind === "hair") wizAppearance.hairStyle = graphic;
        else wizAppearance.beardStyle = graphic;
        for (const el of container.children) el.classList.toggle("sel", el === cell);
        rebuildWizDoll();
      });
      container.appendChild(cell);
      if (graphic) {
        // Fill in the art async (AnimID lookup); the cell is clickable meanwhile.
        wizItemAnim(graphic).then((anim) => {
          if (anim == null || !art.isConnected) return;
          const off = (kind === "hair" && female) ? FEMALE_GUMP_OFFSET : MALE_GUMP_OFFSET;
          const img = document.createElement("img");
          img.src = `gump/${anim + off}.png` + (hue ? `?hue=${hue}` : "");
          img.alt = "";
          img.onerror = () => img.remove();
          art.replaceChildren(img);
        });
      }
    }
  }
  function rebuildStyleStrips() {
    buildStyleStrip(hairStylesRow, WIZ_HAIR_STYLES, "hair");
    buildStyleStrip(beardStylesRow, WIZ_BEARD_STYLES, "beard");
  }
  // "Special colors ▸" reveals the extended dye palette (collapsed by default —
  // the natural band stays the primary row).
  for (const toggle of document.querySelectorAll(".wiz-ext-toggle")) {
    toggle.addEventListener("click", () => {
      const row = document.getElementById(toggle.dataset.ext);
      if (!row) return;
      const open = row.style.display === "none";
      row.style.display = open ? "flex" : "none";
      toggle.textContent = toggle.textContent.replace(open ? "▸" : "▾", open ? "▾" : "▸");
    });
  }

  // ---- step 4: live paperdoll preview (display-only — never touches the
  // `create` payload). Layers absolutely-positioned <img>s back-to-front —
  // same technique as the real paperdoll render (refreshPaperdoll, ~L5648):
  // body gump hued by skin, then hair/beard gumps hued by their own dye, each
  // with an onerror fallback that just hides that layer instead of showing a
  // broken-image icon. Hair/beard styles are graphic ids (from the <select>s
  // above); the paperdoll gump needs the item's AnimID instead, so it's looked
  // up once per graphic via the server's `iteminfo` route and memoized here. ----
  const wizItemAnimCache = new Map(); // graphic id -> anim id, or null if unknown
  async function wizItemAnim(graphic) {
    if (wizItemAnimCache.has(graphic)) return wizItemAnimCache.get(graphic);
    let anim = null;
    try {
      const response = await fetch("iteminfo/" + graphic);
      if (response.ok) {
        const data = await response.json();
        if (Number.isFinite(data.anim)) anim = data.anim;
      }
    } catch { /* offline/errored — cache the miss so we don't refetch every rebuild */ }
    wizItemAnimCache.set(graphic, anim);
    return anim;
  }
  // Monotonic sequence guards against an out-of-order async response (the
  // hair/beard `iteminfo` round-trip) overwriting a newer rebuild's result.
  let wizDollSeq = 0;
  async function rebuildWizDoll() {
    const seq = ++wizDollSeq;
    const doll = document.getElementById("wiz-doll");
    if (!doll) return;
    const female = genderSelect.value === "female";
    const hide = "this.onerror=null;this.style.display='none'";
    const layers = [];
    const skinQ = wizAppearance.skinHue ? `?hue=${wizAppearance.skinHue}` : "";
    layers.push(`<img src="gump/${female ? 13 : 12}.png${skinQ}" alt="" onerror="${hide}">`);
    // Starting clothes, worn so the shirt/pants dyes are visible on the doll —
    // the same garments ServUO spawns a new character with (Shirt 0x1517, Long
    // Pants 0x1539). Drawn pants-then-shirt, under hair/beard. Hue 0 = undyed.
    const off = female ? FEMALE_GUMP_OFFSET : MALE_GUMP_OFFSET;
    for (const [graphic, hue] of [[5433, wizAppearance.pantsHue], [5399, wizAppearance.shirtHue]]) {
      const anim = await wizItemAnim(graphic);
      if (seq !== wizDollSeq) return;
      if (anim != null) {
        const hueQ = hue ? `?hue=${hue}` : "";
        layers.push(`<img src="gump/${anim + off}.png${hueQ}" alt="" onerror="${hide}">`);
      }
    }
    if (wizAppearance.hairStyle) {
      const anim = await wizItemAnim(wizAppearance.hairStyle);
      if (seq !== wizDollSeq) return; // superseded by a newer rebuild — drop it
      if (anim != null) {
        const hueQ = wizAppearance.hairHue ? `?hue=${wizAppearance.hairHue}` : "";
        const gid = anim + (female ? FEMALE_GUMP_OFFSET : MALE_GUMP_OFFSET);
        layers.push(`<img src="gump/${gid}.png${hueQ}" alt="" onerror="${hide}">`);
      }
    }
    if (!female && wizAppearance.beardStyle) {
      const anim = await wizItemAnim(wizAppearance.beardStyle);
      if (seq !== wizDollSeq) return;
      if (anim != null) {
        const hueQ = wizAppearance.beardHue ? `?hue=${wizAppearance.beardHue}` : "";
        layers.push(`<img src="gump/${anim + MALE_GUMP_OFFSET}.png${hueQ}" alt="" onerror="${hide}">`);
      }
    }
    if (seq !== wizDollSeq) return;
    doll.innerHTML = layers.join("");
  }

  // ---- per-step validation gates (Next is blocked until these pass) ----
  const validateStep = (step) => {
    if (step === 1) {
      const name = (document.getElementById("lg-char-name").value || "").trim();
      if (!/^[A-Za-z][A-Za-z .'-]{1,15}$/.test(name) || /[ .'-]{2}/.test(name)) {
        return "Use 2–16 letters with single spaces, dashes, periods, or apostrophes.";
      }
      return null;
    }
    if (step === 2) {
      const [strength, dexterity, intelligence] = statInputs.map(input => Number(input.value));
      if ([strength, dexterity, intelligence].some(value => value < 10 || value > 60)
          || strength + dexterity + intelligence !== 90) {
        return "STR, DEX, and INT must each be 10–60 and total 90.";
      }
      return null;
    }
    if (step === 3) {
      const filled = readSkillRows().filter(Boolean);
      if (filled.some(s => s.value > 50)) return "A starting skill may not exceed 50.";
      const ids = filled.map(s => s.id);
      if (new Set(ids).size !== ids.length) return "Starting skills with a non-zero value must be unique.";
      const total = filled.reduce((sum, s) => sum + s.value, 0);
      if (total !== 100 && total !== 120) return `Skill total is ${total} — it must be exactly 100 or 120.`;
      return null;
    }
    return null; // step 4 (appearance) and step 5 (review) have no gate
  };

  // ---- step 5: read-only review ----
  function renderWizReview() {
    const name = (document.getElementById("lg-char-name").value || "").trim();
    const female = genderSelect.value === "female";
    const [strength, dexterity, intelligence] = statInputs.map(input => Number(input.value));
    const skills = readSkillRows().filter(Boolean);
    // Show the option's LABEL ("Britain — The Wayfarer's Inn"), not the raw
    // index value that's actually submitted as `city_index`.
    const cityLabel = citySelect.options[citySelect.selectedIndex]?.text || "—";
    const chip = (hue) => `<span class="wiz-review-chip" style="background:${hueHex(hue) || "#777"}"></span>`;
    const rows = [
      `<div class="wiz-review-row"><span>Name</span><span>${name || "—"}</span></div>`,
      `<div class="wiz-review-row"><span>Gender</span><span>${female ? "Female" : "Male"}</span></div>`,
      `<div class="wiz-review-row"><span>City</span><span>${cityLabel}</span></div>`,
      `<div class="wiz-review-row"><span>STR / DEX / INT</span><span>${strength} / ${dexterity} / ${intelligence}</span></div>`,
      `<div class="wiz-review-row"><span>Skills</span><span>${
        skills.length ? skills.map(s => `${skillName(s.id)} ${s.value}`).join(", ") : "none"
      }</span></div>`,
      `<div class="wiz-review-row"><span>Skin</span><span>${wizAppearance.skinHue || "default"}${chip(wizAppearance.skinHue)}</span></div>`,
      `<div class="wiz-review-row"><span>Hair</span><span>${wizAppearance.hairStyle ? "#" + wizAppearance.hairStyle : "none"}${chip(wizAppearance.hairHue)}</span></div>`,
    ];
    if (!female) {
      rows.push(`<div class="wiz-review-row"><span>Beard</span><span>${wizAppearance.beardStyle ? "#" + wizAppearance.beardStyle : "none"}${chip(wizAppearance.beardHue)}</span></div>`);
    }
    rows.push(`<div class="wiz-review-row"><span>Shirt</span><span>${chip(wizAppearance.shirtHue)}</span></div>`);
    rows.push(`<div class="wiz-review-row"><span>Pants</span><span>${chip(wizAppearance.pantsHue)}</span></div>`);
    document.getElementById("wiz-review").innerHTML = rows.join("");
  }

  // ---- step navigation ----
  function wizShowStep(step) {
    wizStep = step;
    for (const el of wizSteps) el.classList.toggle("on", Number(el.dataset.wizStep) === step);
    wizStepInd.textContent = `Step ${step} of 5 — ${WIZ_STEP_TITLES[step - 1]}`;
    wizMsg.textContent = "";
    wizBackBtn.textContent = step === 1 ? "Cancel" : "◀ Back";
    wizNextBtn.textContent = step === 5 ? "Create character" : "Next ▶";
    if (step === 4) buildAppearanceStep();
    if (step === 5) renderWizReview();
  }
  function resetWizard() {
    document.getElementById("lg-char-name").value = "";
    genderSelect.value = "male";
    beardGroup.style.display = "flex";
    statInputs[0].value = 60; statInputs[1].value = 20; statInputs[2].value = 10;
    updateStatTotal();
    for (const row of skillRows) { row.select.value = ""; row.value.value = "0"; }
    updateSkillTotal();
    wizAppearance.skinHue = 0; wizAppearance.hairStyle = 0; wizAppearance.hairHue = 0;
    wizAppearance.beardStyle = 0; wizAppearance.beardHue = 0;
    wizAppearance.shirtHue = 0; wizAppearance.pantsHue = 0;
    wizProfession = 0;
    wizShowStep(1);
  }
  wizBackBtn.addEventListener("click", () => {
    // Step 1's Back is a Cancel: un-toggle "Create" and return to the slot view,
    // as opposed to the outer #lg-back which cancels the whole character stage.
    if (wizStep === 1) { createToggle.checked = false; updateCreation(); return; }
    wizShowStep(wizStep - 1);
  });
  wizNextBtn.addEventListener("click", () => {
    if (wizStep === 5) { createCharacterFromWizard(); return; }
    const error = validateStep(wizStep);
    if (error) { wizMsg.textContent = error; return; }
    wizShowStep(wizStep + 1);
  });

  updateCreation();
  slotRow.style.display = "none";
  createToggleRow.style.display = "none";

  // POST the finished `create` object (see docs/DESIGN.md character-creation
  // contract) and surface any server rejection in #lg-msg, same as `submit()`.
  const postCharacterCreate = async (create) => {
    const choiceId = characterChoiceId;
    const msg = document.getElementById("lg-msg");
    msg.textContent = "Creating character…";
    go.disabled = true; backButton.disabled = true;
    wizNextBtn.disabled = true; wizBackBtn.disabled = true;
    if (WASM_MODE) {
      const err = wasmCreateCharacter(create);
      if (err) {
        msg.textContent = "Character creation failed: " + err;
        go.disabled = false; backButton.disabled = false;
        wizNextBtn.disabled = false; wizBackBtn.disabled = false;
      }
      return;
    }
    try {
      const response = await fetch("character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice_id: choiceId, create }),
      });
      if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    } catch (error) {
      if (choiceId !== characterChoiceId) return;
      msg.textContent = "Character creation failed: " + error.message;
      go.disabled = false; backButton.disabled = false;
      wizNextBtn.disabled = false; wizBackBtn.disabled = false;
    }
  };
  function createCharacterFromWizard() {
    const name = (document.getElementById("lg-char-name").value || "").trim();
    const female = genderSelect.value === "female";
    const [strength, dexterity, intelligence] = statInputs.map(input => Number(input.value));
    const skills = readSkillRows().filter(Boolean).map(s => ({ id: s.id, value: s.value }));
    const create = {
      name, female, strength, dexterity, intelligence,
      profession: wizProfession,
      city_index: Number(document.getElementById("lg-city").value),
      skills,
      skin_hue: wizAppearance.skinHue,
      hair_style: wizAppearance.hairStyle,
      hair_hue: wizAppearance.hairHue,
      // The wizard hides the beard block entirely for Female (step 4); enforce
      // that server-side expectation here too in case state lingers from a
      // gender flip after picking a beard.
      facial_hair_style: female ? 0 : wizAppearance.beardStyle,
      facial_hair_hue: female ? 0 : wizAppearance.beardHue,
      shirt_hue: wizAppearance.shirtHue,
      pants_hue: wizAppearance.pantsHue,
    };
    postCharacterCreate(create);
  }

  const submit = async () => {
    if (loginSubmissionPending || (typeof launcherBusy === "function" && launcherBusy())) return;
    if (!characterStage && typeof launcherLoginBlocked === "function" && launcherLoginBlocked()) return;
    const msg = document.getElementById("lg-msg");
    if (characterStage && selectedSlot === null) { msg.textContent = "Select a character."; return; }
    const choosing = characterStage, choiceId = characterChoiceId, slot = selectedSlot;
    const submission = ++loginSubmissionGeneration;
    loginSubmissionPending = true;
    go.disabled = true; backButton.disabled = true;
    try {
      const credentials = choosing ? null : typeof launcherPrepareLogin === "function" && document.getElementById("lg-server-list")
        ? await launcherPrepareLogin()
        : { host: (document.getElementById("lg-host").value || "127.0.0.1").trim(), port: Number(document.getElementById("lg-port").value || 2594), username: (document.getElementById("lg-user").value || "").trim(), password: document.getElementById("lg-pass").value || "" };
      if (credentials && !credentials.username) throw new Error("Enter an account name.");
      // Preparing a saved account may await native storage while another tab
      // advances login. Never repurpose that request into a character action.
      if (submission !== loginSubmissionGeneration || choosing !== characterStage || choiceId !== characterChoiceId) return;
      if (!choosing && !credentials) { go.disabled = false; backButton.disabled = false; go.focus(); return; }
      msg.textContent = choosing ? "Entering world…" : "Connecting…";
      if (WASM_MODE) {
        if (choosing) wasmPlaySlot(slot);
        else await wasmSubmitLogin();
        return;
      }
      const endpoint = choosing ? "character" : "login";
      const body = choosing ? { choice_id: choiceId, slot } : { ...credentials, interactive: true, character_slot: null, create: null };
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Anima-Launcher": "1" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    } catch (error) {
      if (submission !== loginSubmissionGeneration || choiceId !== characterChoiceId || choosing !== characterStage) return;
      msg.textContent = "Login request failed: " + error.message;
      go.disabled = false; backButton.disabled = false;
    } finally {
      if (submission === loginSubmissionGeneration) loginSubmissionPending = false;
      updateLoginProfileAvailability();
    }
  };
  go.addEventListener("click", submit);
  backButton.addEventListener("click", async () => {
    if (!characterStage) return;
    const choiceId = characterChoiceId;
    const msg = document.getElementById("lg-msg");
    msg.textContent = "Returning to account login…";
    go.disabled = true;
    backButton.disabled = true;
    deleteButton.disabled = true;
    if (WASM_MODE) {
      wasmDisconnect();
      window.updateCharacterLoginStage(false);
      msg.textContent = "";
      go.disabled = false;
      backButton.disabled = true;
      deleteButton.disabled = true;
      return;
    }
    try {
      const response = await fetch("character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice_id: choiceId, cancel: true }),
      });
      if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    } catch (error) {
      if (choiceId !== characterChoiceId) return;
      msg.textContent = "Cancel request failed: " + error.message;
      go.disabled = false;
      backButton.disabled = false;
      deleteButton.disabled = false;
    }
  });
  deleteButton.addEventListener("click", async () => {
    const slot = charSlots.find((s) => s.index === selectedSlot);
    if (!characterStage || !slot) return;
    const choiceId = characterChoiceId;
    const name = slot.name;
    if (!window.confirm(`Permanently delete ${name}? This cannot be undone.`)) return;
    if (!characterStage || choiceId !== characterChoiceId) return;
    const msg = document.getElementById("lg-msg");
    msg.textContent = `Deleting ${name}…`;
    go.disabled = true;
    backButton.disabled = true;
    deleteButton.disabled = true;
    if (WASM_MODE) {
      if (!wasmDeleteSlot(slot.index)) {
        msg.textContent = "Delete request failed";
        go.disabled = false;
        backButton.disabled = false;
        deleteButton.disabled = false;
      }
      return;
    }
    try {
      const response = await fetch("character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice_id: choiceId, delete_slot: slot.index }),
      });
      if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    } catch (error) {
      if (choiceId !== characterChoiceId) return;
      msg.textContent = "Delete request failed: " + error.message;
      go.disabled = false;
      backButton.disabled = false;
      deleteButton.disabled = false;
    }
  });
  // Enter on a native select confirms its option; on a file input it opens the
  // picker. Neither is an instruction to connect (or advance character creation).
  for (const input of document.querySelectorAll("#login input")) {
    if (!["text", "password", "number"].includes(input.getAttribute("type") || "text")) continue;
    input.addEventListener("keydown", (e) => {
      if (e.code !== "Enter" || e.isComposing || e.repeat) return;
      e.preventDefault();
      // While the wizard is open, Enter advances it instead of submitting the
      // outer form (which no longer has a `create` path of its own).
      if (characterStage && createToggle.checked) { e.preventDefault(); wizNextBtn.click(); }
      else submit();
    });
  }

  window.updateCharacterLoginStage = (active, slots = [], capacity = 0, cities = [], choiceId = null) => {
    const changedPrompt = characterChoiceId !== choiceId;
    if (changedPrompt || characterStage !== active) {
      loginSubmissionGeneration++;
      loginSubmissionPending = false;
    }
    characterChoiceId = active ? choiceId : null;
    characterStage = active;
    // The server/account you already logged into is no longer relevant once
    // you're picking/creating a character — hide those fields (rather than
    // just disabling them) and, in their place, show a small read-only
    // reminder of what you're connected as. Values are left untouched.
    accountFields.style.display = active ? "none" : "flex";
    if (accountSummary) {
      const host = document.getElementById("lg-host").value;
      const port = document.getElementById("lg-port").value;
      const user = document.getElementById("lg-user").value;
      accountSummary.textContent = active ? `Account ${user} · ${host}:${port}` : "";
      accountSummary.style.display = active ? "block" : "none";
    }
    createToggleRow.style.display = active ? "flex" : "none";
    if (!active) {
      characterListKey = "";
      charSlots = [];
      selectedSlot = null;
      createToggle.checked = false;
      go.textContent = "Connect";
      updateCreation(); // also hides #lg-slot-row (characterStage is false)
      return;
    }
    const key = JSON.stringify([choiceId, slots, capacity, cities]);
    if (key !== characterListKey) {
      characterListKey = key;
      charSlots = slots;
      if (changedPrompt) {
        selectedSlot = null;
        createPanelWasOn = false;
        wizNextBtn.disabled = false; wizBackBtn.disabled = false;
        resetWizard();
      }
      // Keep the selection if that slot still exists; else default to the first.
      if (!charSlots.some((s) => s.index === selectedSlot)) {
        selectedSlot = charSlots.length ? charSlots[0].index : null;
      }
      renderCharList();
      populateCityOptions(cities);
      const full = slots.length >= capacity;
      createToggle.disabled = full;
      createToggle.checked = slots.length === 0 && !full;
    }
    updateCreation(); // sets go.textContent ("Play") and opens the wizard if just toggled on
  };
}
// Form controls own their keyboard input: typing, button activation and Tab
// navigation must not also walk, attack or toggle war mode. Keyup still clears
// movement latches even when focus has moved into a control.
function isTypingTarget(el) {
  if (!el) return false;
  const t = el.tagName;
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || t === "BUTTON" || el.isContentEditable;
}
// Failed attempts belong to the endpoint/account actually submitted. A later
// server selection must not inherit the old error on every scene poll. Older
// backends and global startup failures have no target and remain visible.
function loginErrorMatchesForm(target) {
  if (!target) return true;
  if (typeof target.username !== "string" || (Object.hasOwn(target, "relay")
    ? typeof target.relay !== "string" : typeof target.host !== "string")) return true;
  const value = id => document.getElementById(id)?.value || "";
  if (target.username !== value("lg-user").trim()) return false;
  if (Object.hasOwn(target, "relay")) return target.relay === (typeof wasmRelayUrl === "function" ? wasmRelayUrl() : value("lg-relay").trim());
  return target.host.toLowerCase() === value("lg-host").trim().toLowerCase()
    && target.port === Number(value("lg-port")) && target.shard === Number(value("lg-shard"));
}
function showLogin(auth, msg, slots, capacity, cities, error, connection) {
  wireLogin();
  if (typeof launcherOnAuth === "function") launcherOnAuth(auth, slots);
  if (typeof updateLoginConnection === "function") updateLoginConnection(auth, connection);
  const el = document.getElementById("login");
  if (el) el.classList.add("on");
  const m = document.getElementById("lg-msg");
  const go = document.getElementById("lg-go");
  if (auth === "characters") {
    window.updateCharacterLoginStage(true, slots || [], capacity || 0, cities || [], connection?.choice_id ?? null);
    // `error` is set only when the server just rejected a delete (e.g.
    // ServUO's 7-day too-young-to-delete window) — the session stayed up and
    // re-showed this same list, so surface the reason here instead of the
    // usual instructions. #lg-msg is already styled as a warning (amber).
    if (m) m.textContent = error || "Choose a character or create one in an empty slot.";
    if (go) go.disabled = false;
  } else if (auth === "connecting") {
    if (m) m.textContent = msg || "Connecting…";
    if (go) go.disabled = true;
  } else if (auth === "error") {
    window.updateCharacterLoginStage(false);
    if (m) m.textContent = loginErrorMatchesForm(connection?.login_target) ? "Login failed: " + (msg || "unknown error") : "";
    if (go) go.disabled = false;
  } else {
    window.updateCharacterLoginStage(false);
    if (m) m.textContent = msg || "";
    if (go) go.disabled = false;
  }
  updateLoginProfileAvailability();
}
function hideLogin() {
  const el = document.getElementById("login");
  if (el && el.classList.contains("on")) el.classList.remove("on");
}
