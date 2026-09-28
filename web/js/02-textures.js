// ---- texture + frame-count caches ----
// Hue is part of the URL: visiting more towns and dyes grows both the decoded
// image and GPU working sets. Count AND estimated RGBA bytes govern retention.
// These are soft budgets: never destroy a live sprite's texture to meet them.
const texCache = new Map(), texLastUsed = new Map(), loading = new Set();
const texSizes = new Map(), texUnloading = new Set(), texQueue = new Map(), texFailures = new Map();
const TEX_BUDGET = 1500, TEX_BYTES = 256 * 1024 * 1024;
const TEX_IDLE_MS = 1000; // let new arrivals reach the next scene poll before eviction
const TEX_SWEEP_MS = 1000;
const TEX_LOADS = 16, TEX_QUEUE = 512, TEX_QUEUE_IDLE_MS = 2000;
let texBytes = 0, lastTexSweep = -Infinity;
function touchTex(url) {
  // Animation prefetch lists include URLs not loaded yet; they must not create
  // phantom LRU entries that later count as evicted resources.
  if (texCache.has(url)) texLastUsed.set(url, performance.now());
}
function textureBytes(t) {
  const s = t.source;
  // Bundled Pixi TextureSource stores physical (resolution-adjusted) pixels.
  // This estimates one RGBA surface, not whole-process RAM or driver overhead.
  return Math.max(1, s?.pixelWidth || t.width || 1) * Math.max(1, s?.pixelHeight || t.height || 1) * 4;
}
function texFor(url) {
  if (!url) return null;
  if (texCache.has(url)) { touchTex(url); return texCache.get(url); }
  // Assets.unload awaits the loader's promise before destroying its texture.
  // A concurrent load can otherwise obtain that very same, doomed object.
  if (texUnloading.has(url) || loading.has(url)) return null;
  const failure = texFailures.get(url);
  if (failure && performance.now() < failure.until) return null;
  if (texQueue.has(url) || texQueue.size < TEX_QUEUE) texQueue.set(url, performance.now());
  pumpTextures();
  return null;
}
function textureFailed(url) {
  const delay = Math.min(60_000, (texFailures.get(url)?.delay || 1000) * 2);
  texFailures.delete(url);
  texFailures.set(url, { delay, until: performance.now() + delay });
  while (texFailures.size > TEX_QUEUE) texFailures.delete(texFailures.keys().next().value);
}
function pumpTextures() {
  // Bound actual SDK work, including decode. Do not pretend an uncancellable
  // Pixi promise has stopped merely because a logical deadline has elapsed.
  while (loading.size < TEX_LOADS && texQueue.size) {
    const [url, last] = texQueue.entries().next().value;
    texQueue.delete(url);
    if (performance.now() - last > TEX_QUEUE_IDLE_MS) continue;
    loading.add(url);
    void loadTexture(url);
  }
}
async function loadTexture(url) {
  let t;
  try {
    t = await PIXI.Assets.load(url);
    if (!t || t.destroyed || t.source?.destroyed) throw new Error("Unavailable texture");
  } catch {
    // Pixi removes rejected loader promises itself. An error is retryable; it
    // is not evidence that this art is permanently absent from the resource set.
    textureFailed(url);
  } finally {
    loading.delete(url);
  }
  if (t && !t.destroyed && !t.source?.destroyed) {
    const size = textureBytes(t);
    texCache.set(url, t); texSizes.set(url, size); texBytes += size;
    texFailures.delete(url); touchTex(url);
  }
  pumpTextures();
  // Keep rendering errors outside the load catch: they must not poison the URL.
  markDirty();
  sweepTexCache();
}
// Preserve the hysteresis-ring terrain, animated statics' prefetched frames,
// shadows/slices sharing their parents' sources, and mobile last-good parts.
// An on-stage reference wins over age and budget, even when touch bookkeeping
// missed it. Destroying one freezes Pixi's render path (null alphaMode).
function sweepTexCache() {
  trimLightShapes();
  if (texCache.size <= TEX_BUDGET && texBytes <= TEX_BYTES) return;
  const now = performance.now();
  if (now - lastTexSweep < TEX_SWEEP_MS) return;
  lastTexSweep = now;
  const live = new Set();
  if (REPLAY_MODE) for (const url of replayEffectTextures) live.add(url);
  forEachLiveTexUrl((u) => { if (u) live.add(u); });
  // URL pools cannot describe every on-stage owner: corpse clothing, stationary
  // house previews and an effect's last-good frame are examples. Inspect the
  // actual tree too, comparing SOURCE identity so derived meshes/slices count.
  const sources = new Set(), nodes = [app?.stage || world];
  while (nodes.length) {
    const node = nodes.pop();
    if (!node) continue;
    if (node.texture?.source) sources.add(node.texture.source);
    if (node.children) for (const child of node.children) nodes.push(child);
  }
  const stale = [];
  for (const [url, last] of texLastUsed) {
    if (!live.has(url) && !sources.has(texCache.get(url)?.source) && now - last >= TEX_IDLE_MS) stale.push([url, last]);
  }
  stale.sort((a, b) => a[1] - b[1]);
  for (const [url] of stale) {
    if (texCache.size <= TEX_BUDGET && texBytes <= TEX_BYTES) break;
    texBytes -= texSizes.get(url) || 0; texSizes.delete(url);
    texCache.delete(url); texLastUsed.delete(url);
    discardAlphaMask(url);
    texUnloading.add(url);
    void unloadTexture(url);
  }
}
async function unloadTexture(url) {
  try { await PIXI.Assets.unload(url); }
  catch { textureFailed(url); }
  finally { texUnloading.delete(url); }
  markDirty();
}

// ---- per-pixel hit-testing for interactive world sprites ----
// PIXI hit-tests a sprite by its rectangular bounds by default. UO art is mostly
// transparent (isometric tiles, thin signposts/hangers, foreshortened mobile
// frames), so a fully-transparent part of one sprite can steal a click from
// whatever is actually visible underneath it — measured live, a house sign
// (graphic 0x0BD2) sits UNDER its own hanger (graphic 0x0B98) at the identical
// zIndex, and the hanger's rectangular bounds fully CONTAIN the sign's;
// double-clicking the visible sign body hit the hanger instead (which has no
// double-click behaviour, so nothing happened). ClassicUO hit-tests per PIXEL
// (the art's actual opaque pixels), which is why this works there — so we do
// the same, via a custom `hitArea` per sprite.
//
// The mask is built once per texture URL — not per sprite, not per frame — and
// shared by every sprite currently showing that art. Masks follow the texture's
// lifetime, so leaving a town releases its click data too. A failed mask falls
// back to bounds and can be retried after a cooldown.
const alphaMaskCache = new Map();   // url -> {w, h, bits:Uint8Array} | null
const alphaMaskPending = new Map(); // url -> active fallback image + deadline
const alphaMaskFailures = new Map();
function discardAlphaMask(url) {
  alphaMaskCache.delete(url); alphaMaskFailures.delete(url);
  const pending = alphaMaskPending.get(url);
  if (!pending) return;
  alphaMaskPending.delete(url); clearTimeout(pending.timer);
  pending.img.onload = pending.img.onerror = null;
  pending.img.src = "";
}
function alphaMaskFailed(url) {
  alphaMaskCache.set(url, null);
  alphaMaskFailures.set(url, performance.now() + 30_000);
}
function requestAlphaMask(url) {
  if (!texCache.has(url) || alphaMaskPending.has(url)) return;
  if (alphaMaskCache.get(url) || performance.now() < (alphaMaskFailures.get(url) || 0)) return;
  // Prefer the image PIXI's own loader already decoded for this exact texture
  // (texture.source.resource — an HTMLImageElement or ImageBitmap depending on
  // which loader parser handled it) over fetching it again: this url is almost
  // always already in texCache by the time a sprite using it is clickable, so
  // this skips a redundant network round trip entirely. Only falls back to a
  // fresh Image() when that resource isn't reachable (texture not cached yet,
  // or a resource type drawImage() can't use) — the art is served same-origin
  // by our own play server, and PIXI.Assets.load(url) likely already fetched
  // this exact URL, so the browser's HTTP cache makes even that nearly free.
  const cachedTex = texCache.get(url);
  const resource = cachedTex && cachedTex.source && cachedTex.source.resource;
  const reusable = resource && (
    (typeof HTMLImageElement !== "undefined" && resource instanceof HTMLImageElement) ||
    (typeof ImageBitmap !== "undefined" && resource instanceof ImageBitmap) ||
    (typeof HTMLCanvasElement !== "undefined" && resource instanceof HTMLCanvasElement)
  );
  if (reusable) { rasterizeAlphaMask(url, resource); return; }
  if (alphaMaskPending.size >= TEX_LOADS) return;
  const img = new Image();
  const pending = { img, timer: null };
  alphaMaskPending.set(url, pending);
  const finish = (success) => {
    if (alphaMaskPending.get(url) !== pending) return;
    clearTimeout(pending.timer); alphaMaskPending.delete(url);
    img.onload = img.onerror = null;
    if (!texCache.has(url)) return;
    if (success) rasterizeAlphaMask(url, img);
    else { alphaMaskFailed(url); img.src = ""; }
  };
  img.onload = () => finish(true);
  img.onerror = () => finish(false);
  pending.timer = setTimeout(() => finish(false), 5000);
  img.src = url;
}
// Shared by both sources above (a reused texture resource, or a freshly loaded
// Image): draw into an offscreen canvas, read back alpha, store one byte per
// pixel (>8 alpha ~= opaque enough to count as "hit"). A mask uses one quarter
// of its texture's estimated RGBA bytes and is discarded with that texture.
function rasterizeAlphaMask(url, img) {
  if (!texCache.has(url)) return;
  try {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error("empty image");
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data; // same-origin → never taints the canvas
    const bits = new Uint8Array(w * h);
    for (let p = 0, i = 3; p < bits.length; p++, i += 4) bits[p] = data[i] > 8 ? 1 : 0;
    alphaMaskCache.set(url, { w, h, bits });
    alphaMaskFailures.delete(url);
  } catch { alphaMaskFailed(url); }
}
// Plain-rectangle test — PIXI's own default Sprite.containsPoint formula —
// used as the fallback whenever a mask isn't ready (still loading) or isn't
// available (failed to load): identical to today's bounds-based hit-testing.
function boundsContains(sp, x, y) {
  const w = sp.width, h = sp.height;
  const x0 = -w * sp.anchor.x, y0 = -h * sp.anchor.y;
  return x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h;
}
// A custom hitArea object — PIXI calls `.contains(x, y)` with LOCAL coordinates
// (already anchor-relative, the same space Sprite.containsPoint uses), so a
// point is converted to texture-pixel space via the sprite's own anchor before
// consulting the mask. `getUrl()` is read at CLICK time, not baked in at
// attach time: mobile part sprites are persistent and swap textures frame to
// frame (see drawMobs' `part()`/st.partTex), so the mask must track whatever
// art is currently shown, not whatever was showing when the hitArea was set.
function pixelHitArea(sp, getUrl) {
  // Warm the mask NOW, at attach time, instead of waiting for the first click to
  // discover it's missing: a mask that isn't ready falls back to bounds, so
  // without this the FIRST click on any sprite is still the old rectangle
  // behaviour (measured: the first click on the house sign went to a different
  // overlapping item; the second, once the mask had loaded, hit the sign).
  const first = getUrl();
  if (first) requestAlphaMask(first);
  return {
    contains(x, y) {
      const url = getUrl();
      if (!url) return boundsContains(sp, x, y);
      const mask = alphaMaskCache.get(url);
      if (mask == null) { requestAlphaMask(url); return boundsContains(sp, x, y); }
      const w = sp.width, h = sp.height;
      if (!w || !h) return false;
      // A depth-sliced mobile part is only a horizontal strip of the frame
      // (`_sliceY`/`_sliceH`); map local y into that strip of the full mask.
      const srcH = sp._sliceH || mask.h;
      const srcY = sp._sliceY || 0;
      const px = Math.floor((x + sp.anchor.x * w) / w * mask.w);
      const py = Math.floor((y + sp.anchor.y * h) / h * srcH) + srcY;
      if (px < 0 || px >= mask.w || py < 0 || py >= mask.h) return false; // outside the texture rect
      return mask.bits[py * mask.w + px] !== 0;
    },
  };
}

const frameCount = new Map();
const animInfoPending = new Map(), animInfoLoads = new Set(), animInfoFailures = new Map();
const ANIM_INFO_ENTRIES = 4096, ANIM_INFO_CENTERS = 65536, ANIM_INFO_BODY_BYTES = 1024 * 1024;
let frameCenterCount = 0;
function touchFrameInfo(k) {
  if (!frameCount.has(k)) return;
  const n = frameCount.get(k);
  frameCount.delete(k); frameCount.set(k, n);
}
function cacheFrameInfo(k, j) {
  // Counts and draw centers form one record: evict together. Missing animation
  // records (frames:0) cost no centers but still count toward the entry limit.
  while (frameCount.size >= ANIM_INFO_ENTRIES || frameCenterCount + j.c.length > ANIM_INFO_CENTERS) {
    const oldest = frameCount.keys().next().value;
    frameCenterCount -= frameCtr.get(oldest)?.length || 0;
    frameCount.delete(oldest); frameCtr.delete(oldest);
  }
  frameCount.set(k, j.frames); frameCtr.set(k, j.c); frameCenterCount += j.c.length;
}
async function readFrameInfo(response) {
  if (!response.ok) throw new Error("Animation information unavailable");
  if (Number(response.headers?.get("Content-Length")) > ANIM_INFO_BODY_BYTES) throw new Error("Animation information too large");
  let text = "";
  if (response.body?.getReader) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > ANIM_INFO_BODY_BYTES) { void reader.cancel().catch(() => {}); throw new Error("Animation information too large"); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
  } else {
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > ANIM_INFO_BODY_BYTES) throw new Error("Animation information too large");
  }
  const j = JSON.parse(text);
  if (!j || !Number.isInteger(j.frames) || j.frames < 0 || j.frames > ANIM_INFO_CENTERS ||
      !Array.isArray(j.c) || j.c.length !== j.frames ||
      !j.c.every(c => Array.isArray(c) && c.length === 2 && c.every(n => Number.isInteger(n) && Math.abs(n) <= 65536))) {
    throw new Error("Invalid animation information");
  }
  return j;
}
function framesFor(body, group, dir) {
  const k = `${body}/${group}/${dir}`;
  if (frameCount.has(k)) { touchFrameInfo(k); return Math.max(1, frameCount.get(k)); }
  if (animInfoPending.has(k) || animInfoLoads.size >= 8 || performance.now() < (animInfoFailures.get(k) || 0)) return 5;
  const controller = new AbortController(), request = { done: false, deadline: performance.now() + 5000 };
  animInfoPending.set(k, request); animInfoLoads.add(request);
  const finish = j => {
    if (request.done) return;
    request.done = true; clearTimeout(timer);
    if (animInfoPending.get(k) === request) animInfoPending.delete(k);
    if (j) { cacheFrameInfo(k, j); animInfoFailures.delete(k); }
    else {
      controller.abort();
      animInfoFailures.delete(k); animInfoFailures.set(k, performance.now() + 2000);
      while (animInfoFailures.size > TEX_QUEUE) animInfoFailures.delete(animInfoFailures.keys().next().value);
    }
    markDirty();
  };
  const expired = () => request.done || performance.now() >= request.deadline;
  const timer = setTimeout(() => finish(null), 5000);
  void (async () => {
    let result = null;
    try {
      const response = await fetch(`animinfo/${k}`, { signal: controller.signal });
      if (!expired()) result = await readFrameInfo(response);
    } catch { /* A transport/JSON error is not a confirmed zero-frame animation. */ }
    finally { animInfoLoads.delete(request); }
    finish(expired() ? null : result);
  })();
  return 5;
}
// Per-frame draw-center [cx, cy] (from animinfo). The renderer positions a part's
// sprite at (screenX - cx, screenY - height - cy) — ClassicUO's draw math — so the
// body, worn equipment, held items and a rider on a mount all align instead of
// being foot-anchored at the same point. null until the animinfo load lands.
const frameCtr = new Map(); // "body/group/dir" -> [[cx,cy],...]
function centerFor(body, group, dir, frame) {
  const k = `${body}/${group}/${dir}`;
  touchFrameInfo(k);
  const c = frameCtr.get(k);
  return c && c[frame] ? c[frame] : null;
}


// ---- light.mul shapes (ClassicUO LightsLoader) ------------------------------
// Each light-emitting graphic names one of ~100 hand-drawn masks through its
// tiledata Quality byte; the server decodes light.mul and serves them as white
// PNGs whose alpha is the intensity (see anima-assets `lights.rs`). Fetched as
// plain <img> rather than through the PIXI texture cache: the night overlay is a
// 2D canvas, not a PIXI layer. Colour variants are cached separately.
// Keyed by "<id>/<colour>": a coloured light is the same mask with ClassicUO's
// intensity ramp for that colour baked into the RGB, which the server does
// (anima-assets `light_colored`) because it owns the curve tables.
const lightShapes = new Map();
const LIGHT_SHAPE_LIMIT = 256, LIGHT_SHAPE_BYTES = 16 * 1024 * 1024, LIGHT_SHAPE_LOADS = 8;
let lightShapeBytes = 0, lightShapeLoads = 0;
function trimLightShapes(reserve = 0) {
  const now = performance.now();
  // Calls touch entries in draw order. Keep this frame's masks alive for the
  // later additive pass, and give newly decoded shapes a frame to be used.
  for (const [key, entry] of lightShapes) {
    if (lightShapes.size + reserve <= LIGHT_SHAPE_LIMIT && lightShapeBytes <= LIGHT_SHAPE_BYTES) break;
    if (entry.loading || now - entry.at < 1000) continue;
    lightShapes.delete(key); lightShapeBytes -= entry.bytes;
    entry.img?.removeAttribute("src");
  }
}
function lightShape(id, color) {
  if (id == null) return null;
  color = color == null ? 0 : color;
  if (!Number.isInteger(id) || id < 0 || id >= 100 || !Number.isInteger(color) || color < 0 || color > 65535) return null;
  const now = performance.now(), key = `${id}/${color}`;
  let entry = lightShapes.get(key);
  if (entry) {
    entry.at = now; lightShapes.delete(key); lightShapes.set(key, entry);
    trimLightShapes();
    if (entry.loading) return null;
    if (entry.img) return entry.img;
    if (now < entry.retryAt) return null;
  }
  if (lightShapeLoads >= LIGHT_SHAPE_LOADS) return null;
  if (!entry) {
    trimLightShapes(1);
    if (lightShapes.size >= LIGHT_SHAPE_LIMIT) return null;
    entry = { img: null, bytes: 0, at: now, retryAt: 0, failures: 0, loading: false };
    lightShapes.set(key, entry);
  }
  const img = new Image();
  entry.img = img; entry.loading = true; lightShapeLoads++;
  let timer;
  const finish = success => {
    if (!entry.loading || entry.img !== img) return;
    clearTimeout(timer); img.onload = null; img.onerror = null;
    entry.loading = false; lightShapeLoads--;
    const bytes = img.naturalWidth * img.naturalHeight * 4;
    if (success && Number.isFinite(bytes) && bytes > 0 && bytes <= LIGHT_SHAPE_BYTES) {
      entry.bytes = bytes; lightShapeBytes += bytes; entry.failures = 0; entry.at = performance.now();
    } else {
      entry.img = null; img.removeAttribute("src");
      entry.failures++; entry.retryAt = performance.now() + Math.min(60000, 2000 * 2 ** Math.min(entry.failures - 1, 5));
    }
    trimLightShapes();
  };
  img.onload = () => finish(true); img.onerror = () => finish(false);
  timer = setTimeout(() => finish(false), 5000);
  img.src = `light/${id}.png` + (color ? `?c=${color}` : "");
  return null;
}
