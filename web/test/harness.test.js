// The foundation testing itself. If this file fails, nothing else in web/test
// means anything — a green suite on top of a harness that quietly skipped a file
// or handed out throwaway DOM nodes reports health it never measured.
const { newContext, pageScripts } = require("./harness.js");
const { test, ok, eq, ne, deepEq, includes, throws, between } = require("./run.js");

test("binary response fixtures preserve headers, body streams and delayed reads", async () => {
  const ctx = newContext(); let finish;
  const stream = { getReader() {} }, bytes = new ArrayBuffer(5);
  ctx.setFetch(() => ({ ok: true, headers: { get: () => "5" }, body: stream,
    arrayBuffer: () => new Promise(resolve => { finish = resolve; }),
    text: async () => "binary fixture",
  }));
  const response = await ctx.run('fetch("fixture.wav")');
  eq(response.headers.get("Content-Length"), "5"); eq(response.body, stream);
  const reading = response.arrayBuffer(); finish(bytes); eq(await reading, bytes);
  eq(await response.text(), "binary fixture");
});

test("every script index.html loads, runs", () => {
  const ctx = newContext();
  ctx.loadAll();
  deepEq(ctx.loaded, pageScripts(), "loaded exactly the page's scripts, in the page's order");
  ok(ctx.loaded.length >= 15, `expected the whole client, got ${ctx.loaded.length} files`);
  ok(ctx.booted, "the page's entry point was reached");
  // Spot-check that state from the FIRST file and the LAST are in one scope —
  // this is the shared-global-scope property check-web-globals.mjs guards.
  eq(typeof ctx.get("dialogFamilies"), "object", "dialogs.js ran");
  eq(ctx.loaded[ctx.loaded.length - 1], "js/99-start.js", "the entry-point script loads last");
  ok(ctx.get("dialogFamilies").length > 0, "09-gumps.js registered dialog families into dialogs.js's list");
});

test("a file that throws while loading fails with the file and the line", () => {
  const ctx = newContext();
  // Sabotage a global the page scripts depend on, then load them: the harness
  // must surface WHERE it died, not swallow it and report a short load.
  ctx.set("PIXI", null);
  const err = throws(() => ctx.loadAll(), /web\/(dialogs|js)/, "the failing file is named");
  ok(/:\d+/.test(String(err.message) + String(err.stack)), "…with a line number");
});

test("index.html is the source of truth for which files load", () => {
  const ctx = newContext();
  throws(() => ctx.load("99-nope.js"), /not loaded by web\/index\.html/,
         "a file the page does not list is refused, not silently skipped");
});

test("load() uses the page's order, not the caller's", () => {
  const ctx = newContext();
  ctx.load("06-movement.js", "00-state.js");
  deepEq(ctx.loaded, ["storage.js", "js/00-state.js", "js/06-movement.js"], "sorted back into index.html order");
});

test("the clock is the test's, not the machine's", () => {
  const ctx = newContext().load("00-state.js");
  ctx.setNow(1234);
  eq(ctx.run("performance.now()"), 1234, "performance.now");
  eq(ctx.run("Date.now()"), 1234, "Date.now");
  eq(ctx.run("new Date().getTime()"), 1234, "new Date()");
  ctx.setNow(9999);
  eq(ctx.run("performance.now()"), 9999, "…and it moves only when the test says so");
});

test("timers fire on advance(), never on their own", () => {
  const ctx = newContext().load("00-state.js");
  ctx.run("globalThis.hits = []; setTimeout(() => hits.push(performance.now()), 100);");
  ctx.advance(50);
  deepEq(ctx.get("hits"), [], "not yet due");
  ctx.advance(60);
  deepEq(ctx.get("hits"), [100], "fires at its due time, and sees that time on the clock");

  ctx.run("hits.length = 0; const id = setInterval(() => hits.push(performance.now()), 30); setTimeout(() => clearInterval(id), 100);");
  ctx.advance(200);
  deepEq(ctx.get("hits"), [140, 170, 200], "an interval repeats until it is cleared");
});

test("Math.random is seeded, so the same test gives the same answer twice", () => {
  const a = newContext({ seed: 7 }).load("00-state.js");
  const b = newContext({ seed: 7 }).load("00-state.js");
  const roll = (c) => Array.from({ length: 8 }, () => c.run("Math.random()"));
  deepEq(roll(a), roll(b), "same seed, same sequence");
  const c = newContext({ seed: 8 }).load("00-state.js");
  ne(JSON.stringify(roll(c)), JSON.stringify(roll(newContext({ seed: 7 }).load("00-state.js"))), "a different seed differs");
  a.setRandom(() => 0.5);
  eq(a.run("Math.random()"), 0.5, "…and a test can pin it outright to force a branch");
  eq(a.run("Math.floor(3.7)"), 3, "everything else on Math is the real Math");
});

test("fetch never reaches the network", async () => {
  const ctx = newContext().load("00-state.js");
  let boom = null;
  await ctx.run("fetch('scene.json')").catch((e) => { boom = e; });
  ok(boom && /no stub/.test(boom.message), "an unstubbed fetch fails loudly instead of hanging");
  ctx.serve({ "scene.json": { light: 30 } });
  const got = await ctx.run("fetch('scene.json').then(r => r.json())");
  deepEq(got, { light: 30 }, "a served fixture comes back");
  includes(ctx.fetchLog, "scene.json", "and the URL is logged");
});

test("the DOM remembers what it was told", () => {
  const ctx = newContext();
  const doc = ctx.document;
  doc.body.innerHTML = '<div id="hud" class="a b"><span class="x" data-serial="7">hi</span></div>';
  const hud = doc.getElementById("hud");
  ok(hud, "getElementById finds a parsed element");
  eq(hud, doc.getElementById("hud"), "…and returns the SAME node every time");
  eq(hud.textContent, "hi", "text came through");
  ok(hud.classList.contains("b"), "classes parsed");
  hud.classList.toggle("b");
  ok(!hud.classList.contains("b"), "classList.toggle actually removes");
  eq(doc.querySelector(".x").dataset.serial, "7", "data-* landed in dataset");
  eq(doc.querySelectorAll("#hud .x").length, 1, "descendant selector");
  eq(doc.querySelector('[data-serial="7"]').tagName, "SPAN", "attribute selector");
  eq(doc.querySelector(".x").closest("#hud"), hud, "closest walks up");
  hud.innerHTML = "";
  eq(doc.querySelector(".x"), null, "clearing innerHTML detaches the children");
});

test("malformed markup is an error, not a guess", () => {
  const ctx = newContext();
  throws(() => { ctx.document.body.innerHTML = "<div><span></div>"; }, /<\/div> closes <span>/,
         "the client building broken HTML should fail a test, not be papered over");
});

test("events bubble and can be cancelled", () => {
  const ctx = newContext();
  ctx.document.body.innerHTML = '<div id="win"><button id="go"></button></div>';
  const seen = [];
  ctx.document.getElementById("win").addEventListener("click", (e) => seen.push(["win", e.target.id]));
  ctx.document.getElementById("go").addEventListener("click", (e) => { seen.push(["go", e.target.id]); e.preventDefault(); });
  const alive = ctx.fire(ctx.document.getElementById("go"), "click", { bubbles: true });
  deepEq(seen, [["go", "go"], ["win", "go"]], "target first, then up the tree, with the original target");
  eq(alive, false, "preventDefault comes back to the dispatcher");
});

test("a page global declared with let is still reachable", () => {
  const ctx = newContext().load("00-state.js", "01-audio.js", "02-textures.js", "03-world.js", "04-boot.js");
  ctx.set("camZoom", 2.5);
  eq(ctx.get("camZoom"), 2.5, "`let camZoom` lives in the lexical scope, not on globalThis");
});

test("the whole client can be booted head-less", async () => {
  const ctx = newContext();
  ctx.serve({});                                  // every request 404s; boot must cope
  ctx.mountPage();                                // index.html's real body
  ctx.loadAll({ boot: true });
  await ctx.flush(4);
  ok(ctx.fetchLog.includes("scene.json?0"), `boot polled the scene; asked for ${ctx.fetchLog.slice(0, 4)}`);
  const app = ctx.get("app");
  ok(app && app.stage.children.length >= 5, "the Pixi stage got its layers");
  between(ctx.document.querySelectorAll("[id]").length, 100, 400, "the real page markup is mounted");
});
