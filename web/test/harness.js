// Load the REAL web/js into a vm context, head-less, and hand a test the levers.
//
// The gate already has scripts/check-web-globals.mjs, which compiles these files
// TOGETHER (one shared global scope, index.html's order) — but never runs them.
// This runs them. Same file list, read from the same source of truth, so a
// <script> tag added to the page is picked up here without anyone remembering to.
//
// Everything a browser would supply is stubbed, and every stub that could make a
// test flake is under the test's control:
//   * the clock  — performance.now(), Date.now() and new Date() all read one
//                  number the test sets (ctx.setNow / ctx.advance).
//   * timers     — setTimeout/setInterval/requestAnimationFrame queue; nothing
//                  fires until ctx.advance() moves the clock over it.
//   * randomness — Math.random is a seeded PRNG, re-seedable per test.
//   * the net    — fetch/EventSource/WebSocket answer from the test, never the
//                  network. An unstubbed fetch is a test failure, not a hang.
// Nothing here reads a UO data file, a shard, or the network. CI-safe by
// construction: there is nothing to reach.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Document, Element, DomEvent } = require("./dom.js");

const ROOT = path.resolve(__dirname, "..", "..");     // repo root
const WEB = path.join(ROOT, "web");
const PAGE = path.join(WEB, "index.html");

// ── which scripts, in what order ───────────────────────────────────────────
// index.html, not a directory listing: a listing silently disagrees with the
// page the moment a tag is added, removed or reordered. `vendor/` is a pre-built
// PixiJS drop, not ours — it is stubbed instead (see makePixi).
function pageScripts() {
  const html = fs.readFileSync(PAGE, "utf8");
  const files = [...html.matchAll(/<script\s+src="([^"]+)"\s*>\s*<\/script>/g)]
    .map((m) => m[1].split("?")[0])
    .filter((src) => !src.startsWith("vendor/"));
  if (!files.length) throw new Error("web/test: no <script src> tags found in web/index.html");
  return files;
}

// ── deterministic clock + timer queue ──────────────────────────────────────
function makeClock() {
  let now = 0, seq = 0;
  const queue = [];                                   // {id, at, every, fn, args}
  const add = (fn, ms, every, args) => {
    if (typeof fn !== "function") return 0;
    const id = ++seq;
    queue.push({ id, at: now + Math.max(0, ms | 0), every, fn, args });
    return id;
  };
  const cancel = (id) => {
    const i = queue.findIndex((t) => t.id === id);
    if (i >= 0) queue.splice(i, 1);
  };
  return {
    get now() { return now; },
    set(t) { now = t; },
    // Run every timer due in the next `ms`, in due order, with the clock set to
    // each one's own due time — so a callback that reads performance.now() sees
    // when it fired, not when the test asked.
    advance(ms) {
      const end = now + ms;
      for (let guard = 0; guard < 100000; guard++) {
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        const t = queue[0];
        if (!t || t.at > end) break;
        now = t.at;
        if (t.every === undefined) queue.shift();
        else t.at += Math.max(1, t.every | 0);
        t.fn(...t.args);
      }
      now = end;
    },
    pending() { return queue.length; },
    setTimeout: (fn, ms, ...a) => add(fn, ms, undefined, a),
    setInterval: (fn, ms, ...a) => add(fn, ms, ms, a),
    clearTimeout: cancel,
    clearInterval: cancel,
    // 60 Hz, so a render loop that chains rAF advances one frame per 16 ms.
    requestAnimationFrame: (fn) => add(() => fn(now), 16, undefined, []),
    cancelAnimationFrame: cancel,
  };
}

// mulberry32: 32 bits of state, uniform enough for "did the roll reach all three
// fidget groups", and the same sequence on every machine and every run.
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── PixiJS stand-in ────────────────────────────────────────────────────────
// vendor/pixi.min.js is a real renderer that wants a GPU. These are display
// objects with the same shape: a test asserts on the tree the client built
// (children, textures, positions, tints) rather than on pixels.
function makePixi(doc) {
  const makeNode = (kind) => {
    const pt = (x, y) => ({ x, y, set(a, b) { this.x = a; this.y = b === undefined ? a : b; } });
    const n = {
      __pixi: kind,
      x: 0, y: 0, alpha: 1, visible: true, zIndex: 0, rotation: 0, tint: 0xffffff,
      width: 0, height: 0, sortableChildren: false, destroyed: false, texture: null,
      eventMode: "auto", cursor: "default", interactiveChildren: true, filters: null,
      blendMode: "normal", label: "", mask: null, hitArea: null,
      anchor: pt(0, 0), scale: pt(1, 1), skew: pt(0, 0), pivot: pt(0, 0), position: pt(0, 0),
      children: [], parent: null, listeners: new Map(), style: {},
      addChild(...cs) { for (const c of cs) { if (c.parent) c.parent.removeChild(c); c.parent = n; n.children.push(c); } return cs[0]; },
      addChildAt(c, i) { if (c.parent) c.parent.removeChild(c); c.parent = n; n.children.splice(i, 0, c); return c; },
      removeChild(...cs) { for (const c of cs) { const i = n.children.indexOf(c); if (i >= 0) { n.children.splice(i, 1); c.parent = null; } } return cs[0]; },
      removeChildren() { const old = n.children.slice(); old.forEach((c) => { c.parent = null; }); n.children.length = 0; return old; },
      getChildByLabel(l) { return n.children.find((c) => c.label === l) || null; },
      destroy() { n.destroyed = true; if (n.parent) n.parent.removeChild(n); },
      on(t, f) { const l = n.listeners.get(t) || []; l.push(f); n.listeners.set(t, l); return n; },
      once(t, f) { return n.on(t, f); },
      off(t, f) { const l = n.listeners.get(t) || []; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); return n; },
      // A test fires a Pixi event the way the client's user would: sp.emit("pointerdown", ev).
      emit(t, ...a) { for (const f of (n.listeners.get(t) || []).slice()) f(...a); return n; },
      getBounds() { return { x: n.x, y: n.y, width: n.width, height: n.height }; },
      getGlobalPosition() { return { x: n.x, y: n.y }; },
      toLocal(p) { return { x: p.x - n.x, y: p.y - n.y }; },
      toGlobal(p) { return { x: p.x + n.x, y: p.y + n.y }; },
      updateTransform() { return n; },
      // Graphics: record the calls, don't rasterise.
      __drawn: [],
      clear() { n.__drawn.length = 0; return n; },
      beginFill(...a) { n.__drawn.push(["beginFill", ...a]); return n; },
      endFill() { return n; },
      lineStyle(...a) { n.__drawn.push(["lineStyle", ...a]); return n; },
      setStrokeStyle(...a) { n.__drawn.push(["setStrokeStyle", ...a]); return n; },
      setFillStyle(...a) { n.__drawn.push(["setFillStyle", ...a]); return n; },
      fill(...a) { n.__drawn.push(["fill", ...a]); return n; },
      stroke(...a) { n.__drawn.push(["stroke", ...a]); return n; },
      rect(...a) { n.__drawn.push(["rect", ...a]); return n; },
      roundRect(...a) { n.__drawn.push(["roundRect", ...a]); return n; },
      circle(...a) { n.__drawn.push(["circle", ...a]); return n; },
      ellipse(...a) { n.__drawn.push(["ellipse", ...a]); return n; },
      poly(...a) { n.__drawn.push(["poly", ...a]); return n; },
      moveTo(...a) { n.__drawn.push(["moveTo", ...a]); return n; },
      lineTo(...a) { n.__drawn.push(["lineTo", ...a]); return n; },
      closePath() { n.__drawn.push(["closePath"]); return n; },
      drawRect(...a) { n.__drawn.push(["drawRect", ...a]); return n; },
      drawCircle(...a) { n.__drawn.push(["drawCircle", ...a]); return n; },
      drawPolygon(...a) { n.__drawn.push(["drawPolygon", ...a]); return n; },
    };
    return n;
  };
  const Texture = Object.assign(
    function (o) {
      const t = { __texture: true, source: (o && o.source) || null, frame: o && o.frame,
                  width: (o && o.frame && o.frame.width) || 44, height: (o && o.frame && o.frame.height) || 44,
                  __url: (o && o.source && o.source.__url) || (o && o.__url) || null,
                  destroy() { t.destroyed = true; } };
      return t;
    },
    { EMPTY: { __texture: true, __empty: true, width: 0, height: 0 },
      WHITE: { __texture: true, __white: true, width: 1, height: 1 },
      from: (src) => ({ __texture: true, __url: String(src && src.__url ? src.__url : src), width: 44, height: 44 }) });
  return {
    Sprite: Object.assign(function (tex) { const s = makeNode("Sprite"); s.texture = tex || null; return s; },
                          { from: (t) => { const s = makeNode("Sprite"); s.texture = Texture.from(t); return s; } }),
    Container: function () { return makeNode("Container"); },
    Graphics: function () { return makeNode("Graphics"); },
    Text: function (o) { const s = makeNode("Text"); s.text = (o && (o.text ?? o)) || ""; s.style = (o && o.style) || {}; return s; },
    TilingSprite: function () { return makeNode("TilingSprite"); },
    AnimatedSprite: function () { const s = makeNode("AnimatedSprite"); s.play = () => {}; s.stop = () => {}; return s; },
    Texture,
    TextureSource: function (o) { return { __url: o && o.resource && o.resource.__url }; },
    Rectangle: function (x, y, w, h) { return { x, y, width: w, height: h }; },
    Point: function (x, y) { return { x: x || 0, y: y || 0 }; },
    ColorMatrixFilter: function () { return { desaturate() {}, brightness() {}, saturate() {}, tint() {}, matrix: [] }; },
    AlphaFilter: function () { return { alpha: 1 }; },
    BlurFilter: function () { return { blur: 0 }; },
    Assets: { load: async () => ({}), get: () => null, add() {}, unload: async () => {} },
    Application: function () {
      const app = {
        stage: makeNode("Container"),
        canvas: null,                                  // init() fills this in
        renderer: { width: 800, height: 600, resize(w, h) { app.renderer.width = w; app.renderer.height = h; app.screen.width = w; app.screen.height = h; }, render() { app.__renders++; } },
        screen: { width: 800, height: 600 },
        ticker: { add() {}, remove() {}, start() {}, stop() {} },
        __renders: 0,
        render() { app.__renders++; },
        init: async (opts = {}) => {
          app.__initOpts = opts;
          app.renderer.resize(opts.width || 800, opts.height || 600);
          app.canvas = doc.createElement("canvas");
          app.canvas.rect = { left: 0, top: 0, width: app.renderer.width, height: app.renderer.height };
          return app;
        },
      };
      return app;
    },
    BLEND_MODES: { NORMAL: "normal", ADD: "add", MULTIPLY: "multiply" },
    SCALE_MODES: { NEAREST: "nearest", LINEAR: "linear" },
    __makeNode: makeNode,
  };
}

// ── a 2d canvas context that records instead of painting ───────────────────
function make2d(calls) {
  const rec = (name) => (...a) => { calls.push([name, ...a]); };
  const ctx = {
    canvas: null, calls,
    globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "#000",
    strokeStyle: "#000", lineWidth: 1, font: "10px sans-serif", textAlign: "start",
    textBaseline: "alphabetic", imageSmoothingEnabled: true, filter: "none", lineCap: "butt",
    lineJoin: "miter", shadowBlur: 0, shadowColor: "transparent",
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({}),
    measureText: (t) => ({ width: String(t).length * 6 }),
    // Reads back the LAST image drawn into this context, when the test gave that
    // image an alpha mask (`img.alpha = (x, y) => 0..255`, or a w*h array).
    // Without one every pixel is transparent — the honest answer for a canvas
    // nothing was painted into, and the state a real un-decoded image produces.
    getImageData: (x, y, w, h) => {
      const d = new Uint8ClampedArray(w * h * 4);
      const src = ctx.__lastImage;
      const a = src && src.alpha;
      if (a) {
        for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
          const v = typeof a === "function" ? a(px, py) : a[py * w + px];
          d[(py * w + px) * 4 + 3] = v | 0;
        }
      }
      return { width: w, height: h, data: d };
    },
    putImageData() {}, createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    setTransform() {}, resetTransform() {}, getTransform: () => ({}),
  };
  for (const m of ["clearRect", "fillRect", "strokeRect", "save", "restore", "beginPath",
                   "closePath", "arc", "arcTo", "ellipse", "rect", "roundRect", "fill",
                   "stroke", "clip", "moveTo", "lineTo", "quadraticCurveTo", "bezierCurveTo",
                   "translate", "scale", "rotate", "fillText", "strokeText",
                   "setLineDash"]) ctx[m] = rec(m);
  ctx.drawImage = (...a) => { ctx.__lastImage = a[0]; calls.push(["drawImage", ...a]); };
  return ctx;
}

// ── the context ────────────────────────────────────────────────────────────
function newContext(opts = {}) {
  const clock = makeClock();
  const doc = new Document();
  const PIXI = makePixi(doc);
  const drawCalls = [];                 // every 2d-canvas call, in order
  const ctx2d = make2d(drawCalls);
  doc.__context2d = (el) => { ctx2d.canvas = el; return ctx2d; };

  const fetchLog = [];                  // every URL asked for, in order
  let fetchImpl = null;
  const openSockets = [];               // EventSource / WebSocket the client opened

  const win = {
    innerWidth: opts.width || 1280,
    innerHeight: opts.height || 800,
    devicePixelRatio: 1,
    listeners: new Map(),
    scrollX: 0, scrollY: 0,
    // window.confirm / window.prompt block a browser; here they answer from the
    // test (ctx.answer.confirm / ctx.answer.prompt) so a "are you sure?" path is
    // testable in both directions.
    confirm: (msg) => { win.__asked.push(["confirm", msg]); return answer.confirm; },
    prompt: (msg, def) => { win.__asked.push(["prompt", msg, def]); return answer.prompt === undefined ? def : answer.prompt; },
    alert: (msg) => { win.__asked.push(["alert", msg]); },
    __asked: [],
    getComputedStyle: (el) => new Proxy(el.style, { get: (t, k) => (k in t ? t[k] : "") }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    getSelection: () => ({ toString: () => "", removeAllRanges() {} }),
    open: (u) => { win.__asked.push(["open", u]); return null; },
    close() {}, focus() {}, scrollTo() {},
  };
  const answer = { confirm: true, prompt: null };
  win.addEventListener = (t, f) => Element.prototype.addEventListener.call(win, t, f);
  win.removeEventListener = (t, f) => Element.prototype.removeEventListener.call(win, t, f);
  win.dispatchEvent = (ev) => { ev.target = ev.target || win; for (const f of (win.listeners.get(ev.type) || []).slice()) f.call(win, ev); return !ev.defaultPrevented; };

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(String(k)); },
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };

  const location = { href: opts.href || "http://127.0.0.1:8090/", origin: "http://127.0.0.1:8090",
                     protocol: "http:", host: "127.0.0.1:8090", hostname: "127.0.0.1", port: "8090",
                     pathname: "/", search: opts.search || "", hash: "",
                     assign() {}, replace() {}, reload() {}, toString() { return location.href; } };

  const sandbox = {
    PIXI,
    console: opts.console || console,
    document: doc,
    localStorage, sessionStorage: localStorage,
    location,
    navigator: { userAgent: "anima-test", language: "en-US", platform: "test",
                 clipboard: { writeText: async () => {}, readText: async () => "" },
                 maxTouchPoints: 0 },
    performance: { now: () => clock.now, timeOrigin: 0, mark() {}, measure() {} },
    Date: makeDate(clock),
    Math: makeMath(opts.seed === undefined ? 0x1234abcd : opts.seed),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    requestAnimationFrame: clock.requestAnimationFrame, cancelAnimationFrame: clock.cancelAnimationFrame,
    queueMicrotask,
    fetch: (u, init) => {
      fetchLog.push(String(u));
      if (!fetchImpl) {
        return Promise.reject(new Error(
          `fetch(${JSON.stringify(String(u))}) with no stub — call ctx.setFetch() ` +
          `in the test. Tests never touch the network.`));
      }
      return Promise.resolve(fetchImpl(String(u), init));
    },
    Image: function () {
      const img = doc.createElement("img");
      // A real <img> loads asynchronously; so does this — the load event lands on
      // the next timer tick, which a test reaches with ctx.advance(0).
      Object.defineProperty(img, "src", {
        get() { return img.__src || ""; },
        set(v) {
          img.__src = String(v);
          img.width = img.width || 44; img.height = img.height || 44;
          clock.setTimeout(() => img.dispatchEvent(new DomEvent("load", { bubbles: false })), 0);
        },
      });
      return img;
    },
    Audio: function (src) { const a = doc.createElement("audio"); a.src = src || ""; a.volume = 1; return a; },
    AudioContext: function () {
      const node = () => ({ connect: () => node(), disconnect() {}, start() {}, stop() {},
                            gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} },
                            buffer: null, playbackRate: { value: 1 } });
      return { destination: node(), currentTime: 0, state: "running", sampleRate: 44100,
               createGain: node, createBufferSource: node, createOscillator: node,
               decodeAudioData: async () => ({ duration: 1 }), resume: async () => {}, close: async () => {} };
    },
    EventSource: function (url) {
      const es = { url: String(url), readyState: 1, listeners: new Map(), closed: false,
                   addEventListener(t, f) { Element.prototype.addEventListener.call(es, t, f); },
                   removeEventListener(t, f) { Element.prototype.removeEventListener.call(es, t, f); },
                   close() { es.closed = true; es.readyState = 2; },
                   // ctx.sockets[0].emit("message", {data: "..."}) — the test IS the server.
                   emit(t, ev) { for (const f of (es.listeners.get(t) || []).slice()) f(ev); } };
      openSockets.push(es);
      return es;
    },
    WebSocket: function (url) {
      const ws = { url: String(url), readyState: 1, sent: [], listeners: new Map(), closed: false,
                   binaryType: "blob",
                   addEventListener(t, f) { Element.prototype.addEventListener.call(ws, t, f); },
                   removeEventListener(t, f) { Element.prototype.removeEventListener.call(ws, t, f); },
                   send(d) { ws.sent.push(d); }, close() { ws.closed = true; ws.readyState = 3; },
                   emit(t, ev) { for (const f of (ws.listeners.get(t) || []).slice()) f(ev); } };
      openSockets.push(ws);
      return ws;
    },
    ResizeObserver: function (cb) { return { __cb: cb, observe() {}, unobserve() {}, disconnect() {} }; },
    MutationObserver: function (cb) { return { __cb: cb, observe() {}, disconnect() {}, takeRecords: () => [] }; },
    IntersectionObserver: function (cb) { return { __cb: cb, observe() {}, unobserve() {}, disconnect() {} }; },
    Event: DomEvent, CustomEvent: DomEvent, KeyboardEvent: DomEvent, MouseEvent: DomEvent,
    PointerEvent: DomEvent, WheelEvent: DomEvent,
    URL, URLSearchParams, Blob, TextDecoder, TextEncoder, AbortController, Headers: class Headers {},
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    structuredClone,
    Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int8Array, Int16Array,
    Int32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
    Promise, Symbol, Proxy, Reflect, WeakMap, WeakSet, BigInt,
  };
  // `window`, `self` and `globalThis` are the vm global itself, exactly as in a
  // page: a file that says `window.foo = 1` and another that reads bare `foo`
  // must see the same slot, or the harness tests a fiction.
  Object.assign(sandbox, win);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  vm.createContext(sandbox);

  const loaded = [];
  const scripts = pageScripts();

  function readScript(rel) {
    const file = path.join(WEB, rel);
    if (!fs.existsSync(file)) throw new Error(`web/test: index.html loads ${rel}, which does not exist`);
    return fs.readFileSync(file, "utf8");
  }

  // Run one file. A throw here is FATAL and reported against the real file and
  // line — a harness that skipped a file that failed to evaluate would report
  // green over a client that does not boot, which is worse than no suite at all.
  function runFile(rel) {
    const src = readScript(rel);
    try {
      vm.runInContext(src, sandbox, { filename: `web/${rel}`, displayErrors: true });
    } catch (err) {
      const at = (err.stack || "").split("\n").find((l) => l.includes(`web/${rel}:`));
      const e = new Error(`web/${rel} threw while loading: ${err.message}` +
                          (at ? `\n    ${at.trim()}` : ""));
      e.stack = err.stack;
      e.cause = err;
      throw e;
    }
    loaded.push(rel);
  }

  const known = (rel) => (rel.includes("/") || ["dialogs.js", "storage.js"].includes(rel) ? rel : `js/${rel}`);

  const ctx = {
    sandbox, PIXI, document: doc, window: sandbox, clock, drawCalls, ctx2d,
    fetchLog, sockets: openSockets, localStorage, location, answer, scripts,
    get loaded() { return loaded.slice(); },
    get asked() { return sandbox.__asked; },

    /** Load named page scripts ("00-state.js" or "js/00-state.js"), in the order
     *  index.html lists them — never the order the test happens to name them. */
    load(...names) {
      const want = new Set(names.flat().map(known));
      for (const n of want) {
        if (!scripts.includes(n)) {
          throw new Error(`web/test: ${n} is not loaded by web/index.html (it lists ${scripts.join(", ")})`);
        }
      }
      if (want.has("js/00-state.js") || want.has("dialogs.js")) want.add("storage.js");
      for (const rel of scripts) if (want.has(rel) && !loaded.includes(rel)) runFile(rel);
      return ctx;
    },

    /** Every script the page loads — the whole client in one scope.
     *  web/js/99-start.js is a bare `main()`: the page's entry point. A
     *  test loads the CODE, not the page, so `main` is replaced with a recorder
     *  just before that file runs. Pass {boot: true} to let the real one fire. */
    loadAll({ boot = false } = {}) {
      const last = scripts[scripts.length - 1];
      const intercept = !boot && !loaded.includes(last);
      for (const rel of scripts) {
        if (rel === last && intercept) {
          if (typeof sandbox.main !== "function") {
            throw new Error("web/test: expected a global main() before the last page script — " +
                            "the bootstrap moved; update loadAll()");
          }
          ctx.realMain = sandbox.main;
          sandbox.main = () => { ctx.booted = true; };
        }
        if (!loaded.includes(rel)) runFile(rel);
      }
      // If the page stops calling main() from its last script, say so here rather
      // than let every test quietly run against a client that never started.
      if (intercept && !ctx.booted) {
        throw new Error(`web/test: ${last} did not call main() — the page's entry point moved; ` +
                        "update loadAll()");
      }
      return ctx;
    },

    /** Evaluate an expression in the page's own scope. The value comes back. */
    run(code) { return vm.runInContext(code, sandbox, { filename: "web/test/<inline>" }); },
    /** Read / write a page global by name — `let`/`const` included.
     *  (A top-level `let app` in a classic script lives in the global LEXICAL
     *  environment, not on the global object, so sandbox.app would be undefined
     *  for most of this client's state. These go through the scope instead.) */
    get(name) { return vm.runInContext(name, sandbox, { filename: "web/test/<get>" }); },
    set(name, value) {
      sandbox.__animaSet = value;
      try { vm.runInContext(`${name} = __animaSet;`, sandbox, { filename: "web/test/<set>" }); }
      finally { delete sandbox.__animaSet; }
      return value;
    },

    /** Move the clock WITHOUT running timers (what most render code needs). */
    setNow(t) { clock.set(t); return ctx; },
    now() { return clock.now; },
    /** Move the clock forward AND fire every timer that comes due. */
    advance(ms) { clock.advance(ms); return ctx; },
    /** Let queued promise callbacks run. `await ctx.flush()` after a fetch. */
    flush(times = 1) {
      let p = Promise.resolve();
      for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
      return p;
    },
    /** Answer every fetch from `fn(url, init)`. Return a Response-ish object, or
     *  a plain object / string / number and the harness wraps it. */
    setFetch(fn) {
      fetchImpl = (url, init) => {
        const r = fn(url, init);
        return Promise.resolve(r).then(wrapResponse);
      };
      return ctx;
    },
    /** Serve a fixed table of url -> body. Anything else 404s. */
    serve(table) {
      return ctx.setFetch((u) => {
        const key = Object.keys(table).find((k) => k === u || u === k.replace(/^\//, "") || u.split("?")[0] === k);
        if (key === undefined) return { status: 404, ok: false, body: null };
        const v = table[key];
        return typeof v === "function" ? v(u) : v;
      });
    },
    /** Re-seed Math.random. Same seed, same sequence, every machine. */
    seed(n) { sandbox.Math.__seed(n); return ctx; },
    /** Replace Math.random outright (e.g. () => 0.999 to force a branch). */
    setRandom(fn) { sandbox.Math.__setRandom(fn); return ctx; },

    /** Every 2d-canvas call of one kind, arguments only, in order.
     *  ctx.calls("drawImage") -> [[img, x, y, w, h], ...] */
    calls(name) { return drawCalls.filter((c) => c[0] === name).map((c) => c.slice(1)); },
    /** Forget what the canvas was told — call before the frame under test. */
    clearCalls() { drawCalls.length = 0; return ctx; },

    /** Build a DOM event the client will accept. */
    event(type, init) { return new DomEvent(type, init); },
    /** Dispatch one at `target` (an element, or "window" / "document"). */
    fire(target, type, init) {
      const t = target === "window" ? sandbox : target === "document" ? doc : target;
      const ev = new DomEvent(type, init);
      ev.target = ev.target || (t === sandbox ? sandbox : t);
      return t.dispatchEvent(ev);
    },
    /** Give the page the #id elements index.html declares but the test needs. */
    mount(html) { doc.body.innerHTML = html; return doc.body; },
    /** Mount web/index.html's REAL <body> — every #id the client looks up, with
     *  the markup it actually ships. <script>/<style> are dropped: the scripts
     *  are what load() runs, and there is no CSS engine to feed. Needed by
     *  anything that walks the page (the HUD, the login form, boot itself). */
    mountPage() {
      const html = fs.readFileSync(PAGE, "utf8");
      const open = html.indexOf("<body");
      const close = html.lastIndexOf("</body>");
      if (open < 0 || close < 0) throw new Error("web/test: web/index.html has no <body>");
      doc.body.innerHTML = html.slice(html.indexOf(">", open) + 1, close)
        .replace(/<script[\s\S]*?<\/script>/g, "")
        .replace(/<style[\s\S]*?<\/style>/g, "");
      return doc.body;
    },
  };
  return ctx;
}

// fetch() returns a Response; tests mostly want to hand back a JS value. Accept
// either, so `setFetch(() => ({ light: 30 }))` just works.
function wrapResponse(r) {
  if (r && typeof r.json === "function") return r;
  if (r && typeof r === "object" && ("status" in r || "body" in r || "ok" in r)) {
    const body = r.body === undefined ? null : r.body;
    const ok = r.ok !== undefined ? r.ok : (r.status || 200) < 400;
    return { ...r, ok, status: r.status || (ok ? 200 : 404), headers: r.headers || { get: () => null },
             json: async () => body, text: r.text || (async () => (typeof body === "string" ? body : JSON.stringify(body))),
             arrayBuffer: r.arrayBuffer || (async () => new ArrayBuffer(0)) };
  }
  return { ok: true, status: 200, headers: { get: () => null },
           json: async () => r, text: async () => (typeof r === "string" ? r : JSON.stringify(r)),
           arrayBuffer: async () => new ArrayBuffer(0) };
}

// The page's Date: `Date.now()` and `new Date()` read the harness clock, so a
// timestamp in a journal line or a save file is the same on every run. Every
// other Date behaviour (parsing, formatting, explicit arguments) is the real one.
function makeDate(clock) {
  const D = function Date_(...a) {
    if (!new.target) return new global.Date(clock.now).toString();
    return a.length ? new global.Date(...a) : new global.Date(clock.now);
  };
  D.now = () => clock.now;
  D.parse = global.Date.parse;
  D.UTC = global.Date.UTC;
  D.prototype = global.Date.prototype;
  return D;
}

// Math with a swappable random(). Everything else is the real Math object.
function makeMath(seed) {
  let rnd = makeRandom(seed);
  const M = Object.create(Math);
  M.random = () => rnd();
  M.__seed = (n) => { rnd = makeRandom(n); };
  M.__setRandom = (fn) => { rnd = fn; };
  return M;
}

module.exports = { newContext, pageScripts, ROOT, WEB };
