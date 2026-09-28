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
