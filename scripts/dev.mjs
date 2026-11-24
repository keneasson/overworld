// Local development: Vite for the web app, with /api/* served in-process by the
// same API code that runs in Lambda (backed by a JSON file in .data/).

import { createServer } from 'vite';
import { createApi } from '../api/app.mjs';
import { createModel } from '../api/model/index.mjs';
import { githubApp } from '../api/stores/github/app.mjs';
import { createStores } from '../api/stores/index.mjs';
import { createSync } from '../api/sync.mjs';
import { readGitHubApp } from './local-config.mjs';
import { allowedLogins } from '../api/aws.mjs';

const model = await createModel({ DATA_FILE: process.env.DATA_FILE ?? '.data/table.json' });

// Sync writes to real GitHub issues, so it is off locally unless asked for: SYNC=1 npm run dev.
// There's no stream or scheduler here: a save drains straight away, and retries are timers.
const app = process.env.SYNC === '1' ? readGitHubApp() : null;
if (process.env.SYNC === '1' && !app) console.warn('SYNC=1, but .conf/ has no github-app.json and github-app.pem: sync stays off');
const stores = createStores({ githubApp: app ? githubApp(app) : null });
const sync = app && createSync({ model, stores, schedule: async (pid, at) => setTimeout(() => sync.drain(pid), Math.max(0, Date.parse(at) - Date.now())).unref() });
const drainSoon = (pid) => sync.drain(pid).catch((err) => console.error(`sync ${pid}:`, err));
// Sign-in (#52) can't reach Cognito or GitHub from here. SIGN_IN=stub stands both in, so the screens can be tried: signing in
// skips GitHub's page and signs in as SIGN_IN_AS (a GitHub login, 'octocat' by default), who is let in.
const signIn = process.env.SIGN_IN === 'stub' ? await stubSignIn(model, process.env.SIGN_IN_AS ?? 'octocat') : {};
const api = createApi({ model, accessKey: process.env.ACCESS_KEY ?? '', sync, stores, onSaved: sync && drainSoon, ...signIn });

async function stubSignIn(model, login) {
  const { createAuth } = await import('free-tier-auth');
  const { fakeCognito, fakeGitHub } = await import('../packages/free-tier-auth/test/helpers.mjs');
  const person = { id: 1, login, name: login, emails: [{ email: `${login}@example.com`, verified: true, primary: true }] };
  const auth = createAuth({
    baseUrl: `http://localhost:${process.env.PORT ?? 5173}`, basePath: '/api/auth', cookieName: 'projectmap_session', store: model.signIn,
    cognito: { client: fakeCognito({ bridgeSecret: 'stub' }), userPoolId: 'stub', clientId: 'stub', clientSecret: 'stub' },
    github: { clientId: 'stub', clientSecret: 'stub' }, bridgeSecret: 'stub', fetchImpl: fakeGitHub({ stub: person }),
  });
  const handle = async (req) => {
    const out = await auth.handle(req);
    // Instead of GitHub's page, straight back to the callback, as GitHub would after "Authorize".
    if (out?.headers?.location?.startsWith('https://github.com/')) out.headers.location = `/api/auth/github/callback?code=stub&state=${new URL(out.headers.location).searchParams.get('state')}`;
    return out;
  };
  console.log(`Sign-in is stubbed: "Sign in with GitHub" signs in as ${login}`);
  return { auth: { ...auth, handle }, mayEnter: allowedLogins(login) };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = await createServer({
  configFile: new URL('../vite.config.js', import.meta.url).pathname,
  server: { port: Number(process.env.PORT ?? 5173) },
  plugins: [
    {
      name: 'projectmap-api',
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (!req.url.startsWith('/api/')) return next();
          const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
          // A screenshot sent to a one-time upload link (#16) is its own bytes, not JSON.
          if (req.url.startsWith('/api/uploads/')) {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const out = await api({ method: req.method, path: req.url.split('?')[0], headers, rawBytes: Buffer.concat(chunks) });
            res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
            return;
          }
          let body = null;
          try {
            body = await readBody(req);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"Body must be JSON"}');
            return;
          }
          const [path, search = ''] = req.url.split('?');
          const out = await api({ method: req.method, path, query: Object.fromEntries(new URLSearchParams(search)), headers, body });
          if (out.raw !== undefined) {
            // Sign-in's routes: their own headers and cookies.
            res.writeHead(out.status, { ...out.headers, ...(out.cookies?.length ? { 'set-cookie': out.cookies } : {}) }).end(out.raw);
            return;
          }
          res.writeHead(out.status, { 'content-type': 'application/json' }).end(out.body == null ? '' : JSON.stringify(out.body));
        });
      },
    },
  ],
});
await server.listen();
server.printUrls();

// Live documents (prototype): one shared document per item, edited together by people, agents and the store. LIVE=0 turns it off.
if (process.env.LIVE !== '0') {
  const { startLiveServer } = await import('./live/server.mjs');
  await startLiveServer({ api, model, load: (path) => server.ssrLoadModule(path), port: Number(process.env.LIVE_PORT ?? 1234), accessKey: process.env.ACCESS_KEY ?? '' });
}
