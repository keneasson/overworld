import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polygonArea, polygonCentroid, polygonContains } from 'd3';
import { demoProject } from '../../api/seed.mjs';
import { buildTree } from '../src/model/tree.js';
import { computeLayout } from '../src/map/layout.js';
import { PLACE_KINDS, placeKindOf } from '../src/map/size.js';
import { guessPlace, guessSurface, resolveSite } from '../src/map/places.js';
import { bounds } from '../src/map/geometry.js';

const demo = () => buildTree(demoProject().nodes);
const find = (tree, title) => tree.list.find((n) => n.title === title);
const centroid = (out, n) => polygonCentroid(out.geo.get(n.id).poly);
const box = (out, n) => {
  const [x0, y0, x1, y1] = bounds(out.geo.get(n.id).poly);
  return { w: x1 - x0, h: y1 - y0 };
};

test('guesses where things sit from their names', () => {
  assert.equal(guessPlace({ title: 'Site footer' }), 'bottom');
  assert.equal(guessPlace({ title: 'Header & buttons' }), 'top');
  assert.equal(guessPlace({ title: 'Filters & facets' }), 'left');
  assert.equal(guessPlace({ title: 'Account menu' }), 'top-right');
  assert.equal(guessPlace({ title: 'Mini-cart' }), 'right');
  assert.equal(guessPlace({ title: 'Search endpoint v2' }), 'offscreen');
  assert.equal(guessPlace({ title: 'Checkout', tags: ['page'] }), 'center');
  assert.equal(guessPlace({ title: 'Orders database schema' }, 'back'), 'bottom');
  assert.equal(guessPlace({ title: 'Orders REST handlers' }, 'back'), 'top');
  assert.equal(guessSurface({ title: 'iOS app' }), 'mobile');
  assert.equal(guessSurface({ title: 'Storefront API' }), 'api');
  assert.equal(guessSurface({ title: 'Inventory service' }), 'service');
  assert.equal(guessSurface({ title: 'Stripe integration' }), 'external');
  assert.equal(guessSurface({ title: 'Catalog & Search' }), 'none');
});

const overlaps = (a, b) => a.some((p) => polygonContains(b, p)) || b.some((p) => polygonContains(a, p));

test('PLACE-03 every place is inside its parent, with open ground between its items, never splitting it edge to edge', () => {
  const tree = demo();
  const out = computeLayout(tree, 'demo');
  for (const n of tree.list) {
    const g = out.geo.get(n.id);
    assert.ok(g && g.area > 0, `${n.title} has land`);
    if (n.parent) assert.ok(polygonContains(out.geo.get(n.parent.id).poly, polygonCentroid(g.poly)), `${n.title} is inside ${n.parent.title}`);
    if (n.children.length > 1) {
      for (let i = 0; i < n.children.length; i++)
        for (let j = i + 1; j < n.children.length; j++) {
          const [a, b] = [n.children[i], n.children[j]];
          assert.ok(!overlaps(out.geo.get(a.id).poly, out.geo.get(b.id).poly), `${a.title} and ${b.title} stand apart`);
        }
      const filled = n.children.reduce((sum, c) => sum + out.geo.get(c.id).area, 0);
      assert.ok(filled < g.area * 0.85, `${n.title} has open ground between its items`);
    }
  }
});

test('PLACE-01 a place\'s kind comes from what it holds, not from how deep it is', () => {
  assert.equal(placeKindOf(1, 0), 'house');
  assert.equal(placeKindOf(30, 1), 'neighbourhood', 'one level deep is a neighbourhood at most, however many houses');
  assert.equal(placeKindOf(30, 3), 'district');
  assert.equal(placeKindOf(500, 4), 'province');
  // At the same depth, an item that holds far more is a bigger kind of place.
  const tree = demo();
  const out = computeLayout(tree, 'demo');
  const rank = (n) => PLACE_KINDS.findIndex((p) => p.kind === out.geo.get(n.id).kind);
  const pairs = tree.list.filter((n) => n.depth === 1).sort((a, b) => out.geo.get(a.id).area - out.geo.get(b.id).area);
  assert.ok(rank(pairs.at(-1)) > rank(pairs[0]), `${pairs.at(-1).title} is a bigger kind of place than ${pairs[0].title}`);
});

test('PLACE-15 the same project always gets the same map, and adding an item leaves its neighbours where they stood', () => {
  const { nodes } = demoProject();
  const fingerprint = (out) => [...out.geo.values()].map((g) => `${g.poly.length}:${g.poly[0].map((v) => v.toFixed(6))}:${g.area.toFixed(4)}`).join('|');
  assert.ok(fingerprint(computeLayout(buildTree(nodes), 'demo')) === fingerprint(computeLayout(buildTree(nodes), 'demo')));
  // A new item in an area takes open ground beside the others: they keep their places relative to each other.
  const tree = buildTree(nodes);
  const area = tree.list.filter((n) => n.depth === 1).sort((a, b) => b.children.length - a.children.length)[0];
  const added = buildTree([...nodes, { id: 'brand-new', parentId: area.id, title: 'A brand new idea', kind: 'feature', status: 'idea', createdAt: '2099-01-01' }]);
  const [before, after] = [computeLayout(tree, 'demo'), computeLayout(added, 'demo')];
  const first = area.children[0].id;
  const rel = (out, id) => {
    const [a, b] = [out.geo.get(id).label, out.geo.get(first).label];
    return [a[0] - b[0], a[1] - b[1]];
  };
  for (const c of area.children.slice(1)) {
    const [p, q] = [rel(before, c.id), rel(after, c.id)];
    assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6, `${c.title} stays where it stood beside ${area.children[0].title}`);
  }
});
