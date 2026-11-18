// The live version's web assets, kept beside the new ones in a deploy (#71 SHIP-13). An app left open on the previous version
// loads parts of itself only when they're first needed (the comment box, the editor): those files must still be there after
// the deploy, or that part fails. Their names carry their content's hash, so they never clash with the new build's.

// A file names another as assets/<name> (the page, and Vite's preload lists) or ./<name> (a chunk's own imports).
const ASSET = /["'`(/](?:assets\/|\.\/)([\w.-]+\.(?:js|css))/g;

/**
 * Every asset the live app at `url` can load: its page's scripts and styles, and every file those name, followed to the end.
 * Anything that can't be fetched is left out: the app on the old version then offers Update instead (SHIP-12).
 * @returns {Promise<Map<string, Buffer>>} file name in assets/ → its bytes
 */
export async function previousAssets(url, { fetchImpl = fetch, max = 200 } = {}) {
  const get = async (path) => {
    try {
      const res = await fetchImpl(new URL(path, url));
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    } catch {
      return null;
    }
  };
  const page = await get('/');
  const out = new Map();
  if (!page) return out;
  const names = (text) => [...text.matchAll(ASSET)].map((m) => m[1]);
  const queue = names(page.toString('utf8'));
  while (queue.length && out.size < max) {
    const name = queue.shift();
    if (out.has(name)) continue;
    const body = await get(`/assets/${name}`);
    if (!body) continue;
    out.set(name, body);
    queue.push(...names(body.toString('utf8')).filter((n) => !out.has(n)));
  }
  return out;
}
