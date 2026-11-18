const { newContext } = require('./harness.js');
const { test, eq, ok, includes } = require('./run.js');
const catalog = { walls:[{category:1,items:[{comment:'Stone',graphics:[100,101,0,-1,16384]}]}], doors:[], floors:[],
  stairs:[{comment:'Stone stairs',graphics:[200,201,202,203,204,205,206,207,208],multis:[1000,1001,1002,1003]}],
  teleporters:[{comment:"Teleporter",graphics:[400]}], roofs:[{category:1,items:[{comment:'Slate',graphics:[300]}]}],misc:[] };
function setup() {
  const ctx=newContext();ctx.mountPage();ctx.loadAll();const sent=[];
  ctx.setFetch((url,init) => { if(String(url)==='/input')sent.push(init.body); return String(url)==='/housecatalog'?catalog:{}; });
  ctx.run(`sceneTransportAvailable=true; scene={sessionId:'own-session',houseDesign:{serial:123,revision:1,floors:3,floor:1,floorZ:7,x:100,y:100,z:10,tilesReady:true,bounds:{minX:-3,maxX:3,minY:-3,maxY:3},tiles:[{graphic:100,x:0,y:0,z:7},{graphic:300,x:1,y:1,z:10}]}}; hdesignCatalog=${JSON.stringify(catalog)}; syncDialogs(scene);`);
  ctx.sent=sent;return ctx;
}
const win=ctx=>ctx.run('hdesignWin');
test('house catalog pieces are named native toggle controls; unsupported graphics cannot be picked',()=>{
 const c=setup(), buttons=win(c).grid.querySelectorAll('button');eq(buttons.length,2);eq(buttons[0].tagName,'BUTTON');
 includes(buttons[0].getAttribute('aria-label'),'Stone');eq(buttons[0].getAttribute('aria-pressed'),'false');buttons[0].click();eq(buttons[0].getAttribute('aria-pressed'),'true');
 eq(win(c).el.querySelector('.gump-close button').getAttribute('aria-label'),'Exit house design');
});
test('switching category clears stale placement and Escape clears tools without exiting',()=>{
 const c=setup();win(c).grid.querySelector('button').click();win(c).el.querySelector('[data-mode="roof"]').click();eq(c.run('hdesignPiece'),null);
 win(c).grid.querySelector('button').click();c.fire(win(c).el,'keydown',{key:'Escape',bubbles:true});eq(c.run('hdesignPiece'),null);eq(c.sent.length,0);
});
test('toolbar fallback has one tab stop and arrows wrap without changing selection',()=>{
 const c=setup(),bar=win(c).el.querySelector('.hdesign-tabs'),buttons=bar.querySelectorAll('button');
 eq(buttons.filter(b=>b.tabIndex===0).length,1);c.fire(buttons[0],'keydown',{key:'ArrowLeft',bubbles:true});eq(c.document.activeElement,buttons[6]);eq(c.run('hdesignMode'),'wall');
});
test('actual eraser tile does not need a palette selection and uses foundation-relative z',async()=>{
 const c=setup();c.run('hdesignEraser=true; handleHouseDesignStatic({x:100,y:100,z:17,g:100});');await c.flush();eq(c.sent[0],'hdesign:del:100:0:0:7');
 ok(c.run('hdesignPending !== null'));includes(win(c).status.textContent,'waiting for the server');
});
test('roof placement uses chosen roof offset; deletion uses actual tile z',async()=>{
 const c=setup();win(c).el.querySelector('[data-mode="roof"]').click();win(c).grid.querySelector('button').click();c.run('hdesignRoofZ=12; applyHouseDesignTile(1,1)');await c.flush();eq(c.sent[0],'hdesign:roof:300:1:1:12');
 c.run('hdesignPending=null; hdesignEraser=true; applyHouseDesignTile(1,1)');await c.flush();eq(c.sent[1],'hdesign:roofdel:300:1:1:10');
});
test('stair assembly uses multi id while individual block uses item id',async()=>{
 const c=setup();win(c).el.querySelector('[data-mode="stair"]').click();const buttons=win(c).grid.querySelectorAll('button');buttons[0].click();c.run('applyHouseDesignTile(0,0)');await c.flush();eq(c.sent[0],'hdesign:stair:1000:0:0');
 c.run('hdesignPending=null');buttons[4].click();c.run('applyHouseDesignTile(0,0)');await c.flush();eq(c.sent[1],'hdesign:add:204:0:0');
});
test('outside, fractional and not-yet-loaded foundation tiles never send edits',()=>{
 const c=setup();win(c).grid.querySelector('button').click();c.run('applyHouseDesignTile(99,0);applyHouseDesignTile(.5,0);scene.houseDesign.tilesReady=false;applyHouseDesignTile(0,0)');eq(c.sent.length,0);includes(win(c).status.textContent,'loaded foundation');
});
test('duplicate edits are gated until server revision; confirmation never claims commit',async()=>{
 const c=setup();win(c).grid.querySelector('button').click();c.run('applyHouseDesignTile(0,0);applyHouseDesignTile(1,0)');await c.flush();eq(c.sent.length,1);
 c.run('scene.houseDesign.revision=2;syncDialogs(scene)');eq(c.run('hdesignPending'),null);includes(win(c).status.textContent,'Commit when ready');
});
test('no revision produces bounded unconfirmed feedback without repeating edits',async()=>{
 const c=setup();win(c).grid.querySelector('button').click();c.run('applyHouseDesignTile(0,0)');await c.flush();c.advance(5001);eq(c.sent.length,1);eq(c.run('hdesignPending'),null);includes(win(c).status.textContent,'No design change confirmed');
});
test('server floor update preserves picker and sets authoritative floor buttons',()=>{
 const c=setup(),grid=win(c).grid;grid.querySelector('button').click();c.run('scene.houseDesign.floor=2;scene.houseDesign.floorZ=27;syncDialogs(scene)');eq(win(c).grid,grid);eq(c.run('hdesignFloor'),2);eq(win(c).el.querySelector('.hdesign-floor-value').textContent,'2');
});
test('disconnected or stale design session cannot submit housing commands',async()=>{
 const c=setup();c.run('sceneTransportAvailable=false;hdesignSend("commit","Commit")');await c.flush();eq(c.sent.length,0);includes(win(c).status.textContent,'Not connected');
});
test('failed command retains design and reports recovery without automatic retry',async()=>{
 const c=setup();c.setFetch(()=>({ok:false,status:409}));await c.run('hdesignSend("backup","Backup")');ok(win(c));eq(c.run('hdesignBusy'),false);includes(win(c).status.textContent,'Resync before trying');
});
test('commit and clear cancellation never send commands',()=>{
 const c=setup();c.answer.confirm=false;win(c).el.querySelector('[data-cmd="commit"]').click();win(c).el.querySelector('[data-cmd="clear"]').click();eq(c.sent.length,0);
});
test('catalog failure shows retry and recovers without closing editor',async()=>{
 const c=setup();c.run('hdesignCatalog=null;hdesignCatalogPromise=null');c.setFetch(()=>({ok:false,status:503}));await c.run('loadHouseCatalog()');eq(win(c).retry.hidden,false);includes(win(c).status.textContent,'could not load');
 c.setFetch(()=>catalog);win(c).retry.click();await c.flush();eq(win(c).retry.hidden,true);eq(win(c).grid.querySelectorAll('button').length,2);
});


test('floor requests block placement until the requested server floor arrives',async()=>{
 const c=setup();win(c).grid.querySelector('button').click();await c.run('hdesignSend("floor:2","Floor requested")');c.run('applyHouseDesignTile(0,0)');eq(c.sent.length,1);
 c.run('scene.houseDesign.floor=2;scene.houseDesign.floorZ=27;syncDialogs(scene);applyHouseDesignTile(0,0)');await c.flush();eq(c.sent[1],'hdesign:add:100:0:0');
});
test('teleporters are discoverable and send ordinary item placement',async()=>{
 const c=setup();win(c).el.querySelector('[data-mode="teleporter"]').click();win(c).grid.querySelector('button').click();c.run('applyHouseDesignTile(0,0)');await c.flush();eq(c.sent[0],'hdesign:add:400:0:0');
});
test('old session response cannot mark a new editor as changed',async()=>{
 const c=setup();let resolve;c.setFetch(()=>new Promise(r=>{resolve=r;}));const pending=c.run('hdesignSend("add:100:0:0","Place",true)');
 c.run('closeHouseDesignWindow();hdesignSerial=123;buildHouseDesignWindow(scene.houseDesign)');resolve({});await pending;eq(c.run('hdesignPending'),null);eq(win(c).status.textContent,'');
});
