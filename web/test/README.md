# web/test — running the real renderer, head-less

`web/js` is ~16.5k lines of client. Before this directory existed, every line of
it was verified by a person driving a live ServUO shard by hand — which is why
the same bugs kept coming back, and why three separate throwaway fake-DOM
harnesses got built and thrown away in one week.

This is that harness, committed, and wired into `scripts/check.sh` and CI.

    node web/test/run.js              # the whole suite (what the gate runs)
    node web/test/run.js idle lights  # just those files
    node web/test/run.js --list       # every test name

## What it is

`harness.js` loads the **real** `web/dialogs.js` + `web/js/*.js` into one shared
`vm` context, in **the order `web/index.html` lists them** — the same source of
truth `scripts/check-web-globals.mjs` reads. That script proves the files
*compile* together; this one *runs* them.

Everything a browser supplies is stubbed, and every stub that could make a test
flake is the test's to set:

| browser thing | here |
|---|---|
| the DOM | `dom.js` — real parent/child links, real `classList`/`dataset`, real `innerHTML` parsing, event dispatch with bubbling, `querySelector`/`closest` |
| PixiJS | display objects with Pixi's shape; assert on the tree, not on pixels |
| `<canvas>` 2d | records every call — `ctx.calls("drawImage")` |
| `performance.now`, `Date.now`, `new Date()` | one number: `ctx.setNow(t)` |
| `setTimeout`/`setInterval`/`rAF` | queued; nothing fires until `ctx.advance(ms)` |
| `Math.random` | seeded PRNG — `newContext({seed})`, `ctx.seed(n)`, `ctx.setRandom(fn)` |
| `fetch` | `ctx.setFetch(fn)` / `ctx.serve({url: body})`. **Unstubbed = a loud failure**, never a hang |
| `EventSource` / `WebSocket` | opened sockets land in `ctx.sockets`; the test emits the messages |
| `confirm` / `prompt` | `ctx.answer.confirm = false`, `ctx.answer.prompt = "..."`; what was asked is in `ctx.asked` |

No network, no shard, no UO data file, no browser. There is nothing to reach.

## Writing a test

```js
// web/test/thing.test.js
const { newContext } = require("./harness.js");
const { test, ok, eq, deepEq } = require("./run.js");

test("a pile draws twice", () => {
  const ctx = newContext().load("00-state.js", "03-world.js", "05-poll.js");
  ctx.run("world = new PIXI.Container();");
  eq(ctx.run("itemPool.size"), 0, "nothing pooled yet");
});
```

`test()` takes an async function too. Assertions: `ok eq ne deepEq near between
includes throws fail` — all counted, all reporting expected vs actual. Node's
own `assert` is re-exported if you want it. No test framework: the core has one
dependency and it is the protocol's zlib (CLAUDE.md); a runner is a list, a loop
and an exit code.

### The context

- `ctx.load("06-movement.js", …)` — named page scripts, always re-sorted into
  index.html's order. A name the page does not load is an error, not a skip.
- `ctx.loadAll()` — the whole client. `99-start.js` is a bare `main()`
  (the page's entry point); `loadAll()` replaces `main` with a recorder first.
  `ctx.loadAll({boot: true})` lets the real one run — pair it with
  `ctx.mountPage()`, which mounts index.html's real `<body>`.
- `ctx.run(code)` — evaluate in the page's own scope, get the value back.
- `ctx.get(name)` / `ctx.set(name, v)` — page globals, `let`/`const` included
  (a top-level `let` in a classic script is NOT a property of `globalThis`, so
  reaching into the sandbox object directly would find `undefined` for most of
  this client's state).
- `ctx.flush(n)` — let queued promise callbacks run; `await ctx.flush()` after a
  fetch.
- `ctx.fire(el, "click", {bubbles: true})`, `ctx.event(type, init)` — input.
- `ctx.mount(html)` — just the markup a test needs.

### What the fake DOM models, and what it does not

Two stubs are worth knowing about because code under test reads them and a
missing one is silence, not an error:

- `el.dataset.x = v` writes the `data-x` attribute, as the browser does, so
  `[data-x]` selectors match elements the client built. This was NOT true at
  first, and `.cont-item[data-serial]` — the selector the client's own press
  handler uses — silently matched nothing.
- An `<img>` has no intrinsic size until a test gives it one: `el.natural =
  {w, h}` sets `naturalWidth`/`naturalHeight` and makes `complete` true. Leaving
  it unset is the real state of an image that has not loaded, and code that
  reads pixels has to cope with it.
- `el.alpha` (a `(x, y) => 0..255` function, or a `w*h` array) is the mask
  `getImageData` returns for the last image drawn into a 2d context. That is how
  a per-pixel hit test is testable at all.

### Rules

1. **Deterministic or it does not go in.** Anything reading the clock or the RNG
   must be driven from the test. A flaky gate step gets deleted by whoever gets
   paged, and then we are back to hand-testing on a live shard.
2. **Fixtures are written by the test.** No file under `web/test/` may read a
   UO data file, a capture, or a server.
3. **Loud on load.** If a page script throws while loading, the suite fails with
   that file and line. A suite that skipped a file that failed to evaluate would
   report green over a client that does not boot — worse than no suite at all.
   `harness.test.js` asserts this, because it is the property everything else
   rests on.
4. Assert on behaviour a player would notice (which art was asked for, which
   sprite exists, which request went out), not on the shape of the code.
