// Jalan relay (Cloudflare Worker)
// The app talks to this relay; the relay adds your secret TomTom key and forwards the request.
// Nobody who uses the app can ever see the key.
//
// Settings (Worker > Settings > Variables and Secrets):
//   TOMTOM_KEY       (Secret)  your TomTom API key
//   ALLOWED_ORIGINS  (Text)    websites allowed to call the relay, comma separated, e.g. https://yourname.github.io
//   ROUTE_PER_MIN    (Text, optional) route requests per person per minute (default 20)
//   TILE_PER_MIN     (Text, optional) traffic-tile requests per person per minute (default 600)
//   SEARCH_PER_MIN   (Text, optional) place-search requests per person per minute (default 60)

const MY = { minLat: 0.8, maxLat: 7.4, minLon: 99.6, maxLon: 119.3 };   // Malaysia only
const AVOID = new Set(['tollRoads', 'motorways', 'ferries']);
const hits = new Map();

function limited(ip, kind, max) {
  const now = Date.now(), k = kind + ip, e = hits.get(k);
  if (hits.size > 5000) hits.clear();
  if (!e || now - e.t > 60000) { hits.set(k, { t: now, n: 1 }); return false; }
  e.n++; return e.n > max;
}
const num = (v, a, b) => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) && n >= a && n <= b ? n : null; };
function pt(s) {
  const p = String(s || '').split(',');
  if (p.length !== 2) return null;
  const la = num(p[0], MY.minLat, MY.maxLat), lo = num(p[1], MY.minLon, MY.maxLon);
  return la == null || lo == null ? null : [la, lo];
}
function tileOK(z, x, y) {
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 16) return false;
  const n = 2 ** z; if (x < 0 || y < 0 || x >= n || y >= n) return false;
  const lon = t => t / n * 360 - 180, lat = t => Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) * 180 / Math.PI;
  return !(lon(x + 1) < MY.minLon || lon(x) > MY.maxLon || lat(y) < MY.minLat || lat(y + 1) > MY.maxLat);
}
function allowed(req, env) {
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return { ok: true, origin: '*' };
  const o = req.headers.get('Origin') || '';
  if (o && list.includes(o)) return { ok: true, origin: o };
  try { const r = req.headers.get('Referer'); if (r && list.includes(new URL(r).origin)) return { ok: true, origin: new URL(r).origin }; } catch (e) {}
  return { ok: false };
}
const cors = o => ({ 'Access-Control-Allow-Origin': o, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' });
const json = (obj, status, h) => new Response(JSON.stringify(obj), { status, headers: { ...h, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default {
  async fetch(req, env) {
    const u = new URL(req.url), a = allowed(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: a.ok ? 204 : 403, headers: a.ok ? cors(a.origin) : {} });
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if (!a.ok) return new Response('Forbidden', { status: 403 });
    const h = cors(a.origin);
    if (!env.TOMTOM_KEY) return json({ error: 'relay not configured' }, 500, h);
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    if (env.LIMITER) { try { const r = await env.LIMITER.limit({ key: ip }); if (!r.success) return json({ error: 'too many requests' }, 429, h); } catch (e) {} }

    if (u.pathname === '/route') {
      if (limited(ip, 'r', Number(env.ROUTE_PER_MIN || 20))) return json({ error: 'too many requests' }, 429, h);
      const f = pt(u.searchParams.get('from')), t = pt(u.searchParams.get('to'));
      if (!f || !t) return json({ error: 'bad request' }, 400, h);
      const alt = num(u.searchParams.get('alt') || '0', 0, 3) ?? 0;
      const type = u.searchParams.get('type') === 'short' ? 'short' : 'fastest';
      const q = new URLSearchParams({ key: env.TOMTOM_KEY, traffic: 'true', travelMode: 'car', routeType: type, maxAlternatives: String(Math.floor(alt)), instructionsType: 'text', computeTravelTimeFor: 'all', sectionType: 'tollRoad', departAt: 'now' });
      (u.searchParams.get('avoid') || '').split(',').filter(x => AVOID.has(x)).forEach(x => q.append('avoid', x));
      let r; try { r = await fetch(`https://api.tomtom.com/routing/1/calculateRoute/${f[0]},${f[1]}:${t[0]},${t[1]}/json?${q}`); } catch (e) { return json({ error: 'upstream unreachable' }, 502, h); }
      if (!r.ok) return json({ error: 'upstream', status: r.status }, r.status === 429 ? 429 : 502, h);
      return new Response(await r.text(), { status: 200, headers: { ...h, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    // ---- NEW: place & store search (TomTom Fuzzy Search, Malaysia only) ----
    if (u.pathname === '/search') {
      if (limited(ip, 's', Number(env.SEARCH_PER_MIN || 60))) return json({ error: 'too many requests' }, 429, h);
      const text = (u.searchParams.get('q') || '').trim().slice(0, 120);
      if (text.length < 2) return json({ results: [] }, 200, h);
      const q = new URLSearchParams({
        key: env.TOMTOM_KEY, countrySet: 'MY', limit: '20', language: 'en-GB',
        typeahead: u.searchParams.get('ta') === '1' ? 'true' : 'false',
        minFuzzyLevel: '1', maxFuzzyLevel: '2',          // tolerates small typos
        idxSet: 'POI,PAD,Addr,Str,Geo',                  // shops & places, addresses, streets, towns
      });
      const la = num(u.searchParams.get('lat'), MY.minLat, MY.maxLat), lo = num(u.searchParams.get('lon'), MY.minLon, MY.maxLon);
      if (la != null && lo != null) { q.set('lat', String(la)); q.set('lon', String(lo)); }   // nearer results first
      let r; try { r = await fetch(`https://api.tomtom.com/search/2/search/${encodeURIComponent(text)}.json?${q}`, { cf: { cacheEverything: true, cacheTtl: 3600 } }); } catch (e) { return json({ error: 'upstream unreachable' }, 502, h); }
      if (!r.ok) return json({ error: 'upstream', status: r.status }, r.status === 429 ? 429 : 502, h);
      const j = await r.json();
      // only send back what the app uses (smaller and faster on mobile data)
      const results = (j.results || []).map(x => ({
        type: x.type, position: x.position, dist: x.dist,
        address: x.address && { freeformAddress: x.address.freeformAddress, streetName: x.address.streetName, streetNumber: x.address.streetNumber,
          municipality: x.address.municipality, municipalitySubdivision: x.address.municipalitySubdivision, countrySubdivision: x.address.countrySubdivision },
        poi: x.poi && { name: x.poi.name, phone: x.poi.phone, categories: x.poi.categories, brands: x.poi.brands },
      }));
      return json({ results }, 200, h);
    }

    const m = u.pathname.match(/^\/tiles\/flow\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (m) {
      const z = +m[1], x = +m[2], y = +m[3];
      if (!tileOK(z, x, y)) return new Response(null, { status: 400, headers: h });
      if (limited(ip, 't', Number(env.TILE_PER_MIN || 600))) return new Response(null, { status: 429, headers: h });
      let r; try { r = await fetch(`https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?key=${env.TOMTOM_KEY}&tileSize=256`, { cf: { cacheEverything: true, cacheTtl: 60 } }); } catch (e) { return new Response(null, { status: 502, headers: h }); }
      if (!r.ok) return new Response(null, { status: r.status === 404 ? 404 : 502, headers: h });
      return new Response(r.body, { status: 200, headers: { ...h, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60' } });
    }
    return json({ ok: true, service: 'jalan-relay' }, 200, h);
  }
};
