// Offline data regression: no browser automation or changes to source recordings.
const fs = require('node:fs');
const {newContext} = require('../web/test/harness.js');
const c = newContext().load('00-state.js', '15-replay.js');
c.run(`function oldMotion(track,p,t) {
  const next=track.find(r=>r.t>t&&(r.pos[0]!==p.pos[0]||r.pos[1]!==p.pos[1]));
  let x=p.pos[0],y=p.pos[1];
  if(!p.paralyzed&&next&&next.round===p.round&&next.phase===p.phase&&next.t-p.t<=400&&Math.max(Math.abs(next.pos[0]-x),Math.abs(next.pos[1]-y))<=1){
    const f=Math.max(0,Math.min(1,(t-p.t)/(next.t-p.t||1)));
    x+=(next.pos[0]-x)*f;y+=(next.pos[1]-y)*f;
  }return {x,y};
}`);
for (const file of process.argv.slice(2)) {
  c.set('text',fs.readFileSync(file,'utf8'));
  const result=c.run(`(()=>{
    const data=replayParse(text);const out={id:data.header.id,fighters:[]};
    for(const [serial,track] of data.tracks){
      let oldJumps=0,newJumps=0,maxOld=0,maxNew=0;
      for(let i=1;i<track.length;i++){
        const p=track[i],before=track[i-1];
        if(p.t<=before.t||p.round!==before.round||p.phase!==before.phase||p.pos.some((v,k)=>v!==before.pos[k]))continue;
        for(const [fn,isOld] of [[oldMotion,true],[replayMotion,false]]){
          const a=fn(track,replayAt(track,p.t-.001),p.t-.001),b=fn(track,replayAt(track,p.t+.001),p.t+.001);
          const jump=Math.hypot(b.x-a.x,b.y-a.y);
          if(isOld){maxOld=Math.max(maxOld,jump);if(jump>.05)oldJumps++;}
          else{maxNew=Math.max(maxNew,jump);if(jump>.05)newJumps++;}
        }
      }
      out.fighters.push({serial,samples:track.length,oldJumps,newJumps,maxOld,maxNew});
    }return out;
  })()`);
  console.log(JSON.stringify(result));
  if(result.fighters.some(f=>f.newJumps))process.exitCode=1;
}
