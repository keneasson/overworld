import { test } from 'node:test';
import { hsl, polygonContains } from 'd3';
import assert from 'node:assert/strict';
import { demoProject } from '../../api/seed.mjs';
import { buildTree } from '../src/model/tree.js';
import { LADDER, holdingsOf, housesOf, labelFor, markersOf, symbolsInUse } from '../src/map/labels.js';
import { buildScene } from '../src/map/scene.js';
import { fitScale, hitTest, overviewView, markerAt, nameFromOf, namesAt, namesOnScreen, placeInView, thresholds } from '../src/map/renderer.js';
import { pathOf } from '../src/model/tree.js';
import { rectsOverlap } from '../src/map/geometry.js';
import { placeNames } from '../src/map/names.js';
import { lotsAt } from '../src/map/lots.js';
import { HOUSE, claimsByNode, housesAt, isHouse } from '../src/map/houses.js';
import { LENSES } from '../src/map/lenses.js';

const root = { id: 'root', parentId: null, title: 'Project', kind: 'project', status: 'planned' };
const CLEAR = { summary: 'A clear piece of work', body: 'Enough detail to say what this is and why it matters.\n\n## Acceptance\n- [ ] it works', estimate: 2 };
const item = (id, parentId, extra = {}) => ({ id, parentId, title: id, kind: parentId === 'root' ? 'epic' : 'task', status: 'ready', ...CLEAR, ...extra });
const types = (markers) => Object.fromEntries(markers.map((m) => [m.type, m.count]));

test('MARK-01 every region big enough is named at every zoom, until its items\' items are, and the selected region always is', () => {
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
    assert.ok(labels.some((l) => l.named && l.alpha > 0.5), `something is named at zoom ${k.toFixed(2)}`);
    const size = (n) => scene.geo.get(n.id).size * k;
    for (const n of scene.tree.list) {
      // Which kinds are named at which zoom, and when a region hands its name over, is MARK-13's.
      if (!n.depth || n.children.some((c) => c.children.some((gc) => size(gc) >= 36))) continue;
      // Drawn: every ancestor is big enough that its children's land has fully faded in.
      let drawn = true;
      for (let a = n.parent; a; a = a.parent) if (size(a) < T.sub * 1.25) drawn = false;
      const [x0, y0, x1, y1] = scene.geo.get(n.id).bbox;
      const centre = [((x0 + x1) / 2) * k + view.x, ((y0 + y1) / 2) * k + view.y];
      const onScreen = centre[0] > 0 && centre[0] < W && centre[1] > 0 && centre[1] < H;
      if (drawn && onScreen && size(n) >= Math.max(62, nameFromOf(n) + 12)) {
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

// Text measured as if every letter were 6.5px wide: enough to know where names would collide.
const measuring = { font: '', measureText: (t) => ({ width: String(t).length * 6.5 }) };
const namesOn = (scene, view, opts = {}) => namesOnScreen(measuring, scene, view, { theme: LENSES[0].theme, ...opts });
// A town of districts of streets of houses, four levels below the project: one long street, and one house has an open question.
const town = () => [
  root,
  item('town', 'root', { kind: 'area' }),
  item('elsewhere', 'root', { kind: 'area' }),
  ...['north', 'south', 'east'].map((d) => item(d, 'town', { kind: 'epic' })),
  ...['high', 'mill', 'church'].map((st) => item(st, 'north', { kind: 'feature' })),
  ...['high', 'mill', 'church'].flatMap((st) => Array.from({ length: st === 'church' ? 30 : 6 }, (_, i) => item(`${st}${i}`, st, { title: `${st} street ${i + 1}`, ...(st === 'mill' && i === 2 ? { body: `${CLEAR.body}\n\n## Open questions\n- Which door?` } : {}) }))),
  ...['south', 'east', 'elsewhere'].flatMap((p) => Array.from({ length: 3 }, (_, i) => item(`${p}${i}`, p))),
];
const W13 = 1200, H13 = 800;
const looking = (scene, [cx, cy], k) => ({ x: W13 / 2 - cx * k, y: H13 / 2 - cy * k, k, width: W13, height: H13 });
// Zooming in from the whole map to a place, in steps of 2%.
const zoomInTo = (scene, [px, py], from, to) => {
  const steps = [];
  for (let k = from; k < to; k *= 1.02) {
    const t = Math.min(1, Math.log(k / from) / Math.log(to / from));
    steps.push(looking(scene, [scene.world.cx + (px - scene.world.cx) * t, scene.world.cy + (py - scene.world.cy) * t], k));
  }
  return steps;
};

test('MARK-13 each kind of place is named over its own zoom range; where names collide the more important stays, never overlapping, never popping', () => {
  const demo = buildScene(demoProject().nodes, 'demo', null, 'organic');
  const streets = buildScene(town(), 'town', null, 'organic');
  const high = streets.geo.get('high');
  const kStreet = 1100 / high.size;
  const k0 = (s) => fitScale(W13, H13, s.world) * 0.8;
  const runs = [
    [demo, zoomInTo(demo, [demo.world.cx, demo.world.cy], k0(demo), k0(demo) * 40)],
    [streets, zoomInTo(streets, high.label, k0(streets) / 20, kStreet * 1.3)],
  ];
  const firstNamed = new Map();
  let together = 0, crowded = 0;
  for (const [scene, views] of runs) {
    let before = new Map();
    for (const v of views) {
      const names = namesOn(scene, v);
      const at = `zoom ${v.k.toFixed(2)} on ${scene.tree.root.title}`;
      for (const l of names) {
        // Houses only on a street: a house is named once its house is drawn (MARK-16), not before.
        if (isHouse(l.n)) assert.ok(l.s >= HOUSE.from, `${l.n.title} isn't named before its house is drawn (${at})`);
        const kind = isHouse(l.n) ? 'house' : l.n.kind;
        if (scene === streets && l.named && l.alpha > 0.5 && !firstNamed.has(kind)) firstNamed.set(kind, v.k);
      }
      // Never overlapping: where two names would, one has made room for the other.
      for (const a of names) for (const b of names) {
        if (a === b || !rectsOverlap(a.rect, b.rect)) continue;
        assert.ok(a.alpha + b.alpha <= 1.001, `${a.n.title} and ${b.n.title} don't both show where they overlap (${at})`);
        if (a.shown > 0.99 && b.shown > 0.99) crowded++;
      }
      // Never popping: no name comes or goes all at once between two close zooms.
      const now = new Map(names.map((l) => [l.n.id, l]));
      for (const id of new Set([...before.keys(), ...now.keys()])) {
        const was = before.get(id), is = now.get(id);
        const [px, py] = (is ?? was).g.label;
        const there = px * v.k + v.x > 0 && px * v.k + v.x < W13 && py * v.k + v.y > 0 && py * v.k + v.y < H13;
        if (!there || !before.size) continue;
        assert.ok(Math.abs((is?.alpha ?? 0) - (was?.alpha ?? 0)) < 0.5, `${(is ?? was).n.title} fades rather than pops (${at})`);
      }
      for (const l of names) if (l.named && l.alpha > 0.5 && l.n.children.some((c) => now.get(c.id)?.named && now.get(c.id).alpha > 0.5)) together++;
      before = now;
    }
  }
  const overview = { ...overviewView(demo, W13, H13), width: W13, height: H13 };
  assert.ok((namesOn(demo, overview).find((l) => l.n.depth === 0)?.alpha ?? 0) > 0.95, "at the overview, the project's card is named");
  assert.ok(together > 0, 'a region is still named beside its named items');
  assert.ok(crowded > 0, 'names do collide on the way in, and make room');
  const order = ['area', 'epic', 'feature', 'house'].map((kind) => firstNamed.get(kind));
  assert.ok(order.every((k, i) => k && (!i || k > order[i - 1])), `areas are named first, then epics, then features, then houses (${order.map((k) => k?.toFixed(2))})`);

  // Where two names collide the more important stays: the selected item, then one with something going on, then the bigger.
  const two = buildTree([root, item('big', 'root'), item('small', 'root')]);
  const big = two.byId.get('big'), small = two.byId.get('small');
  const name = (n, size, extra = {}) => ({ n, g: { size }, s: size, alpha: 1, named: true, rect: { x: 0, y: 0, w: 100, h: 40 }, ...extra });
  const stays = (cands, opts) => placeNames(cands, opts).map((l) => l.n.id);
  assert.deepEqual(stays([name(small, 80), name(big, 200)]), ['big'], 'the bigger stays');
  assert.deepEqual(stays([name(small, 80, { urgent: true }), name(big, 200)]), ['small'], 'something going on outranks size');
  assert.deepEqual(stays([name(small, 80), name(big, 200, { urgent: true })], { selected: small }), ['small'], 'the selected item outranks all');
  const fading = placeNames([name(small, 80), name(big, 200, { alpha: 0.3 })]);
  assert.ok(fading.find((l) => l.n === small).alpha >= 0.69, 'it gives way only as far as the other shows');

  // Zoomed in on a street: its houses are named, the outer areas aren't.
  const street = namesOn(streets, looking(streets, high.label, kStreet));
  const shows = (id) => street.find((l) => l.n.id === id)?.alpha ?? 0;
  assert.ok(street.filter((l) => l.n.parent?.id === 'high' && l.named && l.alpha > 0.5).length >= 3, 'the houses are named');
  assert.equal(shows('town'), 0, 'the town is not');
  assert.equal(shows('north'), 0, 'nor its district, whose streets\' houses are named');
  // Beside its named items a region shows only what is its own, so a question is never counted twice.
  const asks = `${CLEAR.body}\n\n## Open questions\n- Which store?`;
  const tree = buildTree([root, item('epic', 'root', { body: asks }), item('task', 'epic', { body: asks })]);
  const epic = tree.byId.get('epic');
  assert.deepEqual(types(labelFor(epic, 200).badges), { question: 2 }, 'alone, it rolls up what it holds');
  assert.deepEqual(types(labelFor(epic, 200, undefined, true).badges), { question: 1 }, 'beside its items, only its own');
});

test('MARK-19 the place in view is named in the header, with the way to it, even where its name has faded from the map', () => {
  const streets = buildScene(town(), 'town', null, 'organic');
  const high = streets.geo.get('high');
  const view = looking(streets, high.label, 1100 / high.size);
  const here = placeInView(streets, view);
  assert.equal(here?.id, 'high', 'among its houses, the street is the place in view');
  assert.deepEqual(pathOf(here).map((n) => n.id), ['root', 'town', 'north', 'high'], 'the header names the way to it');
  assert.equal(namesOn(streets, view).find((l) => l.n.id === 'town'), undefined, 'though the town is no longer named on the map');
  const out = placeInView(streets, looking(streets, [streets.world.cx, streets.world.cy], fitScale(W13, H13, streets.world) * 0.8));
  assert.equal((out ?? streets.tree.root).id, 'root', 'zoomed out, the whole project');
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
  ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => item(id, 'street', id === 'b' && big ? { body: behaviours('BIG', big) } : {})),
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

test('MARK-16 zoomed in, an issue that is work is a house: a footprint on its own lot, in rows along a street, growing with what it holds', () => {
  const scene = buildScene(neighbourhood(), 'houses', null, 'organic');
  const near = viewOn(scene, 'street', 1200 / scene.geo.get('street').size);
  const houses = housesIn(scene, near);
  const ids = houses.map((h) => h.n.id).sort();
  assert.deepEqual(ids.filter((id) => 'abcdefgh'.includes(id)), [...'abcdefgh'], 'every task on the street is a house');
  assert.ok(!ids.includes('street') && !ids.includes('code'), 'a parent is a block, not a house; code land is not work');
  // In rows along a street: the houses stand on a few lines across the block, several to a line, not scattered.
  const street = houses.filter((x) => 'abcdefgh'.includes(x.n.id));
  const [bx0, by0, bx1, by1] = scene.geo.get('street').bbox;
  const wide = bx1 - bx0 >= by1 - by0;
  const across = (h) => (wide ? h.g.label[1] : h.g.label[0]);
  const rows = [];
  for (const h of [...street].sort((a, b) => across(a) - across(b))) {
    const row = rows.at(-1);
    if (row && across(h) - across(row[0]) < 0.08 * (wide ? by1 - by0 : bx1 - bx0)) row.push(h);
    else rows.push([h]);
  }
  assert.ok(rows.length >= 2 && rows.length <= 4 && rows.every((r) => r.length >= 2), `${street.length} houses in ${rows.length} rows of ${rows.map((r) => r.length).join(', ')}`);
  for (const h of street) {
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
