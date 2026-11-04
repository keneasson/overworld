// Local development: Vite for the web app, with /api/* served in-process by the
// same API code that runs in Lambda (backed by a JSON file in .data/).

import { createServer } from 'vite';
import { createApi } from '../api/app.mjs';
import { createModel } from '../api/model/index.mjs';

const api = createApi({ model: await createModel({ DATA_FILE: process.env.DATA_FILE ?? '.data/table.json' }), accessKey: process.env.ACCESS_KEY ?? '' });

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
          res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
        });
      },
    },
  ],
});
await server.listen();
server.printUrls();
