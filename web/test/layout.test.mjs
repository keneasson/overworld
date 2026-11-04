import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polygonArea, polygonCentroid, polygonContains } from 'd3';
import { demoProject } from '../../api/seed.mjs';
import { buildTree } from '../src/model/tree.js';
import { computeLayout } from '../src/map/layout.js';
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

test('the site projection is shaped like the product', () => {
  const tree = demo();
  const out = computeLayout(tree, 'demo', { projection: 'site' });
  const [nav, catalog, cart, accounts, footer] = ['Navigation & Wayfinding', 'Catalog & Search', 'Cart & Checkout', 'Accounts & Identity', 'Footer & help'].map(
    (t) => centroid(out, find(tree, t)),
  );
  assert.ok(nav[1] < catalog[1], 'navigation is above the catalog');
  assert.ok(footer[1] > nav[1] && footer[1] > catalog[1] - 20, 'the footer is at the bottom');
  assert.ok(cart[0] > catalog[0], 'the cart is right of the catalog');
  assert.ok(accounts[0] > nav[0] && accounts[1] < cart[1], 'accounts sit top right');

  const mobile = box(out, find(tree, 'Mobile app'));
  const api = box(out, find(tree, 'Storefront API'));
  assert.ok(mobile.h > mobile.w * 1.4, 'the mobile app is a tall phone');
  assert.ok(api.w > api.h * 2.5, 'the API is a thin strip');
  const y = (t) => centroid(out, find(tree, t))[1];
  assert.ok(y('Navigation & Wayfinding') < y('Storefront API') && y('Storefront API') < y('Order service'), 'clients, then API, then services');
  assert.ok(y('Orders REST handlers') < y('Orders database schema'), 'in a service, endpoints sit above storage');

  const land = out.land.map((r) => Math.abs(polygonArea(r)));
  assert.equal(land.length, 7, 'on screen, mobile, API, order service, back office and two third parties');
  assert.ok(out.notes.some((n) => n.text === 'Behind the screen'));
});

test('every region is inside its parent and sized by its work', () => {
  const tree = demo();
  const out = computeLayout(tree, 'demo', { projection: 'site' });
  for (const n of tree.list) {
    const g = out.geo.get(n.id);
    assert.ok(g && g.area > 0, `${n.title} has land`);
    if (n.parent?.parent) assert.ok(polygonContains(out.geo.get(n.parent.id).poly, polygonCentroid(g.poly)), `${n.title} is inside ${n.parent.title}`);
    if (n.children.length > 1) {
      const w = n.children.map((k) => Math.pow(Math.max(k.stats.raw, 0.1), 0.8));
      const a = n.children.map((k) => out.geo.get(k.id).area);
      const sw = w.reduce((s, v) => s + v, 0), sa = a.reduce((s, v) => s + v, 0);
      for (let i = 0; i < w.length; i++) assert.ok(Math.abs(w[i] / sw - a[i] / sa) < 0.04, `${n.children[i].title} area matches its share`);
    }
  }
});

test('the same project always gets the same map', () => {
  const { nodes } = demoProject();
  const fingerprint = (out) => [...out.geo.values()].map((g) => `${g.poly.length}:${g.poly[0].map((v) => v.toFixed(6))}:${g.area.toFixed(4)}`).join('|');
  const a = computeLayout(buildTree(nodes), 'demo', { projection: 'site' });
  const b = computeLayout(buildTree(nodes), 'demo', { projection: 'site' });
  assert.ok(fingerprint(a) === fingerprint(b));
});

test('projects without placements still get a screen and a back office', () => {
  const nodes = demoProject().nodes.map(({ place, surface, ...n }) => n);
  const tree = buildTree(nodes);
  const site = resolveSite(tree);
  assert.equal(site.continents.get(find(tree, 'Design System').id).surface, 'backoffice');
  assert.equal(site.continents.get(find(tree, 'Navigation & Wayfinding').id).surface, 'web');
  assert.equal(site.places.get(find(tree, 'Navigation & Wayfinding').id), 'top');
  const out = computeLayout(tree, 'demo', { projection: 'site', site });
  assert.ok(centroid(out, find(tree, 'Platform & Performance'))[1] > centroid(out, find(tree, 'Catalog & Search'))[1]);
});

test('the organic projection is one island', () => {
  const out = computeLayout(demo(), 'demo', { projection: 'organic' });
  assert.equal(out.land.length, 1);
  assert.ok(out.world.w > 800 && out.world.h > 800);
});
