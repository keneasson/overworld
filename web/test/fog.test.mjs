import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/model/tree.js';
import { buildScene } from '../src/map/scene.js';
import { LENS_BY_ID } from '../src/map/lenses.js';
import { FOG_LAYERS, boltOf, driftOf, fogClock, fogOver, fogPatches, fogReason, staleFog, stormAt } from '../src/map/fog.js';
import { drawMap, thresholds } from '../src/map/renderer.js';

const root = { id: 'root', parentId: null, title: 'Project', kind: 'project', status: 'planned' };
const item = (id, parentId, extra = {}) => ({ id, parentId, title: id, kind: parentId === 'root' ? 'epic' : 'task', status: 'ready', tags: [], ...extra });
const gwt = (id) => `- ${id} Given a shopper, when they look, then ${id} is kept.`;
const fogRow = (id) => `- ${id} Not worked out yet: what happens when the network drops.`;
const spec = (...rows) => `## Behaviours\n\n${rows.join('\n')}`;
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1));
const ID = (p, i) => `${p}-${String(i).padStart(2, '0')}`;

test('FOG-05 an issue\'s fog comes from its behaviours alone', () => {
  const tree = buildTree([
    root,
    item('epic', 'root', { body: 'An epic.' }),
    item('none', 'epic', { summary: 'A long and careful summary', estimate: 3, body: 'Lots of detail.\n\n## Acceptance\n- [ ] it works' }),
    // Like #14: every behaviour worked out, no estimate, no summary.
    item('handoff', 'epic', { body: spec(...range(10, (i) => gwt(ID('HAND', i)))) }),
    item('quarter', 'epic', { body: spec(gwt('Q-01'), gwt('Q-02'), fogRow('Q-03'), gwt('Q-04')) }),
    item('asks', 'epic', { body: `${spec(gwt('A-01'))}\n\n## Open questions\n\n- Which store?` }),
  ]);
  const fog = (id) => tree.byId.get(id).stats.fog;
  assert.equal(fog('none'), 1, 'no behaviours: fully in the fog, whatever else it has');
  assert.equal(fog('handoff'), 0, 'every behaviour worked out: no fog, without an estimate');
  assert.equal(fog('quarter'), 0.25, 'the share of its behaviours that are fog');
  assert.equal(fog('asks'), 0, 'an open question is a "?" badge, never fog');
  assert.ok(tree.byId.get('quarter').stats.vague && !tree.byId.get('handoff').stats.vague);
  const kids = tree.byId.get('epic').children;
  const avg = kids.reduce((s, c) => s + c.stats.fog * c.stats.raw, 0) / kids.reduce((s, c) => s + c.stats.raw, 0);
  assert.ok(Math.abs(fog('epic') - avg) < 1e-9, "a parent's fog is the size-weighted average of its children's");
  assert.equal(LENS_BY_ID.definition.fog(tree.byId.get('handoff')), 0, 'the Fog lens shows no fog over it');
});

// A street: one issue with four behaviours, one of them not worked out; one with ten, all worked out; one with none.
const street = () =>
  buildScene(
    [
      root,
      item('area', 'root', { kind: 'area' }),
      item('quarter', 'area', { kind: 'feature', body: spec(gwt('Q-01'), gwt('Q-02'), fogRow('Q-03'), gwt('Q-04')) }),
      item('clear', 'area', { kind: 'feature', body: spec(...range(10, (i) => gwt(ID('HAND', i)))) }),
      item('empty', 'area', { kind: 'feature', body: 'Nothing written yet.' }),
    ],
    'street',
    null,
    'organic',
  );
const streetZoom = (scene, id) => 1100 / scene.geo.get(id).size;

test('FOG-06 at street zoom the cloud lies over the houses of behaviours not worked out, and the card says so in words', () => {
  const scene = street();
  const at = (id) => {
    const n = scene.tree.byId.get(id);
    return fogPatches(n, { fog: fogOver, geo: scene.geo, k: streetZoom(scene, id), kidsOf: scene.kidsOf });
  };
  const quarter = at('quarter');
  assert.deepEqual(
    quarter.map((p) => p.n.behaviour),
    ['Q-03'],
    'over the one house not worked out, not the whole block',
  );
  assert.equal(quarter[0].w, 1);
  assert.deepEqual(at('clear'), [], 'worked-out houses stand clear');
  const empty = at('empty');
  assert.deepEqual(
    empty.map((p) => p.n.id),
    ['empty'],
    'an issue with no behaviours: over its open ground',
  );
  const n = (id) => scene.tree.byId.get(id);
  assert.equal(fogReason(n('quarter')), '1 of 4 behaviours not worked out yet');
  assert.equal(fogReason(n('clear')), 'All 10 behaviours are worked out');
  assert.match(fogReason(n('empty')), /^No behaviours yet/);
  assert.match(fogReason(n('area')), /% in the Fog: 2 items inside not worked out$/, 'a region gives its reason with its share');
  assert.equal(LENS_BY_ID.definition.stat(n('quarter')), '1 of 4 behaviours not worked out yet', 'the lens says it in the same words');
});

test('FOG-03 the cloud drifts in two layers at different speeds, and stands still for reduced motion', () => {
  assert.equal(FOG_LAYERS.length, 2);
  const [a, b] = driftOf(10);
  assert.ok(Math.hypot(a.x, a.y) > 0 && Math.hypot(b.x, b.y) > 0, 'both layers move');
  assert.notEqual(Math.hypot(a.x, a.y), Math.hypot(b.x, b.y), 'at different speeds');
  assert.ok(Math.hypot(a.x, a.y) / 10 < 30, 'slowly: a few pixels a second');
  assert.deepEqual(driftOf(fogClock(10, true)), driftOf(fogClock(500, true)), 'still, for someone who asks for reduced motion');
});

const DAY = 86_400_000;
test('FOG-04 lightning strikes the oldest fog that has sat more than 14 days, at most 5% of the project', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const ago = (d) => new Date(now - d * DAY).toISOString();
  const nodes = [root, item('epic', 'root', { body: 'An epic.', updatedAt: ago(100) })];
  // 40 places: fog untouched for 20 to 60 days, fog changed last week, and old work that is worked out.
  for (let i = 0; i < 10; i++) nodes.push(item(`old${i}`, 'epic', { updatedAt: ago(20 + 4 * i) }));
  for (let i = 0; i < 10; i++) nodes.push(item(`fresh${i}`, 'epic', { updatedAt: ago(3) }));
  for (let i = 0; i < 18; i++) nodes.push(item(`clear${i}`, 'epic', { body: spec(gwt(ID('C', i + 1))), updatedAt: ago(400) }));
  const tree = buildTree(nodes);
  assert.equal(tree.list.length, 40);
  assert.deepEqual([...staleFog(tree, now)].sort(), ['old8', 'old9'], 'the two oldest: 5% of 40 places, oldest first');
  assert.equal(staleFog(buildTree(nodes.map((n) => (n.id.startsWith('old') ? { ...n, updatedAt: ago(1) } : n))), now).size, 0, 'none once refined');
  const worked = buildTree(nodes.map((n) => (n.id.startsWith('old') ? { ...n, body: spec(gwt('W-01')) } : n)));
  assert.equal(staleFog(worked, now).size, 0, 'none once worked out');

  // Now and then: over a minute some strikes, but mostly the cloud is dark and still.
  const frames = Array.from({ length: 1200 }, (_, i) => stormAt('old9', i / 20));
  const struck = frames.filter((f) => f.bolt > 0.3).length;
  assert.ok(struck > 0 && struck < frames.length * 0.2, `strikes now and then (${struck} of ${frames.length} frames)`);
  assert.ok(new Set(frames.filter((f) => f.strike !== null).map((f) => f.strike)).size >= 2, 'more than once a minute');
  const strike = frames.find((f) => f.strike !== null).strike;
  const bolt = boltOf('old9', strike);
  assert.ok(bolt.length >= 3 && bolt[0].points.length > 10, 'a jagged trunk with branching bolts');
  assert.deepEqual(boltOf('old9', strike), bolt, 'each strike keeps its shape');
  assert.notDeepEqual(boltOf('old9', strike + 1), bolt, 'and the next strikes differently');
  const calm = Array.from({ length: 200 }, (_, i) => stormAt('old9', i / 2, true));
  assert.ok(calm.every((f) => f.bolt === 0 && f.flash === 0 && f.glow > 0), 'for reduced motion, a soft glow and no flashing');
});

// A canvas that records what is drawn, in order, so a test can tell what lies over what.
function recorder() {
  const ops = [];
  const tiles = new Set();
  const patterns = new Set();
  class Path2D {
    rings = 0;
    moveTo() {
      this.rings++;
    }
    lineTo() {}
    closePath() {}
    arc() {}
    rect() {}
    quadraticCurveTo() {}
    bezierCurveTo() {}
    addPath() {}
  }
  class DOMMatrix {
    translate() {
      return this;
    }
    scale() {
      return this;
    }
  }
  const state = { fillStyle: '', strokeStyle: '' };
  const ctx = new Proxy(state, {
    get(t, key) {
      if (key in t) return t[key];
      if (key === 'measureText') return (s) => ({ width: String(s).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      if (key === 'createPattern')
        return (img) => {
          const p = { setTransform() {}, fog: tiles.has(img) };
          patterns.add(p);
          return p;
        };
      if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (key === 'getImageData') return () => ({ data: [] });
      return (...args) => ops.push({ op: key, fill: t.fillStyle, stroke: t.strokeStyle, args });
    },
    set(t, key, v) {
      t[key] = v;
      return true;
    },
  });
  globalThis.Path2D = Path2D;
  globalThis.DOMMatrix = DOMMatrix;
  globalThis.document = {
    createElement: () => {
      const c = { width: 0, height: 0, getContext: () => ctx };
      tiles.add(c);
      return c;
    },
  };
  return { ctx, ops };
}

test('FOG-02 the clouds are over the land and its borders, under every symbol, label, badge and pin', () => {
  const scene = street();
  const lens = LENS_BY_ID.definition;
  const { ctx, ops } = recorder();
  const g = scene.geo.get('area');
  const k = 900 / g.size;
  const [cx, cy] = g.label;
  drawMap(ctx, scene, { x: 600 - cx * k, y: 400 - cy * k, k, width: 1200, height: 800, dpr: 1 }, { lens, selectedId: 'empty', T: thresholds(1200, 800), time: 3 });
  const fog = ops.map((o, i) => (o.op === 'fill' && o.fill?.fog ? i : -1)).filter((i) => i >= 0);
  assert.ok(fog.length, 'there is cloud on screen');
  const border = ops.findLastIndex((o) => o.op === 'stroke' && o.stroke === lens.theme.border);
  assert.ok(border >= 0 && border < fog[0], 'over the borders');
  const text = ops.findIndex((o) => o.op === 'fillText');
  assert.ok(text > fog.at(-1), 'under every name, symbol and badge');
});

test('FOG-01 PLACE-02 a place in the Fog keeps its cloud over the open land between its items once they are drawn, never over them', () => {
  const scene = street();
  const lens = LENS_BY_ID.definition;
  const { ctx, ops } = recorder();
  const area = scene.tree.byId.get('area');
  assert.ok(fogOver(area) > 0, 'the area is partly in the Fog');
  const g = scene.geo.get('area');
  const k = 1400 / g.size;
  const [cx, cy] = g.label;
  drawMap(ctx, scene, { x: 600 - cx * k, y: 400 - cy * k, k, width: 1200, height: 800, dpr: 1 }, { lens, T: thresholds(1200, 800), time: 3 });
  // Cloud is drawn with a pattern (its tiles are made once, by whichever test draws first).
  const cloud = (o) => o.op === 'fill' && typeof o.fill === 'object' && o.fill?.setTransform;
  // Its open land is one outline with a hole for each of its items: the cloud lies round them, not on them.
  const holes = scene.kidsOf(area).length + 1;
  assert.ok(ops.some((o) => cloud(o) && o.args[0]?.rings === holes), 'cloud over its open land, its items cut out');
  // A place nobody has left anything undefined in has open land, but no cloud on it.
  const { ctx: c2, ops: o2 } = recorder();
  const clear = scene.geo.get('clear');
  const k2 = 1400 / clear.size;
  drawMap(c2, scene, { x: 600 - clear.label[0] * k2, y: 400 - clear.label[1] * k2, k: k2, width: 1200, height: 800, dpr: 1 }, { lens, T: thresholds(1200, 800), time: 3 });
  assert.ok(!o2.some((o) => cloud(o) && o.args[0]?.rings === scene.kidsOf(scene.tree.byId.get('clear')).length + 1), 'no cloud over a worked-out block');
});
