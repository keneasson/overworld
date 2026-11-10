import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { polygonCentroid } from 'd3';
import { demoProject } from '../../api/seed.mjs';
import { buildTree } from '../src/model/tree.js';
import { LENSES, LENS_BY_ID, statusColor } from '../src/map/lenses.js';
import { badgesOf, labelFor, symbolsInUse } from '../src/map/labels.js';
import { SYMBOL_NAMES, symbolPath } from '../src/map/symbols.js';
import { buildScene } from '../src/map/scene.js';
import { hitTest, roads, thresholds } from '../src/map/renderer.js';

const root = { id: 'root', parentId: null, title: 'Project', kind: 'project', status: 'planned' };
const item = (id, parentId, extra = {}) => ({ id, parentId, title: `#${id.length + 10} ${id}`, kind: parentId === 'root' ? 'epic' : 'task', status: 'ready', ...extra });
const LONG = 'This is a long enough body to count as some detail about the work.\n\n## Acceptance\n- [ ] it works';
const SIZES = [20, 40, 62, 95, 150, 330, 600, 1200, 4000];

test('SYM-01 SYM-06 at every zoom an item shows at most its symbol, short title and badges', () => {
  const tree = buildTree(demoProject().nodes);
  for (const n of tree.list) {
    for (const s of SIZES) {
      const label = labelFor(n, s);
      assert.deepEqual(Object.keys(label).sort(), ['badges', 'fill', 'lines', 'symbol', 'title']);
      assert.equal(label.symbol, n.kind);
      assert.ok(n.title.endsWith(label.title) && label.title.length, 'the title, without its issue number');
      assert.ok(label.lines <= 2);
      assert.ok(!JSON.stringify(label).includes(n.summary || '\u0000'), 'the summary is for the place card');
    }
  }
  assert.equal(labelFor(buildTree([root, item('s', 'root', { title: '#7 Save' })]).byId.get('s'), 400).title, 'Save');
});

test('SYM-02 FOG-01 a symbol is filled by its status, and the Fog lens puts poorly defined work under fog', () => {
  const tree = buildTree([
    root,
    item('epic', 'root', { body: LONG, summary: 'An epic with a summary' }),
    item('a', 'epic', { status: 'ready', body: LONG, summary: 'Well defined task', estimate: 3 }),
    item('b', 'epic', { status: 'in_progress', body: LONG, summary: 'Well defined task', estimate: 3 }),
    item('c', 'epic', { status: 'in_progress' }),
  ]);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => tree.byId.get(id));
  assert.notEqual(labelFor(a, 400).fill, labelFor(b, 400).fill, 'different states, different fills');
  assert.equal(labelFor(b, 400).fill, labelFor(c, 400).fill, 'the same state, the same fill');
  assert.equal(labelFor(b, 400).fill, LENS_BY_ID.lifecycle.fill(b), 'in the colours of the Lifecycle lens');
  assert.equal(labelFor(tree.byId.get('epic'), 400).fill, statusColor(b), 'a region shows what most of its work is in');

  const fog = LENS_BY_ID.definition;
  assert.ok(fog.fog(c) === 1 && fog.fog(b) === 0, 'uncharted land is under fog, charted land is clear');
  assert.notEqual(fog.fill(c), fog.fill(b));
  assert.ok(fog.matches(c) && !fog.matches(b));
});

test('SYM-03 badges show pull requests, agents, comments and open questions, and questions never change the terrain', () => {
  const asked = '## Open questions\n- Which store keeps the drafts while nobody is signed in?\n- Who signs off?';
  const nodes = [root, item('epic', 'root'), item('a', 'epic', { body: LONG, pulls: [41] }), item('b', 'epic', { body: asked }), item('c', 'epic', { status: 'done', pulls: [12] })];
  const tree = buildTree(nodes);
  const live = { agents: new Map([['a', 1]]), comments: new Map([['a', 3]]) };
  assert.deepEqual(badgesOf(tree.byId.get('a'), live), [
    { type: 'pull', count: 1 },
    { type: 'agent', count: 1 },
    { type: 'comment', count: 3 },
  ]);
  assert.deepEqual(badgesOf(tree.byId.get('b')), [{ type: 'question', count: 2 }], 'a "?" badge with the count');
  assert.deepEqual(badgesOf(tree.byId.get('c')), [], 'a done item has no open pull request');
  assert.deepEqual(labelFor(tree.byId.get('b'), 400).badges, badgesOf(tree.byId.get('b')));
  assert.deepEqual(badgesOf(buildTree([root, item('d', 'root', { body: '## Open questions\nNone.' })]).byId.get('d')), []);

  // The same items without the questions: every lens paints the land the same.
  const quiet = buildTree(nodes.map((n) => (n.id === 'b' ? { ...n, body: '' } : n)));
  for (const lens of LENSES) {
    for (const n of tree.list) {
      const m = quiet.byId.get(n.id);
      assert.equal(lens.fill(n, tree), lens.fill(m, quiet), `${lens.name} fills ${n.id} the same`);
      assert.equal(Boolean(lens.hatch?.(n)), Boolean(lens.hatch?.(m)), `${lens.name} hatches ${n.id} the same`);
    }
  }
});

test('SYM-04 the legend lists every symbol and badge in use on the map and nothing else', () => {
  const tree = buildTree([root, item('epic', 'root'), item('a', 'epic', { kind: 'bug', status: 'in_progress', body: '## Open questions\n- Why?' }), item('b', 'epic', { status: 'done' })]);
  const used = symbolsInUse(tree);
  assert.deepEqual(
    used.kinds.map((k) => k.symbol),
    ['project', 'epic', 'task', 'bug'],
  );
  assert.deepEqual(
    used.badges.map((b) => b.symbol),
    ['question'],
  );
  assert.deepEqual(new Set(used.fills.map((f) => f.color)), new Set(tree.list.map(statusColor)));
  const all = symbolsInUse(tree, { agents: new Map([['b', 1]]) });
  assert.deepEqual(
    all.badges.map((b) => b.symbol),
    ['agent', 'question'],
  );
});

test('SYM-05 a road joins two visible linked items, and zoomed out the roads merge into what is visible', () => {
  const tree = buildTree([
    root,
    item('left', 'root'),
    item('right', 'root'),
    item('a', 'left', { links: [{ to: 'x', type: 'depends' }] }),
    item('b', 'left', { links: [{ to: 'y', type: 'depends' }] }),
    item('x', 'right'),
    item('y', 'right'),
  ]);
  const near = roads(tree, (n) => n);
  assert.deepEqual(near.map((r) => [r.a.id, r.b.id, r.count]).sort(), [
    ['a', 'x', 1],
    ['b', 'y', 1],
  ]);
  const top = (n) => (n.depth <= 1 ? n : top(n.parent));
  const far = roads(tree, top, tree.byId.get('a'));
  assert.deepEqual(
    far.map((r) => [r.a.id, r.b.id, r.type, r.count, r.hot]),
    [['left', 'right', 'depends', 2, true]],
  );
});

test('SYM-07 symbols come from one module of ours, so the icon library can be replaced there alone', () => {
  for (const name of ['project', 'area', 'epic', 'feature', 'story', 'task', 'bug', 'behavior', 'pull', 'agent', 'comment', 'question']) {
    assert.ok(SYMBOL_NAMES.includes(name));
    assert.match(symbolPath(name), /^M[\d.\s-]/, `${name} has a drawable outline`);
  }
  const src = new URL('../src/', import.meta.url).pathname;
  const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
  const importers = files(src).filter((f) => /from ['"]lucide/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(
    importers.map((f) => f.slice(src.length)),
    ['map/symbols.js'],
  );
});

test('SYM-08 hover and click land on the innermost item under the pointer', () => {
  const scene = buildScene(demoProject().nodes, 'demo', null, 'organic');
  const W = 1200, H = 800;
  const area = scene.tree.root.children.find((n) => n.children.length > 1);
  const child = area.children[0];
  // Zoom so the area's children are drawn but its own label is still up.
  const g = scene.geo.get(area.id);
  const k = (thresholds(W, H).sub * 1.3) / g.size;
  const [cx, cy] = polygonCentroid(scene.geo.get(child.id).poly);
  const view = { x: W / 2 - cx * k, y: H / 2 - cy * k, k, width: W, height: H };
  const over = (id) => ({ labels: [{ id, alpha: 1, rect: { x: W / 2 - 60, y: H / 2 - 20, w: 120, h: 40 } }] });
  assert.equal(hitTest(scene, view, over(area.id), W / 2, H / 2), child.id, "the area's label over its child's land: the child");
  assert.equal(hitTest(scene, view, over(child.id), W / 2, H / 2), child.id);
  assert.equal(hitTest(scene, view, { labels: [] }, W / 2, H / 2), child.id, 'on the land alone');
});
