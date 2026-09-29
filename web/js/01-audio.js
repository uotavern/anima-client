// ---- audio: sound effects (0x54) + background music (0x6D) ----
// Browsers block autoplay until the first user gesture, so sounds/music only
// start after the player first clicks or presses a key — that's expected.
let audioMuted = false;          // global master mute (N key / on-screen button)
let lastSoundSeq = 0;            // highest sound event seq we've already played
let curMusicId = null;           // music id currently loaded into bgMusic
const MAX_CONCURRENT_SFX = 8;
const bgMusic = new Audio();     // single looping background track (HTMLAudio is fine for a long loop)
bgMusic.loop = true;
bgMusic.volume = settings.musicVol;

// SFX use the Web Audio API instead of a fresh `new Audio(url)` per hit. The old
// path re-fetched AND re-decoded the WAV every single time before it could start —
// the main cause of "late" sound. Decoded buffers are reused while in a bounded
// LRU cache; active sources retain their own buffers even after cache eviction.
let audioCtx = null, sfxGain = null;
const sfxBuffers = new Map();    // id -> ready AudioBuffer, oldest use first
const SFX_CACHE_BYTES = 128 * 1024 * 1024, SFX_CACHE_ENTRIES = 512;
const SFX_MAX_WAV_BYTES = 32 * 1024 * 1024; // stock beatFast.wav is ~21 MB
const SFX_MAX_LOADS = 4, SFX_LOAD_TIMEOUT_MS = 5000, SFX_PLAY_DEADLINE_MS = 1000;
let sfxBufferBytes = 0;
const sfxPending = new Map(), sfxLoads = new Set(), sfxFailures = new Map();
const activeSfx = new Set();     // live BufferSource nodes (concurrency cap + mute-stop)
let sfxPlaybackGeneration = 0;
function stopSoundEffects() {
  // Invalidate delayed fetch/decode callbacks too. Unmuting or reconnecting
  // must not replay effects requested before this stop.
  sfxPlaybackGeneration++;
  for (const src of activeSfx) { try { src.stop(); } catch (_) {} }
  activeSfx.clear();
}
function soundPlaybackAllowed() {
  return !audioMuted && settings.sfx && (REPLAY_MODE || (
    !(typeof sceneReloading !== "undefined" && sceneReloading) &&
    !(typeof sceneTransportAvailable !== "undefined" && !sceneTransportAvailable)));
}
function ensureAudioCtx() {
  if (audioCtx) return audioCtx;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sfxGain = audioCtx.createGain();
    sfxGain.gain.value = settings.sfxVol;
    sfxGain.connect(audioCtx.destination);
  } catch (_) { audioCtx = null; }
  return audioCtx;
}
// Browsers start the context "suspended" until a user gesture — resume it (and kick
// pending music) on the first click/keypress. Idempotent, so it can fire repeatedly.
function unlockAudio() {
  const ctx = ensureAudioCtx();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  if (!audioMuted && settings.music && curMusicId != null) bgMusic.play().catch(() => {});
}
window.addEventListener("pointerdown", unlockAudio);
window.addEventListener("keydown", unlockAudio);
function cachedSfx(id) {
  const buffer = sfxBuffers.get(id);
  if (buffer) { sfxBuffers.delete(id); sfxBuffers.set(id, buffer); }
  return buffer;
}
function sfxBytes(buffer) { return buffer.length * buffer.numberOfChannels * 4; }
function cacheSfx(id, buffer) {
  const bytes = sfxBytes(buffer);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > SFX_CACHE_BYTES) return;
  const old = sfxBuffers.get(id);
  if (old) { sfxBufferBytes -= sfxBytes(old); sfxBuffers.delete(id); }
  while (sfxBuffers.size >= SFX_CACHE_ENTRIES || sfxBufferBytes + bytes > SFX_CACHE_BYTES) {
    const oldest = sfxBuffers.keys().next().value;
    sfxBufferBytes -= sfxBytes(sfxBuffers.get(oldest)); sfxBuffers.delete(oldest);
  }
  sfxBuffers.set(id, buffer); sfxBufferBytes += bytes;
}
// Bound the body before handing it to Web Audio, including servers without a
// Content-Length. The arrayBuffer fallback is for engines without body streams.
async function readSoundBytes(response) {
  const declared = Number(response.headers?.get("Content-Length"));
  if (Number.isFinite(declared) && declared > SFX_MAX_WAV_BYTES) throw new Error("Sound is too large");
  if (!response.body?.getReader) {
    const data = await response.arrayBuffer();
    if (data.byteLength > SFX_MAX_WAV_BYTES) throw new Error("Sound is too large");
    return data;
  }
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > SFX_MAX_WAV_BYTES) {
        await reader.cancel(); throw new Error("Sound is too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data.buffer;
}
// Coalesce one ID, cap physical fetch/decode work, and settle callers by a
// deadline. Web Audio decode cannot be aborted: timed-out decoders keep their
// work slot until they actually finish, so repeated timeouts cannot pile up.
function loadSfx(id) {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff) return Promise.resolve(null);
  const c = cachedSfx(id);
  if (c) return Promise.resolve(c);
  const pending = sfxPending.get(id);
  if (pending) return pending.promise;
  const now = performance.now();
  if ((sfxFailures.get(id) || 0) > now || sfxLoads.size >= SFX_MAX_LOADS) return Promise.resolve(null);
  sfxFailures.delete(id);
  const ctx = ensureAudioCtx();
  if (!ctx) return Promise.resolve(null);
  const controller = new AbortController();
  const request = { done: false, deadline: now + SFX_LOAD_TIMEOUT_MS, promise: null };
  let resolve, timer, retryMs = 1000;
  request.promise = new Promise(done => { resolve = done; });
  sfxPending.set(id, request); sfxLoads.add(request);
  const finish = (buffer) => {
    if (request.done) return;
    request.done = true; clearTimeout(timer);
    if (sfxPending.get(id) === request) sfxPending.delete(id);
    if (buffer) cacheSfx(id, buffer);
    else {
      controller.abort();
      sfxFailures.delete(id); sfxFailures.set(id, performance.now() + retryMs);
      while (sfxFailures.size > 128) sfxFailures.delete(sfxFailures.keys().next().value);
    }
    resolve(buffer);
  };
  const expired = () => request.done || performance.now() >= request.deadline;
  timer = setTimeout(() => finish(null), SFX_LOAD_TIMEOUT_MS);
  (async () => {
    try {
      const response = await fetch("sound/" + id + ".wav", { signal: controller.signal });
      if (expired()) { finish(null); return; }
      if (!response.ok) { retryMs = response.status === 404 ? 60000 : 1000; finish(null); return; }
      const data = await readSoundBytes(response);
      if (expired()) { finish(null); return; }
      const buffer = await ctx.decodeAudioData(data);
      finish(expired() ? null : buffer);
    } catch (_) { finish(null); }
    finally { sfxLoads.delete(request); }
  })();
  return request.promise;
}
// Max tile distance a sound carries; at/over this it's silent (ClassicUO-like).
const SFX_MAX_DIST = 22;
const SFX_PAN_RANGE = 16;   // iso screen-x spread that maps to a hard L/R pan
// Play a decoded buffer, attenuated + panned by the sound's world position (x,y).
// A sound at (0,0) or with no player is treated as non-positional (center, full).
function playBuffer(b, x, y) {
  if (!soundPlaybackAllowed() || !audioCtx || !b || activeSfx.size >= MAX_CONCURRENT_SFX) return;
  const p = scene && scene.player;
  let vol = 1, pan = 0;
  const positional = !!(p && (x || y));
  if (positional) {
    const dx = (x | 0) - (p.x | 0), dy = (y | 0) - (p.y | 0);
    const dist = Math.max(Math.abs(dx), Math.abs(dy));       // chebyshev tiles
    vol = 1 - dist / SFX_MAX_DIST;
    if (vol <= 0.02) return;                                  // out of earshot
    vol = vol * vol;                                          // perceptual falloff
    // iso screen-x ∝ (dx − dy): left of the avatar pans left, right pans right.
    pan = Math.max(-1, Math.min(1, (dx - dy) / SFX_PAN_RANGE));
  }
  const src = audioCtx.createBufferSource();
  src.buffer = b;
  let out = src;
  if (positional && audioCtx.createStereoPanner) {
    const pn = audioCtx.createStereoPanner(); pn.pan.value = pan;
    out.connect(pn); out = pn;
  }
  if (positional) {
    const g = audioCtx.createGain(); g.gain.value = vol;
    out.connect(g); out = g;
  }
  out.connect(sfxGain);
  activeSfx.add(src);
  src.onended = () => activeSfx.delete(src);
  try { src.start(); } catch (_) { activeSfx.delete(src); }
}
function playSfx(id, x, y) {
  if (!soundPlaybackAllowed() || activeSfx.size >= MAX_CONCURRENT_SFX) return;
  const player = scene?.player;
  if (player && (x || y) && Math.max(Math.abs(x - player.x), Math.abs(y - player.y)) >= SFX_MAX_DIST) return;
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const c = cachedSfx(id);
  if (c instanceof AudioBuffer) { playBuffer(c, x, y); return; }  // cached → instant
  const generation = sfxPlaybackGeneration, sessionId = scene?.sessionId, requestedAt = performance.now();
  loadSfx(id).then((b) => {
    if (b && generation === sfxPlaybackGeneration && sessionId === scene?.sessionId &&
        performance.now() - requestedAt <= SFX_PLAY_DEADLINE_MS) playBuffer(b, x, y);
  }); // a first decode may finish after mute, disconnect or a new game session
}
// Apply the current audio settings to the live audio nodes/elements.
function applyAudioSettings() {
  bgMusic.volume = settings.musicVol;
  if (sfxGain) sfxGain.gain.value = settings.sfxVol;
  if (audioMuted || !settings.sfx) stopSoundEffects();
  if (audioMuted || !settings.music) { bgMusic.pause(); }
  else if (curMusicId != null) { bgMusic.play().catch(() => {}); }
}

// Play any sound events newer than the last we played (mirrors journal_seq).
function playSounds(s) {
  if (!s || !s.sounds) return;
  for (const ev of s.sounds) {
    const seq = ev.seq | 0;
    if (seq <= lastSoundSeq) continue;
    lastSoundSeq = seq;
    if (audioMuted || !settings.sfx) continue;
    playSfx(ev.id | 0, ev.x | 0, ev.y | 0);
  }
}
// Sound push channel: the server streams each sound the instant it fires (SSE) so a
// hit no longer waits for the next 150ms poll. EventSource auto-reconnects; the
// poll's playSounds() covers any frame missed during a reconnect. Both dedupe on
// `lastSoundSeq`, so whichever delivers a seq first wins and the other skips it.
function connectSoundStream() {
  if (typeof EventSource === "undefined") return; // no SSE → poll fallback handles sound
  const es = new EventSource("sounds");
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch (_) { return; }
    // SSE can get ahead of polling across a reconnect. A sound from another
    // connection must neither play nor advance this world's sequence cursor.
    if (!ev || !scene?.sessionId || ev.sessionId !== scene.sessionId || !seqPrimed || sceneReloading) return;
    const seq = ev.seq | 0;
    if (seq <= lastSoundSeq) return;
    lastSoundSeq = seq;
    if (audioMuted || !settings.sfx) return;
    playSfx(ev.id | 0, ev.x | 0, ev.y | 0);
  };
}

// Sync the looping background track to scene.music (id or null = stop).
function updateMusic(s) {
  const id = s && s.music != null ? (s.music | 0) : null;
  if (id !== curMusicId) {
    curMusicId = id;
    if (id == null) {
      bgMusic.pause();
      bgMusic.removeAttribute("src");
    } else {
      bgMusic.src = "music/" + id + ".mp3";
      if (!audioMuted && settings.music) bgMusic.play().catch(() => {});
    }
  }
}

function toggleMute() {
  audioMuted = !audioMuted;
  applyAudioSettings();   // pause/resume music respecting both mute + settings.music
  const btn = document.getElementById("mutebtn");
  if (btn) btn.textContent = audioMuted ? "muted" : "sound";
  setStatus(audioMuted ? "audio muted" : "audio on");
}
// UO message types (ClassicUO MessageType.cs): 0 Regular, 1 System, 2 Emote,
// 6 Label, 7 Focus, 8 Whisper, 9 Yell, 10 Spell (power words). ClassicUO colors
// overhead text by the server-sent HUE; these per-type colors are only the
// fallback used when the server sends hue 0. See msgColor()/MSG_CLASS.
const MSG_DEFAULT_COLOR = {
  0: 0xffffff,  // regular speech — white
  2: 0xffd27f,  // emote — soft amber
  6: 0xc8c8c8,  // label
  7: 0xffffff,  // focus
  8: 0x9aa0a6,  // whisper — dim gray
  9: 0xff5a4d,  // yell — red
  10: 0xb9a7ff, // spell / power words — soft violet
};
// Per-type font styling (weight/size/style), applied as an extra CSS class so
// yells read loud, whispers quiet, emotes italic and power words distinct.
const MSG_CLASS = { 2: "oh-emote", 8: "oh-whisper", 9: "oh-yell", 10: "oh-spell" };
// Overhead text color: ClassicUO-style — the server hue wins (resolved through the
// hue table); fall back to the per-type default when the server sent hue 0.
function msgColor(type, hue) {
  if (hue) { const hx = hueHex(hue); if (hx) return hx; }
  return cssColor(MSG_DEFAULT_COLOR[type] ?? 0xffffff);
}

// absolute world iso (no centering); camera does the centering
const isoX = (x, y) => (x - y) * HALF;
// `z || 0` (not `z | 0`): x/y are already fractional here so a mobile can glide
// smoothly, but truncating z threw the whole eased Z away — every height change
// rendered as a hard ZSTEP (4px) jump the instant rz crossed a whole unit, which
// is what made even a correct ±1 correction read as a pop. `|| 0` keeps the
// undefined/NaN guard the int-cast was providing (statics/land pass integers, so
// their positions are bit-identical).
const isoY = (x, y, z) => (x + y) * HALF - (z || 0) * ZSTEP;
// Iso draw order (ClassicUO Chunk.AddGameObject): primary = (x+y) screen depth,
// secondary = priorityZ (z adjusted: land z-2, wall/height +1), tertiary = type
// bias (land 0 < surface/static 4 < mobile 8) so floors draw under walls etc.
const depthZ = (x, y, pz, bias) => (x + y) * 8192 + ((pz | 0) + 130) * 16 + bias;
// A mobile outranks anything sharing its tile, the way ClassicUO's draw-time
// bias does. There, depth is `(x + y) + (127 + z) * 0.01` (View.cs:81) and the
// batcher adds +1.0 for mobiles vs +0.5 for statics — half a tile, i.e. FIFTY z
// units of headroom, so only something towering (>51 z) above you on your own
// tile can paint over you. With bare `depthZ` the gap here is bias 8 vs 4 = 4,
// under one z step (16), so a static merely 1-2 z above your feet — a stair
// riser you are standing on, a table, a low wall — sorted in front and hid you.
// 800 = 50 z units, reproducing ClassicUO's headroom exactly; it stays far
// inside the 8192 tile stride, so it can never reorder across tiles.
const MOB_DEPTH_BIAS = 800;
const mobDepthZ = (x, y, z) => depthZ(x, y, z + 1, 8) + MOB_DEPTH_BIAS;
