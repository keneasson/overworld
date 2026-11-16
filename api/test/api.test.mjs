import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../app.mjs';
import { createModel } from '../model/index.mjs';
import { parseRepo, importGitHub } from '../github.mjs';
import { sanitizeNode } from '../../shared/schema.js';
import { behaviourPrefix, editableOf, isWellFormed, itemKeyOf, nextBehaviourId, parseBehaviours, parseIssue, sectionText } from '../../shared/issue-shape.js';
import { fakeShop } from './fake-github.mjs';
import { threadsOf } from '../../shared/annotations.js';

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
    comments.map((c) => [c.itemKey, c.anchor.behaviour ?? c.anchor.section, c.text, c.author]),
    [
      ['issue-4', 'PAY-10', 'Which vault?', 'QA'],
      ['issue-4', 'Why', 'Agreed.', 'Someone'],
      ['issue-40', 'Why', 'Elsewhere.', 'Someone'],
    ],
  );
  const id = a.body.comment.id;
  assert.equal((await call('PATCH', `/api/projects/${pid}/comments/issue-4/${id}`, { resolved: true })).body.comment.resolved, true);
  assert.equal((await call('DELETE', `/api/projects/${pid}/comments/issue-4/${id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/projects/${pid}/comments/issue-4/${id}`)).status, 404);
  assert.equal((await call('GET', `/api/projects/${pid}/comments`)).body.comments.length, 2);
});

test('NOTE-01 NOTE-02 an annotation has a kind and sits on what it is about; a Change keeps its value apart from the words', async () => {
  const { call, pid, map } = await shopProject();
  const before = (await map()).find((n) => n.title.startsWith('#4 ')).body;
  const post = (body) => call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', ...body });
  const on = { on: 'word', section: 'Why', quote: 'tokens', prefix: 'Cards need ', suffix: '.' };
  const change = await post({ kind: 'change', anchor: on, text: 'Make this blue', value: ' #EEAA18 ', author: 'Ken' });
  assert.equal(change.status, 201, JSON.stringify(change.body));
  const c = change.body.comment;
  assert.deepEqual([c.kind, c.anchor.quote, c.text, c.value], ['change', 'tokens', 'Make this blue', '#EEAA18']);
  for (const kind of ['question', 'problem', 'refactor', 'comment']) assert.equal((await post({ kind, anchor: { on: 'section', section: 'Why' }, text: kind })).status, 201);
  assert.equal((await post({ kind: 'praise', anchor: on, text: 'x' })).status, 400, 'the kinds are fixed');
  assert.equal((await post({ kind: 'problem', anchor: on, text: 'x', value: 'blue' })).status, 400, 'only a Change carries a value');
  assert.equal((await post({ anchor: { on: 'phrase', section: 'Why' }, text: 'x' })).status, 400, 'words are quoted');
  assert.equal((await post({ anchor: { on: 'image', section: 'Why', src: 'https://x/c.png', quote: 'a cat' }, text: 'Too dark' })).status, 201);
  assert.equal((await post({ anchor: { on: 'place' }, text: 'This region is crowded' })).status, 201);
  const { comments } = (await call('GET', `/api/projects/${pid}/comments/issue-4`)).body;
  assert.deepEqual(comments.map((x) => x.kind), ['change', 'question', 'problem', 'refactor', 'comment', 'comment', 'comment']);
  assert.deepEqual(comments.slice(-2).map((x) => x.anchor.on), ['image', 'place']);
  assert.equal((await map()).find((n) => n.title.startsWith('#4 ')).body, before, 'annotating leaves the issue alone');
});

test('NOTE-09 comments made before annotations are Comment annotations in the same place, and none is lost', async () => {
  const { call, model, pid } = await shopProject();
  const old = [
    { id: '00000001aaaa', itemKey: 'issue-4', anchor: { behaviour: 'PAY-10' }, text: 'Which vault?', author: 'QA', resolved: false, createdAt: '2026-11-01T00:00:00.000Z' },
    { id: '00000002aaaa', itemKey: 'issue-4', anchor: { section: 'Why' }, text: 'Agreed.', author: 'Ken', resolved: true, createdAt: '2026-11-02T00:00:00.000Z' },
    { id: '00000003aaaa', itemKey: 'issue-4', anchor: { section: 'Open questions' }, text: 'Which provider?', author: 'Builder (a1)', resolved: false, createdAt: '2026-11-03T00:00:00.000Z' },
  ];
  for (const c of old) await model.comments.put(pid, c);
  const { comments } = (await call('GET', `/api/projects/${pid}/comments/issue-4`)).body;
  assert.deepEqual(
    comments.map((c) => [c.text, c.kind, c.anchor.on, c.anchor.behaviour ?? c.anchor.section, c.resolved]),
    [
      ['Which vault?', 'comment', 'behaviour', 'PAY-10', false],
      ['Agreed.', 'comment', 'section', 'Why', true],
      ['Which provider?', 'question', 'section', 'Open questions', false],
    ],
  );
});

test('NOTE-11 each annotation is its own thread at its own words, and a reply stays in its thread', async () => {
  const { call, pid } = await shopProject();
  const post = async (body) => (await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', ...body })).body.comment;
  const first = await post({ kind: 'question', anchor: { on: 'word', section: 'Open questions', quote: 'vault' }, text: 'Which one?' });
  const second = await post({ kind: 'question', anchor: { on: 'word', section: 'Open questions', quote: 'provider' }, text: 'Stripe?' });
  const reply = await post({ replyTo: first.id, text: 'The PCI one.', author: 'Ken' });
  assert.deepEqual([reply.anchor, reply.replyTo, reply.kind], [first.anchor, first.id, 'comment']);
  assert.equal((await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', replyTo: 'gone', text: 'x' })).status, 404);
  const threads = threadsOf((await call('GET', `/api/projects/${pid}/comments/issue-4`)).body.comments);
  assert.deepEqual(threads.map((t) => [t.root.id, t.root.anchor.quote, t.replies.map((r) => r.text)]), [[first.id, 'vault', ['The PCI one.']], [second.id, 'provider', []]]);
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
  const markdown = md.replace(/## Behaviours\n\n<!--[^\n]*-->/, '## Behaviours\n\n- REFUND-01 Given a refund, when asked, then it is paid.');
  const res = await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: itemKeyOf(made), title: 'Refunds', markdown });
  assert.equal(res.status, 200);
  assert.equal(nextBehaviourId(behaviourPrefix(parseBehaviours(sectionText(parseIssue(markdown), 'Behaviours')), 'Refunds'), (await map()).map((n) => n.body)), 'REFUND-02');
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

test("ADOPT-08 an item of a refinement that still has open questions can't be adopted", async () => {
  const { call, pid, node, map } = await shopProject();
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: node(1).id, author: 'Builder (a1)' })).body.changeset;
  const four = node(4).body.replace(/\n\n---\n📍[^\n]*$/, '');
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: four.replace('None.', '- Which vault?') });
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${cs.id}/items/issue-4/adopt`, { by: 'Ken' })).status, 409, 'a question in its text');
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-4', title: 'Card tokens', markdown: four.replace('a token.', 'a token, kept.') });
  const { comment } = (await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', anchor: { section: 'Open questions' }, text: 'Which vault?' })).body;
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${cs.id}/items/issue-4/adopt`, { by: 'Ken' })).status, 409, 'a question asked on it');
  assert.doesNotMatch((await map()).find((n) => n.title.startsWith('#4 ')).body, /kept/);
  await call('PATCH', `/api/projects/${pid}/comments/issue-4/${comment.id}`, { resolved: true });
  assert.equal((await call('POST', `/api/projects/${pid}/changesets/${cs.id}/items/issue-4/adopt`, { by: 'Ken' })).status, 200, 'answered, it can be adopted');
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
