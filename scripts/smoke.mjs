// The smoke test run against a live deploy (#27, SHIP-03): the app answers, and the API serves the
// project list with the access key. A cold start can take a few seconds, so it retries briefly.
//
//   PROJECTMAP_ACCESS_KEY=… node scripts/smoke.mjs https://….lambda-url.….on.aws

const url = (process.argv[2] ?? '').replace(/\/$/, '');
const key = process.env.PROJECTMAP_ACCESS_KEY ?? '';
if (!url) {
  console.error('Usage: node scripts/smoke.mjs <url>');
  process.exit(2);
}

const checks = [
  ['the page loads', async () => (await fetch(`${url}/`)).status === 200],
  ['the health check answers', async () => (await (await fetch(`${url}/api/health`)).json()).ok === true],
  ['the API serves the project list with the access key', async () => Array.isArray((await (await fetch(`${url}/api/projects`, { headers: { 'x-projectmap-key': key } })).json()).projects)],
  ['the API refuses a request without it', async () => (await fetch(`${url}/api/projects`)).status === 401],
];

let failed = 0;
for (const [name, check] of checks) {
  let ok = false;
  for (let attempt = 0; attempt < 5 && !ok; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 3000));
    ok = await check().catch(() => false);
  }
  console.log(`${ok ? '✔' : '✖'} ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
