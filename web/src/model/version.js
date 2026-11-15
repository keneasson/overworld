// Which build of the app a page runs (SHIP-12). A deploy gives the entry script a new hashed name, so comparing the
// entry the open page loaded with the one the server now serves says whether a newer version is out.

const ENTRY = /<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+\.js)"/;

/** The built entry script a page's HTML loads, or null (as in development, where nothing is hashed). */
export function entryOf(html) {
  return ENTRY.exec(html ?? '')?.[1] ?? null;
}

/** True when the server's page loads a different build from the open one. Unknown on either side is never "newer". */
export function isNewer(runningEntry, servedHtml) {
  const served = entryOf(servedHtml);
  return Boolean(runningEntry && served && served !== runningEntry);
}
