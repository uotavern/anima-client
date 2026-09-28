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
