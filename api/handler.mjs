// AWS Lambda entry point (Function URL, payload format 2.0).
// /api/* goes to the JSON API; everything else is the built web app.

import { createApi } from './app.mjs';
import { createModel } from './model/index.mjs';
import { serveStatic, SECURITY_HEADERS } from './static.mjs';

let api;

async function getApi() {
  api ??= createApi({ model: await createModel(), accessKey: process.env.ACCESS_KEY ?? '' });
  return api;
}

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.rawPath ?? '/';
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

  if (!path.startsWith('/api/')) return serveStatic({ method, path, headers });

  let body = null;
  if (event.body) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: 'Body must be JSON' });
    }
  }
  const res = await (await getApi())({ method, path, headers, body });
  return json(res.status, res.body);
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS },
    body: JSON.stringify(data),
  };
}
