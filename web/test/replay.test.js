const { newContext } = require('./harness.js');
const { test, eq, throws, ok } = require('./run.js');

test('replay rejects archives without visual track and broken time ordering', () => {
  const ctx = newContext({ search: '?replay=1' }).load('00-state.js', '15-replay.js');
  ctx.set('record', JSON.stringify({type:'header',schema:1,seq:0,t:0}));
  throws(() => ctx.run('replayParse(record)'), /visual track/);
  ctx.set('record', '{"seq":0,"t":2}\n{"seq":1,"t":1}');
  throws(() => ctx.run('replayParse(record)'), /timeline/);
});
test('replay clock is frozen independently of wall time and refuses live commands', () => {
  const ctx = newContext({ search: '?replay=1' }).loadAll();
  ctx.run('replayClockMs = 1234');
  ctx.setNow(9000); eq(ctx.run('visualNow()'), 1234);
  ctx.run('sendInput("say:[Duel")');
  eq(ctx.sockets.length, 0);
});
test('replay timeline selects the newest state at or before seek', () => {
  const ctx = newContext().load('00-state.js', '15-replay.js');
  eq(ctx.run('replayAt([{t:10,v:1},{t:20,v:2}], 19).v'),1);
  eq(ctx.run('replayAt([{t:10,v:1},{t:20,v:2}], 20).v'),2);
  eq(ctx.run('replayAt([{t:10}], 0)'),null);
  ok(!ctx.run('REPLAY_MODE'));
});

test('replay decodes wire hue, blend and reversed animation without changing them', () => {
  const ctx = newContext().load('00-state.js', '15-replay.js');
  ctx.set('atob', value => Buffer.from(value, 'base64').toString('binary'));
  const fx = Buffer.alloc(36); fx[0] = 0xc0; fx[1] = 3;
  fx.writeUInt32BE(123,2); fx.writeUInt16BE(0x376a,10); fx.writeUInt32BE(33,28); fx.writeUInt32BE(8,32);
  ctx.set('row', {seq:7,t:500,packet:fx.toString('base64')});
  eq(ctx.run('replayDecode(row).hue'),33); eq(ctx.run('replayDecode(row).blend'),1);
  const act = Buffer.alloc(14); act[0]=0x6e; act.writeUInt32BE(123,1); act.writeUInt16BE(16,5); act[11]=1; act[13]=2;
  ctx.set('row', {seq:8,t:600,packet:act.toString('base64')});
  eq(ctx.run('replayDecode(row).act'),16); eq(ctx.run('replayDecode(row).fwd'),false);
  eq(ctx.run('replayDecode(row).delay'),2);
});

test('replay speech follows pause, expiry and seeking without duplicates', () => {
  const ctx = newContext({ search: '?replay=1' }).loadAll();
  ctx.run(`
    replayData = {end:{t:20000}, speech:[
      {seq:1,t:1000,actor:57,text:'Vas Ort Flam',messageType:10,hue:33},
      {seq:2,t:2000,actor:58,text:'Good luck!',messageType:0,hue:44}
    ]};
    drawOverheads = () => {};
    addOverhead = (id,text,type,hue,born) => overheads.push({id,text,type,hue,born});
    replayTime = 2500; replayClockMs = 3500; replayDrawSpeech();
  `);
  eq(ctx.run('overheads.length'), 2);
  eq(ctx.run('overheads[0].born'), 2000);
  eq(ctx.run('overheads[1].text'), 'Good luck!');
  ctx.setNow(100000); ctx.run('replayDrawSpeech()');
  eq(ctx.run('overheads.length'), 2);
  ctx.run('replaySeek(500); replayDrawSpeech()');
  eq(ctx.run('overheads.length'), 0);
  ctx.run('replaySeek(2500); replayDrawSpeech()');
  eq(ctx.run('overheads.length'), 2);
  ctx.run('replaySeek(15000); replayDrawSpeech()');
  eq(ctx.run('overheads.length'), 0);
});

test('replay sound emits crossed cues once, stays silent while paused and skips seek history', () => {
  const ctx = newContext({search:'?replay=1'}).loadAll();
  ctx.run(`
    globalThis.played = [];
    playSfx = (id,x,y) => played.push(id); loadSfx = () => {};
    replayData = {end:{t:10000},visuals:[{t:100,sound:42},{t:800,sound:43}]};
    replayPlaying = true; replayTime = 500; replayPlaySounds(); replayPlaySounds();
  `);
  eq(ctx.run('played.join()'), '42');
  ctx.run('replayPlaying = false; replayTime = 900; replayPlaySounds()');
  eq(ctx.run('played.join()'), '42');
  ctx.run('replaySeek(900); replayPlaying = true; replayPlaySounds()');
  eq(ctx.run('played.join()'), '42');
  ctx.run('replaySeek(0); replayTime = 900; replayPlaySounds()');
  eq(ctx.run('played.join()'), '42,42,43');
});

test('replay status labels track paralysis, cure and death', () => {
  const ctx = newContext({search:'?replay=1'}).loadAll();
  ctx.run(`app = new PIXI.Application(); app.renderer = {width:800,height:600};
    replayDrawStatus([{serial:57,alive:true,paralyzed:true,x:1,y:1,z:0}]);`);
  eq(ctx.run('replayStatusLabels.get(57).textContent'), 'PARALYZED');
  ctx.run('replayDrawStatus([{serial:57,alive:true,paralyzed:false,x:1,y:1,z:0}])');
  eq(ctx.run('replayStatusLabels.size'), 0);
  ctx.run('replayDrawStatus([{serial:57,alive:false,paralyzed:true,x:1,y:1,z:0}])');
  eq(ctx.run('replayStatusLabels.size'), 0);
});

test('replay accepts real spell and public speech types but excludes private channels', () => {
  const ctx = newContext().load('00-state.js','15-replay.js');
  const rows = [
    {type:'header',schema:1,visualVersion:1,id:'a',players:[{serial:1},{serial:2}],arena:{floor:[1,1,2,2]}},
    {type:'frame',players:[{serial:1},{serial:2}]},
    ...[0,2,8,9,10,13].map(messageType => ({type:'speech',actor:1,text:'Test',messageType})),
    {type:'end',id:'a',complete:true,dropped:0}
  ].map((r,seq) => ({...r,seq,t:seq}));
  ctx.set('record', rows.map(r=>JSON.stringify(r)).join('\n'));
  eq(ctx.run('replayParse(record).speech.map(s=>s.messageType).join()'),'0,2,9,10');
});

test('replay preloads energy bolt, potion, impact and all lightning frames', () => {
  const ctx = newContext().loadAll();
  ctx.run(`replayArt.set(14239,{frames:[14239,14240]}); replayArt.set(0x36cb,{frames:[0x36cb,0x36cc]})`);
  ctx.set('data',{visuals:[{kind:0,g:14239,hue:5,explodes:true},{kind:0,g:3853,hue:0},{kind:1,g:0,hue:0}]});
  eq(ctx.run('replayEffectUrls(data).length'),15);
  ok(ctx.run("replayEffectUrls(data).includes('art/static/14240.png?hue=5&fx=1')"));
  ok(ctx.run("replayEffectUrls(data).includes('gump/20009.png?v=lightning-2')"));
});
test('potion countdown follows holding, flight, landing, explosion and a reused stack', () => {
  const ctx = newContext().loadAll();
  ctx.set('track',[
    {t:0,phase:'prime',count:-1,pos:[10,10,0],holder:1},
    {t:100,phase:'tick',count:3,pos:[10,10,0],holder:1},
    {t:200,phase:'throw',count:-1,flight:true,from:[10,10,0],pos:[20,10,0]},
    {t:1100,phase:'tick',count:2,flight:true,pos:[20,10,0]},
    {t:1200,phase:'land',count:-1,flight:false,pos:[20,10,0]},
    {t:3000,phase:'explode',count:0,pos:[20,10,0]},
    {t:4000,phase:'prime',count:-1,pos:[10,10,0],holder:1}
  ]);
  eq(ctx.run('replayPotionAt(track,700).count'),3);
  eq(ctx.run('replayPotionAt(track,700).pos[0]'),15);
  eq(ctx.run('replayPotionAt(track,1500).count'),2);
  eq(ctx.run('replayPotionAt(track,3000)'),null);
  eq(ctx.run('replayPotionAt(track,4000).count'),-1);
});
test('replay resource panels use recorded HP mana stamina and refresh after seeking', () => {
  const ctx = newContext().loadAll();
  ctx.run(`const host=document.createElement('div'); host.id='replay-stats'; document.body.appendChild(host);
    replayDrawStats([{name:'Mage',hits:42,hitsMax:100,mana:17,manaMax:100,stam:5,stamMax:25}]);`);
  eq(ctx.run("document.getElementById('replay-stats').children[0].children[2].children[1].textContent"),'Mana 17 / 100');
  eq(ctx.run("document.getElementById('replay-stats').children[0].children[3].children[0].style.width"),'20%');
  ctx.run("replayDrawStats([{name:'Mage',hits:100,hitsMax:100,mana:100,manaMax:100,stam:25,stamMax:25}])");
  eq(ctx.run("document.getElementById('replay-stats').children[0].children[1].getAttribute('aria-valuenow')"),'100');
});

test('moving art stays above terrain and potion travel uses recorded landing time', () => {
  const ctx = newContext({search:'?replay=1'}).loadAll();
  ctx.run(`world=new PIXI.Container(); texFor=()=>({width:6,height:28});
    spawnEffect({kind:0,g:14239,sx:10,sy:10,sz:0,tx:16,ty:10,tz:0,speed:7,travelMs:1000},1000);
    drawEffects(1500);`);
  eq(ctx.run('fxEffects[0].sprite.x'),ctx.run('isoX(13,10)'));
  eq(ctx.run('fxEffects[0].sprite.y'),ctx.run('isoY(13,10,0)-HALF'));
  eq(ctx.run('fxEffects[0].totalMs'),1000);
});

test('replay outcome uses recorded winner and distinguishes interrupted games and draws', () => {
  const ctx = newContext().load('00-state.js', '15-replay.js');
  ctx.set('result', {header:{players:[{serial:1,name:'A'},{serial:2,name:'B'}]},end:{winner:2,score:[0,1]}});
  eq(ctx.run('replayOutcome(result).title'),'B wins!');
  eq(ctx.run('replayOutcome(result).detail'),'A 0 — B 1');
  ctx.run('result.end.aborted="disconnect"');
  eq(ctx.run('replayOutcome(result).title'),'Match interrupted');
  ctx.run('result.end.aborted=null; result.end.winner=0');
  eq(ctx.run('replayOutcome(result).title'),'Draw');
});

test('thrown potion remains opaque through flight and expires at recorded landing', () => {
  const ctx = newContext({search:'?replay=1'}).loadAll();
  ctx.run(`world=new PIXI.Container(); texFor=()=>({width:32,height:32});
    spawnEffect({kind:0,g:0xf0d,sx:10,sy:10,sz:0,tx:16,ty:10,tz:0,speed:7,travelMs:1028},1000);
    drawEffects(2000);`);
  eq(ctx.run('fxEffects[0].sprite.alpha'),1);
  eq(ctx.run('fxEffects[0].totalMs'),1028);
  ok(ctx.run('fxEffects[0].sprite.visible'));
  ctx.run('drawEffects(2028)'); eq(ctx.run('fxEffects.length'),0);
  ctx.run(`spawnEffect({kind:0,g:0x379f,sx:10,sy:10,sz:0,tx:16,ty:10,tz:0,speed:7,travelMs:1000},3000);drawEffects(3900);`);
  ok(ctx.run('fxEffects[0].sprite.alpha < 1'));
});
