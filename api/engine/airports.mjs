// Airports and flights (#36, AIR-01, AIR-02): where the systems in a repository meet, and what links them, from the code
// alone. Deterministic: the same files always give the same airports and flights, in the same order.
//
//   airport  a module another top-level area imports, a file that defines API routes, or one that calls another area's routes
//   flight   an import across areas, or a call whose URL string matches a route (the web app reaches the API that way,
//            so nothing imports across)
//
// URLs are matched to routes segment by segment: a `${…}` in the call fits a route's parameter, and literal segments must
// be equal. Routes are read from three shapes: [method, /^\/regex$/] tables, Express-style app.get('/path'), and
// Next.js file routes (app/**/route.ts, pages/api/**).

import { posix } from 'node:path';

const TEST = /(^|\/)(tests?|__tests__|e2e|cypress|playwright)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/;
const CODE = /\.(m?js|cjs|jsx|tsx?)$/;
const EXTS = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '/index.js', '/index.mjs', '/index.ts', '/index.tsx', '/index.jsx'];
const GROUPED = /^(apps|packages|services|libs|modules)$/;
const METHODS = 'GET|POST|PUT|PATCH|DELETE';
const MAX_AIRPORTS = 300;
const MAX_FLIGHTS = 600;

/** The top-level area a file belongs to: its first folder, or two for a monorepo's apps/x and packages/y. Root files have none. */
export function areaOf(path) {
  const s = path.split('/');
  if (s.length < 2) return null;
  return GROUPED.test(s[0]) && s.length > 2 ? `${s[0]}/${s[1]}` : s[0];
}

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {object} input
 * @param {string[]} input.paths every file in the repository
 * @param {Map<string, string>} input.sources source text by path, for the files that were read
 * @param {Map<string, object>} [input.manifests] package.json path -> contents, so a workspace package's name resolves
 * @returns {{ airports: object[], flights: object[], truncated?: { airports: number, flights: number } }}
 */
export function mapAirports({ paths, sources, manifests = new Map() }) {
  const files = new Set(paths);
  const tops = new Set(paths.map((p) => p.split('/')[0]));
  const packages = new Map([...manifests].filter(([, m]) => m?.name).map(([p, m]) => [m.name, p.slice(0, p.lastIndexOf('/'))]).filter(([, dir]) => dir));
  const read = [...sources.keys()].filter((p) => CODE.test(p)).sort(byKey);

  const resolve = (spec, from) => {
    let base;
    if (spec.startsWith('.')) base = posix.join(posix.dirname(from), spec);
    else {
      const parts = spec.split('/');
      const n = spec.startsWith('@') ? 2 : 1;
      const name = parts.slice(0, n).join('/');
      if (packages.has(name)) base = posix.join(packages.get(name), parts.slice(n).join('/'));
      else if (/^@\w[\w-]*$/.test(parts[0]) && tops.has(parts[0].slice(1))) base = posix.join(parts[0].slice(1), parts.slice(1).join('/')); // an alias like @shared/x for shared/x
      else return null;
    }
    const tries = [...EXTS.map((e) => base + e), ...(/\.js$/.test(base) ? ['.ts', '.tsx'].map((e) => base.replace(/\.js$/, e)) : [])];
    return tries.find((t) => files.has(t)) ?? (packages.has(spec) && files.has(`${base}/src/index.ts`) ? `${base}/src/index.ts` : null);
  };

  // Routes, by the file that defines them.
  const routes = [];
  for (const p of paths) {
    const next = p.match(/(?:^|\/)app\/(.*\/)?route\.(?:ts|js|mjs)$/) ?? p.match(/(?:^|\/)pages\/(api\/.*)\.(?:ts|js|mjs)$/);
    if (!next || TEST.test(p)) continue;
    const url = (p.includes('/pages/api/') || p.startsWith('pages/api/') ? next[1].replace(/\/index$/, '') : (next[1] ?? '').replace(/\/$/, '')).split('/').filter((s) => s && !/^\(.*\)$/.test(s));
    const verbs = [...(sources.get(p) ?? '').matchAll(new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+(${METHODS})\\b`, 'g'))].map((m) => m[1]);
    for (const method of verbs.length ? [...new Set(verbs)] : ['*']) routes.push({ file: p, method, segs: url.map((s) => (/^\[.*\]$/.test(s) ? null : s)) });
  }
  for (const p of read) {
    if (TEST.test(p)) continue;
    const src = sources.get(p);
    for (const m of src.matchAll(new RegExp(`\\[\\s*'(${METHODS})'\\s*,\\s*\\/\\^(.*?)\\$\\/\\w*\\s*,`, 'g'))) {
      routes.push({ file: p, method: m[1], segs: m[2].split('\\/').filter(Boolean).map((s) => (/[()[\]+*?|]/.test(s) ? null : s.replace(/\\(.)/g, '$1'))) });
    }
    for (const m of src.matchAll(/\b(?:app|router|server|routes?)\.(get|post|put|patch|delete|all)\(\s*(['"`])(\/[^'"`]*)\2/gi)) {
      routes.push({ file: p, method: m[1].toLowerCase() === 'all' ? '*' : m[1].toUpperCase(), segs: m[3].split('/').filter(Boolean).map((s) => (s.startsWith(':') ? null : s)) });
    }
  }
  const label = (r) => `${r.method === '*' ? '' : `${r.method} `}/${r.segs.map((s) => s ?? '*').join('/')}`;

  // Imports across areas, and calls whose URL lands on a route.
  const flights = new Map();
  const importedBy = new Map();
  const fly = (from, to, kind, via) => {
    const k = `${from}|${to}|${kind}`;
    const f = flights.get(k) ?? { from, to, fromArea: areaOf(from), toArea: areaOf(to), kind, ...(kind === 'call' ? { calls: [] } : {}) };
    if (via && !f.calls.some((c) => c.url === via.url && c.route === via.route)) f.calls.push(via);
    flights.set(k, f);
  };
  for (const p of read) {
    if (TEST.test(p)) continue;
    const src = sources.get(p);
    const from = areaOf(p);
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g)) {
      const to = resolve(m[1], p);
      if (!to || !from || areaOf(to) === from || !areaOf(to)) continue;
      fly(p, to, 'import');
      importedBy.set(to, new Set([...(importedBy.get(to) ?? []), from]));
    }
    for (const m of src.matchAll(/(['"`])((?:\$\{[^}`]*\})?\/(?:[^'"`\n\\$]|\$\{[^}`]*\})*)\1/g)) {
      const before = src.slice(Math.max(0, m.index - 40), m.index);
      if (/\b(?:app|router|server|routes?)\.(?:get|post|put|patch|delete|all)\(\s*$/i.test(before)) continue; // a route, not a call
      const url = m[2].replace(/^\$\{[^}]*\}/, '').replace(/[?#].*$/, '');
      const segs = url.split('/').filter(Boolean);
      if (!segs.length || !segs.some((s) => !s.includes('${'))) continue;
      const said = before.match(new RegExp(`['"](${METHODS})['"]\\s*,\\s*$`))?.[1] ?? before.match(/\.(get|post|put|patch|delete)\(\s*$/i)?.[1]?.toUpperCase();
      const method = said ?? (/\bfetch\(\s*$/.test(before) ? (src.slice(m.index, m.index + 200).match(new RegExp(`method:\\s*['"](${METHODS})['"]`))?.[1] ?? 'GET') : null);
      for (const r of routes) {
        if (r.file === p || r.segs.length !== segs.length) continue;
        if (method && r.method !== '*' && r.method !== method) continue;
        if (!r.segs.every((s, i) => (s == null ? true : s === segs[i]))) continue;
        fly(p, r.file, 'call', { ...(method ? { method } : {}), url: `/${segs.map((s) => (s.includes('${') ? '*' : s)).join('/')}`, route: label(r) });
      }
    }
  }

  const airports = new Map();
  for (const [path, by] of importedBy) airports.set(path, { path, area: areaOf(path), kinds: ['module'], usedBy: [...by].sort(byKey) });
  for (const r of routes) {
    const a = airports.get(r.file) ?? { path: r.file, area: areaOf(r.file), kinds: [], usedBy: [] };
    if (!a.kinds.includes('routes')) a.kinds.push('routes');
    a.routes = [...new Set([...(a.routes ?? []), label(r)])];
    airports.set(r.file, a);
  }
  // A call from another area makes both ends airports: the route's file is used from there, and the caller (a web app's API
  // client, say) is where that area leaves for it.
  for (const f of flights.values()) {
    if (f.kind !== 'call' || !f.fromArea || f.fromArea === f.toArea) continue;
    const to = airports.get(f.to);
    if (!to.usedBy.includes(f.fromArea)) to.usedBy = [...to.usedBy, f.fromArea].sort(byKey);
    const from = airports.get(f.from) ?? { path: f.from, area: f.fromArea, kinds: [], usedBy: [] };
    if (!from.kinds.includes('calls')) from.kinds.push('calls');
    airports.set(f.from, from);
  }
  const allAirports = [...airports.values()].map((a) => ({ ...a, kinds: a.kinds.sort(byKey), ...(a.routes ? { routes: a.routes.sort(byKey).slice(0, 100) } : {}) })).sort((x, y) => byKey(x.path, y.path));
  const allFlights = [...flights.values()].map((f) => (f.calls ? { ...f, calls: f.calls.sort((x, y) => byKey(`${x.url} ${x.route}`, `${y.url} ${y.route}`)) } : f)).sort((x, y) => byKey(`${x.from}|${x.to}|${x.kind}`, `${y.from}|${y.to}|${y.kind}`));
  const over = { airports: Math.max(0, allAirports.length - MAX_AIRPORTS), flights: Math.max(0, allFlights.length - MAX_FLIGHTS) };
  return { airports: allAirports.slice(0, MAX_AIRPORTS), flights: allFlights.slice(0, MAX_FLIGHTS), ...(over.airports || over.flights ? { truncated: over } : {}) };
}
