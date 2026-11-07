import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTable } from '../model/table.mjs';
import { modelFor } from '../model/index.mjs';

async function setup() {
  const table = fileTable(join(await mkdtemp(join(tmpdir(), 'overworld-')), 'table.json'));
  return { table, model: modelFor(table) };
}

const project = (id, updatedAt) => ({ id, title: `Project ${id}`, createdAt: '2026-01-01T00:00:00Z', updatedAt });
const node = (id, title = id) => ({ id, title, parentId: id === 'root' ? null : 'root' });

test('lists projects from the index, most recently updated first', async () => {
  const { model } = await setup();
  await model.projects.put(project('a', '2026-03-01T00:00:00Z'));
  await model.projects.put(project('b', '2026-05-01T00:00:00Z'));
  await model.projects.put(project('c', '2026-04-01T00:00:00Z'));
  await model.nodes.put('a', [node('root'), node('x')]);
  assert.deepEqual(
    (await model.projects.list()).map((p) => p.id),
    ['b', 'c', 'a'],
    'nodes and flags are not in the project list',
  );
  await model.projects.put(project('a', '2026-06-01T00:00:00Z'));
  assert.equal((await model.projects.list())[0].id, 'a', 'saving a project moves it to the top');
});

test('reads a whole map from one partition, and hands back plain entities', async () => {
  const { model } = await setup();
  await model.projects.put(project('a', '2026-03-01T00:00:00Z'));
  await model.nodes.put('a', [node('root'), node('x'), node('y')]);
  await model.projects.put(project('b', '2026-03-01T00:00:00Z'));
  await model.nodes.put('b', [node('root')]);
  const map = await model.projects.getWithNodes('a');
  assert.equal(map.project.title, 'Project a');
  assert.deepEqual(map.nodes.map((n) => n.id).sort(), ['root', 'x', 'y']);
  for (const it of [map.project, ...map.nodes]) for (const k of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'entity']) assert.equal(k in it, false, k);
  assert.equal(await model.projects.getWithNodes('nope'), null);
});

test('deleting a project removes its whole partition and nothing else', async () => {
  const { model, table } = await setup();
  await model.projects.put(project('a', '2026-03-01T00:00:00Z'));
  await model.nodes.put('a', [node('root'), node('x')]);
  await model.projects.put(project('b', '2026-03-01T00:00:00Z'));
  await model.nodes.put('b', [node('root')]);
  await model.flags.set('seeded');
  await model.projects.delete('a');
  assert.equal(await model.projects.getWithNodes('a'), null);
  assert.deepEqual((await table.scan()).map((it) => it.PK).sort(), ['APP', 'PROJECT#b', 'PROJECT#b']);
});

test('replacing a map keeps the root, writes the new nodes and drops the old', async () => {
  const { model } = await setup();
  await model.projects.put(project('a', '2026-03-01T00:00:00Z'));
  await model.nodes.put('a', [node('root', 'Old'), node('x'), node('y')]);
  await model.nodes.replace('a', [node('root', 'New'), node('y'), node('z')]);
  const { nodes } = await model.projects.getWithNodes('a');
  assert.deepEqual(nodes.map((n) => n.id).sort(), ['root', 'y', 'z']);
  assert.equal(nodes.find((n) => n.id === 'root').title, 'New');
});

test('flags remember one-off facts', async () => {
  const { model } = await setup();
  assert.equal(await model.flags.has('seeded'), false);
  await model.flags.set('seeded');
  assert.equal(await model.flags.has('seeded'), true);
});

test('changesets and comments live in their project partition, and go with it', async () => {
  const { model, table } = await setup();
  await model.projects.put(project('a', '2026-03-01T00:00:00Z'));
  await model.nodes.put('a', [node('root')]);
  await model.changesets.put('a', { id: 'c2', createdAt: '2026-03-02T00:00:00Z', items: [] });
  await model.changesets.put('a', { id: 'c1', createdAt: '2026-03-01T00:00:00Z', items: [] });
  assert.deepEqual((await model.changesets.list('a')).map((c) => c.id), ['c1', 'c2'], 'oldest first');
  assert.equal((await model.changesets.get('a', 'c1')).id, 'c1');
  assert.equal(await model.changesets.get('a', 'nope'), null);
  await model.comments.put('a', { id: '002', itemKey: 'issue-5', text: 'second' });
  await model.comments.put('a', { id: '001', itemKey: 'issue-5', text: 'first' });
  await model.comments.put('a', { id: '003', itemKey: 'issue-50', text: 'another item' });
  assert.deepEqual((await model.comments.list('a', 'issue-5')).map((c) => c.text), ['first', 'second'], "one item's thread, in order, and not issue-50's");
  assert.equal((await model.comments.list('a')).length, 3);
  const map = await model.projects.getWithNodes('a');
  assert.deepEqual(map.nodes.map((n) => n.id), ['root'], 'a map is still only its nodes');
  await model.comments.delete('a', { itemKey: 'issue-5', id: '001' });
  assert.equal((await model.comments.list('a', 'issue-5')).length, 1);
  await model.projects.delete('a');
  assert.deepEqual(await table.scan(), []);
});
