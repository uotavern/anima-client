const { newContext } = require('./harness.js');
const { test, eq, ok } = require('./run.js');
function setup(elements) {
  const ctx = newContext(); ctx.mountPage(); ctx.loadAll();
  ctx.run(`__win = buildGumpWindow(${JSON.stringify({serial:123,gumpId:9,w:500,h:300,elements})});`);
  return ctx;
}
const button = (extra={}) => ({t:'button',x:25,y:80,id:1,pageflag:1,page:1,...extra});
const label = (extra={}) => ({t:'text',x:60,y:80,s:'Accept',page:1,...extra});
test('gump reply names use sanitized visible labels with stable references', () => {
  const ctx=setup([button(),label({s:'<b>Accept</b>'})]);
  const btn=ctx.run('__win.nodes[0]'), text=ctx.run('__win.nodes[1]');
  eq(btn.getAttribute('aria-labelledby'),text.id);
  eq(text.textContent,'Accept');
  eq(btn.getAttribute('aria-label'),'Reply 1');
});
test('ambiguous, distant and cross-page labels retain neutral reply names', () => {
  for(const elements of [[button(),label(),label({s:'Decline'})], [button(),label({page:2})], [button(),label({x:200})], [button(),button({x:27,id:2}),label()]]) {
    const ctx=setup(elements);
    eq(ctx.run('__win.nodes[0].getAttribute("aria-labelledby")'),null);
  }
});
test('item-art controls are native buttons and page navigation stays local', () => {
  const ctx=setup([{t:'btnart',x:25,y:80,id:9,pf:0,param:2,page:1,art:1},label({s:'Next'}),label({page:2,s:'Second page'})]);
  const btn=ctx.run('__win.nodes[0]');
  eq(btn.tagName,'BUTTON'); eq(btn.type,'button');
  eq(btn.getAttribute('aria-label'),'Go to page 2');
  btn.click(); eq(ctx.run('__win.page'),2);
  eq(ctx.run('__win.nodes[0].style.display'),'none');
  eq(ctx.run('__win.nodes[2].style.display'),'');
});
test('labels in separate open gumps have unique ids', () => {
  const ctx=setup([button(),label()]);
  ctx.run(`__other = buildGumpWindow(${JSON.stringify({serial:124,gumpId:9,elements:[button(),label()]})})`);
  ok(ctx.run('__win.nodes[1].id !== __other.nodes[1].id'));
});
test('named item-art reply keeps exact server response identity', () => {
  const ctx=setup([{t:'btnart',x:25,y:80,id:21,pf:1,page:1,art:1},label({s:'Quick preparation'})]);
  const sent=[];
  ctx.setFetch((url, init) => { if(String(url)==='/input') sent.push(String(init.body)); return {}; });
  ctx.run('__win.nodes[0].click()');
  eq(sent.length,1);
  ok(sent[0].includes('gump:123:9:21'));
});
