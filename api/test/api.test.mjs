import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../app.mjs';
import { createModel } from '../model/index.mjs';
import { parseRepo, importGitHub } from '../github.mjs';
import { sanitizeNode } from '../../shared/schema.js';
import { fakeShop } from './fake-github.mjs';

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

// ---- The area editor: changesets and anchored comments (#5) ----

async function shopProject() {
  const shop = fakeShop();
  shop.issues[3].body = 'Part of #1.\n\n## Why\n\nCards need tokens.\n\n## Behaviours\n\n- PAY-10 Given a card, when saved, then it is a token.\n\n## Acceptance\n\n## Out of scope\n\n## Open questions\n\nNone.\n';
  const dir = await mkdtemp(join(tmpdir(), 'projectmap-'));
  const api = createApi({ model: await createModel({ DATA_FILE: join(dir, 'db.json') }), accessKey: 'k', fetchImpl: shop.fetch, log: { error() {} } });
  const call = (method, path, body) => api({ method, path, body, headers: { 'x-projectmap-key': 'k' } });
  const { project, nodes } = (await call('POST', '/api/import/github', { repo: 'octo/shop' })).body;
  const node = (n) => nodes.find((x) => x.title.startsWith(`#${n} `));
  return { shop, call, pid: project.id, nodes, node, map: async () => (await call('GET', `/api/projects/${project.id}`)).body.nodes };
}

test('EDIT-03 edits to several items collect into one changeset, accepted together', async () => {
  const { call, pid, node, map } = await shopProject();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Ken' })).body.changeset;
  assert.equal(cs.status, 'open');
  assert.equal(cs.scopeTitle, '#1 Epic: checkout');

  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '');
  const edited = four.replace('Cards need tokens.', 'Cards need tokens, never numbers.').replace('None.', '- Which vault?');
  let res = await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: edited });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.changeset.items[0].base, { title: 'Card tokens', markdown: four }, 'the base is the item as the map had it');
  res = await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-3', title: 'Coupon field rejects valid codes', markdown: node(3).body.replace(/\n\n---\n📍[^\n]*$/, '') });
  assert.equal(res.body.changeset.items.length, 2);
  // Putting an item back as it was takes it out of the changeset.
  res = await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-3', title: 'Coupon field broken', markdown: node(3).body.replace(/\n\n---\n📍[^\n]*$/, '') });
  assert.equal(res.body.changeset.items.length, 1);
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-3', title: 'Coupon field rejects valid codes', markdown: node(3).body.replace(/\n\n---\n📍[^\n]*$/, '') });

  const before = await map();
  const accepted = await call('POST', `/api/projects/${pid}/changesets/${cs.id}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.changeset.status, 'accepted');
  assert.equal(accepted.body.changeset.sync, 'waiting', 'GitHub issues still have to receive it');
  const after = await map();
  const four2 = after.find((n) => n.title.startsWith('#4 '));
  assert.match(four2.body, /never numbers/);
  assert.match(four2.body, /\n\n---\n📍 /, "the map's note stays");
  assert.equal(four2.status, 'needs_decision', 'an open question puts it in the Fog');
  assert.equal(four2.definition, 'vague');
  assert.equal(after.find((n) => n.title.startsWith('#3 ')).title, '#3 Coupon field rejects valid codes');
  assert.equal(after.length, before.length);
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${cs.id}/accept`)).status, 409, 'accepted once');
  assert.equal((await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-3', title: 'x', markdown: '' })).status, 409);
});

test('EDIT-03 a changeset can be discarded, and an empty one cannot be accepted', async () => {
  const { call, pid, node, map } = await shopProject();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id })).body.changeset;
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${cs.id}/accept`)).status, 400);
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-5', title: 'Think harder', markdown: 'Hmm.' });
  const before = await map();
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${cs.id}/discard`)).body.changeset.status, 'discarded');
  assert.deepEqual(await map(), before);
  assert.equal((await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-404', title: 'x', markdown: '' })).status, 409);
  const other = (await call('POST', `/api/projects/${pid}/changesets`, {})).body.changeset;
  assert.equal((await call('PUT', `/api/projects/${pid}/changesets/${other.id}/items`, { key: 'issue-404', title: 'x', markdown: '' })).status, 404);
  assert.equal((await call('PUT', `/api/projects/${pid}/changesets/${other.id}/items`, { key: '../x', title: 'x', markdown: '' })).status, 400);
});

test('EDIT-03 an item that changed since editing began is a conflict, never overwritten', async () => {
  const { shop, call, pid, node, map } = await shopProject();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id })).body.changeset;
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-5', title: 'Think about the vibe', markdown: 'Ours.' });
  shop.issues[4].body = 'Theirs, edited on GitHub.';
  await call('POST', `/api/projects/${pid}/refresh`, {});
  const res = await call('POST', `/api/projects/${pid}/changesets/${cs.id}/accept`);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.conflicts, ['issue-5']);
  assert.match((await map()).find((n) => n.title.startsWith('#5 ')).body, /^Theirs/);
});

test("EDIT-03 a refresh from GitHub keeps accepted edits that haven't synced yet", async () => {
  const { shop, call, pid, node, map } = await shopProject();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id })).body.changeset;
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-3', title: 'Coupon field broken', markdown: 'Fixed wording.' });
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-5', title: 'Think about the vibe', markdown: 'Ours.' });
  await call('POST', `/api/projects/${pid}/changesets/${cs.id}/accept`);
  shop.issues[4].body = 'Theirs, edited on GitHub.';
  await call('POST', `/api/projects/${pid}/refresh`, {});
  const nodes = await map();
  assert.match(nodes.find((n) => n.title.startsWith('#3 ')).body, /^Fixed wording\./, 'GitHub unchanged: our edit stays on the map');
  assert.match(nodes.find((n) => n.title.startsWith('#5 ')).body, /^Theirs/, 'GitHub moved on: theirs shows, and ours waits for a person');
  const [kept] = (await call('GET', `/api/projects/${pid}/changesets`)).body.changesets;
  assert.deepEqual(
    kept.items.map((it) => [it.key, Boolean(it.conflict)]),
    [
      ['issue-3', false],
      ['issue-5', true],
    ],
  );
});

test('EDIT-04 comments anchor to a section or behaviour and survive a refresh', async () => {
  const { call, pid } = await shopProject();
  const a = await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', anchor: { behaviour: 'PAY-10' }, text: 'Which vault?', author: 'QA' });
  assert.equal(a.status, 201);
  await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', anchor: { section: 'Why' }, text: 'Agreed.' });
  await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-40', anchor: { section: 'Why' }, text: 'Elsewhere.' });
  assert.equal((await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', text: '  ' })).status, 400);
  await call('POST', `/api/projects/${pid}/refresh`, {});
  const { comments } = (await call('GET', `/api/projects/${pid}/comments`)).body;
  assert.deepEqual(
    comments.map((c) => [c.itemKey, c.anchor, c.text, c.author]),
    [
      ['issue-4', { behaviour: 'PAY-10' }, 'Which vault?', 'QA'],
      ['issue-4', { section: 'Why' }, 'Agreed.', 'Someone'],
      ['issue-40', { section: 'Why' }, 'Elsewhere.', 'Someone'],
    ],
  );
  const id = a.body.comment.id;
  assert.equal((await call('PATCH', `/api/projects/${pid}/comments/issue-4/${id}`, { resolved: true })).body.comment.resolved, true);
  assert.equal((await call('DELETE', `/api/projects/${pid}/comments/issue-4/${id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/projects/${pid}/comments/issue-4/${id}`)).status, 404);
  assert.equal((await call('GET', `/api/projects/${pid}/comments`)).body.comments.length, 2);
});
