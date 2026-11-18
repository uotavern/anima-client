const { newContext } = require("./harness.js");
const { test, ok, eq, deepEq, throws } = require("./run.js");
const GEOMETRY = "anima.winGeom", ENVELOPE = "anima.preferences.v1";
function context(values = {}, options = {}) {
  const ctx = newContext(options); ctx.mountPage();
  for (const [key, value] of Object.entries(values)) ctx.localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  ctx.loadAll(); return ctx;
}
function frame(ctx, cls = "fixture-win", resizable = true) {
  ctx.set("fixtureClass", cls); ctx.set("fixtureResizable", resizable);
  return ctx.run('makeWindowFrame({cls:fixtureClass,title:"Fixture",resizable:fixtureResizable,pos:{left:30,top:40}})');
}
function saved(ctx) { return JSON.parse(JSON.parse(ctx.localStorage.getItem(ENVELOPE)).values[GEOMETRY]); }

test("malformed saved window geometry cannot prevent dialogs from opening", () => {
  for (const original of ["null", "[]", "17", '"bad"', '{".fixture-win":null}', '{".fixture-win":{"left":"far","top":10,"w":-1,"h":100}}']) {
    const ctx = context({ [GEOMETRY]: original });
    const win = frame(ctx);
    eq(win.el.style.left, "30px"); eq(win.el.style.top, "40px");
    ok(!win.body.style.width); ok(!ctx.document.getElementById("preference-warning").hidden);
    eq(ctx.localStorage.getItem(GEOMETRY), original, "bad source is not overwritten by opening a window");
    ctx.run("preferenceStorage.recover()");
    eq(JSON.parse(ctx.localStorage.getItem(ENVELOPE)).recovery.source.legacy[GEOMETRY], original);
  }
});

test("window positions and sizes participate in settings backup and restore", () => {
  const geometry = { ".fixture-win": { left: 75, top: 90, w: 240, h: 120 } };
  const ctx = context({ [GEOMETRY]: geometry });
  const backup = JSON.parse(ctx.run("preferenceStorage.exportData()"));
  deepEq(JSON.parse(backup.values[GEOMETRY]), geometry);
  const destination = context(); destination.set("geometryBackup", JSON.stringify(backup));
  destination.run("preferenceStorage.replace(preferenceStorage.parseBackup(geometryBackup), preferenceStorage.source())");
  const win = frame(destination);
  eq(win.el.style.left, "75px"); eq(win.el.style.top, "90px");
  eq(win.body.style.width, "240px"); eq(win.body.style.height, "120px");
});

test("geometry added after an older settings migration is adopted without losing other groups", () => {
  const old = { version: 1, values: { "anima.settings": '{"music":false}' } };
  const geometry = { ".fixture-win": { left: 80, top: 100 } };
  const ctx = context({ [ENVELOPE]: old, [GEOMETRY]: geometry });
  eq(frame(ctx).el.style.left, "80px");
  ctx.run('saveWinGeom(".fixture-win", {w:300,h:200})');
  const record = JSON.parse(ctx.localStorage.getItem(ENVELOPE));
  eq(JSON.parse(record.values["anima.settings"]).music, false);
  deepEq(saved(ctx)[".fixture-win"], { left: 80, top: 100, w: 300, h: 200 });
  ok(record.migratedKeys.includes(GEOMETRY));
  deepEq(JSON.parse(ctx.localStorage.getItem(GEOMETRY)), geometry);
});

test("restoring a backup without geometry does not resurrect its untouched legacy source", () => {
  const geometry = { ".fixture-win": { left: 150, top: 160 } };
  const ctx = context({ [GEOMETRY]: geometry });
  ctx.run("preferenceStorage.replace({}, preferenceStorage.source())");
  const restarted = context({ [GEOMETRY]: geometry, [ENVELOPE]: ctx.localStorage.getItem(ENVELOPE) });
  eq(frame(restarted).el.style.left, "30px");
  const previous = restarted.run("preferenceStorage.parseBackup(preferenceStorage.previousData())");
  deepEq(JSON.parse(previous[GEOMETRY]), geometry, "the explicit previous copy still restores it");
});

test("geometry saves merge another window's newer positions and retain this window's size", () => {
  const initial = { ".fixture-win": { left: 15, top: 20, w: 100, h: 80 } };
  const first = context({ [GEOMETRY]: initial }), second = context({ [GEOMETRY]: initial });
  first.run('saveWinGeom(".other-win", {left:300,top:210})');
  second.localStorage.setItem(ENVELOPE, first.localStorage.getItem(ENVELOPE));
  second.run('saveWinGeom(".fixture-win", {left:50,top:60})');
  deepEq(saved(second)[".other-win"], { left: 300, top: 210 });
  deepEq(saved(second)[".fixture-win"], { left: 50, top: 60, w: 100, h: 80 });
});

test("failed geometry saves remain usable and exportable while the stored original stays intact", () => {
  const original = JSON.stringify({ ".fixture-win": { left: 50, top: 60 } });
  const ctx = context({ [GEOMETRY]: original });
  ctx.localStorage.setItem = () => { throw new Error("Quota exceeded"); };
  ctx.run('saveWinGeom(".fixture-win", {left:200,top:220})');
  eq(frame(ctx).el.style.left, "200px");
  eq(ctx.localStorage.getItem(GEOMETRY), original); eq(ctx.localStorage.getItem(ENVELOPE), null);
  const exported = JSON.parse(ctx.run("preferenceStorage.exportData()"));
  eq(JSON.parse(exported.values[GEOMETRY])[".fixture-win"].top, 220);
  ok(ctx.run("preferenceStorage.status().pending") > 0);
});

test("a restored offscreen window keeps a reachable title bar on a smaller display", () => {
  const ctx = context({ [GEOMETRY]: { ".fixture-win": { left: 5000, top: 4000 } } }, { width: 600, height: 400 });
  const win = frame(ctx);
  ok(parseFloat(win.el.style.left) <= 560); ok(parseFloat(win.el.style.top) <= 376);
});

test("invalid geometry in a backup is rejected before any preference replacement", () => {
  const ctx = context();
  ctx.set("badGeometryBackup", JSON.stringify({ format: "anima-preferences", version: 1, values: { [GEOMETRY]: '{".fixture-win":{"left":5,"top":null}}' } }));
  throws(() => ctx.run("preferenceStorage.parseBackup(badGeometryBackup)"), /invalid values/);
  eq(ctx.localStorage.getItem(ENVELOPE), null);
});

const CHARACTER_GEOMETRY = "anima.characterWinGeom";
async function bind(ctx, identity = '["native-v1","fixture.invalid",2593,0,"account"]', serial = 42) {
  ctx.set("crypto", require("node:crypto").webcrypto);
  ctx.set("layoutScene", { layoutIdentity: identity, player: { serial } });
  await ctx.run("bindCharacterGeometry(layoutScene)");
  return ctx.run("characterGeometryKey");
}

test("character layouts inherit common geometry without rewriting it and survive restart", async () => {
  const common = { ".fixture-win": { left: 70, top: 80, w: 200, h: 100 } };
  const first = context({ [GEOMETRY]: common });
  const key = await bind(first);
  eq(frame(first).el.style.left, "70px");
  first.run('saveWinGeom(".fixture-win", {left:220,top:180})');
  const record = JSON.parse(first.localStorage.getItem(ENVELOPE));
  deepEq(JSON.parse(record.values[GEOMETRY]), common);
  const restart = context({ [ENVELOPE]: record });
  eq(await bind(restart), key);
  const win = frame(restart);
  eq(win.el.style.left, "220px"); eq(win.body.style.width, "200px");
  const backup = first.run("preferenceStorage.exportData()");
  ok(!backup.includes("fixture.invalid")); ok(!backup.includes("account"));
});

test("different characters accounts and destinations have separate window geometry", async () => {
  const first = context(); const key = await bind(first);
  first.run('saveWinGeom(".fixture-win", {left:240,top:190})');
  for (const [identity, serial] of [
    ['["native-v1","fixture.invalid",2593,0,"account"]', 43],
    ['["native-v1","other.invalid",2593,0,"account"]', 42],
    ['["native-v1","fixture.invalid",2594,0,"account"]', 42],
    ['["native-v1","fixture.invalid",2593,1,"account"]', 42],
    ['["native-v1","fixture.invalid",2593,0,"other"]', 42],
  ]) {
    const next = context({ [ENVELOPE]: first.localStorage.getItem(ENVELOPE) });
    ok(await bind(next, identity, serial) !== key);
    eq(frame(next).el.style.left, "30px");
    next.run('saveWinGeom(".fixture-win", {left:90,top:100})');
    eq(JSON.parse(JSON.parse(next.localStorage.getItem(ENVELOPE)).values[CHARACTER_GEOMETRY])[key][".fixture-win"].left, 240);
  }
});

test("character layouts participate in backup recovery and update already initialized panels", async () => {
  const source = context(); await bind(source);
  source.run('saveWinGeom(".fixture-win", {left:180,top:190,w:310,h:220})');
  const backup = source.run("preferenceStorage.exportData()");
  const restored = context(); restored.set("layoutBackup", backup);
  restored.run("preferenceStorage.replace(preferenceStorage.parseBackup(layoutBackup), preferenceStorage.source())");
  const win = frame(restored); eq(win.el.style.left, "30px");
  await bind(restored); eq(win.el.style.left, "180px");
  eq(win.body.style.width, "310px"); eq(win.body.style.height, "220px");
  const previous = restored.run("preferenceStorage.parseBackup(preferenceStorage.previousData())");
  ok(!previous[CHARACTER_GEOMETRY]);
});

test("failed character layout writes stay exportable without damaging stored layouts", async () => {
  const ctx = context(); const key = await bind(ctx);
  ctx.run('saveWinGeom(".fixture-win", {left:100,top:110})');
  const original = ctx.localStorage.getItem(ENVELOPE);
  ctx.localStorage.setItem = () => { throw new Error("Quota exceeded"); };
  ctx.run('saveWinGeom(".fixture-win", {left:200,top:210})');
  eq(ctx.localStorage.getItem(ENVELOPE), original);
  eq(frame(ctx).el.style.left, "200px");
  const backup = JSON.parse(ctx.run("preferenceStorage.exportData()"));
  eq(JSON.parse(backup.values[CHARACTER_GEOMETRY])[key][".fixture-win"].left, 200);
});

test("invalid character geometry is preserved and rejects backup replacement", async () => {
  const bad = JSON.stringify({ ["a".repeat(64)]: { ".fixture-win": { left: null, top: 10 } } });
  const record = { version: 1, values: { [CHARACTER_GEOMETRY]: bad } };
  const ctx = context({ [ENVELOPE]: record }); await bind(ctx);
  eq(frame(ctx).el.style.left, "30px");
  ctx.run('saveWinGeom(".fixture-win", {left:100,top:110})');
  eq(ctx.localStorage.getItem(ENVELOPE), JSON.stringify(record));
  ok(ctx.run("preferenceStorage.status().recoverable"));
  ctx.set("invalidBackup", JSON.stringify({ format: "anima-preferences", version: 1, values: record.values }));
  throws(() => ctx.run("preferenceStorage.parseBackup(invalidBackup)"), /invalid values/);
});


test("server dialog kinds isolate sizes while preserving legacy shared geometry", () => {
  const legacy = {left:50,top:60,w:275,h:200};
  const ctx = context({[GEOMETRY]: {".dialog-win": legacy}});
  ctx.run('__small = buildGumpWindow({serial:1,gumpId:10,w:200,h:100,elements:[]})');
  ok(!ctx.run('__small.el.querySelector(".gump-body").style.width'), "ambiguous legacy size is not inherited");
  ctx.run('saveWinGeom(winKey(__small.el), {left:30,top:40,w:210,h:110})');
  ctx.run('__large = buildGumpWindow({serial:2,gumpId:20,w:600,h:480,elements:[]})');
  ok(!ctx.run('__large.el.querySelector(".gump-body").style.width'), "different kind keeps natural content size");
  eq(ctx.run('__large.canvas.style.width'), '600px');
  ctx.run('__reopen = buildGumpWindow({serial:99,gumpId:10,w:200,h:100,elements:[]})');
  eq(ctx.run('__reopen.el.querySelector(".gump-body").style.width'), '210px');
  eq(ctx.run('__reopen.el.querySelector(".gump-body").style.height'), '110px');
  eq(ctx.run('__reopen.el.style.left'), '30px');
  deepEq(saved(ctx)['.dialog-win'], legacy, "old config remains available in backup");
  deepEq(saved(ctx)['.dialog-win-10'], {left:30,top:40,w:210,h:110});
});
