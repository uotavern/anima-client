const { newContext } = require("./harness.js");
const { test, ok, eq, includes } = require("./run.js");

function pollContext() {
  const ctx = newContext(); ctx.mountPage();
  ctx.load("00-state.js", "04-connection.js", "05-poll.js");
  ctx.set("showLogin", () => {}); ctx.set("setStatus", () => {}); ctx.set("diag", {});
  return ctx;
}
test("scene polling never overlaps while a previous body is pending", async () => {
  const ctx = pollContext(); let finish;
  ctx.setFetch(() => ({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) }));
  const first = ctx.run("poll()"); await ctx.flush();
  await ctx.run("poll()"); await ctx.run("poll(true)");
  eq(ctx.fetchLog.length, 1);
  finish({ auth: "login", msg: "Newest" }); await first;
  eq(ctx.run("scene.msg"), "Newest"); ok(!ctx.run("scenePollPending"));
});
test("timed-out scene bodies cannot overwrite a recovered connection", async () => {
  const ctx = pollContext(); let late, signal;
  ctx.setFetch((_, init) => { signal = init.signal; return { ok: true, json: () => new Promise(resolve => { late = resolve; }) }; });
  const first = ctx.run("poll()"); await ctx.flush();
  ctx.advance(5000); await first;
  ok(signal.aborted); ok(!ctx.run("sceneTransportAvailable"));
  ok(!ctx.document.getElementById("client-connection").hidden);
  ctx.setFetch(() => ({ ok: true, json: async () => ({ auth: "login", msg: "Recovered" }) }));
  await ctx.run("poll(true)");
  late({ auth: "error", msg: "Stale" }); await ctx.flush();
  eq(ctx.run("scene.msg"), "Recovered"); ok(ctx.run("sceneTransportAvailable"));
  ok(ctx.document.getElementById("client-connection").hidden);
});
test("failed scene requests back off instead of hammering the stopped client", async () => {
  const ctx = pollContext(); ctx.setFetch(() => { throw new Error("offline"); });
  await ctx.run("poll()");
  for (let i = 0; i < 5; i++) { ctx.advance(150); await ctx.run("poll()"); }
  eq(ctx.fetchLog.length, 1);
  ctx.advance(250); await ctx.run("poll()"); eq(ctx.fetchLog.length, 2);
});
test("disconnect stops macros and movement without replaying them on recovery", () => {
  const ctx = newContext(); ctx.mountPage(); ctx.loadAll(); ctx.setFetch(() => ({ ok: true })); ctx.fetchLog.length = 0;
  ctx.run('held.add(0); macroRun = {actions:[], i:0}; setSceneTransport(false)');
  eq(ctx.run("held.size"), 0); eq(ctx.run("macroRun"), null);
  ctx.run('sendInput("say:must-not-send"); held.add(2)');
  eq(ctx.fetchLog.length, 0); eq(ctx.run("activeMove()"), null);
  ctx.run("setSceneTransport(true)"); eq(ctx.run("held.size"), 0);
});
test("connection notice pauses keyboard access and restores the previous field", () => {
  const ctx = pollContext(), login = ctx.document.getElementById("login"), host = ctx.document.getElementById("lg-host");
  host.focus();
  ctx.run("setSceneTransport(false)");
  ok(login.inert); eq(ctx.document.activeElement.id, "client-connection-retry");
  ctx.run("setSceneTransport(false); setSceneTransport(true)");
  ok(!login.inert); eq(ctx.document.activeElement, host);
});
test("late cancellation errors cannot alter a newer login attempt", async () => {
  const ctx = pollContext(); let reject, submitted;
  ctx.setFetch((_, init) => { submitted = JSON.parse(init.body); return new Promise((resolve, no) => { reject = no; }); });
  ctx.run('updateLoginConnection("connecting", {attempt_id:7, cancellable:true})');
  const pending = ctx.run("cancelLoginConnection()");
  eq(submitted.attempt_id, 7);
  ctx.run('updateLoginConnection("connecting", {attempt_id:8, cancellable:true})');
  reject(new Error("old failure")); await pending;
  eq(ctx.run("loginConnectionId"), 8);
  eq(ctx.document.getElementById("lg-msg").textContent, "");
  ok(!ctx.document.getElementById("lg-cancel-connection").disabled);
});

