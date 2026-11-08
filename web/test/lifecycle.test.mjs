import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/model/tree.js';
import { LENS_BY_ID } from '../src/map/lenses.js';

const node = (id, parentId, status, extra = {}) => ({ id, parentId, title: id, kind: parentId === 'root' ? 'epic' : 'task', status, ...extra });

test('LIFE-06 the Lifecycle layer colours each state and rolls counts up, leaving rejected work out of progress', () => {
  const tree = buildTree([
    { id: 'root', parentId: null, title: 'Project', kind: 'project', status: 'planned' },
    node('epic', 'root', 'planned'),
    node('a', 'epic', 'done'),
    node('b', 'epic', 'ready'),
    node('c', 'epic', 'needs_decision', { definition: 'vague' }),
    node('d', 'epic', 'rejected'),
    node('e', 'epic', 'in_progress'),
    node('f', 'epic', 'in_progress'),
  ]);
  const epic = tree.byId.get('epic');
  assert.deepEqual(epic.stats.states, { done: 1, ready: 1, needs_decision: 1, rejected: 1, in_progress: 2 });
  assert.deepEqual(tree.root.stats.states, epic.stats.states, 'counts reach the top level');
  assert.equal(epic.stats.progress.toFixed(3), ((1 + 0.45 * 2) / 5).toFixed(3), 'rejected work is not counted');
  assert.ok(tree.byId.get('d').stats.raw > 0, 'a ruin still has ground on the map');

  const lens = LENS_BY_ID.lifecycle;
  assert.equal(lens.stat(epic), '1 needs decision · 2 in progress · 1 ready · 1 done · 1 rejected');
  assert.equal(lens.fill(epic), lens.fill(tree.byId.get('e')), 'a region takes the colour of most of its open work');
  assert.ok(lens.hatch(tree.byId.get('d')));
  assert.ok(lens.dots(tree.byId.get('c')) && lens.matches(tree.byId.get('c')));
  assert.equal(lens.count(tree), 1);
  const colours = lens.legend().map((l) => l.color);
  assert.equal(new Set(colours).size, colours.length, 'every state has its own colour');
});

test('LIFE-06 a region whose work was all rejected is settled, not empty', () => {
  const tree = buildTree([
    { id: 'root', parentId: null, title: 'Project', kind: 'project', status: 'planned' },
    node('epic', 'root', 'planned'),
    node('x', 'epic', 'rejected'),
  ]);
  const epic = tree.byId.get('epic');
  assert.equal(epic.stats.health, 'done');
  assert.equal(epic.stats.progress, 1);
  assert.ok(Number.isFinite(epic.stats.defAvg));
});

test('land mapped from the code is not work: it counts nothing and says so', () => {
  const tree = buildTree([
    { id: 'root', parentId: null, title: 'Project', kind: 'project', status: 'planned' },
    { id: 'web', parentId: 'root', title: 'Web app', kind: 'area', status: 'in_progress', tags: ['code'] },
    { id: 'empty', parentId: 'web', title: 'Settings', kind: 'feature', status: 'done', tags: ['code'] },
    node('t', 'web', 'ready'),
  ]);
  assert.deepEqual(tree.root.stats.states, { ready: 1 });
  assert.equal(LENS_BY_ID.lifecycle.stat(tree.byId.get('empty')), 'No work here');
});
