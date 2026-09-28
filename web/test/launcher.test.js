const { newContext } = require("./harness.js");
const { test, ok, eq, deepEq, includes } = require("./run.js");
const clone = value => JSON.parse(JSON.stringify(value));
function profiles() {
  return { persistent: true, passwords: true, servers: [
    { id: "one", name: "Home shard", host: "127.0.0.1", port: 2594, shard: 0, notes: "Friends", cache: { checked_at: 1000, reachable: true, latency_ms: 8, clients: 4, uptime_hours: 9, details_at: 1000 } },
    { id: "two", name: "Other world", host: "example.test", port: 2593, shard: 0, notes: "", cache: null },
  ], accounts: [
    { id: "a", server_id: "one", username: "player", label: "Main", remember_password: true, characters: [{ index: 2, name: "Aria" }], last_used: 1000 },
    { id: "b", server_id: "two", username: "crafter", label: "Crafter", remember_password: false, characters: [], last_used: null },
  ] };
}
// The worlds-backup shape the native export produces, built from the fixture profiles.
function backupOf(data) {
  return { format: "anima-worlds", version: 1, servers: data.servers.map(s => ({
    name: s.name, host: s.host, port: s.port, shard: s.shard, notes: s.notes || "",
    accounts: data.accounts.filter(a => a.server_id === s.id).map(a => ({ label: a.label, username: a.username })),
  })) };
}

async function setup() {
  const ctx = newContext(); ctx.mountPage(); ctx.load("00-state.js", "04-launcher.js");
  const state = profiles(), calls = [];
  ctx.localStorage.setItem("anima.launcher.selection.v1", JSON.stringify({ server: "one", accounts: { one: "a", two: "b" } }));
  ctx.setFetch((url, init) => {
    calls.push({ url, init });
    if (init.body) {
      const body = JSON.parse(init.body);
      if (body.op === "save_server") {
        const next = { ...body }; delete next.op;
        const index = state.servers.findIndex(s => s.id === body.id);
        if (index >= 0) state.servers[index] = next; else state.servers.push(next);
      }
      if (body.op === "save_account") {
        const next = { id: body.id, server_id: body.server_id, username: body.username, label: body.label, remember_password: body.remember_password, characters: [], last_used: null };
        const index = state.accounts.findIndex(a => a.id === body.id);
        if (index >= 0) state.accounts[index] = next; else state.accounts.push(next);
      }
    }
    return { ok: true, json: async () => clone(state) };
  });
  ctx.run("initLauncher()"); await ctx.run("launcherInitPromise");
  return { ctx, state, calls, el: id => ctx.document.getElementById(id) };
}
test("server switching scopes accounts and clears the password field", async () => {
  const { ctx, el } = await setup();
  eq(el("lg-user").value, "player"); ok(el("lg-pass").placeholder.includes("Saved securely"));
  el("lg-pass").value = "unsubmitted-secret";
  ctx.run('launcherSelectServer("two")');
  eq(el("lg-user").value, "crafter"); eq(el("lg-pass").value, "");
  eq(el("lg-account-list").children.length, 2, "only New account plus this server's account");
  eq(el("lg-save-password").checked, false);
  ctx.run('launcherSelectServer("one")');
  includes(el("lg-cached-characters").textContent, "Aria");
  includes(el("lg-info-status").textContent, "last check");
});
test("connecting uses a saved account reference without reading its password", async () => {
  const { ctx, calls, el } = await setup();
  const login = await ctx.run("launcherPrepareLogin()");
  eq(login.account_id, "a"); eq(login.password, "");
  const writes = calls.filter(c => c.init.body).map(c => JSON.parse(c.init.body));
  eq(writes.length, 0, "unchanged saved accounts need no prompt or rewrite");
  ok(!el("lg-save-prompt").open);
  eq(el("lg-pass").value, "");
  ok(calls.every(c => c.init.headers["X-Anima-Launcher"] === "1"));
  ok(!calls.some(c => /password|secret/.test(c.url)), "no password retrieval endpoint");
});
test("typing a saved password sends it only to the native save/login path", async () => {
  const { ctx, calls, el } = await setup(); el("lg-pass").value = "temporary-secret";
  const pending = ctx.run("launcherPrepareLogin()"); await ctx.flush();
  ok(el("lg-save-prompt").open); el("lg-connect-saved").click();
  const login = await pending;
  eq(login.password, "temporary-secret");
  eq(JSON.parse(calls.at(-1).init.body).password, "temporary-secret");
  for (let i = 0; i < ctx.localStorage.length; i++) ok(!ctx.localStorage.getItem(ctx.localStorage.key(i)).includes("temporary-secret"));
});
test("storage errors preserve the draft and do not announce a saved account", async () => {
  const { ctx, el } = await setup(); el("lg-account-label").value = "My new label"; el("lg-pass").value = "keep-this";
  ctx.setFetch(() => ({ ok: false, status: 400, json: async () => ({ error: "Vault locked" }) }));
  await ctx.run('launcherAction(launcherSaveAccount, "Account saved.")');
  eq(el("lg-profile-msg").textContent, "Vault locked"); eq(el("lg-pass").value, "keep-this");
  eq(el("lg-account-label").value, "My new label"); ok(!ctx.run("launcherBusy()"));
});
test("changing a saved endpoint needs confirmation before any password operation", async () => {
  const { ctx, calls, el } = await setup(); const before = calls.length;
  el("lg-host").value = "different.test"; ctx.answer.confirm = false;
  let failed = false;
  const pending = ctx.run("launcherPrepareLogin()"); await ctx.flush();
  el("lg-connect-saved").click();
  try { await pending; } catch (_) { failed = true; }
  ok(failed); eq(calls.length, before, "no save or password request after cancel");
});
test("character selection clears the transient password and displays the next stage", async () => {
  const { ctx, el } = await setup(); el("lg-pass").value = "discard";
  ctx.run('launcherOnAuth("characters", [{index:2,name:"Aria"}])'); await ctx.flush();
  eq(el("lg-pass").value, ""); ok(el("lg-shell").classList.contains("character-stage"));
  ctx.run('launcherOnAuth("login", [])'); ok(!el("lg-shell").classList.contains("character-stage"));
});
test("worlds backup preview is read-only and import preserves the active saved account", async () => {
  const { ctx, el, calls, state } = await setup();
  ctx.set("fixtureBackup", backupOf(ctx.get("launcherData")));
  ctx.run('launcherPreviewWorlds(JSON.stringify(fixtureBackup), "travel.json")');
  includes(el("lg-worlds-summary").textContent, "2 servers · 2 accounts");
  ok(!el("lg-worlds-preview").hidden); eq(calls.length, 1, "preview sends no profile command");
  const commands = [];
  el("lg-pass").value = "unsaved-password";
  ctx.setFetch((url, init) => {
    commands.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ ...clone(state), imported: { servers: 0, accounts: 0 } }) };
  });
  await ctx.run("launcherImportWorlds()");
  eq(commands[0].op, "import");
  ok(!JSON.stringify(commands[0]).includes("remember_password"));
  eq(el("lg-user").value, "player"); ok(el("lg-save-password").checked);
  eq(el("lg-pass").value, "unsaved-password", "import keeps the login form draft");
  includes(el("lg-worlds-message").textContent, "Added 0 servers and 0 accounts");
  ok(el("lg-worlds-preview").hidden);
});
test("malformed, future and password-bearing backups cannot be applied", async () => {
  const { ctx, el, calls } = await setup();
  const valid = backupOf(ctx.get("launcherData"));
  for (const text of ["{broken", JSON.stringify({ ...valid, version: 99 }), JSON.stringify({ ...valid, password: "nope" }), JSON.stringify({ ...valid, servers: [{ ...valid.servers[0], accounts: [{ label: "bad", username: "a", password: "nope" }] }] })]) {
    ctx.set("fixtureBackupText", text); ctx.run('launcherPreviewWorlds(fixtureBackupText, "broken.json")');
    ok(el("lg-import-worlds").disabled); ok(el("lg-worlds-preview").hidden);
    await ctx.run("launcherImportWorlds()");
  }
  eq(calls.length, 1, "invalid backups never reach a write endpoint");
});
test("worlds export uses its own download and ignores unrelated download results", async () => {
  const { ctx, el } = await setup();
  const exported = backupOf(ctx.get("launcherData"));
  const commands = [];
  ctx.setFetch((url, init) => { commands.push(JSON.parse(init.body)); return { ok: true, json: async () => clone(exported) }; });
  el("lg-pass").value = "unsaved-secret";
  await ctx.run("launcherExportWorlds()");
  deepEq(commands, [{ op: "export" }]);
  const link = el("lg-worlds-download");
  ok(!link.hidden); eq(link.download, "anima-worlds.json"); ok(link.href.startsWith("blob:"));
  const message = el("lg-worlds-message").textContent;
  ctx.run('launcherDownloadResult(true, "blob:another-export")'); eq(el("lg-worlds-message").textContent, message);
  ctx.run("launcherDownloadResult(false, launcherDownloadUrl)"); includes(el("lg-worlds-message").textContent, "could not be saved");
  ctx.run("URL.revokeObjectURL(launcherDownloadUrl)");
});
test("unreadable profiles expose recovery while allowing renderer settings repair", async () => {
  const { ctx, el, state } = await setup(); let requests = 0;
  ctx.setFetch(() => { requests++; return { ok: false, json: async () => ({ error: "Unreadable profiles", recoverable: true }) }; });
  ctx.run("launcherLoadProfiles()"); await ctx.run("launcherInitPromise");
  ok(!ctx.run("launcherReady")); ok(el("lg-export-worlds").disabled); ok(!el("lg-recover-worlds").hidden); ok(!el("lg-recover-worlds").disabled);
  ok(!el("lg-settings-data").disabled); ok(el("lg-backup-tools").open);
  ctx.answer.confirm = false; await ctx.run("launcherRecoverWorlds()"); eq(requests, 1, "cancel never writes");
  const commands = []; ctx.answer.confirm = true;
  ctx.setFetch((url, init) => {
    if (init.body) commands.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ ...clone(state), recovery_copy: "/isolated/launcher.recovered.json" }) };
  });
  await ctx.run("launcherRecoverWorlds()");
  deepEq(commands, [{ op: "recover" }]); ok(ctx.run("launcherReady"));
  ok(el("lg-recover-worlds").hidden); includes(el("lg-worlds-message").textContent, "/isolated/launcher.recovered.json");
});
test("a cancelled asynchronous file read cannot reopen an import preview", async () => {
  const { ctx, el } = await setup();
  let complete;
  const text = new Promise(resolve => { complete = resolve; });
  el("lg-worlds-file").files = [{ name: "slow.json", size: 200, text: () => text }];
  ctx.fire(el("lg-worlds-file"), "change");
  ok(!el("lg-cancel-worlds").hidden, "cancel stays available while the file is being read");
  ctx.fire(el("lg-cancel-worlds"), "click");
  complete(JSON.stringify(backupOf(ctx.get("launcherData")))); await ctx.flush();
  ok(el("lg-worlds-preview").hidden); eq(ctx.run("launcherWorldsPreview"), null);
});

test("saved-server login keeps management folded; adding a server exposes its address", async () => {
  const { ctx, el } = await setup();
  ok(!el("lg-server-settings").open); ok(!el("lg-account-settings").open);
  ctx.run('launcherSelectServer("")'); ok(el("lg-server-settings").open);
  el("lg-host").value = "new.example.test";
  await ctx.run("launcherSaveServer()"); ok(!el("lg-server-settings").open);
});

test("an unsaved account connects without writing profiles or selecting an old vault secret", async () => {
  const { ctx, calls, el } = await setup();
  ctx.run('launcherSelectAccount("")'); el("lg-user").value = "new-player"; el("lg-pass").value = "once-only";
  const pending = ctx.run("launcherPrepareLogin()"); await ctx.flush();
  ok(el("lg-save-prompt").open); ok(!el("lg-confirm-password").checked);
  eq(calls.filter(c => c.init.body).length, 0, "no write before choosing");
  el("lg-connect-once").click(); const login = await pending;
  eq(login.account_id, null); eq(login.username, "new-player"); eq(login.password, "once-only");
  eq(calls.filter(c => c.init.body).length, 0); ok(!ctx.run("launcherBusy()"));
});

test("save-and-connect stores the account and only opts into passwords when selected", async () => {
  const { ctx, calls, el } = await setup();
  ctx.run('launcherSelectAccount("")'); el("lg-user").value = "new-player"; el("lg-pass").value = "chosen-secret";
  const pending = ctx.run("launcherPrepareLogin()"); await ctx.flush();
  ok(!el("lg-confirm-password").checked); el("lg-confirm-password").checked = true;
  el("lg-connect-saved").click(); const login = await pending;
  ok(login.account_id); eq(login.username, "new-player");
  const saved = calls.filter(c => c.init.body).map(c => JSON.parse(c.init.body));
  deepEq(saved.map(c => c.op), ["save_server", "save_account"]);
  eq(saved[1].label, "new-player"); eq(saved[1].remember_password, true);
});

test("Back and Escape cancel saving and release the login form for another attempt", async () => {
  const { ctx, calls, el } = await setup();
  ctx.run('launcherSelectAccount("")'); el("lg-user").value = "unsaved";
  for (const escape of [false, true]) {
    const pending = ctx.run("launcherPrepareLogin()"); await ctx.flush();
    if (escape) ctx.fire(el("lg-save-prompt"), "cancel"); else el("lg-connect-cancel").click();
    eq(await pending, null); ok(!el("lg-save-prompt").open); ok(!ctx.run("launcherBusy()"));
  }
  eq(calls.filter(c => c.init.body).length, 0);
});

test("connecting once to an edited endpoint never uses the previous saved password", async () => {
  const { ctx, calls, el } = await setup(); el("lg-host").value = "other.example.test";
  const pending = ctx.run("launcherPrepareLogin()"); await ctx.flush();
  el("lg-connect-once").click(); const login = await pending;
  eq(login.account_id, null); eq(login.host, "other.example.test"); eq(login.password, "");
  eq(calls.filter(c => c.init.body).length, 0);
});

test("an edited username does not inherit another account's password-saving choice", async () => {
  const { ctx, el } = await setup(); el("lg-user").value = "another-person";
  const pending = ctx.run("launcherPrepareLogin()"); await ctx.flush();
  ok(!el("lg-confirm-password").checked);
  el("lg-connect-cancel").click(); eq(await pending, null);
});

test("an incoming character session dismisses a pending save choice without writing", async () => {
  const { ctx, calls, el } = await setup(); el("lg-user").value = "unsaved";
  const pending = ctx.run("launcherPrepareLogin()"); await ctx.flush();
  ctx.run('launcherOnAuth("characters", [])');
  eq(await pending, null); ok(!el("lg-save-prompt").open);
  eq(calls.filter(c => c.init.body).length, 0);
});

