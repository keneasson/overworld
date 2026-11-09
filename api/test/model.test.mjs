// The data layer's promises (DATA-01 to DATA-03, #19), tested once for the whole design and through the API.
// Which keys an access pattern uses is mechanics; these only watch what reaches the table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../app.mjs';
import { fileTable } from '../model/table.mjs';
import { modelFor } from '../model/index.mjs';
import { fakeShop } from './fake-github.mjs';

/** The API on a table that records every scan and every query, with what each query read. */
async function setup() {
  const table = fileTable(join(await mkdtemp(join(tmpdir(), 'overworld-')), 'table.json'));
  const seen = { scans: 0, queries: [] };
  const watched = {
    ...table,
    async scan() {
      seen.scans++;
      return table.scan();
    },
    async query(q) {
      const items = await table.query(q);
      seen.queries.push(items);
      return items;
    },
  };
  const shop = fakeShop();
  const api = createApi({ model: modelFor(watched), accessKey: 'k', fetchImpl: shop.fetch, log: { error() {} } });
  const call = async (method, path, body) => {
    const res = await api({ method, path, body, headers: { 'x-projectmap-key': 'k' } });
    assert.ok(res.status < 500, `${method} ${path}: ${res.status}`);
    return res;
  };
  return { table, seen, shop, call };
}

/** A project with everything a project can hold: nodes, a changeset and a comment. */
async function fullProject(call) {
  const { project, nodes } = (await call('POST', '/api/import/github', { repo: 'octo/shop' })).body;
  const pid = project.id;
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { scopeId: nodes[0].id })).body.changeset;
  await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key: 'issue-5', title: 'Think about the vibe', markdown: 'Ours.' });
  await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-4', anchor: { section: 'Why' }, text: 'Agreed.' });
  return { pid, nodes, cs };
}

test('DATA-01 no request the API serves scans the table', async () => {
  const { seen, shop, call } = await setup();
  const demo = (await call('GET', '/api/projects')).body.projects[0].id;
  const blank = (await call('POST', '/api/projects', { title: 'Hand made' })).body.project.id;
  const { body: map } = await call('GET', `/api/projects/${demo}`);
  const area = (await call('POST', `/api/projects/${blank}/nodes`, { node: { title: 'Area', kind: 'area', parentId: 'root' } })).body.nodes[0];
  await call('PATCH', `/api/projects/${blank}/nodes/${area.id}`, { status: 'done' });
  await call('DELETE', `/api/projects/${blank}/nodes/${area.id}`);
  await call('POST', '/api/import/json', map);
  const { pid, cs } = await fullProject(call);
  const c = (await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-3', text: 'Hm.' })).body.comment;
  await call('PATCH', `/api/projects/${pid}/comments/issue-3/${c.id}`, { resolved: true });
  await call('DELETE', `/api/projects/${pid}/comments/issue-3/${c.id}`);
  await call('GET', `/api/projects/${pid}/comments`);
  await call('GET', `/api/projects/${pid}/changesets`);
  await call('POST', `/api/projects/${pid}/changesets/${cs.id}/accept`);
  const other = (await call('POST', `/api/projects/${pid}/changesets`, {})).body.changeset;
  await call('POST', `/api/projects/${pid}/changesets/${other.id}/discard`);
  shop.issues.push(shop.issue(7, 'Cart badge shows the wrong count'));
  await call('POST', `/api/projects/${pid}/refresh`, {});
  await call('DELETE', `/api/projects/${pid}`);
  await call('GET', '/api/projects');
  assert.equal(seen.scans, 0);
});

test('DATA-02 opening a map reads the project and its nodes in one query, and nothing else', async () => {
  const { seen, call } = await setup();
  const { pid } = await fullProject(call);
  await fullProject(call);
  seen.queries = [];
  const { body } = await call('GET', `/api/projects/${pid}`);
  assert.equal(seen.queries.length, 1, 'one query');
  const [read] = seen.queries;
  assert.equal(new Set(read.map((it) => it.PK)).size, 1, 'one partition');
  assert.deepEqual([...new Set(read.map((it) => it.entity))].sort(), ['node', 'project'], 'changesets and comments load only when asked for');
  assert.equal(read.filter((it) => it.entity === 'node').length, body.nodes.length, 'and no other project');
});

test('DATA-03 deleting a project removes its partition and touches nothing else', async () => {
  const { table, call } = await setup();
  await call('GET', '/api/projects');
  const { pid } = await fullProject(call);
  await fullProject(call);
  const before = await table.scan();
  const partition = before.find((it) => it.entity === 'project' && it.id === pid).PK;
  assert.ok(new Set(before.filter((it) => it.PK === partition).map((it) => it.entity)).size === 4, 'it held nodes, a changeset and a comment');
  await call('DELETE', `/api/projects/${pid}`);
  const after = await table.scan();
  assert.equal(after.filter((it) => it.PK === partition).length, 0, 'everything in its partition is gone');
  const ours = (it) => it.PK === partition || (it.entity === 'store-link' && it.projectId === pid);
  assert.deepEqual(after, before.filter((it) => !ours(it)), 'its store links go too, and everything else is as it was');
});
