const { newContext } = require("./harness.js");
const { test, ok, eq, deepEq } = require("./run.js");

function world(id, serial = 9) {
  return { sessionId: id, player: { serial, x: 1000, y: 2000 }, map: { tiles: [] }, mobiles: [], items: [], journal: [], sounds: [] };
}
function renderer() {
  const ctx = newContext();
  ctx.mountPage(); ctx.loadAll();
  ctx.run(`world = new PIXI.Container(); mobs = new PIXI.Container(); entLayer = new PIXI.Graphics();
    overLayer = new PIXI.Container(); itemLayer = new PIXI.Container(); barLayer = new PIXI.Container();`);
  const errors = [];
  ctx.set("console", { ...console, error: (...args) => errors.push(args) });
  let reloads = 0;
  ctx.location.reload = () => reloads++;
  return { ctx, errors, reloads: () => reloads };
}
async function receive(ctx, next) {
  ctx.setFetch(() => ({ ok: true, json: async () => next }));
  await ctx.run("poll(true)");
}

for (const serial of [9, 10]) test(`missed native login frame resets before rendering the new session (serial ${serial})`, async () => {
  const { ctx, errors, reloads } = renderer();
  await receive(ctx, world("one"));
  ctx.run('held.add(0); macroRun = {actions:[], i:0}; lastSoundSeq = 80;');
  let oldRendererAdvances = 0;
  ctx.set("ingestBoatMoves", () => oldRendererAdvances++);
  await receive(ctx, world("two", serial));
  eq(reloads(), 1); eq(oldRendererAdvances, 0); eq(ctx.run("scene.sessionId"), "one");
  eq(ctx.run("lastSoundSeq"), 80); eq(ctx.run("held.size"), 0); eq(ctx.run("macroRun"), null);
  ok(!ctx.run("sceneTransportAvailable"));
  const requests = ctx.fetchLog.length;
  await ctx.run("poll(true); sendInput('say:old screen')");
  eq(reloads(), 1); eq(ctx.fetchLog.length, requests); deepEq(errors, []);
});

test("initial empty native scene does not mark world entry or cause login reload loops", async () => {
  const { ctx, errors, reloads } = renderer();
  await receive(ctx, {});
  ok(!ctx.run("wasInWorld")); ok(!ctx.run("seqPrimed"));
  // Use the real auth path without starting the profile fetch in wireLogin.
  ctx.set("showLogin", () => {});
  await receive(ctx, { auth: "error", msg: "Server is offline" });
  eq(reloads(), 0); eq(ctx.run("scene.msg"), "Server is offline"); deepEq(errors, []);
});

test("one native session keeps rendering and logout requests only one reload", async () => {
  const { ctx, errors, reloads } = renderer();
  await receive(ctx, world("same"));
  const next = world("same"); next.player.x = 1001;
  await receive(ctx, next);
  eq(ctx.run("scene.player.x"), 1001); eq(reloads(), 0);
  await receive(ctx, { auth: "login" }); await ctx.run("poll(true)");
  eq(reloads(), 1); eq(ctx.run("scene.sessionId"), "same"); deepEq(errors, []);
});

test("input carries its observed session and a rejection refreshes without replaying it", async () => {
  const { ctx } = renderer();
  await receive(ctx, world("one"));
  let polls = 0; ctx.set("poll", () => polls++);
  const calls = [];
  ctx.fetchLog.length = 0; ctx.setFetch((url, init) => { calls.push({ url, init }); return { ok: false, status: 409 }; });
  ctx.run('sendInput("walk:2:1")'); await ctx.flush();
  eq(calls[0].init.headers["X-Anima-Session"], "one");
  eq(calls[0].init.body, "walk:2:1"); eq(polls, 1);
  ok(!ctx.run("sceneTransportAvailable"));
  ctx.run('sendInput("say:blocked")'); eq(ctx.fetchLog.length, 1);
});

test("a late input rejection cannot stop a different session", async () => {
  const { ctx } = renderer(); await receive(ctx, world("old"));
  let finish, polls = 0; ctx.set("poll", () => polls++);
  ctx.setFetch(() => new Promise(resolve => { finish = resolve; }));
  ctx.run('sendInput("say:old")'); await ctx.flush();
  ctx.set("scene", world("new"));
  finish({ ok: false, status: 409 }); await ctx.flush();
  ok(ctx.run("sceneTransportAvailable")); eq(polls, 0);
});

test("sound push cannot play or advance event cursors for an unobserved session", async () => {
  const { ctx } = renderer();
  ctx.run("connectSoundStream()");
  const push = (sessionId, seq) => ctx.sockets[0].onmessage({ data: JSON.stringify({ sessionId, seq, id: 1 }) });
  push("one", 500); eq(ctx.run("lastSoundSeq"), 0);
  await receive(ctx, world("one"));
  const played = []; ctx.set("playSfx", (...args) => played.push(args));
  ctx.run("audioMuted = false; settings.sfx = true;");
  push("two", 600); eq(ctx.run("lastSoundSeq"), 0); eq(played.length, 0);
  push("one", 1); eq(ctx.run("lastSoundSeq"), 1); eq(played.length, 1);
  ctx.run("sceneReloading = true"); push("one", 2);
  eq(ctx.run("lastSoundSeq"), 1); eq(played.length, 1);
});

function characterUi() {
  const ctx = newContext(); ctx.mountPage(); ctx.loadAll();
  ctx.set("initLauncher", () => {}); ctx.set("launcherOnAuth", () => {});
  ctx.set("Option", function (text, value) {
    const el = ctx.document.createElement("option"); el.textContent = text; el.value = value; return el;
  });
  const calls = [];
  ctx.setFetch((url, init) => { calls.push({ url, init }); return {}; });
  const prompt = (id, slots = [{ index: 0, name: "Aria" }, { index: 2, name: "Mira" }]) => {
    ctx.set("promptFixture", { id, slots });
    ctx.run('showLogin("characters", "", promptFixture.slots, 5, [], null, {choice_id:promptFixture.id})');
  };
  return { ctx, prompt, calls, el: id => ctx.document.getElementById(id) };
}

test("identical slots on a new character prompt reset selection and ignore detached old rows", async () => {
  const { ctx, prompt, calls, el } = characterUi();
  prompt("old");
  const oldRow = el("lg-char-list").children[1]; oldRow.click();
  prompt("new");
  ctx.fetchLog.length = 0;
  ctx.fire(oldRow, "dblclick"); await ctx.flush(); eq(ctx.fetchLog.length, 0);
  el("lg-go").click(); await ctx.flush();
  const posted = calls.find(f => f.url === "character");
  deepEq(JSON.parse(posted.init.body), { choice_id: "new", slot: 0 });
});

test("new empty character prompts reset unfinished creation and bind the created character", async () => {
  const { ctx, prompt, calls, el } = characterUi();
  prompt("old", []); el("lg-char-name").value = "Previous";
  ctx.run("wizStep = 5; wizAppearance.hairHue = 1105");
  prompt("new", []);
  eq(el("lg-char-name").value, ""); eq(ctx.run("wizStep"), 1); eq(ctx.run("wizAppearance.hairHue"), 0);
  el("lg-char-name").value = "New character";
  ctx.run("wizStep = 5"); ctx.fetchLog.length = 0;
  el("wiz-next").click(); await ctx.flush();
  const posted = calls.find(f => f.url === "character");
  eq(JSON.parse(posted.init.body).choice_id, "new");
  eq(JSON.parse(posted.init.body).create.name, "New character");
});

test("a pending Play on an old prompt cannot block or unlock a newer Play request", async () => {
  const { ctx, prompt, el } = characterUi(); prompt("old"); await ctx.flush();
  const pending = [];
  ctx.setFetch((url, init) => new Promise(resolve => pending.push({ resolve, body: JSON.parse(init.body) })));
  el("lg-go").click(); await ctx.flush(); eq(pending.length, 1);
  prompt("new"); el("lg-go").click(); await ctx.flush();
  eq(pending.length, 2); eq(pending[1].body.choice_id, "new");
  pending[0].resolve({ ok: false, status: 409, text: async () => "Stale request" }); await ctx.flush();
  el("lg-go").click(); await ctx.flush(); eq(pending.length, 2);
  ok(el("lg-go").disabled);
  pending[1].resolve({ ok: true }); await ctx.flush();
});

for (const [button, field] of [["lg-delete", "delete_slot"], ["lg-back", "cancel"]]) {
  test(`${field} stays bound to its prompt and a late error cannot alter another account`, async () => {
    const { ctx, prompt, el } = characterUi(); prompt("old");
    await ctx.flush(); let finish, submitted;
    ctx.fetchLog.length = 0;
    ctx.setFetch((url, init) => { submitted = JSON.parse(init.body); return new Promise(resolve => { finish = resolve; }); });
    el(button).click(); await ctx.flush();
    const body = submitted;
    eq(body.choice_id, "old"); eq(body[field], field === "cancel" ? true : 0);
    prompt("new"); const message = el("lg-msg").textContent;
    finish({ ok: false, status: 409, text: async () => "Old prompt" }); await ctx.flush();
    eq(el("lg-msg").textContent, message); ok(!el("lg-go").disabled);
  });
}

test("scene polling binds character geometry before advancing game dialogs", async () => {
  const { ctx, errors, reloads } = renderer();
  ctx.set("crypto", require("node:crypto").webcrypto);
  const next = { ...world("layout-session"), layoutIdentity: '["native-v1","fixture.invalid",2593,0,"one"]' };
  let bound = null;
  ctx.set("ingestBoatMoves", () => { bound = ctx.run("characterGeometryKey"); });
  await receive(ctx, next);
  ok(/^[a-f0-9]{64}$/.test(bound));
  const first = bound;
  ctx.run('saveWinGeom(".fixture-win", {left:180,top:190})');
  await receive(ctx, { ...world("new-session"), layoutIdentity: '["native-v1","fixture.invalid",2593,0,"two"]' });
  eq(reloads(), 1); eq(ctx.run("characterGeometryKey"), first);
  deepEq(errors, []);
});
