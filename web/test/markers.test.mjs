import { test } from 'node:test';
import { hsl, polygonContains } from 'd3';
import assert from 'node:assert/strict';
import { demoProject } from '../../api/seed.mjs';
import { buildTree } from '../src/model/tree.js';
import { LADDER, holdingsOf, housesOf, labelFor, markersOf, symbolsInUse } from '../src/map/labels.js';
import { buildScene } from '../src/map/scene.js';
import { fitScale, hitTest, markerAt, namesAt, thresholds } from '../src/map/renderer.js';
import { lotsAt } from '../src/map/lots.js';
import { claimsByNode, housesAt } from '../src/map/houses.js';
import { LENSES } from '../src/map/lenses.js';

const root = { id: 'root', parentId: null, title: 'Project', kind: 'project', status: 'planned' };
const CLEAR = { summary: 'A clear piece of work', body: 'Enough detail to say what this is and why it matters.\n\n## Acceptance\n- [ ] it works', estimate: 2 };
const item = (id, parentId, extra = {}) => ({ id, parentId, title: id, kind: parentId === 'root' ? 'epic' : 'task', status: 'ready', ...CLEAR, ...extra });
const types = (markers) => Object.fromEntries(markers.map((m) => [m.type, m.count]));

test('MARK-01 every region big enough is named at every zoom, and the selected region always is', () => {
  const scene = buildScene(demoProject().nodes, 'demo', null, 'organic');
  const W = 1200, H = 800;
  const T = thresholds(W, H);
  const k0 = fitScale(W, H, scene.world) * 0.8;
  const { cx, cy } = scene.world;
  for (let k = k0; k < k0 * 40; k *= 1.25) {
    const view = { x: W / 2 - cx * k, y: H / 2 - cy * k, k, width: W, height: H };
    const { labels } = namesAt(scene, view);
    const named = new Map();
    for (const l of labels) named.set(l.n.id, (named.get(l.n.id) ?? 0) + l.alpha);
    const size = (n) => scene.geo.get(n.id).size * k;
    for (const n of scene.tree.list) {
      if (!n.depth) continue;
      // Drawn: every ancestor is big enough that its children's land has fully faded in.
      let drawn = true;
      for (let a = n.parent; a; a = a.parent) if (size(a) < T.sub * 1.25) drawn = false;
      const [x0, y0, x1, y1] = scene.geo.get(n.id).bbox;
      const centre = [((x0 + x1) / 2) * k + view.x, ((y0 + y1) / 2) * k + view.y];
      const onScreen = centre[0] > 0 && centre[0] < W && centre[1] > 0 && centre[1] < H;
      if (drawn && onScreen && size(n) >= 62) {
        assert.ok((named.get(n.id) ?? 0) >= 0.5, `${n.title} is named at zoom ${k.toFixed(2)}`);
      }
    }
  }

  const tiny = scene.tree.list.reduce((a, b) => (scene.geo.get(b.id).size < scene.geo.get(a.id).size ? b : a));
  const view = { x: W / 2 - cx * k0, y: H / 2 - cy * k0, k: k0, width: W, height: H };
  assert.equal(namesAt(scene, view).labels.find((l) => l.n === tiny), undefined, 'too small to be named on its own');
  assert.equal(namesAt(scene, view, { selectedId: tiny.id }).labels.find((l) => l.n === tiny)?.alpha, 1, 'named once selected');
});

test('MARK-02 MARK-03 an item shows what it holds as markers, and combined markers say so', () => {
  const tree = buildTree([
    root,
    item('epic', 'root'),
    item('bug', 'epic', { kind: 'bug', status: 'in_progress' }),
    item('fixed', 'epic', { kind: 'bug', status: 'done' }),
    item('vague', 'epic', { summary: '', body: '', estimate: null }),
    item('asks', 'epic', { body: `${CLEAR.body}\n\n## Open questions\n- Which store?` }),
    item('pr', 'epic', { pulls: [7] }),
    item('code', 'root', { kind: 'area', tags: ['code'], summary: '', body: '' }),
    item('crash', 'code', { kind: 'bug', status: 'planned' }),
    item('file', 'code', { kind: 'task', tags: ['code'], summary: '', body: '', estimate: null }),
  ]);
  const of = (id) => types(markersOf(tree.byId.get(id)));
  assert.deepEqual(of('bug'), { fire: 1 }, 'an open bug is a fire');
  assert.deepEqual(of('fixed'), {}, 'a fixed bug is not');
  assert.deepEqual(of('vague'), { fog: 1 }, 'undefined work is under fog');
  assert.deepEqual(of('asks'), { question: 1 });
  assert.deepEqual(of('pr'), { pull: 1 });
  assert.deepEqual(of('file'), {}, 'land mapped from the code is not fog');
  const code = markersOf(tree.byId.get('code'));
  assert.deepEqual(code, [{ type: 'fire', count: 1, target: 'crash', on: 'code' }], 'code with a fire is code with an open bug');
  assert.equal(markersOf(tree.byId.get('epic')).find((m) => m.type === 'fire').on, undefined, 'only code carries the code mark');
  assert.deepEqual(
    symbolsInUse(tree).markers.map((m) => m.label),
    ['Open bug', 'Code with an open bug', 'Fog: behaviour nobody has defined yet'],
    'the legend explains each marker in use',
  );
});

test('MARK-04 a zoomed-out region rolls its items up into one marker per kind with a count', () => {
  const tree = buildTree([
    root,
    item('country', 'root'),
    item('epic', 'country', { kind: 'epic' }),
    item('a', 'epic', { kind: 'bug', status: 'planned', priority: 'P2' }),
    item('b', 'epic', { kind: 'bug', status: 'planned', priority: 'P0' }),
    item('c', 'country', { kind: 'bug', status: 'in_progress' }),
    item('d', 'epic', { summary: '', body: '', estimate: null }),
    item('e', 'country', { summary: '', body: '', estimate: null, kind: 'story' }),
    item('f', 'epic', { body: `${CLEAR.body}\n\n## Open questions\n- One?\n- Two?` }),
    item('g', 'country', { body: `${CLEAR.body}\n\n## Open questions\nWhat about prose?` }),
  ]);
  const country = tree.byId.get('country');
  const markers = markersOf(country);
  assert.deepEqual(types(markers), { fire: 3, fog: 2, question: 3 }, 'a country shows "3 fires, 2 fog, 3 questions"');
  assert.deepEqual(
    markers.map((m) => m.type),
    ['fire', 'fog', 'question'],
    'one cluster per kind',
  );
  assert.equal(markers[0].target, 'b', 'the fire cluster leads to the most urgent bug');
  assert.deepEqual(labelFor(country, 300).badges, markers, "the region's label carries its clusters");
  assert.deepEqual(types(labelFor(tree.byId.get('a'), 300).badges), { fire: 1 }, 'an item carries its own');
});

test('MARK-05 choosing a marker goes straight to the item it stands for', () => {
  const scene = buildScene(demoProject().nodes, 'demo', null, 'organic');
  const W = 1200, H = 800;
  const view = { x: 0, y: 0, k: fitScale(W, H, scene.world), width: W, height: H };
  const region = scene.tree.root.children[0];
  const target = region.children[0].id;
  const info = { labels: [{ id: region.id, alpha: 1, rect: { x: 100, y: 100, w: 200, h: 60 }, markers: [{ target, type: 'fire', rect: { x: 220, y: 104, w: 30, h: 16 } }] }] };
  assert.equal(markerAt(info, 230, 110), target);
  assert.equal(hitTest(scene, view, info, 230, 110), target, 'the pointer lands on the item, not the region');
  assert.equal(markerAt(info, 150, 140), null, 'beside the marker is the region itself');
  assert.equal(hitTest(scene, view, info, 150, 140), region.id);
});

test('MARK-09 how much a place holds shows as density: a busy feature is a town, a new idea is open country', () => {
  const asks = (id, parentId, extra) => item(id, parentId, { body: `${CLEAR.body}\n\n## Open questions\n- One?\n- Two?`, ...extra });
  const tree = buildTree([
    root,
    item('idea', 'root', { kind: 'feature' }),
    item('busy', 'root', { kind: 'feature', body: '**Code here** (40 files):\n\n- [a.js](https://github.com/o/r/blob/main/a.js)' }),
    asks('b1', 'busy'),
    asks('b2', 'busy'),
    item('b3', 'busy', { kind: 'bug', status: 'in_progress' }),
    item('b4', 'busy', { kind: 'behavior' }),
    item('b5', 'busy', { kind: 'behavior' }),
  ]);
  const idea = tree.byId.get('idea'), busy = tree.byId.get('busy');
  assert.deepEqual(holdingsOf(busy), { items: 6, behaviours: 2, questions: 4, files: 40, bugs: 1 }, 'counted from what the map knows, code files included');
  assert.ok(housesOf(busy) >= 5 * housesOf(idea), `a town (${housesOf(busy)} houses) against open country (${housesOf(idea)})`);
  assert.ok(housesOf(idea) > 0, 'something is there');
  const quiet = buildTree([root, item('q', 'root')]).byId.get('q');
  const asked = buildTree([root, asks('q', 'root')]).byId.get('q');
  assert.ok(housesOf(asked) > housesOf(quiet), 'open questions add to a place');
  // Zooming in shares a place's houses out among what is inside it; the town doesn't grow or shrink.
  const own = housesOf(buildTree([root, { ...item('busy', 'root', { kind: 'feature' }), body: '**Code here** (40 files):' }]).byId.get('busy'));
  assert.equal(housesOf(busy), own + busy.children.reduce((sum, c) => sum + housesOf(c), 0));
  assert.equal(housesOf(tree.root), housesOf(idea) + housesOf(busy), 'the whole map holds what its places hold');
});

test('MARK-10 zooming in adds one layer of detail at a time: there, kind, name, markers, then the items', () => {
  const tree = buildTree([root, item('epic', 'root'), item('asks', 'epic', { body: `${CLEAR.body}\n\n## Open questions\n- Why?` })]);
  const n = tree.byId.get('asks');
  const layers = (s) => {
    const l = labelFor(n, s);
    return [s >= LADDER[0].from, Boolean(l.symbol), Boolean(l.title), l.badges.length > 0];
  };
  let seen = 0;
  for (let s = 1; s <= 600; s++) {
    const shown = layers(s);
    const count = shown.filter(Boolean).length;
    assert.ok(count === seen || count === seen + 1, `one layer at a time (size ${s})`);
    assert.deepEqual(shown, shown.map((_, i) => i < count), `in order: there, kind, name, markers (size ${s})`);
    seen = count;
  }
  assert.equal(seen, 4);
});

test('MARK-13 zooming in only adds: a region keeps its pin beside its items, and each marker is counted once', () => {
  const scene = buildScene(demoProject().nodes, 'demo', null, 'organic');
  const W = 1200, H = 800;
  const k0 = fitScale(W, H, scene.world) * 0.8;
  const { cx, cy } = scene.world;
  const at = (k) => ({ x: W / 2 - cx * k, y: H / 2 - cy * k, k, width: W, height: H });
  const inside = (n, v) => {
    const [px, py] = scene.geo.get(n.id).label;
    const sx = px * v.k + v.x, sy = py * v.k + v.y;
    return sx > 0 && sx < W && sy > 0 && sy < H;
  };
  let before = new Map(), together = 0;
  for (let k = k0; k < k0 * 40; k *= 1.08) {
    const v = at(k);
    const { labels } = namesAt(scene, v);
    const now = new Map(labels.filter((l) => l.n.depth > 0).map((l) => [l.n.id, l]));
    for (const [id, l] of before) {
      if (l.alpha < 0.9 || !inside(l.n, v)) continue;
      assert.ok((now.get(id)?.alpha ?? 0) >= 0.9, `${l.n.title} stays named while it is on screen (zoom ${k.toFixed(2)})`);
    }
    for (const l of now.values()) if (l.n.children.some((c) => now.has(c.id))) together++;
    before = now;
  }
  assert.ok(together > 0, 'a region and its items are named together');

  // Beside its named items a region shows only what is its own, so a question is never counted twice.
  const asks = `${CLEAR.body}\n\n## Open questions\n- Which store?`;
  const tree = buildTree([root, item('epic', 'root', { body: asks }), item('task', 'epic', { body: asks })]);
  const epic = tree.byId.get('epic');
  assert.deepEqual(types(labelFor(epic, 200).badges), { question: 2 }, 'alone, it rolls up what it holds');
  assert.deepEqual(types(labelFor(epic, 200, undefined, true).badges), { question: 1 }, 'beside its items, only its own');
});

test('MARK-15 an item whose outline can be read is its own lot, apart from its siblings, inside its parent\'s lot', () => {
  const scene = buildScene(demoProject().nodes, 'demo', null, 'organic');
  const { tree, geo } = scene;
  const W = 1200, H = 800;
  const T = thresholds(W, H);
  const k0 = fitScale(W, H, scene.world) * 0.8;
  const { cx, cy } = scene.world;
  // Two lots touch when one's corner lies on the other's outline.
  const onEdge = ([px, py], poly, eps) => poly.some(([ax, ay], i) => {
    const [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(ax + t * dx - px, ay + t * dy - py) < eps;
  });
  const touching = new Map();
  const touch = (a, b) => touching.get(`${a.id}|${b.id}`) ?? touching.set(`${a.id}|${b.id}`, touches(geo.get(a.id), geo.get(b.id))).get(`${a.id}|${b.id}`);
  const touches = (a, b) => {
    const [x0, y0, x1, y1] = b.bbox;
    const eps = 1e-6 * Math.max(scene.world.w, scene.world.h);
    return a.poly.filter(([x, y]) => x >= x0 - eps && x <= x1 + eps && y >= y0 - eps && y <= y1 + eps && onEdge([x, y], b.poly, eps)).length >= 2;
  };
  let checked = 0;
  for (const lens of LENSES) {
    for (let k = k0; k < k0 * 40; k *= 1.6) {
      const view = { x: W / 2 - cx * k, y: H / 2 - cy * k, k, width: W, height: H };
      const { grounds, streets } = lotsAt(scene, view, { lens, T });
      const groundOf = new Map(grounds.map((l) => [l.n.id, l.ground]));
      const street = new Map(streets.map((s) => [s.of.id, s]));
      for (const { n, s } of grounds) {
        if (n.depth < 1 || !n.children.length || s < T.sub * 1.25) continue;
        // Its items' outlines can be read: each one on screen is a lot of its own, edged and set back by a street.
        const lots = street.get(n.id)?.lots ?? [];
        const onScreen = n.children.filter((c) => groundOf.has(c.id));
        if (!onScreen.length) continue;
        assert.deepEqual(lots.map((l) => l.n.id).sort(), onScreen.map((c) => c.id).sort(), `${lens.id}: ${n.title}'s items are lots at zoom ${k.toFixed(2)}`);
        assert.ok(street.get(n.id).width > 0 && lots.every((l) => l.edge && l.edge !== l.ground), `${lens.id}: ${n.title}'s lots have edges and streets`);
        // Neighbouring lots never share a ground, whatever colour the lens gives them.
        for (const a of lots) for (const b of lots) {
          if (a.n.id < b.n.id && touch(a.n, b.n)) {
            assert.notEqual(a.ground, b.ground, `${lens.id}: ${a.n.title} and ${b.n.title} touch, so they look apart`);
            checked++;
          }
        }
        // A parent's lot holds its children's lots: streets inside streets, the outer ones wider.
        for (const l of lots) if (street.has(l.n.id)) assert.ok(street.get(l.n.id).width <= street.get(n.id).width, `${l.n.title}'s streets are no wider than ${n.title}'s`);
      }
      // Until a place is big enough for its items' outlines to be read, they aren't drawn as lots (MARK-10).
      for (const { n, s } of grounds) if (s < T.sub * 0.8) assert.ok(!street.has(n.id), `${n.title} is still one place at zoom ${k.toFixed(2)}`);
    }
  }
  assert.ok(checked > 50, `neighbouring lots were compared (${checked})`);
  // A lot's ground is the lens's colour for it, only lighter or darker: the lens still says what the land means.
  const lens = LENSES.find((l) => l.id === 'health');
  const k = k0 * 20;
  const { grounds } = lotsAt(scene, { x: W / 2 - cx * k, y: H / 2 - cy * k, k, width: W, height: H }, { lens, T });
  for (const { n, ground } of grounds) {
    const [a, b] = [hsl(ground), hsl(lens.fill(n, tree))];
    if (b.s > 0.1) assert.ok(Math.abs(a.h - b.h) < 3, `${n.title} keeps the lens's colour`);
  }
});

// A neighbourhood: a street of houses, a big issue with only two houses so far (a park), and code land.
const behaviours = (prefix, count) => `${CLEAR.body}\n\n## Behaviours\n\n${Array.from({ length: count }, (_, i) => `- ${prefix}-${String(i + 1).padStart(2, '0')} Given this, when that, then the other.`).join('\n')}`;
const neighbourhood = ({ big = 0, parkKids = 2, busy = 0 } = {}) => [
  root,
  item('street', 'root', { kind: 'feature' }),
  ...['a', 'b', 'c', 'd'].map((id) => item(id, 'street', id === 'b' && big ? { body: behaviours('BIG', big) } : {})),
  item('code', 'street', { kind: 'task', tags: ['code'] }),
  item('park', 'root', { kind: 'feature', body: behaviours('PARK', busy || 20) }),
  ...Array.from({ length: parkKids }, (_, i) => item(`p${i}`, 'park')),
  item('plain', 'root', { kind: 'feature' }),
  ...Array.from({ length: 2 }, (_, i) => item(`q${i}`, 'plain')),
];
const viewOn = (scene, id, k) => {
  const [x0, y0, x1, y1] = scene.geo.get(id).bbox;
  return { x: 600 - ((x0 + x1) / 2) * k, y: 400 - ((y0 + y1) / 2) * k, k, width: 1200, height: 800 };
};
const housesIn = (scene, view, live) => housesAt(lotsAt(scene, view, { lens: LENSES[0], T: thresholds(1200, 800) }).grounds, { k: view.k, live });
const inside = (poly, pts) => pts.every((p) => polygonContains(poly, p));

test('MARK-16 zoomed in, an issue that is work is a house: a footprint on its own lot, facing its neighbours, growing with what it holds', () => {
  const scene = buildScene(neighbourhood(), 'houses', null, 'organic');
  const near = viewOn(scene, 'street', 1200 / scene.geo.get('street').size);
  const houses = housesIn(scene, near);
  const ids = houses.map((h) => h.n.id).sort();
  assert.deepEqual(ids.filter((id) => 'abcd'.includes(id)), ['a', 'b', 'c', 'd'], 'every task on the street is a house');
  assert.ok(!ids.includes('street') && !ids.includes('code'), 'a parent is a block, not a house; code land is not work');
  for (const h of houses.filter((x) => 'abcd'.includes(x.n.id))) {
    assert.ok(inside(h.g.poly, h.corners), `${h.n.id}'s house stands on its own lot`);
    assert.ok(h.area < 0.6 * h.g.area, `${h.n.id}'s house doesn't fill its lot`);
    const [[x0, y0], , [x1, y1]] = h.corners;
    assert.ok(x1 - x0 > y1 - y0, `${h.n.id} faces the street like its neighbours`);
  }
  // Zoomed out, the houses aren't there yet: their lots are too small to hold one that can be read.
  const far = { x: 600 - scene.world.cx * 0.05, y: 400 - scene.world.cy * 0.05, k: 0.05, width: 1200, height: 800 };
  assert.equal(housesIn(scene, far).length, 0);
  // The same lot with more to hold has a bigger house.
  const bigger = buildScene(neighbourhood({ big: 12 }), 'houses', null, 'organic');
  const area = (s, id) => housesIn(s, viewOn(s, 'street', near.k)).find((h) => h.n.id === id).area;
  assert.ok(area(bigger, 'b') > 1.3 * area(scene, 'b'), 'twelve behaviours make a bigger house');
});

test('MARK-17 a house being coded has a bulldozer on its lot, and the bulldozer leaves when the claim ends', () => {
  const scene = buildScene(neighbourhood(), 'houses', null, 'organic');
  const now = Date.parse('2026-11-16T12:00:00Z');
  const claim = (item, owner, until) => ({ behaviour: `X-${owner}`, item, owner, until });
  const claims = [claim('node-a', 'ag1', '2026-11-16T14:00:00Z'), claim('node-a', 'ag1', '2026-11-16T14:00:00Z'), claim('node-c', 'ag2', '2026-11-16T11:00:00Z')];
  const agents = claimsByNode(claims, scene.tree, now);
  assert.deepEqual([...agents], [['a', 1]], "one agent at work on a; c's claim has ended");
  const view = viewOn(scene, 'street', 1200 / scene.geo.get('street').size);
  const houses = housesIn(scene, view, { agents });
  const a = houses.find((h) => h.n.id === 'a');
  assert.ok(a.bulldozer && polygonContains(a.g.poly, a.bulldozer), 'the bulldozer is on its lot');
  assert.ok(!polygonContains(a.corners, a.bulldozer), 'beside the house, not on it');
  assert.deepEqual(houses.filter((h) => h.bulldozer).map((h) => h.n.id), ['a'], 'no other house is being coded');
  const later = claimsByNode(claims, scene.tree, Date.parse('2026-11-16T15:00:00Z'));
  assert.equal(housesIn(scene, view, { agents: later }).filter((h) => h.bulldozer).length, 0, 'gone when the claim ends');
});

test('MARK-18 a big issue with only a few houses is a park: open green land beside them, filling with houses as children are added', () => {
  const T = thresholds(1200, 800);
  const parkOf = (scene, lens = LENSES[0]) => lotsAt(scene, viewOn(scene, 'park', 1000 / scene.geo.get('park').size), { lens, T }).parks.find((p) => p.of.id === 'park');
  const scene = buildScene(neighbourhood(), 'houses', null, 'organic');
  const park = parkOf(scene);
  assert.ok(park, 'twenty behaviours and two houses: mostly open land');
  assert.ok(park.g.area > 0.5 * scene.geo.get('park').area, 'the green is most of the lot');
  assert.ok(scene.geo.get('park').area > 2 * scene.geo.get('plain').area, "the lot's size shows how big the issue is");
  // Park green in every lens, whatever colour the lens gives the land.
  const greens = new Set(LENSES.filter((l) => !l.theme.dark).map((l) => parkOf(scene, l).ground));
  assert.equal(greens.size, 1);
  assert.ok(hsl([...greens][0]).h > 90 && hsl([...greens][0]).h < 150, 'green');
  // As children are added, houses fill the green.
  const filling = buildScene(neighbourhood({ parkKids: 10 }), 'houses', null, 'organic');
  const share = (s) => (parkOf(s)?.g.area ?? 0) / s.geo.get('park').area;
  assert.ok(share(filling) < share(scene), `ten houses leave less green (${share(filling).toFixed(2)}) than two (${share(scene).toFixed(2)})`);
  assert.equal(parkOf(buildScene(neighbourhood({ parkKids: 20 }), 'houses', null, 'organic')), undefined, 'built out: no park left');
  assert.equal(parkOf(buildScene(neighbourhood({ busy: 2 }), 'houses', null, 'organic')), undefined, 'a small issue with its houses has no park');
});
