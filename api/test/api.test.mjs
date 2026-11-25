import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../app.mjs';
import { createModel } from '../model/index.mjs';
import { parseRepo, importGitHub } from '../github.mjs';
import { sanitizeNode } from '../../shared/schema.js';
import { editableOf, isWellFormed, itemKeyOf, parseBehaviours, parseIssue, sectionText } from '../../shared/issue-shape.js';
import { fakeShop } from './fake-github.mjs';
import { isUnread, threadsOf } from '../../shared/annotations.js';

async function setup(accessKey = 'secret-key', clock = Date.now) {
  const dir = await mkdtemp(join(tmpdir(), 'projectmap-'));
  const model = await createModel({ DATA_FILE: join(dir, 'db.json') });
  const api = createApi({ model, accessKey, log: { error() {} }, clock });
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
  assert.notEqual(byTitle('PAY-03').definition, 'vague', 'a decision still needed is a question, not Fog');
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
  const model = await createModel({ DATA_FILE: join(dir, 'db.json') });
  const api = createApi({ model, accessKey: 'k', fetchImpl: shop.fetch, log: { error() {} } });
  const call = (method, path, body) => api({ method, path, body, headers: { 'x-projectmap-key': 'k' } });
  const { project, nodes } = (await call('POST', '/api/import/github', { repo: 'octo/shop' })).body;
  const node = (n) => nodes.find((x) => x.title.startsWith(`#${n} `));
  return { shop, model, call, pid: project.id, nodes, node, map: async () => (await call('GET', `/api/projects/${project.id}`)).body.nodes };
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
  const after = await map();
  const four2 = after.find((n) => n.title.startsWith('#4 '));
  assert.equal(four2.sync, 'unsaved', 'GitHub receives it when it is saved');
  assert.match(four2.body, /never numbers/);
  assert.match(four2.body, /\n\n---\n📍 /, "the map's note stays");
  assert.equal(four2.status, 'needs_decision', 'an open question needs a decision');
  assert.notEqual(four2.definition, 'vague', 'a question is not Fog');
  assert.equal(after.find((n) => n.title.startsWith('#3 ')).title, '#3 Coupon field rejects valid codes');
  assert.equal(after.length, before.length);
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${cs.id}/accept`)).status, 409, 'accepted once');
  assert.equal((await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-3', title: 'x', markdown: '' })).status, 409);
});

test('LIFE-09 an edit that clears the last open question takes the item out of Needs decision, to ready', async () => {
  const { call, pid, node, map } = await shopProject();
  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '');
  const asking = four.replace(/## Open questions[\s\S]*?(?=\n## |$)/, '## Open questions\n\n- Tokens or numbers?\n');
  const settled = four.replace(/## Open questions[\s\S]*?(?=\n## |$)/, '## Open questions\n\nNone.\n');
  const edit = async (markdown) => {
    const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Ken' })).body.changeset;
    await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown });
    assert.equal((await call('POST', `/api/projects/${pid}/changesets/${cs.id}/accept`)).status, 200);
    return (await map()).find((n) => n.title.startsWith('#4 ')).status;
  };
  assert.equal(await edit(asking), 'needs_decision');
  assert.equal(await edit(settled), 'ready', 'answered: it no longer waits on anyone');
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

test("EDIT-03 a refresh keeps accepted edits that aren't on GitHub yet", async () => {
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
  assert.deepEqual(
    [3, 5].map((n) => nodes.find((x) => x.title.startsWith(`#${n} `)).sync),
    ['unsaved', 'conflict'],
  );
});

test('NOTE-21 a comment that doesn\'t say who wrote it is refused, so none shows as "Someone"', async () => {
  const { call, pid } = await shopProject();
  for (const author of [undefined, '', '   ']) {
    const r = await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', anchor: { section: 'Why' }, text: 'Agreed.', author });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /who/);
  }
  assert.equal((await call('GET', `/api/projects/${pid}/comments`)).body.comments.length, 0);
  const ok = await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', anchor: { section: 'Why' }, text: 'Agreed.', author: 'Ken' });
  assert.equal(ok.body.comment.author, 'Ken');
});

test('EDIT-04 comments anchor to a section or behaviour and survive a refresh', async () => {
  const { call, pid } = await shopProject();
  const a = await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', anchor: { behaviour: 'PAY-10' }, text: 'Which vault?', author: 'QA' });
  assert.equal(a.status, 201);
  await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', anchor: { section: 'Why' }, text: 'Agreed.', author: 'Ann' });
  await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-40', anchor: { section: 'Why' }, text: 'Elsewhere.', author: 'Ann' });
  assert.equal((await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', text: '  ' })).status, 400);
  await call('POST', `/api/projects/${pid}/refresh`, {});
  const { comments } = (await call('GET', `/api/projects/${pid}/comments`)).body;
  assert.deepEqual(
    comments.map((c) => [c.itemKey, c.anchor.behaviour ?? c.anchor.section, c.text, c.author]),
    [
      ['issue-4', 'PAY-10', 'Which vault?', 'QA'],
      ['issue-4', 'Why', 'Agreed.', 'Ann'],
      ['issue-40', 'Why', 'Elsewhere.', 'Ann'],
    ],
  );
  const id = a.body.comment.id;
  assert.equal((await call('DELETE', `/api/projects/${pid}/comments/issue-4/${id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/projects/${pid}/comments/issue-4/${id}`)).status, 404);
  assert.equal((await call('GET', `/api/projects/${pid}/comments`)).body.comments.length, 2);
});

test('NOTE-01 a comment sits on what it is about, and is just a comment: no kind, no value', async () => {
  const { call, pid, map } = await shopProject();
  const before = (await map()).find((n) => n.title.startsWith('#4 ')).body;
  const post = (body) => call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', author: 'Ann', ...body });
  const on = { on: 'word', section: 'Why', quote: 'tokens', prefix: 'Cards need ', suffix: '.' };
  const said = await post({ kind: 'change', anchor: on, text: 'Make this blue', value: '#EEAA18', author: 'Ken' });
  assert.equal(said.status, 201, JSON.stringify(said.body));
  const c = said.body.comment;
  assert.deepEqual([c.anchor.quote, c.text, c.kind, c.value], ['tokens', 'Make this blue', undefined, undefined], 'a kind or a value sent is not kept');
  assert.equal((await post({ anchor: { on: 'phrase', section: 'Why' }, text: 'x' })).status, 400, 'words are quoted');
  assert.equal((await post({ anchor: { on: 'image', section: 'Why', src: 'https://x/c.png', quote: 'a cat' }, text: 'Too dark' })).status, 201);
  assert.equal((await post({ anchor: { on: 'place' }, text: 'This region is crowded' })).status, 201);
  const { comments } = (await call('GET', `/api/projects/${pid}/comments/issue-4`)).body;
  assert.deepEqual(comments.map((x) => x.anchor.on), ['word', 'image', 'place']);
  assert.equal((await map()).find((n) => n.title.startsWith('#4 ')).body, before, 'commenting leaves the issue alone');
});

test('SYNC-01 a comment on a changeset as a whole is an ordinary anchored comment, on the area its edits are in', async () => {
  const { call, pid } = await shopProject();
  const said = await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', anchor: { on: 'changeset', section: 'Why' }, text: 'These three go together', author: 'Ken' });
  assert.equal(said.status, 201, JSON.stringify(said.body));
  const { comments } = (await call('GET', `/api/projects/${pid}/comments/issue-4`)).body;
  assert.deepEqual(comments.map((c) => [c.anchor, c.text]), [[{ on: 'changeset' }, 'These three go together']], 'not a thread of its own kind: just a comment');
});

test('NOTE-09 comments made before annotations are comments in the same place, and none is lost', async () => {
  const { call, model, pid } = await shopProject();
  const old = [
    { id: '00000001aaaa', itemKey: 'issue-4', anchor: { behaviour: 'PAY-10' }, text: 'Which vault?', author: 'QA', resolved: false, createdAt: '2026-11-01T00:00:00.000Z' },
    { id: '00000002aaaa', itemKey: 'issue-4', anchor: { section: 'Why' }, text: 'Agreed.', author: 'Ken', resolved: true, createdAt: '2026-11-02T00:00:00.000Z' },
    { id: '00000003aaaa', itemKey: 'issue-4', anchor: { section: 'Open questions' }, text: 'Which provider?', author: 'Builder (a1)', resolved: false, createdAt: '2026-11-03T00:00:00.000Z' },
  ];
  for (const c of old) await model.comments.put(pid, c);
  const { comments } = (await call('GET', `/api/projects/${pid}/comments/issue-4`)).body;
  assert.deepEqual(
    comments.map((c) => [c.text, c.anchor.on, c.anchor.behaviour ?? c.anchor.section, Boolean(c.dismissed)]),
    [
      ['Which vault?', 'behaviour', 'PAY-10', false],
      ['Agreed.', 'section', 'Why', true],
      ['Which provider?', 'section', 'Open questions', false],
    ],
  );
});

test('NOTE-11 each annotation is its own thread at its own words, and a reply stays in its thread', async () => {
  const { call, pid } = await shopProject();
  const post = async (body) => (await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', author: 'Ann', ...body })).body.comment;
  const first = await post({ anchor: { on: 'word', section: 'Open questions', quote: 'vault' }, text: 'Which one?' });
  const second = await post({ anchor: { on: 'word', section: 'Open questions', quote: 'provider' }, text: 'Stripe?' });
  const reply = await post({ replyTo: first.id, text: 'The PCI one.', author: 'Ken' });
  assert.deepEqual([reply.anchor, reply.replyTo], [first.anchor, first.id]);
  assert.equal((await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', replyTo: 'gone', text: 'x', author: 'Ann' })).status, 404);
  const threads = threadsOf((await call('GET', `/api/projects/${pid}/comments/issue-4`)).body.comments);
  assert.deepEqual(threads.map((t) => [t.root.id, t.root.anchor.quote, t.replies.map((r) => r.text)]), [[first.id, 'vault', ['The PCI one.']], [second.id, 'provider', []]]);
});

test('NOTE-03 a thread is unread for everyone but whoever said its last word, read once opened, and reading moves nothing', async () => {
  const { call, pid } = await shopProject();
  const post = async (body) => (await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', anchor: { on: 'section', section: 'Why' }, author: 'Ann', ...body })).body;
  const read = async (c, by) => (await call('POST', `/api/projects/${pid}/comments/issue-4/${c.id}/read`, { by })).body.comment;
  const unread = (c, by) => isUnread(c, by);
  const { comment: c } = await post({ text: 'Great work, team.', author: 'Ken' });
  assert.deepEqual([unread(c, 'Ken'), unread(c, 'Ana')], [false, true], 'its author has read it');
  const seen = await read(c, 'Ana');
  assert.deepEqual([unread(seen, 'Ana'), unread(seen, 'Bo')], [false, true], 'read for whoever opened it, and still unread for anyone else');
  const { thread } = await post({ replyTo: c.id, text: 'Thanks!', author: 'Bo' });
  assert.deepEqual([unread(thread, 'Bo'), unread(thread, 'Ana'), unread(thread, 'Ken')], [false, true, true], 'a reply makes it unread again for everyone but its author');
  const after = (await call('GET', `/api/projects/${pid}/comments/issue-4`)).body.comments.find((x) => x.id === c.id);
  assert.deepEqual([after.dismissed, (await call('GET', `/api/projects/${pid}/notes`)).body.open['issue-4'].count], [undefined, 1], 'read or not, it stays where it is');
});

test('NOTE-04 NOTE-05 nothing clears itself: a person dismisses a comment to the conversation log, naming who, and can restore it', async () => {
  const { call, pid } = await shopProject();
  const post = async (text) => (await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', anchor: { on: 'section', section: 'Why' }, text, author: 'Ken' })).body.comment;
  const notes = async () => (await call('GET', `/api/projects/${pid}/notes`)).body.open['issue-4'];
  const a = await post('Tighten this.');
  await post('And this.');
  assert.deepEqual(await notes(), { count: 2, read: ['Ken'] }, 'one badge: how many, and who has read them all');
  const res = await call('POST', `/api/projects/${pid}/comments/issue-4/${a.id}/dismiss`, { by: 'Ana', note: 'Done in #12' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual([res.body.comment.dismissed.by, res.body.comment.dismissed.note], ['Ana', 'Done in #12']);
  assert.equal((await notes()).count, 1, 'dismissed, it leaves the badge');
  const kept = (await call('GET', `/api/projects/${pid}/comments/issue-4`)).body.comments.find((c) => c.id === a.id);
  assert.deepEqual([kept.text, Boolean(kept.dismissed)], ['Tighten this.', true], 'still readable, in the log');
  assert.equal((await call('POST', `/api/projects/${pid}/comments/issue-4/${a.id}/dismiss`, { by: 'Ana' })).status, 409);
  const back = (await call('POST', `/api/projects/${pid}/comments/issue-4/${a.id}/restore`, {})).body.comment;
  assert.equal(back.dismissed, undefined, 'brought back');
  assert.equal((await notes()).count, 2);
});

test('NOTE-06 NOTE-05 any comment made a task becomes a child task in the strict shape, linked both ways; its thread says so, and it is dismissed', async () => {
  const { call, pid, node } = await shopProject();
  const said = (await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', anchor: { on: 'word', section: 'Why', quote: 'tokens' }, text: 'Use our vault client here', author: 'Ana' })).body.comment;
  const res = await call('POST', `/api/projects/${pid}/comments/issue-4/${said.id}/promote`, { by: 'Ken' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { node: task } = res.body;
  const md = editableOf(task).markdown;
  assert.deepEqual([task.kind, task.parentId, task.title], ['task', node(4).id, 'Use our vault client here']);
  assert.ok(isWellFormed(parseIssue(md)), 'in the strict shape');
  assert.match(md, /^Part of #4/);
  assert.match(md, new RegExp(`From comment ${said.id} on issue-4\\.`), 'the task names the comment');
  const thread = threadsOf((await call('GET', `/api/projects/${pid}/comments/issue-4`)).body.comments).find((t) => t.root.id === said.id);
  assert.deepEqual([thread.root.task.key, thread.root.dismissed.by, thread.root.dismissed.task.key], [itemKeyOf(task), 'Ken', itemKeyOf(task)], 'the comment names the task, and is dismissed');
  assert.match(thread.replies.at(-1).text, /^Made it a task: Use our vault client here/, 'the thread says so');
  assert.equal((await call('GET', `/api/projects/${pid}/notes`)).body.open['issue-4'], undefined, 'no longer badged');
  assert.equal((await call('POST', `/api/projects/${pid}/comments/issue-4/${said.id}/promote`, { by: 'Ken' })).status, 409, 'made a task once');
});

const newItem = async (call, pid, cid, parentId, kind, extra = {}) => {
  const res = await call('POST', `/api/projects/${pid}/changesets/${cid}/new`, { parentId, kind, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.node;
};

test('NEW-01 NEW-02 a new item opens in the template, Part of its area, and belongs to the refinement it was made in', async () => {
  const { call, pid, node, map } = await shopProject();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id })).body.changeset;
  const made = await newItem(call, pid, cs.id, node(1).id, 'feature');
  const md = editableOf(made).markdown;
  assert.ok(md.startsWith('Part of #1\nKind: Feature · Place:'), md);
  assert.ok(isWellFormed(parseIssue(md)), 'every section of the strict shape, in order');
  assert.equal(made.parentId, node(1).id);
  assert.equal(made.refinement, cs.id);
  const listed = (await call('GET', `/api/projects/${pid}/changesets`)).body.changesets.find((c) => c.id === cs.id);
  assert.deepEqual(listed.items.map((it) => [it.key, it.new]), [[itemKeyOf(made), true]]);
  const inside = await newItem(call, pid, cs.id, made.id, 'task');
  assert.ok(editableOf(inside).markdown.startsWith(`Part of #new-${made.id}\n`), 'Part of a new item, until it has a number');

  // Its behaviours get IDs the same way as any item's (EDIT-02).
  const markdown = md.replace(/## Behaviours\n\n<!--[^\n]*-->/, '## Behaviours\n\n- REFUND-01 Given a refund, when asked, then it is paid.\n- REFUND-?1 Given a second, when asked, then it is paid too.');
  const res = await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: itemKeyOf(made), title: 'Refunds', markdown });
  assert.equal(res.status, 200);
  assert.deepEqual(parseBehaviours(sectionText(parseIssue(editableOf(res.body.node).markdown), 'Behaviours')).map((r) => r.id), ['REFUND-01', 'REFUND-02']);
  const other = (await call('POST', `/api/projects/${pid}/changesets`, {})).body.changeset;
  assert.equal((await call('PUT', `/api/projects/${pid}/changesets/${other.id}/items`, { key: itemKeyOf(made), title: 'Mine now', markdown })).status, 409, 'it changes only in its own refinement');
});

test('NEW-03 a new item is on the map at once, needing improvement, and a refresh from GitHub keeps it', async () => {
  const { call, pid, node, map } = await shopProject();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id })).body.changeset;
  const made = await newItem(call, pid, cs.id, node(1).id, 'story', { title: 'Refund to the saved card' });
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: itemKeyOf(made), title: 'Refund to the card', markdown: editableOf(made).markdown });
  const seen = (await map()).find((n) => n.id === made.id);
  assert.equal(seen.title, 'Refund to the card', 'everyone sees its edits as they are made');
  assert.equal(seen.status, 'idea');
  assert.equal(seen.sync, undefined, 'nothing to save: it is not in the spec yet');
  await call('POST', `/api/projects/${pid}/refresh`, {});
  const after = (await map()).find((n) => n.id === made.id);
  assert.equal(after?.title, 'Refund to the card');
  assert.equal(after.parentId, node(1).id, 'in its place');
  assert.equal((await call('POST', `/api/projects/${pid}/save`, {})).body.saved.length, 0, 'a save leaves it alone until it is adopted');
});

test("ADOPT-02 ADOPT-05 a person adopts an item of someone else's refinement: the item takes its text and waits for a save, and who adopted it is recorded", async () => {
  const { call, pid, node, map } = await shopProject();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Builder (a1)' })).body.changeset;
  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '');
  const proposed = four.replace('then it is a token.', 'then it is a token, never a number.');
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: proposed });
  assert.doesNotMatch((await map()).find((n) => n.title.startsWith('#4 ')).body, /never a number/, 'the spec is unchanged until adoption');

  const res = await call('POST', `/api/projects/${pid}/changesets/${cs.id}/items/issue-4/adopt`, { by: 'Ken' });
  assert.equal(res.status, 200);
  const adopted = (await map()).find((n) => n.title.startsWith('#4 '));
  assert.match(adopted.body, /never a number/);
  assert.equal(adopted.sync, 'unsaved', 'adopting sends nothing to GitHub: a save does');
  assert.equal(res.body.changeset.status, 'accepted', 'nothing left in it, so the refinement closes');
  assert.equal(res.body.changeset.adopted[0].by, 'Ken');
  assert.ok(res.body.changeset.adopted[0].at);
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${cs.id}/items/issue-4/adopt`, { by: 'Ken' })).status, 409, 'adopted once');
});

test("ADOPT-13 an agent's whole new text, written after a person edited the item, is proposed against that edit and can still be adopted", async () => {
  const { call, pid, node, map } = await shopProject();
  const theirs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Builder (a1)' })).body.changeset;
  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '');
  await call('PUT', `/api/projects/${pid}/changesets/${theirs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: four.replace('then it is a token.', 'then it is a token, never a number.') });

  const mine = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Ken' })).body.changeset;
  const edited = four.replace('then it is a token.', 'then it is a token. (Ken was here.)');
  await call('PUT', `/api/projects/${pid}/changesets/${mine.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: edited });
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${mine.id}/accept`)).status, 200);
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${theirs.id}/items/issue-4/adopt`, { by: 'Ken' })).status, 409, 'a revision from before the edit is a conflict');

  const revised = edited.replace('(Ken was here.)', '(Ken was here.) Never a number.');
  const res = await call('PUT', `/api/projects/${pid}/changesets/${theirs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: revised, rebase: true });
  assert.equal(res.body.rebased, true, 'the agent is told its base moved');
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${theirs.id}/items/issue-4/adopt`, { by: 'Ken' })).status, 200);
  assert.match((await map()).find((n) => n.title.startsWith('#4 ')).body, /Ken was here\.\) Never a number/);
});

test('ADOPT-05 a person declines an item of a refinement: it is dropped, the spec stays, and the reason is kept', async () => {
  const { call, pid, node, map } = await shopProject();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Builder (a1)' })).body.changeset;
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-5', title: 'Think about the vibe', markdown: 'Vibes only.' });
  const before = await map();
  const res = await call('POST', `/api/projects/${pid}/changesets/${cs.id}/items/issue-5/decline`, { by: 'Ken', reason: 'Too vague.' });
  assert.equal(res.body.changeset.status, 'declined');
  assert.deepEqual(res.body.changeset.declined.map((d) => [d.key, d.by, d.reason]), [['issue-5', 'Ken', 'Too vague.']]);
  assert.deepEqual(await map(), before);
});

test("ADOPT-05 ADOPT-06 NEW-06 a person adopts or declines a new item of someone else's refinement on its own, a new item's parent first", async () => {
  const { call, pid, node, map } = await shopProject();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Builder (a1)' })).body.changeset;
  const epic = await newItem(call, pid, cs.id, node(1).id, 'epic', { title: 'Epic: Refunds' });
  const inside = await newItem(call, pid, cs.id, epic.id, 'task', { title: 'Refund to the card' });
  // A split: a new task takes a behaviour out of #4, whose change is in the same refinement.
  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '');
  const split = await newItem(call, pid, cs.id, node(4).id, 'task', { title: 'Token vault' });
  const vault = editableOf(split).markdown.replace(/## Behaviours\n\n<!--[^\n]*-->/, '## Behaviours\n\n- VAULT-01 Given a token, when stored, then it is in the vault.');
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: itemKeyOf(split), title: 'Token vault', markdown: vault });
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: four.replace('then it is a token.', 'then it is a token, see the vault.') });
  const decide = (n, action, body) => call('POST', `/api/projects/${pid}/changesets/${cs.id}/items/${itemKeyOf(n)}/${action}`, { by: 'Ken', ...body });

  const early = await decide(inside, 'adopt');
  assert.equal(early.status, 409, 'not before the new item it is inside');
  assert.match(early.body.error, /Epic: Refunds/);

  // Adopted: in the spec as if a person had accepted it, waiting for a save, and the rest still to decide.
  let res = await decide(split, 'adopt');
  assert.equal(res.status, 200);
  const adopted = (await map()).find((n) => n.id === split.id);
  assert.equal(adopted.refinement, undefined);
  assert.equal(adopted.sync, 'unsaved', 'a save creates it on GitHub');
  assert.deepEqual(res.body.changeset.adopted.map((d) => [d.key, d.behaviours, d.by]), [[itemKeyOf(split), ['VAULT-01'], 'Ken']]);
  assert.ok(res.body.changeset.adopted[0].at);
  assert.equal(res.body.changeset.status, 'open');
  assert.doesNotMatch((await map()).find((n) => n.title.startsWith('#4 ')).body, /see the vault/, 'the parent of a split is decided on its own');
  assert.ok((await call('POST', `/api/projects/${pid}/save`, {})).body.saved.includes(`new-${split.id}`));
  assert.equal((await decide(split, 'adopt')).status, 404, 'adopted once');

  // Declined: gone from the map and the refinement, with what was inside it, and the reason kept for its author.
  res = await decide(epic, 'decline', { reason: 'Refunds wait for next year.' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.deleted.sort(), [epic.id, inside.id].sort());
  assert.ok(!(await map()).some((n) => n.id === epic.id || n.id === inside.id));
  assert.deepEqual(res.body.changeset.declined.map((d) => [d.key, d.reason]).sort(), [[itemKeyOf(epic), 'Refunds wait for next year.'], [itemKeyOf(inside), 'Refunds wait for next year.']].sort());
  assert.deepEqual(res.body.changeset.items.map((it) => it.key), ['issue-4']);

  res = await call('POST', `/api/projects/${pid}/changesets/${cs.id}/items/issue-4/adopt`, { by: 'Ken' });
  assert.equal(res.body.changeset.status, 'accepted', 'everything in it decided: it closes');
});

test('ADOPT-05 ADOPT-06 a person adopts or declines a refinement one behaviour at a time, and it stays open until nothing is left', async () => {
  const { call, pid, node, map } = await shopProject();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Builder (a1)' })).body.changeset;
  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '');
  const more = (n) => `- PAY-${n} Given a token, when case ${n} happens, then it is handled.`;
  const proposed = four
    .replace('Cards need tokens.', 'Cards need tokens, so numbers never reach us.')
    .replace('then it is a token.', `then it is a token, never a number.\n${[11, 12, 13, 14].map(more).join('\n')}`);
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: proposed });
  const spec = async () => (await map()).find((n) => n.title.startsWith('#4 ')).body;
  const decide = (action, body) => call('POST', `/api/projects/${pid}/changesets/${cs.id}/items/issue-4/${action}`, { by: 'Ken', ...body });

  // Ticked ones only: three adopted, and the rest of the item is left as the spec had it.
  let res = await decide('adopt', { behaviours: ['PAY-10', 'PAY-11', 'PAY-12'] });
  assert.equal(res.status, 200);
  let now = await spec();
  assert.match(now, /never a number\.\n- PAY-11 .*\n- PAY-12 /, 'the ticked behaviours are merged in, in their place');
  assert.doesNotMatch(now, /PAY-13|PAY-14|numbers never reach us/, 'nothing unticked is adopted');
  assert.deepEqual(res.body.changeset.adopted.map((d) => [d.key, d.behaviours, d.by]), [['issue-4', ['PAY-10', 'PAY-11', 'PAY-12'], 'Ken']]);
  assert.equal(res.body.changeset.status, 'open', 'the rest is still to decide');
  assert.equal(res.body.changeset.items.length, 1);

  // One declined, with a reason for its author: it is dropped from the proposal, and the spec never sees it.
  res = await decide('decline', { behaviours: ['PAY-13'], reason: 'Covered by PAY-12.' });
  assert.deepEqual(res.body.changeset.declined.map((d) => [d.behaviours, d.reason]), [[['PAY-13'], 'Covered by PAY-12.']]);
  assert.doesNotMatch(res.body.changeset.items[0].after.markdown, /PAY-13/, 'gone from the proposal');
  assert.match(res.body.changeset.items[0].after.markdown, /PAY-14/, 'the rest is still proposed');
  assert.doesNotMatch(await spec(), /PAY-13/);
  assert.equal((await decide('adopt', { behaviours: ['PAY-13'] })).status, 400, 'a declined behaviour is no longer there to adopt');

  // The rest, and the other changes (its Why) as one: nothing is left, so the refinement closes.
  res = await decide('adopt', { behaviours: ['PAY-14', 'other'] });
  assert.equal(res.body.changeset.status, 'accepted');
  assert.equal(res.body.changeset.items.length, 0);
  now = await spec();
  assert.match(now, /numbers never reach us/);
  assert.match(now, /PAY-12 .*\n- PAY-14 /);
  assert.equal((await decide('adopt', {})).status, 409, 'closed');
});

test('ADOPT-05 a person adopts one section of a refinement on its own: the rest stays open, and a section changed since is a conflict', async () => {
  const { call, pid, node, map } = await shopProject();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Builder (a1)' })).body.changeset;
  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '');
  const proposed = four.replace('Cards need tokens.', 'Cards need tokens, so numbers never reach us.').replace('## Acceptance\n', '## Acceptance\n\n- A saved card is a token.\n');
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens kept', markdown: proposed });
  const decide = (action, body) => call('POST', `/api/projects/${pid}/changesets/${cs.id}/items/issue-4/${action}`, { by: 'Ken', ...body });
  const spec = async () => (await map()).find((n) => n.title.startsWith('#4 '));

  let res = await decide('adopt', { behaviours: ['section:Why'] });
  assert.equal(res.status, 200);
  assert.match((await spec()).body, /numbers never reach us/);
  assert.doesNotMatch((await spec()).body, /A saved card is a token/, 'the Acceptance change is still to decide');
  assert.doesNotMatch((await spec()).title, /kept/, 'and so is the title');
  assert.equal(res.body.changeset.status, 'open');

  res = await decide('decline', { behaviours: ['title'], reason: 'Keep the name.' });
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.body.changeset.items[0].after.title, /kept/);

  // Someone changes the Acceptance before it is adopted: adopting that one is a conflict to resolve first.
  const mine = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Ken' })).body.changeset;
  const now = (await spec()).body.replace(/\n\n---\n📍[^\n]*$/, '');
  await call('PUT', `/api/projects/${pid}/changesets/${mine.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: now.replace('## Acceptance\n', '## Acceptance\n\n- Tokens only.\n') });
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${mine.id}/accept`)).status, 200);
  res = await decide('adopt', { behaviours: ['section:Acceptance'] });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Changed since/);
});

test("ADOPT-17 adopting a refinement takes only what it changed: an edit made since, to a part it didn't touch, stays and is no conflict", async () => {
  const { call, pid, node, map } = await shopProject();
  const theirs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Builder (a1)' })).body.changeset;
  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '');
  await call('PUT', `/api/projects/${pid}/changesets/${theirs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: four.replace('then it is a token.', 'then it is a token, never a number.') });

  const mine = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Ken' })).body.changeset;
  await call('PUT', `/api/projects/${pid}/changesets/${mine.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: four.replace('Cards need tokens.', 'Cards need tokens, so numbers never reach us.') });
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${mine.id}/accept`)).status, 200);

  const res = await call('POST', `/api/projects/${pid}/changesets/${theirs.id}/items/issue-4/adopt`, { by: 'Ken' });
  assert.equal(res.status, 200);
  const now = (await map()).find((n) => n.title.startsWith('#4 ')).body;
  assert.match(now, /never a number/);
  assert.match(now, /numbers never reach us/, "Ken's edit to the Why is kept");
});

test('ADOPT-17 accepting takes only what the edit changed: an adoption made since stays, and only a part both changed is a conflict, saying who changed it', async () => {
  const { call, pid, node, map } = await shopProject();
  const open = async (who) => (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: who })).body.changeset;
  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '');
  const put = (cs, markdown) => call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown });
  const [theirs, mine, clash] = [await open('Builder (a1b2)'), await open('Ken'), await open('Ann')];
  await put(theirs, four.replace('then it is a token.', 'then it is a token, never a number.'));
  await put(mine, four.replace('Cards need tokens.', 'Cards need tokens, so numbers never reach us.'));
  await put(clash, four.replace('then it is a token.', 'then it is a vault reference.'));
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${theirs.id}/items/issue-4/adopt`, { by: 'Ken' })).status, 200);

  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${mine.id}/accept`)).status, 200, 'a part nobody else changed is no conflict');
  const now = (await map()).find((n) => n.title.startsWith('#4 ')).body;
  assert.match(now, /numbers never reach us/);
  assert.match(now, /never a number/, 'the adoption made since is not undone');

  const res = await call('POST', `/api/projects/${pid}/changesets/${clash.id}/accept`);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.changedBy, { 'issue-4': { on: 'overworld', by: 'Ken', behaviours: ['PAY-10'] } }, 'changed in Overworld, by whom and how');
});

test('ADOPT-17 a refinement is carried onto its item as it now is: a change made since to other lines of a section it edits is in it, and no conflict', async () => {
  const { call, pid, node, map } = await shopProject();
  const open = async (who) => (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: who })).body.changeset;
  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '').replace('Cards need tokens.', 'Cards need tokens.\n\nA token is kept by the provider.');
  const put = (cs, markdown) => call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown });
  const setup = await open('Ken');
  await put(setup, four);
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${setup.id}/accept`)).status, 200);
  const [mine, since] = [await open('Builder (a1)'), await open('Ken')];
  await put(mine, four.replace('A token is kept by the provider.', 'A token is kept by the payment provider.'));
  await put(since, four.replace('Cards need tokens.', 'Cards need tokens.\n\nNumbers never reach us.'));
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${since.id}/accept`)).status, 200);

  // A refresh shows the refinement with the change made since already in it.
  const listed = (await call('GET', `/api/projects/${pid}/changesets`)).body.changesets.find((c) => c.id === mine.id);
  assert.match(listed.items[0].after.markdown, /Numbers never reach us/);
  const res = await call('POST', `/api/projects/${pid}/changesets/${mine.id}/items/issue-4/adopt`, { by: 'Ken' });
  assert.equal(res.status, 200);
  const now = (await map()).find((n) => n.title.startsWith('#4 ')).body;
  assert.match(now, /Numbers never reach us/);
  assert.match(now, /kept by the payment provider/);
});

test('ADOPT-23 whatever someone sends moves the project on at once, so every open page sees it without a refresh', async () => {
  const { call, pid, node } = await shopProject();
  const pulse = async () => (await call('GET', `/api/projects/${pid}/pulse`)).body.pulse?.v ?? null;
  const first = await pulse();
  await call('GET', `/api/projects/${pid}/changesets`);
  assert.equal(await pulse(), first, 'reading moves nothing');
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Builder (a1)' })).body.changeset;
  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '');
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: four.replace('Cards need tokens.', 'Cards need tokens, never numbers.') });
  const proposed = await pulse();
  assert.notEqual(proposed, first, 'a proposal moves it');
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${cs.id}/accept`)).status, 200);
  assert.notEqual(await pulse(), proposed, 'and so does adopting it');
});

test('ADOPT-08 open questions in a refinement show as badges, and never keep it from adoption', async () => {
  const { call, pid, node, map } = await shopProject();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Builder (a1)' })).body.changeset;
  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '');
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: four.replace('None.', '- Which vault?').replace('a token.', 'a token, kept.') });
  await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', anchor: { section: 'Open questions' }, text: 'Which provider?', author: 'Ann' });
  assert.equal((await call('GET', `/api/projects/${pid}/notes`)).body.open['issue-4'].count, 1, 'the question asked on it is badged');
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${cs.id}/items/issue-4/adopt`, { by: 'Ken' })).status, 200, 'adopted with questions in its text and on it');
  assert.match((await map()).find((n) => n.title.startsWith('#4 ')).body, /kept/);
});

test('ADOPT-11 the server numbers each new behaviour on its first save: two at once never share a number, and a dropped one is never given again', async () => {
  const { call, pid, node, map } = await shopProject();
  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '');
  const adding = (said) => four.replace('then it is a token.', `then it is a token.\n- PAY-?1 Given ${said}, when saved, then it is kept.`);
  const open = async (who) => (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: who })).body.changeset;
  const [ann, bob] = [await open('Ann'), await open('Bob')];
  // A behaviour numbered PAY-12 once, then dropped, is still seen in the refinement that held it.
  const old = await open('Cy');
  await call('PUT', `/api/projects/${pid}/changesets/${old.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: four.replace('PAY-10', 'PAY-12') });
  await call('POST', `/api/projects/${pid}/changesets/${old.id}/discard`);
  const both = await Promise.all([ann, bob].map((cs, i) => call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: adding(['a card', 'a wallet'][i]) })));
  const given = both.map((r) => r.body.numbered[0]);
  assert.deepEqual(given.map((g) => g.placeholder), ['PAY-?1', 'PAY-?1']);
  assert.deepEqual(given.map((g) => g.id).sort(), ['PAY-13', 'PAY-14'], 'the next numbers, above every one ever seen, and never the same');
  for (const [i, r] of both.entries()) assert.match(r.body.changeset.items[0].after.markdown, new RegExp(`- ${given[i].id} Given`), 'the saved text carries the number');
  // Saved again before the editor showed it (a queued autosave), it keeps its number.
  const again = await call('PUT', `/api/projects/${pid}/changesets/${ann.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: adding('a card, again') });
  assert.equal(again.body.numbered[0].id, given[0].id);
  // Ann drops hers: its number is not given again.
  await call('PUT', `/api/projects/${pid}/changesets/${ann.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: four });
  const next = await call('PUT', `/api/projects/${pid}/changesets/${ann.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: adding('a third') });
  assert.equal(next.body.numbered[0].id, 'PAY-15');
  // A draft abandoned before its first save uses no number, and a text with none to give gives none.
  assert.equal((await call('PUT', `/api/projects/${pid}/changesets/${bob.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: four })).body.numbered, undefined);
  assert.ok(!(await map()).some((n) => /PAY-\?/.test(n.body)), 'no placeholder reaches the map');
});

test('REVIEW-02 each proposed change says when it was proposed, and the notes say which questions wait to be answered or written in', async () => {
  const { call, pid, node } = await shopProject();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Builder (a1)' })).body.changeset;
  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '');
  const { changeset } = (await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: four.replace('a token.', 'a token, kept.') })).body;
  assert.ok(Date.parse(changeset.items[0].at) >= Date.parse(cs.createdAt), 'waiting since it was proposed');
  const ask = async (text) => (await call('POST', `/api/projects/${pid}/questions`, { itemKey: 'issue-4', text, author: 'Builder (a1)' })).body.question;
  const first = new Date().toISOString();
  await ask('Which provider?');
  const answered = await ask('Which vault?');
  await call('POST', `/api/projects/${pid}/questions/issue-4/${answered.id}/answer`, { text: 'Our own.', by: 'Ken' });
  await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', anchor: { on: 'section', section: 'Why' }, text: 'Nice.', author: 'Ken' });
  const { open, questions } = (await call('GET', `/api/projects/${pid}/notes`)).body;
  assert.equal(open['issue-4'].count, 1, 'a plain comment waits on nobody');
  assert.deepEqual([questions['issue-4'].asked, questions['issue-4'].answered], [1, 1], 'one waiting on its answer, one on being written in');
  assert.ok(questions['issue-4'].since >= first && questions['issue-4'].since <= (await call('GET', `/api/projects/${pid}`)).body.nodes.find((n) => n.title.startsWith('#4 ')).updatedAt, 'waiting since the oldest of them was asked');
});

test('NEW-06 a new item dropped before adoption, or in a discarded refinement, is gone and never reaches GitHub', async () => {
  const { shop, call, pid, node, map } = await shopProject();
  const count = shop.issues.length;
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id })).body.changeset;
  const epic = await newItem(call, pid, cs.id, node(1).id, 'epic');
  const child = await newItem(call, pid, cs.id, epic.id, 'task');
  const kept = await newItem(call, pid, cs.id, node(1).id, 'task');
  const dropped = await call('DELETE', `/api/projects/${pid}/changesets/${cs.id}/items/${itemKeyOf(epic)}`);
  assert.deepEqual(dropped.body.deleted.sort(), [epic.id, child.id].sort(), 'with what was inside it');
  assert.deepEqual(dropped.body.changeset.items.map((it) => it.key), [itemKeyOf(kept)]);
  await call('POST', `/api/projects/${pid}/changesets/${cs.id}/discard`);
  const ids = new Set((await map()).map((n) => n.id));
  assert.ok(![epic.id, child.id, kept.id].some((id) => ids.has(id)));
  await call('POST', `/api/projects/${pid}/refresh`, {});
  assert.ok(!(await map()).some((n) => n.id === kept.id), 'and a refresh does not bring it back');
  assert.equal(shop.issues.length, count);
});

test('SHIP-14 an error a browser caught is kept, with its stack, to be read from anywhere', async () => {
  let now = Date.now();
  const { call } = await setup('secret-key', () => (now += 1000)); // a second apart: two errors in one millisecond have no order
  assert.equal((await call('POST', '/api/errors', { message: 'boom' }, null)).status, 401, 'only with the access key');
  const sent = await call('POST', '/api/errors', { message: "Cannot read properties of undefined (reading 'poly')", stack: 'TypeError: …\n    at hitTest', componentStack: 'at Details', where: 'panel', url: 'https://x/#n=issue-53', userAgent: 'Safari', build: '/assets/index-abc.js', extra: 'dropped' });
  assert.equal(sent.status, 201);
  await call('POST', '/api/errors', { message: 'x'.repeat(5000), stack: 'y'.repeat(20000) });
  const { errors } = (await call('GET', '/api/errors')).body;
  assert.equal(errors.length, 2);
  assert.equal(errors[0].message.length, 1000, 'newest first, and clipped');
  assert.equal(errors[0].stack.length, 8000);
  assert.deepEqual([errors[1].where, errors[1].userAgent, errors[1].stack.includes('hitTest'), 'extra' in errors[1]], ['panel', 'Safari', true, false]);
});
