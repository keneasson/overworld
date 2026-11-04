// The product's geography, read from the code. Deterministic: the same file
// tree always gives the same map.
//
//   web app (Next.js, SvelteKit, Remix, Vite…)  -> a wide-screen continent; its route tree is the site map
//   API routes                                  -> the API strip
//   mobile app (Expo / React Native)            -> a phone-shaped continent
//   email templates (React Email…)              -> a letter-shaped continent
//   back-end apps (Express, Fastify, SAM…)      -> service continents
//   shared packages, server code, tests, docs   -> "Behind the screen"
//   third-party services in the dependencies    -> islands
//
// Every region keeps the files it owns, so an issue can later be placed where
// its code lives.

import { humanize, words } from './text.mjs';

const IGNORE =
  /(^|\/)(node_modules|dist|build|out|coverage|test-results|playwright-report|\.next|\.expo|\.turbo|\.yarn|\.vercel|vendor|__snapshots__|public|static|assets|fonts|images)(\/|$)/;
const SOURCE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|mdx?|py|rb|go|rs|java|kt|swift|php|cs|css|scss|sql|graphql|prisma|ya?ml|sh|html)$/i;
const PAGE_FILE = /(^|\/)(page|\+page)\.(tsx|jsx|ts|js|mdx|svelte|vue)$/;
const ROUTE_FILE = /(^|\/)(route|\+server)\.(ts|js|mjs)$/;
const TEST = /(^|\/)(tests?|__tests__|e2e|cypress|playwright)(\/|$)|\.(test|spec)\.[jt]sx?$/;
const NAV = /(^|\/)[\w-]*(navigation|navbar|nav-?bar|header|menu|sidebar|footer|tab-?bar)[\w-]*\.(tsx|jsx|vue|svelte)$/i;
const SHOWCASE = /(^|\/)(brand|branding|showcase|playground|storybook|stories|sandbox|demo|examples?|ui-ux)(\/|$)/;
const FEATURE_PARENT = /^(features?|screens|views|modules|domains|components|src)$/;

const AUTH_SEGMENT = /^(auth|login|log-in|signin|sign-in|signup|sign-up|register|account|accounts)$/;
const ADMIN_SEGMENT = /^(admin|dashboard|backoffice|back-office|console|manage)$/;

// Well-known services: what the dependency looks like, how issues mention it, and words that belong to it.
const SERVICES = [
  ['Amazon SES', /^@aws-sdk\/client-sesv?2?$/, /\bSES\b/, 'ses email bounce suppression topic deliverability sender'],
  ['DynamoDB', /client-dynamodb|lib-dynamodb|dynamodb-adapter|^dynamoose$|^electrodb$/, /\bdynamo(db)?\b/i, 'dynamodb table gsi index scan query pkey'],
  ['Amazon S3', /^@aws-sdk\/client-s3$/, /\bS3\b/, 's3 bucket upload file storage'],
  ['EventBridge', /client-eventbridge|client-scheduler/, /\beventbridge\b/i, 'eventbridge cron schedule rule'],
  ['CloudWatch', /client-cloudwatch/, /\bcloudwatch\b/i, 'cloudwatch alarm metric log'],
  ['Amazon SNS', /^@aws-sdk\/client-sns$/, /\bSNS\b/, 'sns notification topic webhook'],
  ['Amazon SQS', /^@aws-sdk\/client-sqs$/, /\bSQS\b/, 'sqs queue message'],
  [
    'Google Sheets',
    /^google-spreadsheet$|^@googleapis\/sheets$|^googleapis$/,
    /\bgoogle sheets?\b|\bspreadsheets?\b|\bapps script\b/i,
    'google sheet spreadsheet apps script sync',
  ],
  ['Google Maps', /^@googlemaps\/|google-maps|^@vis\.gl\/react-google-maps$/, /\bgoogle (places|maps)\b/i, 'google maps places location'],
  ['YouTube', /youtube/, /\byoutube\b/i, 'youtube livestream video'],
  ['Vercel', /^@vercel\/|^vercel$/, /\bvercel\b/i, 'vercel deployment preview cron'],
  ['Mailchimp', /mailchimp/, /\bmailchimp\b/i, 'mailchimp newsletter list'],
  ['Stripe', /^stripe$|^@stripe\//, /\bstripe\b/i, 'stripe payment checkout subscription invoice'],
  ['Twilio', /^twilio$/, /\btwilio\b/i, 'twilio sms phone'],
  ['SendGrid', /^@sendgrid\//, /\bsendgrid\b/i, 'sendgrid email'],
  ['Postmark', /^postmark$/, /\bpostmark\b/i, 'postmark email'],
  ['Resend', /^resend$/, /\bresend\.com\b/i, 'resend email'],
  ['Firebase', /^firebase(-admin)?$/, /\bfirebase\b/i, 'firebase'],
  ['Supabase', /^@supabase\//, /\bsupabase\b/i, 'supabase'],
  ['Auth0', /auth0/, /\bauth0\b/i, 'auth0 login'],
  ['Clerk', /^@clerk\//, /\bclerk\b/i, 'clerk login'],
  ['Sentry', /^@sentry\//, /\bsentry\b/i, 'sentry error'],
  ['Algolia', /algolia/, /\balgolia\b/i, 'algolia search'],
  ['OpenAI', /^openai$/, /\bopenai\b|\bchatgpt\b/i, 'openai llm'],
  ['Anthropic', /^@anthropic-ai\//, /\banthropic\b/i, 'anthropic claude llm'],
  ['Shopify', /shopify/, /\bshopify\b/i, 'shopify store'],
  ['PostHog', /posthog/, /\bposthog\b/i, 'posthog analytics'],
  ['Segment', /^@segment\//, /\bsegment\.io\b/i, 'segment analytics'],
  ['Postgres', /^pg$|^postgres$|^@neondatabase\//, /\bpostgres(ql)?\b/i, 'postgres sql database'],
  ['MongoDB', /^mongodb$|^mongoose$/, /\bmongo(db)?\b/i, 'mongodb database'],
  ['Redis', /^redis$|^ioredis$|^@upstash\/redis$/, /\bredis\b/i, 'redis cache'],
  ['Facebook', /facebook/, /\bfacebook\b/i, 'facebook oauth login'],
];

const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const under = (p, prefix) => prefix === '' || p.startsWith(prefix);

/**
 * @param {object} input
 * @param {string[]} input.paths       every file in the repository
 * @param {Map<string, object>} input.manifests  package.json path -> parsed contents
 * @param {string[]} [input.mentions]  issue texts, to notice services the code reaches without a package
 * @returns {{ regions: Map<string, object>, fileOwners: Map<string, string[]>, urlIndex: object[], paths: string[] }}
 */
export function mapArchitecture({ paths, manifests = new Map(), mentions = [] }) {
  const files = paths.filter((p) => !IGNORE.test(p) && SOURCE.test(p));
  const regions = new Map();
  const fileOwners = new Map();
  const urlIndex = [];
  let order = 0;

  const add = (key, parent, title, extra = {}) => {
    const r = { key, parent, title, kind: 'area', place: 'auto', surface: 'auto', summary: '', tags: [], files: [], urls: [], words: new Map(), order: order++, ...extra };
    regions.set(key, r);
    return r;
  };
  const own = (r, path) => {
    if (fileOwners.has(path)) {
      const owners = fileOwners.get(path);
      if (!owners.includes(r.key)) owners.push(r.key);
    } else fileOwners.set(path, [r.key]);
    r.files.push(path);
  };
  const claimed = (p) => fileOwners.has(p);

  // --- Packages and what each one is --------------------------------------
  const packages = [...manifests.entries()]
    .map(([path, json]) => ({ dir: dirOf(path), json, deps: Object.keys({ ...json.dependencies, ...json.devDependencies, ...json.peerDependencies }) }))
    .sort((a, b) => b.dir.length - a.dir.length);
  const isRootOnly = packages.length > 1;
  const appsOf = [];
  for (const pkg of packages) {
    if (isRootOnly && pkg.dir === '') continue;
    const has = (re) => pkg.deps.some((d) => re.test(d));
    const exists = (prefix) => files.some((f) => f.startsWith(pkg.dir + prefix));
    let type = 'library';
    if (has(/^next$/)) type = 'next';
    else if (has(/^@sveltejs\/kit$/)) type = 'sveltekit';
    else if (has(/^@remix-run\/react$|^@react-router\/dev$/)) type = 'remix';
    else if (has(/^expo$|^react-native$/) && (exists('app/') || exists('src/screens/') || exists('screens/'))) type = 'mobile';
    else if (has(/^@react-email\/components$|^react-email$|^mjml$|^@mjml\//)) type = 'email';
    else if (
      has(/^(vite|react-scripts|@vue\/cli-service|nuxt|astro|@angular\/core)$/) &&
      (exists('src/pages/') || exists('src/routes/') || exists('src/views/') || exists('pages/'))
    )
      type = 'spa';
    else if (has(/^(express|fastify|koa|hono|@nestjs\/core|@hapi\/hapi|restify)$/) || exists('template.yaml') || exists('template.yml') || exists('serverless.yml'))
      type = 'server';
    appsOf.push({ ...pkg, type });
  }
  // A repository without package.json files still gets a map from its folders.
  if (!appsOf.length) appsOf.push({ dir: '', json: {}, deps: [], type: 'library' });
  const allDeps = new Set(appsOf.flatMap((p) => p.deps).concat(packages.find((p) => p.dir === '')?.deps ?? []));

  // Shared packages, server code, tests and docs share the "Behind the screen" land.
  const backKey = 'back';

  // --- Web apps: the route tree is the site map ----------------------------
  const webApps = appsOf.filter((a) => ['next', 'sveltekit', 'remix', 'spa'].includes(a.type));
  const apiRoutes = [];
  webApps.forEach((app) => {
    const title = webApps.length > 1 ? `${humanize(baseOf(app.dir.slice(0, -1)) || app.json.name || 'Web')} web app` : 'Web app';
    const web = add(`web:${app.dir}`, null, title, {
      surface: 'web',
      summary: `The ${app.type === 'next' ? 'Next.js' : app.type === 'sveltekit' ? 'SvelteKit' : app.type === 'remix' ? 'Remix' : 'web'} app in ${app.dir || 'the repository root'}.`,
    });
    const roots = ['app/', 'src/app/', 'pages/', 'src/pages/', 'src/routes/', 'app/routes/', 'src/views/']
      .map((r) => app.dir + r)
      .filter((r) => files.some((f) => f.startsWith(r)));
    const pages = [];
    for (const root of roots) {
      const appRouter = /(^|\/)(src\/)?app\/$/.test(root);
      for (const f of files) {
        if (!f.startsWith(root) || TEST.test(f)) continue;
        const rel = f.slice(root.length);
        if (/^api\//.test(rel) || ROUTE_FILE.test(f)) {
          if (/^api\//.test(rel) || appRouter) apiRoutes.push({ file: f, segments: segmentsOf(dirOf(rel)), root, app });
          continue;
        }
        const isPage =
          appRouter || /\/routes\/$/.test(root)
            ? PAGE_FILE.test(f) || (/\/app\/routes\/$/.test(root) && /\.(tsx|jsx)$/.test(f))
            : /\.(tsx|jsx|vue|svelte|astro|mdx?)$/.test(f) && !/(^|\/)_/.test(rel);
        if (isPage) {
          const routePath = appRouter || /\/routes\/$/.test(root) ? dirOf(rel) : rel.replace(/(\/index)?\.\w+$/, '/').replace(/^index\/$/, '');
          pages.push({ file: f, segments: segmentsOf(routePath), groups: groupsOf(routePath) });
        }
      }
    }
    const tree = foldRoutes(buildTrie(pages));
    layoutWebSections(web, tree, app);
    // Everything else under a route folder (layouts, colocated components) belongs to that route.
    for (const root of roots) {
      for (const f of files) {
        if (!f.startsWith(root) || claimed(f) || TEST.test(f) || /^api\//.test(f.slice(root.length))) continue;
        const key = deepestUrlRegion(segmentsOf(dirOf(f.slice(root.length))), web.key, app);
        own(regions.get(key), f);
      }
    }
  });

  // Page regions get keys like "page:/admin/posts"; find the deepest one for a route path.
  function deepestUrlRegion(segments, fallback, app) {
    const page = (url) => urlIndex.find((u) => u.kind === 'page' && u.app === app.dir && u.url === url)?.key;
    for (let n = segments.length; n > 0; n--) {
      const hit = page(`/${segments.slice(0, n).join('/')}`);
      if (hit) return hit;
    }
    return page('/') ?? fallback;
  }

  function layoutWebSections(web, tree, app) {
    const top = [...tree.children.values()];
    const sections = new Map(); // section key -> region
    const sectionFor = (node) => {
      if (AUTH_SEGMENT.test(node.seg)) return null;
      if (ADMIN_SEGMENT.test(node.seg)) return null;
      // Many top-level pages that share a route group, e.g. "(public)", read as one part of the site.
      const g = dominantGroup(node);
      if (!g || top.filter((t) => dominantGroup(t) === g).length < 3 || top.length <= 6) return null;
      if (!sections.has(g)) {
        const name = g.replace(/[()]/g, '');
        const title = /^(public|marketing|site|www|main|web|frontend|front)$/i.test(name) ? `${humanize(name)} site` : humanize(name);
        sections.set(g, add(`section:${app.dir}${g}`, web.key, title, { place: 'center', summary: `Pages in the ${g} route group.` }));
      }
      return sections.get(g);
    };
    // The home page lives where most of the site does.
    if (tree.pages.length) {
      const home = { seg: '', url: '/', pages: tree.pages, children: new Map(), groups: tree.groups };
      const parent = sectionFor({ ...home, seg: '_home' }) ?? web;
      pageRegion(home, parent.key, app, 'Home', 'center');
    }
    for (const node of top) {
      const parent = sectionFor(node) ?? web;
      const place = AUTH_SEGMENT.test(node.seg) ? 'top-right' : 'center';
      const title = AUTH_SEGMENT.test(node.seg) ? 'Sign-in' : ADMIN_SEGMENT.test(node.seg) ? 'Admin' : node.title;
      pageRegion(node, parent.key, app, title, place);
    }
  }

  function pageRegion(node, parentKey, app, title = node.title, place = 'auto') {
    const leaf = node.children.size === 0;
    const r = add(`page:${app.dir}${node.url}`, parentKey, title, {
      kind: leaf ? 'feature' : 'area',
      place: leaf && place === 'auto' ? 'auto' : place,
      tags: [...(leaf ? ['page'] : []), ...(SHOWCASE.test(node.url) ? ['showcase'] : [])],
      urls: node.urls ?? [node.url],
      summary: leaf ? `Page ${(node.urls ?? [node.url]).join(', ')}` : `Pages under ${node.url}`,
    });
    for (const url of r.urls) urlIndex.push({ url, key: r.key, kind: 'page', app: app.dir });
    for (const p of node.pages) own(r, p.file);
    for (const child of node.children.values()) pageRegion(child, r.key, app);
    return r;
  }

  // --- API: the bridge between the screens and the back -------------------
  if (apiRoutes.length) {
    const api = add('api', null, 'API', { surface: 'api', summary: `${apiRoutes.length} endpoints.` });
    const tree = buildTrie(apiRoutes.map((r) => ({ file: r.file, segments: r.segments.filter((s) => s !== 'api'), groups: [] })));
    apiRegions(tree, api.key, '/api', 0);
  }
  function apiRegions(node, parentKey, prefix, depth) {
    const parent = regions.get(parentKey);
    for (const p of node.pages) own(parent, p.file);
    const kids = [...node.children.values()].map((c) => ({ c, n: countPages(c) })).sort((a, b) => b.n - a.n || a.c.seg.localeCompare(b.c.seg));
    const big = depth < 2 ? kids.filter((k) => k.n >= 3).slice(0, 12) : [];
    const rest = kids.filter((k) => !big.includes(k));
    for (const { c } of big) {
      const url = `${prefix}/${c.seg}`;
      const r = add(`api:${url}`, parentKey, `${humanize(c.seg)} API`, { summary: `Endpoints under ${url}`, urls: [url] });
      urlIndex.push({ url, key: r.key, kind: 'api' });
      apiRegions(c, r.key, url, depth + 1);
    }
    if (!rest.length) return;
    const target =
      depth === 0 && rest.length > 1 ? add(`api:${prefix}/*`, parentKey, 'Other endpoints', { summary: rest.map(({ c }) => `${prefix}/${c.seg}`).join(', ') }) : parent;
    for (const { c } of rest) {
      const url = `${prefix}/${c.seg}`;
      urlIndex.push({ url, key: target.key, kind: 'api' });
      for (const p of allPages(c)) own(target, p.file);
      for (const w of words(c.seg)) target.words.set(w, 1);
    }
  }

  // --- Mobile apps -----------------------------------------------------------
  for (const app of appsOf.filter((a) => a.type === 'mobile')) {
    const mobile = add(`mobile:${app.dir}`, null, appsOf.filter((a) => a.type === 'mobile').length > 1 ? `${humanize(baseOf(app.dir.slice(0, -1)))} mobile app` : 'Mobile app', {
      surface: 'mobile',
      summary: `The ${app.deps.includes('expo') ? 'Expo' : 'React Native'} app in ${app.dir}.`,
    });
    const root = [app.dir + 'app/', app.dir + 'src/screens/', app.dir + 'screens/', app.dir + 'src/app/'].find((r) => files.some((f) => f.startsWith(r)));
    const screens = files
      .filter((f) => root && f.startsWith(root) && /\.(tsx|jsx)$/.test(f) && !/(^|\/)[_+]/.test(f.slice(root.length)) && !TEST.test(f))
      .map((f) => {
        const rel = f
          .slice(root.length)
          .replace(/(\/index)?\.(tsx|jsx)$/, '/')
          .replace(/^index\/$/, '');
        return { file: f, segments: segmentsOf(rel), groups: [] };
      });
    const tree = foldRoutes(buildTrie(screens));
    if (tree.pages.length) mobileScreen({ ...tree, seg: '', url: '/', title: 'Home', children: new Map() }, mobile.key, app);
    for (const c of tree.children.values()) mobileScreen(c, mobile.key, app);
    for (const f of files) if (f.startsWith(app.dir) && !claimed(f) && !TEST.test(f)) own(mobile, f);
  }
  function mobileScreen(node, parentKey, app) {
    const r = add(`screen:${app.dir}${node.url}`, parentKey, node.title ?? humanize(node.seg), {
      kind: node.children.size ? 'area' : 'feature',
      tags: ['page'],
      summary: `Screen ${node.url}`,
      urls: [node.url],
    });
    urlIndex.push({ url: node.url, key: r.key, kind: 'screen' });
    for (const p of node.pages) own(r, p.file);
    for (const c of node.children.values()) mobileScreen(c, r.key, app);
  }

  // --- Email templates: the letters people receive --------------------------
  for (const app of appsOf.filter((a) => a.type === 'email')) {
    const email = add(`email:${app.dir}`, null, 'Emails', { surface: 'email', summary: `Email templates in ${app.dir}.` });
    const dir = [app.dir + 'emails/', app.dir + 'src/emails/', app.dir + 'templates/'].find((d) => files.some((f) => f.startsWith(d)));
    for (const f of files.filter((f) => dir && f.startsWith(dir) && dirOf(f) === dir && /\.(tsx|jsx|mjml|html)$/.test(f))) {
      const r = add(`email:${f}`, email.key, humanize(baseOf(f)), { kind: 'feature', tags: ['template'], summary: `Email template ${baseOf(f)}` });
      own(r, f);
    }
    for (const f of files) if (f.startsWith(app.dir) && !claimed(f) && !TEST.test(f)) own(email, f);
  }

  // --- Shared screens: feature folders that belong to a page ---------------
  const pageRegions = [...regions.values()].filter((r) => r.key.startsWith('page:') || r.key.startsWith('screen:'));
  const featureDirs = new Map();
  for (const f of files) {
    if (claimed(f) || TEST.test(f)) continue;
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (!FEATURE_PARENT.test(parts[i - 1])) continue;
      const name = parts[i].replace(/\.(tsx|jsx|ts|js|vue|svelte)$/, '');
      const key = parts.slice(0, i + 1).join('/');
      if (!featureDirs.has(key)) featureDirs.set(key, { name, files: [] });
      featureDirs.get(key).files.push(f);
      break;
    }
  }
  const nav = webApps.length ? regions.get(`web:${webApps[0].dir}`) : null;
  let navRegion = null;
  for (const [, { name, files: fs }] of featureDirs) {
    if (nav && NAV.test(`${name}.tsx`)) {
      navRegion ??= add('nav', nav.key, 'Navigation', { place: 'top', kind: 'feature', summary: 'Header, menus and navigation.' });
      for (const f of fs) own(navRegion, f);
      continue;
    }
    const targets = matchPages(name, pageRegions);
    for (const f of fs) for (const t of targets) own(t, f);
  }

  // --- Back-end services: their own landmasses ------------------------------
  for (const app of appsOf.filter((a) => a.type === 'server')) {
    const svc = add(`service:${app.dir}`, null, humanize(app.json.name?.replace(/^@[\w-]+\//, '') || baseOf(app.dir.slice(0, -1))), {
      surface: 'service',
      summary: `Server in ${app.dir}.`,
    });
    codeRegions(app.dir, svc.key, 0);
  }
  // Serverless templates inside other apps (a SAM health check, a worker) are small services too.
  for (const t of paths.filter((p) => /(^|\/)(template\.ya?ml|serverless\.ya?ml|Dockerfile)$/.test(p) && !IGNORE.test(p))) {
    const dir = dirOf(t);
    if (!dir || appsOf.some((a) => a.dir === dir) || [...regions.keys()].includes(`service:${dir}`)) continue;
    const svc = add(`service:${dir}`, null, humanize(baseOf(dir.slice(0, -1))), { surface: 'service', summary: `Deployed separately from ${dir}.` });
    for (const f of files) if (f.startsWith(dir) && !claimed(f)) own(svc, f);
  }

  // --- Tests, docs and scripts sit behind the screen ------------------------
  const tests = files.filter((f) => TEST.test(f) && !claimed(f));
  const ci = files.filter((f) => f.startsWith('.github/') && !claimed(f));
  if (tests.length + ci.length) {
    const r = add('tests', backKey, 'Tests & CI', { kind: 'feature', summary: `${tests.length} test files${ci.length ? `, ${ci.length} CI files` : ''}.` });
    for (const f of [...tests, ...ci]) own(r, f);
  }

  // --- Shared packages and app internals -------------------------------------
  for (const app of appsOf) {
    const leftovers = files.filter((f) => under(f, app.dir) && !claimed(f) && !appsOf.some((o) => o !== app && o.dir.length > app.dir.length && f.startsWith(o.dir)));
    if (!leftovers.length) continue;
    const name = baseOf(app.dir.slice(0, -1));
    const title =
      app.dir === ''
        ? 'Code'
        : app.type !== 'library'
          ? `${humanize(name)} app code`
          : /^(packages|libs?|modules)\/$/.test(dirOf(app.dir.slice(0, -1)))
            ? `${humanize(name)} package`
            : humanize(name);
    const r = add(`code:${app.dir}`, backKey, title, {
      summary: app.json.description || `${leftovers.length} files in ${app.dir || 'the repository'}${app.json.name ? ` (${app.json.name})` : ''}.`,
    });
    codeRegions(app.dir, r.key, 0, leftovers);
  }
  const loose = files.filter((f) => !claimed(f));
  if (loose.length) {
    const groups = new Map();
    for (const f of loose) {
      const top = f.includes('/') ? f.slice(0, f.indexOf('/') + 1) : '';
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top).push(f);
    }
    for (const [top, fs] of groups) {
      if (top === '' && fs.length < 10) continue;
      const title = top === '' ? 'Repository root' : humanize(top.slice(0, -1));
      const r = add(`code:${top}`, backKey, title, { summary: `${fs.length} files in ${top || 'the repository root'}.` });
      codeRegions(top, r.key, 0, fs);
    }
  }

  function codeRegions(prefix, parentKey, depth, pool = files.filter((f) => under(f, prefix) && !claimed(f))) {
    const parent = regions.get(parentKey);
    const byDir = new Map();
    for (const f of pool) {
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf('/');
      const dir = slash < 0 ? '' : rest.slice(0, slash + 1);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(f);
    }
    const dirs = [...byDir.entries()].filter(([d, fs]) => d && fs.length >= 3).sort((a, b) => b[1].length - a[1].length);
    for (const [d, fs] of byDir) if (!dirs.some(([x]) => x === d)) for (const f of fs) own(parent, f);
    // A folder that is all there is (src/) is not a region of its own.
    if (dirs.length === 1 && !byDir.get('')?.length && depth < 4) return codeRegions(prefix + dirs[0][0], parentKey, depth, dirs[0][1]);
    for (const [d, fs] of dirs.slice(0, 14)) {
      const r = add(`code:${prefix}${d}`, parentKey, humanize(d.slice(0, -1)), { kind: 'feature', summary: `${fs.length} files in ${prefix}${d}` });
      if (fs.length > 30 && depth < 2) {
        r.kind = 'area';
        codeRegions(prefix + d, r.key, depth + 1, fs);
      } else for (const f of fs) own(r, f);
    }
    for (const [, fs] of dirs.slice(14)) for (const f of fs) own(parent, f);
  }

  // --- Third-party services: islands ------------------------------------------
  for (const [name, depRe, textRe, extra] of SERVICES) {
    const deps = [...allDeps].filter((d) => depRe.test(d));
    const mentioned = mentions.filter((m) => textRe.test(m.replace(/^.*generated with .*$/gim, ''))).length;
    if (!deps.length && mentioned < 2) continue;
    const r = add(`ext:${name}`, null, name, {
      surface: 'external',
      kind: 'feature',
      summary: deps.length ? `Third-party service, used through ${deps.slice(0, 3).join(', ')}.` : `Third-party service mentioned in ${mentioned} issues.`,
      details: [deps.length && `The code depends on ${deps.map((d) => `\`${d}\``).join(', ')}.`, mentioned && `${mentioned} issue${mentioned === 1 ? '' : 's'} mention it.`].filter(Boolean).join(' '),
      mentionRe: textRe,
    });
    for (const w of words(extra, { code: true })) r.words.set(w, 1);
  }

  // --- Words each region answers to (for issues that name no files) -------
  for (const r of regions.values()) {
    for (const w of words(r.title, { code: true })) r.words.set(w, Math.max(r.words.get(w) ?? 0, 1));
    for (const u of r.urls) for (const w of words(u.replace(/\[[^\]]*\]/g, ''))) r.words.set(w, Math.max(r.words.get(w) ?? 0, 1));
    for (const f of r.files.slice(0, 60)) {
      for (const w of words(baseOf(f))) if (!r.words.has(w)) r.words.set(w, 0.4);
    }
  }
  const parents = new Set([...regions.values()].map((r) => r.parent));
  for (const r of regions.values()) {
    if (r.parent === backKey) Object.assign(r, { parent: null, place: 'offscreen', surface: 'none' });
    if (r.surface === 'auto' || r.surface === 'none') r.kind = parents.has(r.key) ? 'area' : 'feature';
    if (r.parent === null && r.surface === 'auto') r.surface = 'none';
    r.fileCount = r.files.length;
  }

  return { regions, fileOwners, urlIndex, paths: files };
}

function segmentsOf(routePath) {
  return routePath
    .split('/')
    .filter(Boolean)
    .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@') && !s.startsWith('_') && !/^\[.*\]$/.test(s) && !/^\$/.test(s) && !/^\[\[/.test(s));
}
const groupsOf = (routePath) => routePath.split('/').filter((s) => /^\(.*\)$/.test(s));

function buildTrie(pages) {
  const root = { seg: '', url: '/', pages: [], children: new Map(), groups: [] };
  for (const p of pages) {
    let node = root;
    for (const seg of p.segments) {
      if (!node.children.has(seg))
        node.children.set(seg, { seg, url: `${node.url === '/' ? '' : node.url}/${seg}`, title: humanize(seg), pages: [], children: new Map(), groups: [] });
      node = node.children.get(seg);
    }
    node.pages.push(p);
    node.groups.push(...(p.groups ?? []).slice(0, 1));
  }
  return root;
}

const countPages = (n) => n.pages.length + [...n.children.values()].reduce((s, c) => s + countPages(c), 0);
const allPages = (n) => [...n.pages, ...[...n.children.values()].flatMap(allPages)];

/**
 * Make the route tree read like a site map: a page with a couple of sub-pages
 * ("People" with "add" and "[id]") is one place; a folder with one route
 * ("ui-ux/brand") is one step, not two.
 */
function foldRoutes(node) {
  for (const c of node.children.values()) foldRoutes(c);
  for (const [seg, c] of [...node.children]) {
    if (!c.pages.length && c.children.size === 1) {
      const [only] = c.children.values();
      node.children.set(seg, { ...only, seg, urls: [only.url], title: only.title });
    }
  }
  const kids = [...node.children.values()];
  if (node.url !== '/' && node.pages.length && kids.length && kids.length <= 3 && kids.every((c) => !c.children.size && c.pages.length <= 2)) {
    node.urls = [node.url, ...kids.map((c) => c.url)];
    for (const c of kids) node.pages.push(...c.pages);
    node.children = new Map();
  }
  return node;
}

function dominantGroup(node) {
  const counts = new Map();
  const walk = (n) => {
    for (const g of n.groups) counts.set(g, (counts.get(g) ?? 0) + 1);
    for (const c of n.children.values()) walk(c);
  };
  walk(node);
  let best = null,
    n = 0;
  for (const [g, c] of counts) if (c > n) [best, n] = [g, c];
  return best;
}

/**
 * Which page(s) a feature folder is the screen for: every word of the page's
 * own name appears in the folder's name ("email-lists" -> /admin/email/lists),
 * preferring the page whose whole URL explains the folder best.
 */
function matchPages(name, pages) {
  const want = new Set(words(name, { code: true }));
  if (!want.size) return [];
  let best = [],
    bestScore = 0;
  for (const r of pages) {
    if (r.urls.some((u) => SHOWCASE.test(u))) continue;
    const url = r.urls[0] === '/' ? 'home' : r.urls[0];
    const segs = url.split('/').filter(Boolean);
    const last = new Set(words(segs.at(-1) ?? '', { code: true }));
    if (!last.size || ![...last].every((w) => want.has(w))) continue;
    const all = new Set(words(segs.join(' '), { code: true }));
    const score = [...want].filter((w) => all.has(w)).length / want.size;
    if (score > bestScore + 1e-9) [best, bestScore] = [[r], score];
    else if (Math.abs(score - bestScore) < 1e-9) best.push(r);
  }
  return best;
}
