// What the app does when part of it fails (#71 SHIP-13, SHIP-14). Pure, so the screen and the tests share it.

/** Code the deploy removed: an app on an older version asked for a part of itself that is no longer there (SHIP-13). */
export const isStaleBuild = (err) =>
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (?:CSS )?chunk \S+ failed/i.test(
    String(err?.message ?? err ?? ''),
  );

/** The report an error becomes, for POST /api/errors: what, where, and enough about the device to reproduce it. */
export function crashReport(err, { where, componentStack, url, userAgent, build } = {}) {
  return {
    message: String(err?.message ?? err ?? 'Unknown error').slice(0, 1000),
    stack: err?.stack ? String(err.stack).slice(0, 8000) : undefined,
    componentStack: componentStack ? String(componentStack).slice(0, 8000) : undefined,
    where,
    url,
    userAgent,
    build,
  };
}

/** Each distinct error once per page, and at most a few: a crash that repeats on every draw must not flood the log. */
export function reporter(send, { most = 5 } = {}) {
  const seen = new Set();
  return (report) => {
    const key = `${report.where}|${report.message}`;
    if (seen.has(key) || seen.size >= most) return false;
    seen.add(key);
    Promise.resolve(send(report)).catch(() => {});
    return true;
  };
}
