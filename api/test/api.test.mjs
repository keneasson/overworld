import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../app.mjs';
import { createModel } from '../model/index.mjs';
import { parseRepo, importGitHub } from '../github.mjs';
import { sanitizeNode } from '../../shared/schema.js';

async function setup(accessKey = 'secret-key') {
  const dir = await mkdtemp(join(tmpdir(), 'projectmap-'));
  const model = await createModel({ DATA_FILE: join(dir, 'db.json') });
  const api = createApi({ model, accessKey, log: { error() {} } });
  const call = (method, path, body, key = accessKey) => api({ method, path, body, headers: key ? { 'x-projectmap-key': key } : {} });
  return { call };
}

test('rejects requests without the access key, health stays public', async () => {
  const { call } = await setup();
  assert.equal((await call('GET', '/api/projects', null, '')).status, 401);
  assert.equal((await call('GET', '/api/projects', null, 'wrong')).status, 401);
  assert.equal((await call('GET', '/api/health', null, '')).status, 200);
});

test('seeds the demo project once, then CRUDs nodes', async () => {
  const { call } = await setup();
  const list = await call('GET', '/api/projects');
  assert.equal(list.status, 200);
  assert.equal(list.body.projects.length, 1);
  const pid = list.body.projects[0].id;

  const { body } = await call('GET', `/api/projects/${pid}`);
  assert.ok(body.nodes.length > 100, 'demo has a rich tree');
  assert.ok(
    body.nodes.some((n) => n.links.length),
    'demo has links',
  );

  const created = await call('POST', `/api/projects/${pid}/nodes`, { node: { title: 'New area', kind: 'area', parentId: 'root' } });
  assert.equal(created.status, 201);
  const area = created.body.nodes[0];

  const child = (await call('POST', `/api/projects/${pid}/nodes`, { node: { title: 'Child', parentId: area.id, links: [{ to: 'root', type: 'relates' }] } })).body.nodes[0];
  assert.equal(child.parentId, area.id);
  assert.equal(child.kind, 'task');

  const cyc = await call('PATCH', `/api/projects/${pid}/nodes/${area.id}`, { parentId: child.id });
  assert.equal(cyc.status, 400, 'cannot move a node inside itself');

  const patched = await call('PATCH', `/api/projects/${pid}/nodes/${child.id}`, { status: 'done', tags: 'A, b ,a' });
  assert.equal(patched.body.node.status, 'done');
  assert.deepEqual(patched.body.node.tags, ['a', 'b']);

  const bad = await call('PATCH', `/api/projects/${pid}/nodes/${child.id}`, { status: 'nope' });
  assert.equal(bad.status, 400);

  // Another node links to the child; deleting the area removes both and scrubs the link.
  const other = body.nodes.find((n) => n.kind === 'task');
  await call('PATCH', `/api/projects/${pid}/nodes/${other.id}`, { links: [{ to: child.id, type: 'depends' }] });
  const del = await call('DELETE', `/api/projects/${pid}/nodes/${area.id}`);
  assert.deepEqual(new Set(del.body.deleted), new Set([area.id, child.id]));
  assert.equal(del.body.updated.find((n) => n.id === other.id).links.length, 0);

  assert.equal((await call('DELETE', `/api/projects/${pid}/nodes/root`)).status, 400);

  // Root edits flow into the project listing.
  await call('PATCH', `/api/projects/${pid}/nodes/root`, { title: 'Renamed' });
  assert.equal((await call('GET', '/api/projects')).body.projects[0].title, 'Renamed');

  // Deleting everything does not re-seed.
  await call('DELETE', `/api/projects/${pid}`);
  assert.equal((await call('GET', '/api/projects')).body.projects.length, 0);
});

test('imports exported JSON with fresh ids and intact structure', async () => {
  const { call } = await setup('');
  const pid = (await call('GET', '/api/projects')).body.projects[0].id;
  const exported = (await call('GET', `/api/projects/${pid}`)).body;
  const imported = await call('POST', '/api/import/json', exported);
  assert.equal(imported.status, 201);
  const nodes = imported.body.nodes;
  assert.equal(nodes.length, exported.nodes.length);
  const ids = new Set(nodes.map((n) => n.id));
  assert.ok(nodes.every((n) => n.id === 'root' || ids.has(n.parentId)));
  assert.equal(
    nodes.reduce((s, n) => s + n.links.length, 0),
    exported.nodes.reduce((s, n) => s + n.links.length, 0),
  );
});

test('parses GitHub repo references', () => {
  assert.deepEqual(parseRepo('octo/hello-world'), { owner: 'octo', name: 'hello-world' });
  assert.deepEqual(parseRepo('https://github.com/octo/hello.js.git'), { owner: 'octo', name: 'hello.js' });
  assert.throws(() => parseRepo('nope'));
});

/** A small repository on a fake GitHub: a Next.js shop with issues and a behaviour spec. */
function fakeShop() {
  const issue = (number, title, body = '', extra = {}) => ({ number, title, body, state: 'open', html_url: `u${number}`, labels: [], milestone: null, assignees: [], ...extra });
  const issues = [
    issue(1, 'Epic: checkout', '- [ ] #2\n- [ ] #3'),
    issue(2, 'Pay with saved card', 'depends on #4', { state: 'closed', labels: [{ name: 'enhancement' }] }),
    issue(3, 'Coupon field broken', 'The field on /checkout rejects valid codes.', { labels: [{ name: 'bug' }, { name: 'P1' }], assignees: [{ login: 'ken' }] }),
    issue(4, 'Card tokens', 'Part of #1. See `apps/web/app/api/payments/route.ts`.', { milestone: { title: 'v1', due_on: '2027-01-31T00:00:00Z' } }),
    issue(5, 'Think about the vibe', 'Hmm.'),
    issue(6, 'A PR', '', { pull_request: {} }),
    issue(8, 'Dark mode toggle', 'Maybe later.', { state: 'closed', state_reason: 'not_planned' }),
  ];
  const pulls = [{ number: 9, title: 'Vibes', body: 'Closes #5' }];
  const files = { 'package.json': { name: 'shop', workspaces: ['apps/*'] }, 'apps/web/package.json': { name: 'web', dependencies: { next: '16.0.0', stripe: '19.0.0' } } };
  const spec =
    '# Behaviour spec: Checkout\n\n> What paying must do.\n\n## 1. Paying — `PAY`\n\n| ID | Scenario | Status |\n|---|---|---|\n| PAY-01 | A saved card pays in one tap. | ✅ |\n| PAY-02 | A coupon applies before paying. | ❌ #3 |\n| PAY-03 | Who refunds? | 🔷 |\n';
  const tree = [
    'package.json',
    'apps/web/package.json',
    'apps/web/app/(shop)/page.tsx',
    'apps/web/app/(shop)/checkout/page.tsx',
    'apps/web/app/(shop)/cart/page.tsx',
    'apps/web/app/(shop)/products/page.tsx',
    'apps/web/app/auth/signin/page.tsx',
    'apps/web/app/api/payments/route.ts',
    'apps/web/components/site-header.tsx',
    'docs/behavior/checkout.md',
  ].map((path) => ({ path, type: 'blob' }));
  return {
    issues,
    issue,
    fetch: async (url) => {
      const raw = url.match(/^https:\/\/raw\.githubusercontent\.com\/octo\/shop\/main\/(.*)$/);
      const body = raw
        ? ((files[decodeURIComponent(raw[1])] && JSON.stringify(files[decodeURIComponent(raw[1])])) ?? (raw[1].endsWith('checkout.md') ? spec : null))
        : url.includes('/issues?')
          ? issues
          : url.includes('/pulls?')
            ? pulls
          : url.includes('/git/trees/')
            ? { tree }
            : { full_name: 'octo/shop', description: '', html_url: 'https://github.com/octo/shop', default_branch: 'main' };
      return { ok: body != null, status: body == null ? 404 : 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    },
  };
}

test('maps a GitHub repository: code is the land, issues the work, specs the laws', async () => {
  const { fetch: fake } = fakeShop();
  const { nodes } = await importGitHub({ repo: 'octo/shop' }, fake);
  const byTitle = (t) => nodes.find((n) => n.title.includes(t));
  const pathOf = (n) => {
    const out = [];
    for (let cur = n; cur && cur.id !== 'root'; cur = nodes.find((x) => x.id === cur.parentId)) out.unshift(cur.title);
    return out.join(' › ');
  };

  assert.ok(!byTitle('A PR'), 'pull requests are not issues');
  // The land: routes, the API, the header, a third-party island.
  assert.equal(byTitle('Web app').surface, 'web');
  assert.equal(byTitle('Checkout').kind, 'feature');
  assert.equal(byTitle('Sign-in').place, 'top-right');
  assert.equal(byTitle('Navigation').place, 'top');
  assert.equal(byTitle('Stripe').surface, 'external');
  assert.equal(byTitle('API').surface, 'api');
  // The work: nested by what issues say, placed by what they point at.
  assert.equal(byTitle('#2 ').parentId, byTitle('#1 ').id, 'the task list nests #2 under #1');
  assert.equal(byTitle('#4 ').parentId, byTitle('#1 ').id, '"Part of #1" nests #4');
  assert.equal(pathOf(byTitle('#1 ')), 'Web app › Checkout › #1 Epic: checkout', 'the epic sits on the page its work points at');
  assert.equal(byTitle('#1 ').kind, 'epic');
  assert.match(byTitle('#3 ').body, /📍 Nested here because it is listed in the task list of #1/);
  assert.equal(byTitle('#3 ').kind, 'bug');
  assert.equal(byTitle('#3 ').priority, 'P1');
  assert.equal(byTitle('#3 ').status, 'in_progress');
  assert.equal(byTitle('#2 ').status, 'done');
  assert.equal(byTitle('#8 ').status, 'rejected', 'closed as not planned is a ruin, not done');
  assert.equal(byTitle('#5 ').status, 'in_progress', 'an open pull request that closes it');
  assert.equal(byTitle('#2 ').links[0].type, 'depends');
  assert.equal(byTitle('#4 ').due, '2027-01-31');
  assert.equal(nodes.find((n) => n.id === byTitle('#5 ').parentId).title, 'Uncharted', 'nothing to go by: uncharted');
  // The laws: behaviours with their status, linked to the work that keeps them.
  const pay2 = byTitle('PAY-02');
  assert.equal(pay2.kind, 'behavior');
  assert.equal(pay2.status, 'planned');
  assert.deepEqual(pay2.links, [{ to: byTitle('#3 ').id, type: 'depends', label: '' }]);
  assert.equal(byTitle('PAY-01').status, 'done');
  assert.equal(byTitle('PAY-03').definition, 'vague', 'a decision still needed is fog');
  // Every node is valid as stored.
  for (const n of nodes) assert.doesNotThrow(() => sanitizeNode(n), n.title);
  assert.match(nodes[0].body, /6 pages|5 pages|4 pages/);
});

test('refreshes a GitHub project in place', async () => {
  const shop = fakeShop();
  const dir = await mkdtemp(join(tmpdir(), 'projectmap-'));
  const api = createApi({ model: await createModel({ DATA_FILE: join(dir, 'db.json') }), accessKey: 'k', fetchImpl: shop.fetch, log: { error() {} } });
  const call = (method, path, body) => api({ method, path, body, headers: { 'x-projectmap-key': 'k' } });
  const first = await call('POST', '/api/import/github', { repo: 'octo/shop' });
  assert.equal(first.status, 201);
  const pid = first.body.project.id;
  assert.equal(first.body.project.githubRepo, 'octo/shop');
  shop.issues.push(shop.issue(7, 'Cart badge shows the wrong count', 'On /cart the badge lags.'));
  const again = await call('POST', `/api/projects/${pid}/refresh`, {});
  assert.equal(again.status, 200);
  const { nodes } = (await call('GET', `/api/projects/${pid}`)).body;
  assert.equal(nodes.length, first.body.nodes.length + 1, 'old nodes replaced, the new issue added');
  assert.ok(nodes.some((n) => n.title.startsWith('#7 ')));
  assert.equal(nodes.filter((n) => n.title.startsWith('#1 ')).length, 1);
  const blank = (await call('POST', '/api/projects', { title: 'Hand made' })).body.project.id;
  assert.equal((await call('POST', `/api/projects/${blank}/refresh`, {})).status, 400);
});

test('stores where an item sits and what kind of continent it is', async () => {
  const { call } = await setup();
  const pid = (await call('GET', '/api/projects')).body.projects[0].id;
  const created = await call('POST', `/api/projects/${pid}/nodes`, { node: { title: 'iOS app', kind: 'area', parentId: 'root', surface: 'mobile' } });
  assert.equal(created.status, 201);
  const node = created.body.nodes[0];
  assert.equal(node.surface, 'mobile');
  assert.equal(node.place, 'auto');
  const moved = await call('PATCH', `/api/projects/${pid}/nodes/${node.id}`, { place: 'top-left' });
  assert.equal(moved.body.node.place, 'top-left');
  assert.equal((await call('PATCH', `/api/projects/${pid}/nodes/${node.id}`, { place: 'upside-down' })).status, 400);
  assert.equal((await call('PATCH', `/api/projects/${pid}/nodes/${node.id}`, { surface: 'moon' })).status, 400);
});
