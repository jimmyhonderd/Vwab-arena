// Cadeau-inator afstreep-service (Cloudflare Worker + D1)
// Bewaart alleen welk cadeau is afgestreept. De lijsten zelf staan in de repo Jimmyhonderd/Cadeau-inator.

const json = (d, s = 200, h = {}) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...h } });

function cors(req, env) {
  const o = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const ok = allowed.includes(o) || o.startsWith('http://localhost') || o === '';
  return {
    'Access-Control-Allow-Origin': ok ? (o || '*') : 'null',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
}

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

const slug = v => String(v || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
const cleanName = v => String(v || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

async function isAdmin(env, code) {
  if (!env.ADMIN_HASH || !code) return false;
  const h = await sha('cadeau:' + String(code).trim().toUpperCase());
  let diff = h.length ^ env.ADMIN_HASH.length;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ (env.ADMIN_HASH.charCodeAt(i) || 0);
  return diff === 0;
}
const txt = (v, n) => String(v ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const url = v => { const u = String(v ?? '').trim(); return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u.slice(0, 600) : ''; };

export default {
  async fetch(req, env) {
    const h = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const url_ = new URL(req.url);
    const p = url_.pathname.replace(/\/+$/, '') || '/';

    try {
      if (p === '/') return json({ ok: true, service: 'cadeau-inator' }, 200, h);

      // Welke cadeaus van een lijst zijn afgestreept (geen namen van gevers naar buiten)
      if (p === '/claims' && req.method === 'GET') {
        const list = slug(url_.searchParams.get('list'));
        if (!list) return json({ error: 'lijst' }, 400, h);
        const rows = await env.DB.prepare('SELECT item, ts FROM claims WHERE list=?').bind(list).all();
        const claimed = {};
        for (const r of rows.results) claimed[r.item] = r.ts;
        return json({ list, claimed }, 200, h);
      }


      // Extra wensen (zelf toegevoegd) en verborgen wensen per lijst
      if (p === '/extra' && req.method === 'GET') {
        const list = slug(url_.searchParams.get('list'));
        if (!list) return json({ error: 'lijst' }, 400, h);
        const it = await env.DB.prepare('SELECT data FROM items WHERE list=? ORDER BY ts').bind(list).all();
        const hi = await env.DB.prepare('SELECT id FROM hidden WHERE list=?').bind(list).all();
        return json({ items: it.results.map(r => JSON.parse(r.data)), hidden: hi.results.map(r => r.id) }, 200, h);
      }

      if (p.startsWith('/admin/') && req.method === 'POST') {
        const b = await req.json().catch(() => null);
        if (!b) return json({ error: 'bad json' }, 400, h);
        if (!(await isAdmin(env, b.code))) return json({ error: 'onjuiste beheercode' }, 403, h);
        if (p === '/admin/check') return json({ ok: true }, 200, h);
        const list = slug(b.list);
        if (!list) return json({ error: 'lijst' }, 400, h);
        const now = Date.now();

        if (p === '/admin/add') {
          const i = b.item || {};
          const titel = txt(i.titel, 120);
          if (!titel) return json({ error: 'titel is verplicht' }, 400, h);
          const id = (slug(titel.toLowerCase().replace(/\s+/g, '-')).slice(0, 30) || 'wens') + '-' + crypto.randomUUID().slice(0, 6);
          const item = {
            id, titel,
            omschrijving: txt(i.omschrijving, 500),
            prijs: txt(i.prijs, 40),
            winkel: txt(i.winkel, 60),
            link: url(i.link),
            afbeelding: url(i.afbeelding),
            afstrepen: i.afstrepen !== false,
            prio: 5, eigen: true,
          };
          await env.DB.prepare('INSERT INTO items (list,id,data,ts) VALUES (?,?,?,?)').bind(list, id, JSON.stringify(item), now).run();
          return json({ ok: true, item }, 200, h);
        }

        if (p === '/admin/remove') {
          const id = slug(b.id);
          if (!id) return json({ error: 'id' }, 400, h);
          await env.DB.prepare('DELETE FROM items WHERE list=? AND id=?').bind(list, id).run();
          await env.DB.prepare('INSERT OR REPLACE INTO hidden (list,id,ts) VALUES (?,?,?)').bind(list, id, now).run();
          await env.DB.prepare('DELETE FROM claims WHERE list=? AND item=?').bind(list, id).run();
          return json({ ok: true }, 200, h);
        }

        if (p === '/admin/restore') {
          await env.DB.prepare('DELETE FROM hidden WHERE list=?').bind(list).run();
          return json({ ok: true }, 200, h);
        }
      }

      if ((p === '/claim' || p === '/unclaim') && req.method === 'POST') {
        const b = await req.json().catch(() => null);
        if (!b) return json({ error: 'bad json' }, 400, h);
        const list = slug(b.list), item = slug(b.item);
        if (!list || !item) return json({ error: 'lijst/item' }, 400, h);

        if (p === '/claim') {
          const ip = await sha((req.headers.get('CF-Connecting-IP') || '') + 'cadeau');
          const now = Date.now();
          const rl = await env.DB.prepare('SELECT COUNT(*) c FROM claims WHERE ip=? AND ts>?').bind(ip, now - 600000).first();
          if (rl.c >= 15) return json({ error: 'te snel, probeer het zo nog eens' }, 429, h);
          const token = crypto.randomUUID().replace(/-/g, '');
          const res = await env.DB
            .prepare('INSERT OR IGNORE INTO claims (list,item,name,token,ip,ts) VALUES (?,?,?,?,?,?)')
            .bind(list, item, cleanName(b.name), await sha(token), ip, now)
            .run();
          if (!res.meta.changes) return json({ error: 'al afgestreept' }, 409, h);
          return json({ ok: true, token }, 200, h);
        }

        // unclaim: alleen met de code die bij het afstrepen in de browser van de gever is bewaard
        const token = String(b.token || '').replace(/[^a-f0-9]/g, '');
        if (!token) return json({ error: 'code' }, 403, h);
        const res = await env.DB
          .prepare('DELETE FROM claims WHERE list=? AND item=? AND token=?')
          .bind(list, item, await sha(token))
          .run();
        if (!res.meta.changes) return json({ error: 'niet gevonden of niet van jou' }, 403, h);
        return json({ ok: true }, 200, h);
      }

      return json({ error: 'niet gevonden' }, 404, h);
    } catch (e) {
      return json({ error: 'server', detail: String(e && e.message || e) }, 500, h);
    }
  },
};
