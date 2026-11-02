// Jalan relay: /search route (TomTom Fuzzy Search, limited to Malaysia)
// ---------------------------------------------------------------------
// Add this to your existing Cloudflare Worker (jalan-relay), the one that
// already serves /route and /tiles/flow. Your TomTom key stays inside the
// worker; Jalan only ever talks to the relay.
//
// How to add it (Cloudflare dashboard -> Workers & Pages -> jalan-relay -> Edit code):
//   1. Paste the handleSearch function below anywhere in the worker file.
//   2. In the worker's fetch handler, next to where it checks for "/route",
//      add this line:
//          if (url.pathname === '/search') return handleSearch(url, env, request);
//      (`url` is `new URL(request.url)`; use whatever names your worker uses.)
//   3. TOMTOM_KEY below must be the same secret/variable your /route code uses.
//      If yours is called something else (e.g. env.TT_KEY), change it here.
//   4. Click Deploy. Test in a browser:
//          https://jalan-relay.2025118351.workers.dev/search?q=mydin&lat=3.139&lon=101.687
//      You should see JSON with a "results" list.
//
// Free TomTom keys allow about 2,500 search requests a day. Jalan searches
// 0.35 s after you stop typing, so normal use stays well inside that.

const ALLOWED_ORIGINS = ['https://ajeri-clod.github.io']; // add your own domain if Jalan is hosted elsewhere

async function handleSearch(url, env, request) {
  const origin = request.headers.get('Origin') || '';
  const cors = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response('Forbidden', { status: 403, headers: cors });

  const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
  if (q.length < 2) return json({ results: [] }, 200, cors);

  const p = new URLSearchParams({
    key: env.TOMTOM_KEY,              // <- same key your /route code uses
    countrySet: 'MY',
    limit: '20',
    language: 'en-GB',
    typeahead: url.searchParams.get('ta') === '1' ? 'true' : 'false',
    minFuzzyLevel: '1',
    maxFuzzyLevel: '2',               // tolerates small typos ("mcdonals", "petronass")
    idxSet: 'POI,PAD,Addr,Str,Geo',   // shops & places, addresses, streets, towns
  });
  const lat = parseFloat(url.searchParams.get('lat')), lon = parseFloat(url.searchParams.get('lon'));
  if (isFinite(lat) && isFinite(lon)) { p.set('lat', String(lat)); p.set('lon', String(lon)); } // nearer results first

  const r = await fetch('https://api.tomtom.com/search/2/search/' + encodeURIComponent(q) + '.json?' + p, {
    cf: { cacheTtl: 3600, cacheEverything: true },  // same query from the same area is cached for an hour
  });
  if (!r.ok) return json({ error: 'search failed', status: r.status }, r.status === 429 ? 429 : 502, cors);

  // only send back what Jalan uses (smaller and faster on mobile data)
  const j = await r.json();
  const results = (j.results || []).map(x => ({
    type: x.type,
    position: x.position,
    dist: x.dist,
    address: x.address && {
      freeformAddress: x.address.freeformAddress, streetName: x.address.streetName, streetNumber: x.address.streetNumber,
      municipality: x.address.municipality, municipalitySubdivision: x.address.municipalitySubdivision,
      countrySubdivision: x.address.countrySubdivision,
    },
    poi: x.poi && { name: x.poi.name, phone: x.poi.phone, categories: x.poi.categories, brands: x.poi.brands },
  }));
  return json({ results }, 200, cors);
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) });
}
