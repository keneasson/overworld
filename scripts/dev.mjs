// Local development: Vite for the web app, with /api/* served in-process by the
// same API code that runs in Lambda (backed by a JSON file in .data/).

import { createServer } from 'vite';
import { createApi } from '../api/app.mjs';
import { createModel } from '../api/model/index.mjs';
import { githubApp } from '../api/stores/github/app.mjs';
import { createStores } from '../api/stores/index.mjs';
import { createSync } from '../api/sync.mjs';
import { readGitHubApp } from './local-config.mjs';

const model = await createModel({ DATA_FILE: process.env.DATA_FILE ?? '.data/table.json' });

// Sync writes to real GitHub issues, so it is off locally unless asked for: SYNC=1 npm run dev.
// There's no stream or scheduler here: a save drains straight away, and retries are timers.
const app = process.env.SYNC === '1' ? readGitHubApp() : null;
if (process.env.SYNC === '1' && !app) console.warn('SYNC=1, but .conf/ has no github-app.json and github-app.pem: sync stays off');
const stores = createStores({ githubApp: app ? githubApp(app) : null });
const sync = app && createSync({ model, stores, schedule: async (pid, at) => setTimeout(() => sync.drain(pid), Math.max(0, Date.parse(at) - Date.now())).unref() });
const drainSoon = (pid) => sync.drain(pid).catch((err) => console.error(`sync ${pid}:`, err));
const api = createApi({ model, accessKey: process.env.ACCESS_KEY ?? '', sync, stores, onSaved: sync && drainSoon });

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
          let body = null;
          try {
            body = await readBody(req);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"Body must be JSON"}');
            return;
          }
          const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
          const out = await api({ method: req.method, path: req.url.split('?')[0], headers, body });
          res.writeHead(out.status, { 'content-type': 'application/json' }).end(out.body == null ? '' : JSON.stringify(out.body));
        });
      },
    },
  ],
});
await server.listen();
server.printUrls();
