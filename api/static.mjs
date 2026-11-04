// Serves the built web app (bundled into the Lambda zip under ./public).

import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const ROOT = process.env.STATIC_DIR ?? fileURLToPath(new URL('./public/', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest', '.txt']);

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const cache = new Map();

async function load(rel) {
  if (cache.has(rel)) return cache.get(rel);
  let file = null;
  try {
    const raw = await readFile(join(ROOT, rel));
    file = { raw, ext: extname(rel) };
  } catch {
    // missing file -> null
  }
  cache.set(rel, file);
  return file;
}

export async function serveStatic({ method, path, headers }) {
  if (method !== 'GET' && method !== 'HEAD') return { statusCode: 405, body: 'Method not allowed' };
  let rel = normalize(decodeURIComponent(path)).replace(/^[/\\]+/, '');
  if (rel.startsWith('..')) return { statusCode: 404, body: 'Not found' };
  if (!rel || rel.endsWith('/')) rel += 'index.html';

  let file = await load(rel);
  // Unknown extension-less paths fall back to the app shell.
  if (!file && !extname(rel)) file = await load((rel = 'index.html'));
  if (!file) return { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' };

  const accept = headers['accept-encoding'] ?? '';
  let body = file.raw;
  let encoding;
  if (COMPRESSIBLE.has(file.ext) && file.raw.length > 1024) {
    if (accept.includes('br')) {
      body = file.br ??= brotliCompressSync(file.raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } });
      encoding = 'br';
    } else if (accept.includes('gzip')) {
      body = file.gz ??= gzipSync(file.raw, { level: 9 });
      encoding = 'gzip';
    }
  }

  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: {
      'content-type': TYPES[file.ext] ?? 'application/octet-stream',
      'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      vary: 'accept-encoding',
      ...(encoding ? { 'content-encoding': encoding } : {}),
      ...SECURITY_HEADERS,
    },
    body: method === 'HEAD' ? '' : body.toString('base64'),
  };
}
