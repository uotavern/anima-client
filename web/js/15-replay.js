// Read-only server replay, composed by the same PIXI UO renderer as live play.
// No fake sprites, no simulation of combat outcomes, and no shard connection.
let replayData = null, replayTime = 0, replayPlaying = false, replayRate = 1;
let replayLastReal = 0, replayLastWorld = null, replayLastDraw = -1, replayLastSyncWall = 0;
const replaySpeechShown = new Set(), replayStatusLabels = new Map(), replayPotionLabels = new Map();
let replaySoundTime = 0;
const replayEffectTextures = new Set();
const replayLooks = new Map(), replayArt = new Map(), replaySpawned = new Set();

function replayAt(rows, t) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].t <= t) lo = mid + 1; else hi = mid; }
  return lo ? rows[lo - 1] : null;
}
function replayDecode(row) {
  const b = Uint8Array.from(atob(row.packet), c => c.charCodeAt(0));
  const d = new DataView(b.buffer), u16 = o => d.getUint16(o), u32 = o => d.getUint32(o), i8 = o => d.getInt8(o);
  const ev = { seq: row.seq, t: row.t, packetId: b[0] };
  const sizes = { 110: 14, 226: 10, 112: 28, 192: 36, 199: 49, 175: 13, 84: 12, 47: 10 };
  if (b.length !== sizes[b[0]]) throw new Error("Invalid visual packet length");
  switch (b[0]) {
    case 0x6e: return { ...ev, serial: u32(1), act: u16(5), frames: u16(7), repeat: u16(9), fwd: !b[11], loop: !!b[12], delay: b[13] };
    case 0xe2: return { ...ev, serial: u32(1), typ: u16(5), act: u16(7), mode: b[9] };
    case 0xaf: return { ...ev, serial: u32(1), corpse: u32(5) };
    case 0x2f: return { ...ev, serial: u32(2), target: u32(6) };
    case 0x54: return { ...ev, sound: u16(2), x: u16(6), y: u16(8), z: d.getInt16(10) };
    default: return { ...ev, kind: b[1], src: u32(2), tgt: u32(6), g: u16(10),
      sx: u16(12), sy: u16(14), sz: i8(16), tx: u16(17), ty: u16(19), tz: i8(21),
      speed: b[22], dur: b[23], fixed: !!b[26], explodes: !!b[27],
      hue: b.length >= 36 ? u32(28) & 0xffff : 0, blend: b.length >= 36 ? u32(32) % 7 : 0 };
  }
}
function replayParse(text) {
  if (text.length > 34 * 1024 * 1024) throw new Error("Replay is too large");
  const rows = text.trim().split('\n').map(line => JSON.parse(line));
  if (rows.length > 150001) throw new Error("Replay has too many events");
  let last = -1;
  rows.forEach((r, i) => {
    if (r.seq !== i || !Number.isFinite(r.t) || r.t < last || r.t < 0) throw new Error("Broken replay timeline");
    last = r.t;
  });
  const header = rows[0], end = rows[rows.length - 1];
  if (header?.type !== 'header' || header.schema !== 1 || header.visualVersion !== 1)
    throw new Error("This recording has no UO visual track. Record a new match with visual replay enabled.");
  if (end?.type !== 'end' || end.id !== header.id || !end.complete || end.dropped || end.t > 86400000)
    throw new Error("Replay is incomplete");
  if (!Array.isArray(header.players) || header.players.length !== 2 || !header.arena?.floor?.length)
    throw new Error("Invalid replay header");
  const tracks = new Map(header.players.map(p => [p.serial, []]));
  for (const r of rows) {
    const players = r.type === 'frame' ? r.players : r.type === 'position' ? [r.player] : [];
    for (const p of players) if (tracks.has(p.serial)) tracks.get(p.serial).push({ ...p, t: r.t, round: r.round, phase: r.phase });
  }
  if ([...tracks.values()].some(t => !t.length)) throw new Error("Missing fighter positions");
  const potions = new Map();
  for (const r of rows.filter(r => r.type === 'potion_state')) {
    if (!potions.has(r.item)) potions.set(r.item, []);
    potions.get(r.item).push(r);
  }
  return { header, end, rows, tracks, potions, loads: [header, ...rows.filter(r => r.type === 'loadout')],
    speech: rows.filter(r => r.type === 'speech' && tracks.has(r.actor) && typeof r.text === 'string' && r.text.length <= 512 && [0, 2, 9, 10].includes(r.messageType) &&
      !(/^\d+$/.test(r.text) && rows.some(p => p.type === 'potion_state' && p.phase === 'tick' && p.holder === r.actor && p.count === Number(r.text) && Math.abs(p.t-r.t) < 25))),
    worlds: rows.filter(r => r.type === 'world'), frames: rows.filter(r => r.type === 'frame'),
    visuals: rows.filter(r => r.type === 'visual').map(replayDecode) };
}
async function replayJson(url) {
  const res = await fetch(url); if (!res.ok) throw new Error(`Asset unavailable: ${res.status}`); return res.json();
}
function replayLookKey(p) { return JSON.stringify([p.body, p.hue, p.equipment]); }
async function replayLoadAppearance(p) {
  const key = replayLookKey(p); if (replayLooks.has(key)) return;
  const body = await replayJson(`replay-look.json?body=${p.body}&hue=${p.hue}`);
  const equip = [];
  let mountAnim = 0, mountOff = 0;
  for (const item of p.equipment || []) {
    const e = await replayJson(`replay-look.json?body=${p.body}&g=${item.graphic}&hue=${item.hue}`);
    if (item.layer === 25) { mountAnim = e.mountAnim; mountOff = e.mountOff; }
    equip.push({ serial: item.serial, layer: item.layer, g: item.graphic, anim: e.anim, hue: e.hue });
  }
  replayLooks.set(key, { ...body, equip: body.body >= 400 ? equip : [], mounted: mountAnim ? 1 : 0, mountAnim, mountOff });
}
function replayEffectUrls(data) {
  const urls = new Set();
  const add = (frames, hue, lightning = false) => {
    for (const g of frames) urls.add(effectTextureUrl(g, lightning ? 1 : 2, hue));
  };
  for (const ev of data.visuals) {
    if (ev.g === undefined) continue;
    if (ev.kind === 1) { add(Array.from({length:10}, (_,i) => 20000+i), 0, true); continue; }
    if (!ev.g) continue;
    add(replayArt.get(ev.g)?.frames || [ev.g], ev.hue);
    if (ev.explodes) add(replayArt.get(0x36cb)?.frames || [0x36cb], ev.hue);
  }
  return [...urls];
}
async function replayWarmEffects(data) {
  const urls = replayEffectUrls(data), deadline = performance.now() + 60000;
  if (urls.length > 1024) throw new Error('Too many combat graphics in recording');
  replayEffectTextures.clear(); for (const url of urls) replayEffectTextures.add(url);
  // A first-play bolt can expire in 150–500ms. Its textures must already exist.
  // Use the shared bounded loader, including its retry/backoff and GPU cache.
  while (urls.some(url => !texCache.has(url))) {
    for (const url of urls) texFor(url);
    if (performance.now() > deadline) throw new Error('Combat graphics could not load. Please reload the replay.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function replayLoad(text) {
  replayPlaying = false; stopSoundEffects();
  const data = replayParse(text);
  replayLooks.clear(); replayArt.clear();
  for (const load of data.loads) for (const p of load.players) await replayLoadAppearance(p);
  const graphics = new Set([0x36cb]);
  for (const e of data.visuals) if (e.g) graphics.add(e.g);
  for (const w of data.worlds) for (const item of w.items) graphics.add(item.g);
  for (const g of graphics) replayArt.set(g, await replayJson(`replay-art.json?g=${g}`));
  document.getElementById('replay-title').textContent = 'Loading combat effects…';
  await replayWarmEffects(data);
  const a = data.header.arena, f = a.floor;
  data.center = { x: f[0] + Math.floor(f[2] / 2), y: f[1] + Math.floor(f[3] / 2), z: a.z };
  data.terrain = await replayJson(`terrain.json?x=${data.center.x}&y=${data.center.y}&z=${a.z}&map=0&season=0`);
  replayData = data; replayTime = 0; replaySoundTime = -1; replayLastWorld = null; replayLastDraw = -1;
  replayResetEffects(); anim.clear(); dyingMobs.clear();
  document.getElementById('replay-seek').max = String(data.end.t);
  document.getElementById('replay-title').textContent = data.header.players.map(p => p.name).join(' vs ') + ' · ' + data.header.rules;
  document.getElementById('replay-error').textContent = '';
  document.getElementById('replay-play').textContent = 'Play';
}
function replayResetEffects() {
  for (const fx of fxEffects) { if (fx.sprite) { fx.sprite.removeFromParent(); fx.sprite.destroy(); } }
  fxEffects.length = 0; replaySpawned.clear();
  for (const o of overheads) if (o.el) o.el.remove();
  overheads.length = 0; replaySpeechShown.clear();
  for (const el of replayStatusLabels.values()) el.remove();
  replayStatusLabels.clear();
  for (const el of replayPotionLabels.values()) el.remove();
  replayPotionLabels.clear();
}
function replaySeek(t) {
  stopSoundEffects();
  replayTime = Math.max(0, Math.min(replayData?.end.t || 0, t));
  replaySoundTime = replayTime;
  replayLastDraw = -1; replayResetEffects(); anim.clear(); dyingMobs.clear();
}
function replayMobile(p, identity, track) {
  const death = replayAt(replayData.visuals.filter(e => e.serial === p.serial && e.packetId === 0xaf), replayTime);
  const fallen = death && !p.alive;
  if (fallen) {
    const previous = replayAt(replayData.loads, death.t - 1) || replayData.header;
    identity = previous.players.find(i => i.serial === p.serial) || identity;
    p = { ...(replayAt(track, death.t - 1) || p), hits: 0, alive: false };
  }
  const look = replayLooks.get(replayLookKey(identity));
  const next = track.find(row => row.t > replayTime && (row.pos[0] !== p.pos[0] || row.pos[1] !== p.pos[1]));
  let x = p.pos[0], y = p.pos[1], z = p.pos[2], moving = false;
  if (!fallen && !p.paralyzed && next && next.round === p.round && next.phase === p.phase && next.t - p.t <= 400 && Math.max(Math.abs(next.pos[0] - x), Math.abs(next.pos[1] - y)) <= 1) {
    const f = Math.max(0, Math.min(1, (replayTime - p.t) / (next.t - p.t || 1)));
    x += (next.pos[0] - x) * f; y += (next.pos[1] - y) * f; z += (next.pos[2] - z) * f; moving = true;
  }
  const m = { ...p, ...look, name: identity.name, x, y, z, dir: p.direction & 7, run: !!(p.direction & 128), noto: 5, dead: !p.alive && !fallen };
  const id = 'm' + p.serial;
  let st = anim.get(id); if (!st) { st = {}; anim.set(id, st); }
  Object.assign(st, { rx: x, ry: y, rz: z, tx: x, ty: y, z, dir: m.dir, body: m.body, at: m.at,
    fallback: notoColor(5), animMoving: moving, animPhase: moving ? (replayTime / (m.run ? 400 : 600)) % 1 : 0, mobRec: m });
  st.act = null; st.death = null;
  const action = replayAt(replayData.visuals.filter(e => e.serial === p.serial && (e.packetId === 0x6e || e.packetId === 0xe2)), replayTime);
  if (action && !moving && replayTime - action.t < 4000) {
    st.act = action.packetId === 0x6e
      ? { group: action.act, fwd: action.fwd, startMs: action.t + 1000, frameMs: CHAR_ANIM_FRAME_MS + action.delay * 10 }
      : { typed: true, typ: action.typ, action: action.act, mode: action.mode, fwd: true, startMs: action.t + 1000, frameMs: CHAR_ANIM_FRAME_MS };
  }
  if (fallen) { st.act = null; st.death = { dg: look.dg, startMs: death.t + 1000 }; }
  return m;
}
function replayDrawSpeech() {
  for (const ev of replayData.speech) {
    if (ev.t > replayTime) break;
    if (replayTime - ev.t >= Math.min(8000, 3000 + ev.text.length * 70) || replaySpeechShown.has(ev.seq)) continue;
    replaySpeechShown.add(ev.seq);
    addOverhead('m' + ev.actor, ev.text, ev.messageType, ev.hue | 0, ev.t + 1000);
  }
  drawOverheads(replayClockMs);
}
function replayDrawStatus(mobiles) {
  const fx = window.innerWidth / app.renderer.width, fy = window.innerHeight / app.renderer.height;
  for (const m of mobiles) {
    let el = replayStatusLabels.get(m.serial);
    const label = m.alive ? [m.paralyzed ? 'PARALYZED' : '', m.poisoned ? 'POISONED' : ''].filter(Boolean).join(' · ') : '';
    if (!label) { if (el) el.remove(); replayStatusLabels.delete(m.serial); continue; }
    if (!el) { el = document.createElement('div'); el.className = 'nm-label'; namesEl().appendChild(el); replayStatusLabels.set(m.serial, el); }
    el.textContent = label; el.style.color = m.paralyzed ? '#ffe16a' : '#54ed70';
    el.style.left = ((app.stage.x + isoX(m.x, m.y) * camZoom) * fx) + 'px';
    el.style.top = ((app.stage.y + (isoY(m.x, m.y, m.z) + 25) * camZoom) * fy) + 'px';
  }
}
function replayPlaySounds() {
  if (!replayPlaying) return;
  for (const ev of replayData.visuals) {
    if (ev.sound !== undefined && ev.t > replaySoundTime && ev.t <= replayTime) playSfx(ev.sound, ev.x, ev.y);
    // Warm a short lookahead without playing anything while paused/seeking.
    if (ev.sound !== undefined && ev.t > replayTime && ev.t <= replayTime + 2000) loadSfx(ev.sound);
  }
  replaySoundTime = replayTime;
}
function replayPotionAt(track, t) {
  const rows = track.filter(r => r.t <= t), last = rows.at(-1);
  if (!last || last.phase === 'explode') return null;
  const prime = rows.findLastIndex(r => r.phase === 'prime');
  const life = rows.slice(Math.max(0, prime));
  const tick = life.findLast(r => r.count >= 0);
  const thrown = life.findLast(r => r.phase === 'throw');
  let pos = last.pos;
  if (last.flight && thrown) {
    const land = track.find(r => r.t >= thrown.t && ['land','explode','prime'].includes(r.phase));
    const f = Math.max(0, Math.min(1, (t-thrown.t)/Math.max(1, (land?.t || thrown.t+1000)-thrown.t)));
    pos = thrown.from.map((v,i) => v+(thrown.pos[i]-v)*f);
  }
  return {...last, pos, count:tick?.count ?? -1};
}
function replayDrawPotions() {
  for (const [id, track] of replayData.potions) {
    const state = replayPotionAt(track, replayTime);
    let el = replayPotionLabels.get(id);
    if (!state || state.count <= 0) { if (el) el.remove(); replayPotionLabels.delete(id); continue; }
    if (!el) { el = document.createElement('div'); el.className = 'replay-fuse'; namesEl().appendChild(el); replayPotionLabels.set(id,el); }
    const holder = state.holder && anim.get('m'+state.holder);
    const p = holder ? [holder.rx,holder.ry,holder.rz ?? holder.z] : state.pos;
    el.textContent = String(state.count);
    el.style.left = ((app.stage.x + isoX(p[0],p[1])*camZoom)*window.innerWidth/app.renderer.width)+'px';
    el.style.top = ((app.stage.y + (isoY(p[0],p[1],p[2])-(holder ? 90 : state.flight ? 40 : 25))*camZoom)*window.innerHeight/app.renderer.height)+'px';
  }
}
function replayDrawStats(mobiles) {
  const host = document.getElementById('replay-stats');
  if (!host) return;
  for (let i=0; i<mobiles.length; i++) {
    const m=mobiles[i];
    let panel=host.children[i];
    if (!panel) {
      panel=document.createElement('section'); panel.className='replay-fighter';
      const name=document.createElement('strong'); panel.appendChild(name);
      for (const label of ['HP','Mana','Stamina']) {
        const row=document.createElement('div'); row.className='replay-resource';
        const text=document.createElement('span'); text.className='resource-text';
        const fill=document.createElement('div'); fill.className='resource-fill';
        row.setAttribute('role','progressbar'); row.setAttribute('aria-label',label);
        row.append(fill,text); panel.appendChild(row);
      }
      host.appendChild(panel);
    }
    panel.children[0].textContent=m.name;
    [['hits','hitsMax','HP','#bd4141'],['mana','manaMax','Mana','#3b78c9'],['stam','stamMax','Stamina','#b99a35']].forEach(([value,max,label,color],n)=>{
      const row=panel.children[n+1], current=Math.max(0,Number(m[value])||0), cap=Math.max(0,Number(m[max])||0);
      row.children[0].style.width=(cap ? Math.min(100,current/cap*100) : 0)+'%';
      row.children[0].style.background=(label==='HP' && m.poisoned) ? '#288849' : color;
      row.children[1].textContent=`${label} ${current} / ${cap}`;
      row.setAttribute('aria-label',m.name+' '+label); row.setAttribute('aria-valuenow',String(current));
      row.setAttribute('aria-valuemin','0'); row.setAttribute('aria-valuemax',String(cap));
    });
  }
}
function replayTravelMs(data, ev) {
  for (const track of data.potions.values()) {
    const thrown = track.find(r => r.phase === 'throw' && r.actor === ev.src && r.graphic === ev.g && Math.abs(r.t-ev.t) < 25);
    if (!thrown) continue;
    const landed = track.find(r => r.t >= thrown.t && ['land','explode','prime'].includes(r.phase));
    return landed ? landed.t-thrown.t : 1000;
  }
  return undefined;
}
function replayDraw() {
  if (!replayData) return;
  const data = replayData;
  replayClockMs = replayTime + 1000;
  const load = replayAt(data.loads, replayTime) || data.header;
  const mobiles = [];
  for (const identity of load.players) {
    const track = data.tracks.get(identity.serial), state = replayAt(track, replayTime) || track[0];
    mobiles.push(replayMobile(state, identity, track));
  }
  const w = replayAt(data.worlds, replayTime) || data.worlds[0];
  const corpseSerials = new Set(data.visuals.filter(e => e.packetId === 0xaf && e.t <= replayTime).map(e => e.corpse));
  const items = (w?.items || []).filter(it => !corpseSerials.has(it.serial)).map(it => {
    const art = replayArt.get(it.g) || {};
    return { ...it, x: it.pos[0], y: it.pos[1], z: it.pos[2], hue: it.hue && art.partial ? it.hue | 0x8000 : it.hue,
      pz: it.pos[2] + (art.height ? 1 : 0), a: art.frames?.length > 1 ? art.frames : undefined, ai: (art.interval || 4) * 50 };
  });
  scene = { ...data.terrain, sessionId: data.header.id, player: { ...data.center, serial: 0, body: 400, equip: [] },
    mobiles, items, contItems: [], lights: data.terrain.lights || [], journal: [], facet: 0, season: 0, light: 0,
    war: false, lastAttack: 0, combatant: 0, target: { active: 0 }, buffs: [], stats: {} };
  // Refresh the item projection even when paused: asynchronously loaded corpse/art
  // metadata can change how an existing item is drawn.
  if (w !== replayLastWorld || replayLastDraw < 0 || performance.now() - replayLastSyncWall >= 150) {
    syncWorld(scene); replayLastWorld = w; replayLastSyncWall = performance.now();
  }
  for (const ev of data.visuals) {
    if (ev.t > replayTime || replayTime - ev.t > 3000 || ev.g === undefined || replaySpawned.has(ev.seq)) continue;
    replaySpawned.add(ev.seq);
    const art = replayArt.get(ev.g), ex = replayArt.get(0x36cb);
    spawnEffect({ ...ev, travelMs: ev.kind === 0 ? replayTravelMs(data, ev) : undefined, ...(ev.kind === 0 ? {src:0,tgt:0} : {}), frames: art?.frames, interval: art?.interval, exFrames: ex?.frames, exInterval: ex?.interval }, ev.t + 1000);
  }
  app.stage.scale.set(camZoom);
  app.stage.position.set(app.screen.width / 2 - isoX(data.center.x, data.center.y) * camZoom,
    app.screen.height / 2 - isoY(data.center.x, data.center.y, data.center.z) * camZoom);
  tickAnimatedStatics(replayClockMs); drawMobs(); drawEffects(replayClockMs); drawBars(replayClockMs);
  replayDrawSpeech(); replayDrawStatus(mobiles); replayDrawPotions(); replayDrawStats(mobiles); replayPlaySounds();
  replayDrawResult(); app.render(); replayLastDraw = replayTime;
  const frame = replayAt(data.frames, replayTime);
  document.getElementById('replay-seek').value = String(Math.round(replayTime));
  document.getElementById('replay-time').textContent = `${(replayTime / 1000).toFixed(1)} / ${(data.end.t / 1000).toFixed(1)}s · ${frame?.phase || ''} ${frame?.score?.join(' – ') || ''}${frame?.showdown ? ' · SHOWDOWN' : ''}`;
}
function replayOutcome(data) {
  if (data.end.aborted) return {title:'Match interrupted', detail:String(data.end.aborted)};
  const winner = data.header.players.find(p => p.serial === data.end.winner);
  return {title:winner ? winner.name + ' wins!' : 'Draw', detail:data.header.players.map((p,i) => p.name + ' ' + (data.end.score?.[i] ?? 0)).join(' — ')};
}
function replayDrawResult() {
  const box = document.getElementById('replay-result');
  if (!box || !replayData) return;
  box.hidden = replayTime < replayData.end.t;
  if (!box.hidden) {
    const result = replayOutcome(replayData);
    box.querySelector('h2').textContent = result.title;
    box.querySelector('p').textContent = result.detail;
  }
}
async function replayFetch(url) {
  const res = await fetch(url); if (!res.ok) throw new Error(`Replay HTTP ${res.status}`);
  const reader = res.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > 34 * 1024 * 1024) throw new Error('Replay is too large'); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return new Blob(chunks).text();
}
async function replaySetupLike(id) {
  const button=document.getElementById('replay-like'), status=document.getElementById('replay-like-status');
  let value=null;
  const show=()=>{button.textContent=`${value?.liked ? '♥' : '♡'} ${value?.count ?? 'Like'}`; button.setAttribute('aria-pressed',String(!!value?.liked)); button.disabled=!value;};
  button.onclick=async()=>{
    if (!value) return;
    button.disabled=true;
    try {
      const response=await fetch('/replay-social/likes/'+id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({liked:!value.liked})});
      if(!response.ok) throw new Error('Could not save your like.');
      value=await response.json();status.textContent='';
    } catch(e){status.textContent=e.message;}
    show();
  };
  try {
    const response=await fetch('/replay-social/likes',{cache:'no-store'});
    if(!response.ok) throw new Error('Likes are temporarily unavailable.');
    value=(await response.json()).likes[id] || null;
  } catch(e){status.textContent=e.message;}
  show();
}
async function replayStart() {
  document.title = 'UO Arena Replay';
  settings.sfx = true; audioMuted = false;
  const style = document.createElement('style');
  style.textContent = 'body > :not(#map):not(#names):not(#replay-controls):not(#replay-stats):not(#replay-result):not(script):not(style){display:none!important}#replay-controls{position:fixed;left:16px;right:16px;bottom:16px;z-index:99999;background:#151b24ed;color:#eee;padding:14px;border:1px solid #94764c;border-radius:8px;font:14px system-ui}#replay-controls button,#replay-controls select{margin:8px;padding:5px}#replay-seek{width:45%}#replay-error{color:#ffb4a4}';
  style.textContent += '#replay-stats{position:fixed;top:12px;left:12px;right:12px;display:flex;justify-content:space-between;gap:12px;pointer-events:none;color:#fff;font:13px system-ui;z-index:1000}.replay-fighter{width:240px;max-width:46%;background:#101720e8;border:1px solid #927341;border-radius:6px;padding:10px}.replay-fighter strong{display:block;margin-bottom:7px}.replay-resource{position:relative;background:#20242d;border:1px solid #606573;height:20px;margin-top:4px;overflow:hidden;border-radius:3px}.resource-fill{position:absolute;height:100%}.resource-text{position:absolute;inset:0;text-align:center;line-height:20px;text-shadow:0 1px 2px #000}.replay-fuse{position:absolute;transform:translate(-50%,-100%);font:bold 18px system-ui;color:#fff;background:#a12318;border:1px solid #ffd397;border-radius:50%;min-width:25px;text-align:center;text-shadow:0 1px #000;pointer-events:none}';
  style.textContent += '#replay-result{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2000;width:min(440px,85vw);padding:28px;text-align:center;color:#fff;background:#111923f2;border:2px solid #c59e56;border-radius:12px;font:16px system-ui;box-shadow:0 16px 70px #000a}#replay-result[hidden]{display:none}#replay-result h2{color:#f5d28c}#replay-result button,#replay-result a{display:inline-block;margin:8px;padding:10px;color:#efd4a3}';
  document.head.appendChild(style);
  const result = document.createElement('section'); result.id='replay-result'; result.hidden=true; result.setAttribute('aria-live','polite');
  result.innerHTML='<h2></h2><p></p><button type="button">Watch again</button><a href="/#replays">Back to matches</a>';
  result.querySelector('button').onclick=()=>{replaySeek(0); replayPlaying=true; document.getElementById('replay-play').textContent='Pause';};
  document.body.appendChild(result);
  const stats = document.createElement('div'); stats.id = 'replay-stats'; document.body.appendChild(stats);
  const ui = document.createElement('section'); ui.id = 'replay-controls';
  ui.innerHTML = '<div id="replay-title">UO Arena Replay</div><a href="/#replays" style="color:#e5c38b">← Matches</a><button id="replay-play">Play</button><label>Speed <select id="replay-speed"><option>0.5</option><option selected>1</option><option>2</option><option>4</option></select></label><input id="replay-seek" aria-label="Replay position" type="range" min="0" max="1" value="0" step="1"><span id="replay-time"></span><button id="replay-sound">Sound on</button><button id="replay-like" aria-label="Like this replay" aria-pressed="false" disabled>♡ Like</button><span id="replay-like-status" role="status"></span><div id="replay-error" role="alert"></div>';
  document.body.appendChild(ui);
  const error = e => { document.getElementById('replay-error').textContent = e.message; console.error(e); };
  document.getElementById('replay-play').onclick = () => {
    if (!replayData) return;
    if (replayTime >= replayData.end.t) replaySeek(0);
    replayPlaying = !replayPlaying; if (!replayPlaying) stopSoundEffects(); else unlockAudio(); document.getElementById('replay-play').textContent = replayPlaying ? 'Pause' : 'Play';
  };
  document.getElementById('replay-speed').onchange = e => { replayRate = Number(e.target.value); };
  document.getElementById('replay-seek').oninput = e => replaySeek(Number(e.target.value));
  document.getElementById('replay-sound').onclick = () => {
    audioMuted = !audioMuted; if (audioMuted) stopSoundEffects(); else unlockAudio();
    document.getElementById('replay-sound').textContent = audioMuted ? 'Sound off' : 'Sound on';
  };
  let lastPaint = 0;
  function tick(real) {
    const dt = replayLastReal ? Math.min(100, real - replayLastReal) : 0; replayLastReal = real;
    if (replayPlaying && replayData) {
      replayTime = Math.min(replayData.end.t, replayTime + dt * replayRate);
      if (replayTime >= replayData.end.t) { replayPlaying = false; stopSoundEffects(); document.getElementById('replay-play').textContent = 'Play'; }
    }
    if (real - lastPaint >= 30) { try { replayDraw(); } catch (err) { replayPlaying = false; error(err); } lastPaint = real; }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  const params = new URLSearchParams(location.search), id = params.get('replay');
  if (/^[0-9a-f]{32}$/.test(id || '')) {
    try { const base = new URL(params.get('api') || location.origin); if (!/^https?:$/.test(base.protocol)) throw new Error('Invalid API URL');
      await replayLoad(await replayFetch(new URL(`/duel/replays/${id}.jsonl`, base)));
      document.body.dataset.replayReady = 'true';
      if (params.get('thumbnail') !== '1') void replaySetupLike(id);
      if (params.get('thumbnail') === '1') {
        audioMuted=true;
        const action = replayData.visuals.find(e => e.kind === 1) || replayData.visuals.find(e => e.g);
        replaySeek(Math.min(replayData.end.t * 0.85, action ? action.t + 180 : replayData.end.t * 0.4));
        const thumbnailStyle=document.createElement('style');
        thumbnailStyle.textContent='#replay-controls,#replay-stats,#replay-result{display:none!important}';
        document.head.appendChild(thumbnailStyle);
      }
    } catch (err) { error(err); }
  }
}
