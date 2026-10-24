// VWAB Arena score service (Cloudflare Worker + D1)
const BAD=['kut','hoer','kanker','neger','nazi','hitler','fuck','shit','lul','pik','tering','tyfus','homo','slet'];
const LIMITS={ invasie:{maxRate:600, minDur:5}, default:{maxRate:600, minDur:3} }; // max points per second

function clean(n){ n=String(n||'').replace(/[^A-Za-z0-9 _\-!?.]/g,'').trim().slice(0,12).toUpperCase(); return BAD.some(b=>n.toLowerCase().includes(b))?'':n; }
function cors(req,env){ const o=req.headers.get('Origin')||''; const allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()); const ok=allowed.includes(o)||o.startsWith('http://localhost')||o.startsWith('file://')||o==='';
  return {'Access-Control-Allow-Origin': ok?(o||'*'):'null','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,X-Admin-Key','Access-Control-Max-Age':'86400','Cache-Control':'no-store'}; }
const json=(d,s=200,h={})=>new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json',...h}});
async function sha(s){ const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
const ALPH='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function claimCode(id,dev,env){ const h=await sha(`${id}|${dev}|${env.ADMIN_KEY||'vwab'}|claim`); let out=''; for(let i=0;i<5;i++) out+=ALPH[parseInt(h.substr(i*2,2),16)%32]; return out; }
async function hmac(env,msg){ return (await sha(msg+'|'+(env.ADMIN_KEY||'vwab')+'|ticket')).slice(0,24); }
async function bump(env,key,by){ await env.DB.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=CAST(CAST(v AS INTEGER)+? AS TEXT)").bind(key,String(by),by).run(); }
async function counter(env,key){ const r=await env.DB.prepare('SELECT v FROM meta WHERE k=?').bind(key).first(); return r?parseInt(r.v,10)||0:0; }
let memTop={}; // per-isolate cache
async function round(env){ const r=await env.DB.prepare("SELECT v FROM meta WHERE k='round'").first(); return r?parseInt(r.v,10):1; }

export default {
  async fetch(req,env){
    const h=cors(req,env); if(req.method==='OPTIONS') return new Response(null,{status:204,headers:h});
    const url=new URL(req.url); const p=url.pathname.replace(/\/+$/,'')||'/';
    try{
      if(p==='/' ) return json({ok:true,service:'vwab-arena'},200,h);
      if(p==='/top'){ const game=(url.searchParams.get('game')||'invasie').slice(0,20); const n=Math.min(100,Math.max(1,parseInt(url.searchParams.get('n')||'10',10)));
        const ck=game+'|'+n; const now=Date.now(); const mc=memTop[ck]; if(mc && now-mc.t<5000) return json(mc.d,200,{...h,'X-Cache':'mem'});
        const cache=caches.default; const cacheKey=new Request(url.origin+'/top?game='+game+'&n='+n); const hit=await cache.match(cacheKey); if(hit){ const d=await hit.json(); memTop[ck]={t:now,d}; return json(d,200,{...h,'X-Cache':'edge'}); }
        const rd=await round(env);
        const rows=await env.DB.prepare('SELECT id,name,score,ts,substr(dev,1,4) tag FROM scores WHERE game=? AND round=? AND hidden=0 ORDER BY score DESC, ts ASC LIMIT ?').bind(game,rd,n).all();
        const total=await counter(env,`cnt:${game}:${rd}`), players=await counter(env,`pl:${game}:${rd}`);
        const last=await env.DB.prepare('SELECT name,score,ts FROM scores WHERE game=? AND round=? AND hidden=0 ORDER BY ts DESC LIMIT 5').bind(game,rd).all();
        const d={round:rd,top:rows.results,total,players,recent:last.results}; memTop[ck]={t:now,d};
        await cache.put(cacheKey,new Response(JSON.stringify(d),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=5'}}));
        return json(d,200,{...h,'X-Cache':'db'}); }
      if(p==='/rank'){ const game=(url.searchParams.get('game')||'invasie').slice(0,20); const sc=parseInt(url.searchParams.get('score')||'0',10); const rd=await round(env);
        const r=await env.DB.prepare('SELECT COUNT(*) c FROM scores WHERE game=? AND round=? AND hidden=0 AND score>?').bind(game,rd,sc).first();
        return json({rank:r.c+1,total:await counter(env,`cnt:${game}:${rd}`)},200,h); }
      if(p==='/start' && req.method==='POST'){ const b=await req.json().catch(()=>({})); const dev=String(b.dev||'').replace(/[^a-f0-9]/g,'').slice(0,32); if(dev.length<16) return json({error:'dev'},400,h);
        const ip=await sha((req.headers.get('CF-Connecting-IP')||'')+'vwab'); const now=Date.now();
        const st=await env.DB.prepare('SELECT COUNT(*) c FROM tickets WHERE ip=? AND ts>?').bind(ip,now-60000).first(); if(st.c>=10) return json({error:'te snel'},429,h);
        const nonce=crypto.randomUUID().replace(/-/g,''); const mac=await hmac(env,`${dev}|${nonce}|${now}`);
        await env.DB.prepare('INSERT INTO tickets (nonce,dev,ip,ts,used) VALUES (?,?,?,?,0)').bind(nonce,dev,ip,now).run();
        return json({ticket:`${nonce}.${now}.${mac}`},200,h); }
      if(p==='/score' && req.method==='POST'){
        const b=await req.json().catch(()=>null); if(!b) return json({error:'bad json'},400,h);
        const game=String(b.game||'invasie').slice(0,20), name=clean(b.name), score=Math.floor(Number(b.score)), dur=Math.floor(Number(b.dur)||0), ts=Math.floor(Number(b.ts)||Date.now()); const dev=String(b.dev||'').replace(/[^a-f0-9]/g,'').slice(0,32)||null;
        if(!name) return json({error:'naam niet toegestaan'},400,h); if(!dev||dev.length<16) return json({error:'toestel'},400,h);
        if(!Number.isFinite(score)||score<0||score>5e7) return json({error:'score ongeldig'},400,h);
        const lim=LIMITS[game]||LIMITS.default; if(dur<lim.minDur || score>dur*lim.maxRate+500) return json({error:'score niet plausibel'},422,h);
        if(b.sig!==(await sha(`${game}|${name}|${score}|${dur}|${ts}|vwab`)).slice(0,16)) return json({error:'handtekening'},403,h);
        const ip=await sha((req.headers.get('CF-Connecting-IP')||'')+'vwab'); const now=Date.now();
        // ticket: issued by /start, single use, bound to device, duration must match elapsed time
        const tk=String(b.ticket||'').split('.'); if(tk.length!==3) return json({error:'geen ticket'},403,h);
        const [nonce,tts,mac]=tk; if(mac!==await hmac(env,`${dev}|${nonce}|${tts}`)) return json({error:'ticket ongeldig'},403,h);
        const trow=await env.DB.prepare('SELECT used,ts FROM tickets WHERE nonce=?').bind(nonce).first(); if(!trow||trow.used) return json({error:'ticket gebruikt'},403,h);
        const elapsed=(now-trow.ts)/1000; if(elapsed<lim.minDur || dur>elapsed+8 || elapsed>4*3600) return json({error:'speelduur klopt niet'},422,h);
        await env.DB.prepare('UPDATE tickets SET used=1 WHERE nonce=?').bind(nonce).run();
        const rl=await env.DB.prepare('SELECT COUNT(*) c FROM scores WHERE ip=? AND ts>?').bind(ip,now-60000).first(); if(rl.c>=2) return json({error:'te snel'},429,h);
        const rd2=await env.DB.prepare('SELECT COUNT(*) c FROM scores WHERE dev=? AND ts>?').bind(dev,now-60000).first(); if(rd2.c>=2) return json({error:'te snel'},429,h);
        const rh=await env.DB.prepare('SELECT COUNT(*) c FROM scores WHERE ip=? AND ts>?').bind(ip,now-3600000).first(); if(rh.c>=60) return json({error:'uurlimiet'},429,h);
        const rd=await round(env);
        const ins=await env.DB.prepare('INSERT INTO scores (game,name,score,dur,ts,round,ip,dev) VALUES (?,?,?,?,?,?,?,?)').bind(game,name,score,dur,now,rd,ip,dev).run();
        const claim=await claimCode(ins.meta.last_row_id,dev||'',env); await env.DB.prepare('UPDATE scores SET claim=? WHERE id=?').bind(claim,ins.meta.last_row_id).run();
        const prev=await env.DB.prepare('SELECT id FROM scores WHERE dev=? AND game=? AND round=? AND id<? LIMIT 1').bind(dev,game,rd,ins.meta.last_row_id).first();
        await bump(env,`cnt:${game}:${rd}`,1); if(!prev) await bump(env,`pl:${game}:${rd}`,1); memTop={};
        const r=await env.DB.prepare('SELECT COUNT(*) c FROM scores WHERE game=? AND round=? AND hidden=0 AND score>?').bind(game,rd,score).first();
        return json({ok:true,id:ins.meta.last_row_id,rank:r.c+1,total:await counter(env,`cnt:${game}:${rd}`),claim},200,h); }
      // admin
      if(p.startsWith('/admin')){ if(!env.ADMIN_KEY || req.headers.get('X-Admin-Key')!==env.ADMIN_KEY) return json({error:'geen toegang'},401,h);
        if(p==='/admin/hide' && req.method==='POST'){ memTop={}; const b=await req.json(); await env.DB.prepare('UPDATE scores SET hidden=? WHERE id=?').bind(b.unhide?0:1,b.id|0).run(); return json({ok:true},200,h); }
        if(p==='/admin/hidedev' && req.method==='POST'){ const b=await req.json(); const row=await env.DB.prepare('SELECT dev FROM scores WHERE id=?').bind(b.id|0).first(); if(!row||!row.dev) return json({ok:false},200,h); const r=await env.DB.prepare('UPDATE scores SET hidden=1 WHERE dev=?').bind(row.dev).run(); return json({ok:true,changed:r.meta.changes},200,h); }
        if(p==='/admin/hiderange' && req.method==='POST'){ const b=await req.json(); const r=await env.DB.prepare('UPDATE scores SET hidden=1 WHERE id>=? AND id<=?').bind(b.from|0,b.to|0).run(); return json({ok:true,changed:r.meta.changes},200,h); }
        if(p==='/admin/hidename' && req.method==='POST'){ const b=await req.json(); await env.DB.prepare('UPDATE scores SET hidden=1 WHERE name=?').bind(clean(b.name)).run(); return json({ok:true},200,h); }
        if(p==='/admin/newround' && req.method==='POST'){ memTop={}; const rd=await round(env); await env.DB.prepare("UPDATE meta SET v=? WHERE k='round'").bind(String(rd+1)).run(); return json({ok:true,round:rd+1},200,h); }
        if(p==='/admin/setround' && req.method==='POST'){ const b=await req.json(); await env.DB.prepare("UPDATE meta SET v=? WHERE k='round'").bind(String(b.round|0||1)).run(); return json({ok:true},200,h); }
        if(p==='/admin/export'){ const rd=parseInt(url.searchParams.get('round')||String(await round(env)),10); const game=(url.searchParams.get('game')||'invasie').slice(0,20);
          const rows=await env.DB.prepare('SELECT id,name,score,dur,ts,hidden FROM scores WHERE game=? AND round=? ORDER BY score DESC').bind(game,rd).all();
          const csv='id;naam;score;duur;tijd;verborgen\n'+rows.results.map(r=>[r.id,r.name,r.score,r.dur,new Date(r.ts).toISOString(),r.hidden].join(';')).join('\n');
          return new Response(csv,{headers:{...h,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename=vwab-arena-ronde'+rd+'.csv'}}); }
        if(p==='/admin/list'){ const rd=await round(env); const game=(url.searchParams.get('game')||'invasie').slice(0,20); const before=parseInt(url.searchParams.get('before')||'0',10)||2147483647; const rows=await env.DB.prepare('SELECT id,name,score,dur,ts,hidden,claim FROM scores WHERE game=? AND round=? AND id<? ORDER BY id DESC LIMIT 500').bind(game,rd,before).all(); return json({round:rd,rows:rows.results,total:await counter(env,`cnt:${game}:${rd}`)},200,h); }
        if(p==='/admin/verify'){ const code=(url.searchParams.get('code')||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5); const rd=await round(env);
          const row=await env.DB.prepare('SELECT id,name,score,dur,ts,round,hidden FROM scores WHERE claim=? ORDER BY ts DESC LIMIT 1').bind(code).first(); if(!row) return json({ok:false},200,h);
          const r=await env.DB.prepare('SELECT COUNT(*) c FROM scores WHERE game=? AND round=? AND hidden=0 AND score>?').bind('invasie',row.round,row.score).first(); return json({ok:true,row,rank:r.c+1,currentRound:rd},200,h); }
        if(p==='/admin/ping') return json({ok:true,round:await round(env)},200,h);
      }
      return json({error:'onbekend'},404,h);
    }catch(e){ return json({error:String(e.message||e)},500,h); }
  }
};
