const { newContext } = require("./harness.js");
const { test, ok, eq, deepEq } = require("./run.js");
function editor() {
  const ctx = newContext(); ctx.mountPage(); ctx.loadAll();
  ctx.run('macros = []; setupMacroEditor(); document.getElementById("mc-preset").value = "mage";');
  return ctx;
}
test("presets preserve existing keys and all installed actions actually exist", () => {
  const c = editor();
  c.run('macros = [{id:"old", name:"My heal", key:"F1", actions:[{t:"say", text:"old"}]}]; installMacroPreset();');
  eq(c.run('macros.length'), 8);
  eq(c.run('macros[0].name'), "My heal");
  ok(c.run('macros.every(m => macroActions(m).every(a => MACRO_VERB.has(a.t)))'));
  c.run('installMacroPreset()'); eq(c.run('macros.length'), 8, "reinstall is idempotent");
  ok(c.run('document.getElementById("mc-msg").textContent.includes("Kept existing")'));
});
test("editing changes the same binding and a duplicate trigger is refused", () => {
  const c = editor(); c.run('installMacroPreset(); editMacro(macros[0]);');
  const id = c.run('mcEditing');
  c.run('mcPending = {key:"F2"};');
  c.fire(c.document.getElementById('mc-add-btn'), 'click');
  eq(c.run('macros[0].key'), 'F1');
  ok(c.run('document.getElementById("mc-msg").textContent.includes("already bound")'));
  c.run('mcPending = {key:"Digit1"}; document.getElementById("mc-name").value="My emergency heal";');
  c.fire(c.document.getElementById('mc-add-btn'), 'click');
  eq(c.run('macros.length'), 8); eq(c.run('macros[0].id'), id);
  eq(c.run('macros[0].key'), 'Digit1');
  eq(c.run('macros[0].name'), 'My emergency heal');
  eq(c.run('macroActions(macros[0]).length'), 1, "does not append the editor's current action during edit");
});
test("disabled bindings do not run, modifiers stay distinct, and search finds names", () => {
  const c = editor(); c.run('installMacroPreset(); macros[0].enabled=false;');
  eq(c.run('macroFor({code:"F1", ctrlKey:false, altKey:false, shiftKey:false})'), null);
  eq(c.run('macroConflict({key:"F2", ctrl:true})'), undefined);
  eq(c.run('macroFor({code:"F2", ctrlKey:false, altKey:false, shiftKey:false, metaKey:true})'), null);
  c.run('document.getElementById("mc-search").value="Meditation"; renderMacroList();');
  eq(c.document.getElementById('mc-list').children.length, 1);
});
test("self-heal preset sends a targeted spell and backup opens the real panel", () => {
  const c = editor(); const sent = [];
  c.setFetch((u, init) => { if (String(u) === '/input') sent.push(init.body); return {}; });
  c.run('installMacroPreset(); runMacro(macros[0]);');
  deepEq(sent, ['tspell:29:0']);
  c.fire(c.document.getElementById('mc-backup'), 'click');
  ok(c.document.getElementById('preference-panel').open);
});
test("reserved keys are rejected and cancelling an edit leaves saved actions intact", () => {
  const c = editor(); c.run('installMacroPreset(); editMacro(macros[0]); mcSteps.push({t:"say",text:"extra"}); mcPending={key:"KeyW"};');
  c.fire(c.document.getElementById('mc-add-btn'), 'click');
  ok(c.run('document.getElementById("mc-msg").textContent.includes("reserved")'));
  c.fire(c.document.getElementById('mc-cancel-btn'), 'click');
  eq(c.run('macroActions(macros[0]).length'), 1);
  eq(c.run('mcEditing'), null);
});
