import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../src/model/version.js';
import { crashReport, isStaleBuild, reporter } from '../src/model/crash.js';
import { previousAssets } from '../../scripts/previous-assets.mjs';

const page = (entry) => `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head><body><div id="root"></div></body></html>`;

test('SHIP-12 an open app knows when a newer version has been deployed', () => {
  assert.equal(isNewer('/assets/index-aaa111.js', page('/assets/index-bbb222.js')), true, 'a new deploy');
  assert.equal(isNewer('/assets/index-aaa111.js', page('/assets/index-aaa111.js')), false, 'the same build');
  assert.equal(isNewer(null, page('/assets/index-bbb222.js')), false, 'in development nothing is hashed');
  assert.equal(isNewer('/assets/index-aaa111.js', '<html>Service unavailable</html>'), false, 'an error page is not a version');
});

test('SHIP-13 an app on an older version still loads what it needs after a deploy, and knows when it can\'t', async () => {
  // Each browser says it its own way when a part of the app has gone.
  for (const message of ['Failed to fetch dynamically imported module: https://x/assets/TextBox-abc.js', 'Importing a module script failed.', 'error loading dynamically imported module: https://x/assets/IssueForm-abc.js', 'Unable to preload CSS for /assets/a.css']) {
    assert.equal(isStaleBuild(new TypeError(message)), true, message);
  }
  assert.equal(isStaleBuild(new TypeError("Cannot read properties of undefined (reading 'poly')")), false, 'any other error is a crash, not a new version');

  // A deploy keeps the live version's files: its page's, and every one they load, however deep.
  const live = {
    '/': page('/assets/index-old1.js').replace('</head>', '<link rel="stylesheet" href="/assets/index-old1.css"></head>'),
    '/assets/index-old1.js': 'const a=()=>import("./IssueForm-old2.js");const b="assets/TextBox-old3.js";',
    '/assets/index-old1.css': 'body{}',
    '/assets/IssueForm-old2.js': 'import{x}from"./shared-old4.js";',
    '/assets/TextBox-old3.js': 'export default 1',
  };
  const fetchImpl = async (u) => {
    const body = live[new URL(u).pathname];
    return { ok: body != null, arrayBuffer: async () => new TextEncoder().encode(body ?? '').buffer };
  };
  const kept = await previousAssets('https://live.example/', { fetchImpl });
  assert.deepEqual([...kept.keys()].sort(), ['IssueForm-old2.js', 'TextBox-old3.js', 'index-old1.css', 'index-old1.js'], 'all it can reach; one it cannot fetch is left out');
  assert.equal(kept.get('TextBox-old3.js').toString(), 'export default 1');
  assert.equal((await previousAssets('https://down.example/', { fetchImpl: async () => { throw new Error('offline'); } })).size, 0, 'a site that is down keeps nothing, and the deploy goes on');
});

test('SHIP-14 an error the app catches is reported once, with where it happened and enough to reproduce it', () => {
  const err = new TypeError("Cannot read properties of undefined (reading 'poly')");
  const r = crashReport(err, { where: 'panel', componentStack: '\n    at Details', url: 'https://x/#n=issue-53', userAgent: 'Safari', build: '/assets/index-abc.js' });
  assert.equal(r.message, err.message);
  assert.match(r.stack, /TypeError/);
  assert.deepEqual([r.where, r.url, r.userAgent, r.build], ['panel', 'https://x/#n=issue-53', 'Safari', '/assets/index-abc.js']);
  const sent = [];
  const report = reporter((x) => sent.push(x), { most: 3 });
  assert.equal(report(r), true);
  assert.equal(report(r), false, 'the same error drawn again is not sent again');
  for (const m of ['a', 'b', 'c', 'd']) report(crashReport(new Error(m), { where: 'map' }));
  assert.deepEqual(sent.map((x) => x.message), [err.message, 'a', 'b'], 'and a page sends a few at most');
});
