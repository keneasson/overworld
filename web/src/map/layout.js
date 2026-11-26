// The map: every item is a place, and its places hold what it holds (#104).
//
// A place's size comes from what it holds (size.js): a house is one behaviour, and a place is itself plus everything in
// it. Its items stand inside it as places of their own, with open ground between them, never splitting it edge to edge
// like a treemap (PLACE-03). The more a place promises beyond what is written in it, the more open land it holds: wide
// country round its edges, the room it grows into (PLACE-02, PLACE-10). The project itself is one land, its coast the sea's.
//
// It is deterministic and steady (PLACE-15): no random seed, no memory of an earlier layout, and items stand in a fixed
// order (behaviours by ID, issues by number), each placed beside those before it, so a new item takes open ground at the
// edge and the rest stay where they stood; a place that grows spreads where it stands (PLACE-09).
//
// Returns geometry for every place ({ poly, bbox, area, size, label, labelR, kind }), houses included, the land outlines
// and the world bounds.

import { packEnclose, packSiblings, polygonArea, polygonContains, polygonHull } from 'd3';
import polylabel from 'polylabel';
import { bounds, ensureOrientation, hashString } from './geometry.js';
import { behaviourHouses, lotsOf } from './houses.js';
import { placeSizes } from './size.js';

export const PROJECTIONS = [{ id: 'site', name: 'Places', blurb: 'Every item is a place sized by what it holds, with open land where there is more to define.' }];

/** The geometry key of an issue's open land. Open land is now the ground between a place's items; nothing is stored under it. */
export const parkId = (n) => `${n.id}:park`;

// A house's radius in world units; every other size follows from it.
const UNIT = 10;
// The ground between neighbours, as a share of the smaller one's radius, and at least this much of a house.
const GAP = 0.12, STREET = 0.15 * UNIT;
// How many points an outline has, and how much it wanders.
const STEPS = 72, WANDER = 0.12;

export function computeLayout(tree, projectId, { houses = behaviourHouses(tree) } = {}) {
  const sizes = placeSizes(tree, houses);
  const order = orderOf(houses);
  const geo = new Map();
  const root = tree.root;
  // The project is one land like any other place: its largest parts are its countries, with open country between them.
  place(geo, root, measure(root, sizes, houses, order), 0, 0, sizes);
  const g = geo.get(root.id);
  g.rings = [g.poly];
  const land = [g.poly];
  const [x0, y0, x1, y1] = g.bbox;
  return { geo, land, notes: [], projection: 'site', world: { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 } };
}

// ---------- order: where each item stands among its neighbours ----------

const BEHAVIOUR_ID = /^([A-Z][A-Z0-9]*)-(\d+)\b/;
const ISSUE = /^#(\d+)\b/;
/**
 * Items in the order they are placed: behaviours by ID, then issues by number, then everything else by when it was made.
 * Each item is placed beside those before it, so new ones (higher IDs and numbers) take ground at the edge.
 */
function orderOf() {
  const keyOf = (c) => {
    // A child issue stands where the first behaviour it holds stood, so a behaviour that grows into an issue keeps its spot (PLACE-09).
    const b = (c.behaviour ?? c.behaviourRows?.[0]?.id ?? '').match(BEHAVIOUR_ID) ?? String(c.title ?? '').match(BEHAVIOUR_ID);
    if (b) return [0, b[1], Number(b[2])];
    const i = String(c.title ?? '').match(ISSUE);
    if (i) return [1, '', Number(i[1])];
    return [2, `${c.createdAt ?? ''}|${c.title ?? ''}`, c.id];
  };
  const cmp = (a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
  return (lots) => lots.map((c) => ({ c, k: keyOf(c) })).sort((a, b) => cmp(a.k, b.k)).map((x) => x.c);
}

// ---------- measure: each place's radius and where its items stand in it, from the leaves up ----------

/**
 * A place's shape before it is put anywhere: its radius `r`, and its items' shapes at offsets from its centre. A house
 * fills a lot of its own size; a place's items are packed beside each other in order, and the place is as wide as they
 * need plus the open land it promises beyond them.
 */
function measure(n, sizes, houses, order) {
  const s = sizes.get(n.id);
  const lots = order(lotsOf(n, houses).lots);
  // A house's lot is a little smaller than a unit of scope, so a block's houses and the street between them fill it once
  // as many behaviours are written as it promises.
  const own = UNIT * Math.sqrt(Math.max(s.expected, 1)) * (n.issue ? 0.72 : 0.8);
  if (!lots.length) return { n, r: own * (n.issue ? 1.05 : 0.92 * (1 + WANDER * 2.35)), room: own, kids: [] };
  const shapes = lots.map((c) => measure(c, sizes, houses, order));
  const spots = lotsOf(n, houses).block ? street(shapes) : packed(shapes);
  const kids = shapes.map((m, i) => ({ ...m, x: spots.at[i][0], y: spots.at[i][1] }));
  const name = spots.name ? { at: spots.name, r: spots.nameR, band: spots.band } : null;
  // A place is never smaller than its scope, however few of its items are written yet: what it promises beyond them is open
  // land round them (PLACE-10). A place of places is roomier than a block, with ground between its parts (PLACE-03).
  const room = own;
  // Its edge stands a little way out from its items, wider round a bigger place.
  const margin = Math.max(STREET * 0.6, spots.r * 0.04);
  // Room for its edge to wander out as far as it goes (WAVES) without flattening against its circle.
  const r = Math.max(room * 0.92 * (1 + WANDER * 2.35), spots.r + margin);
  return { n, r, room, kids, name, margin };
}

/** Items of any size packed beside each other in order, each placed against those before it. */
function packed(shapes) {
  const circles = shapes.map((m) => ({ r: m.r + Math.max(STREET, m.r * GAP) }));
  packSiblings(circles);
  const e = packEnclose(circles);
  return { at: circles.map((c) => [c.x - e.x, c.y - e.y]), r: e.r };
}

/**
 * A block's lots along a street that winds through it, row by row, each row running back the way the last one came, so
 * every lot stands beside the next in order (PLACE-13). A child issue among the houses is a wider lot in the same row, so a
 * behaviour that grows into an issue stays where its house stood (PLACE-09).
 */
function street(shapes) {
  const ds = shapes.map((m) => 2 * (m.r + Math.max(STREET * 0.6, m.r * GAP * 0.6)));
  // As wide as its count of lots needs, in houses, so a lot that grows doesn't move the rows before it.
  const width = Math.max(...ds, Math.min(...ds) * Math.ceil(Math.sqrt(ds.length * 1.25)));
  const rows = [];
  let row = null;
  ds.forEach((d, i) => {
    if (!row || (row.w + d > width && row.items.length)) rows.push((row = { w: 0, h: 0, items: [] }));
    row.items.push(i);
    row.w += d;
    row.h = Math.max(row.h, d);
  });
  const at = new Array(shapes.length);
  // A strip along the top where the block's name stands, like a street name, clear of its houses.
  const band = Math.min(...ds) * 0.9;
  const height = band + rows.reduce((sum, r) => sum + r.h, 0);
  let y = -height / 2 + band;
  // Each row starts where the last one ended, at its side of the block, and runs back across it.
  const span = Math.max(width, ...rows.map((r) => r.w));
  rows.forEach((r, j) => {
    const back = j % 2 === 1;
    let x = back ? span / 2 : -span / 2;
    for (const i of r.items) {
      at[i] = [x + (back ? -ds[i] : ds[i]) / 2, y + r.h / 2];
      x += back ? -ds[i] : ds[i];
    }
    y += r.h;
  });
  const name = [0, -height / 2 + band / 2];
  const radius = Math.max(span / 2, ...at.map(([x, yy], i) => Math.hypot(x, yy) + ds[i] / 2));
  return { at, r: radius, name, nameR: span / 2, band };
}

// ---------- place: the outlines, from the top down ----------

function place(geo, n, shape, cx, cy, sizes) {
  // Its items first: its edge follows their outlines, not the circles they were packed in.
  shape.kids.forEach((k) => place(geo, k.n, k, cx + k.x, cy + k.y, sizes));
  const edges = shape.kids.map((k) => geo.get(k.n.id).poly);
  // Its name's strip is part of its land too.
  if (shape.name) {
    const [nx, ny] = [cx + shape.name.at[0], cy + shape.name.at[1]], [w, h] = [shape.name.r, shape.name.band / 2];
    edges.push([[nx - w * 0.7, ny - h], [nx + w * 0.7, ny - h], [nx + w * 0.7, ny + h], [nx - w * 0.7, ny + h]]);
  }
  const s = sizes.get(n.id);
  const poly = ensureOrientation(blob(cx, cy, shape.r, shape.room, edges, n.id, Boolean(n.issue), shape.margin ?? 0));
  const g = describe(poly);
  g.kind = s.kind;
  g.open = s.open;
  // A block is named along its top, clear of its houses.
  if (shape.name) [g.label, g.labelR] = [[cx + shape.name.at[0], cy + shape.name.at[1]], shape.name.r];
  // Every house on a block is built the same size, facing the same way, so its rows read as a street (MARK-16).
  if (n.issue) g.footprint = [g.labelR * 0.62, g.labelR * 0.62 * 0.6];
  geo.set(n.id, g);
}

/**
 * An organic outline inside the circle (cx, cy, r) round its items' outlines (`kids`): it follows them like a town's edge
 * follows its streets, and reaches at least `room` from its centre, the scope it promises, so the less of it is written the
 * more open land it holds round its items (PLACE-10). A place with no items is a rounded patch. The wander comes from the id alone, so the same place
 * always has the same shape.
 */
function blob(cx, cy, r, room, kids, id, small = false, margin = 0) {
  const rng = hashString(String(id));
  const waves = [2, 3, 5, 7].map((f, i) => ({ f, a: WANDER * [1, 0.7, 0.4, 0.25][i], p: (((rng >>> (i * 7)) & 127) / 127) * Math.PI * 2 }));
  // How far its items reach along each ray from its centre: to the edge of the hull round their outlines.
  const hull = kids.length ? polygonHull(kids.flat()) : null;
  const inside = hull && polygonContains(hull, [cx, cy]);
  const reach = new Array(STEPS);
  for (let j = 0; j < STEPS; j++) {
    const t = (j / STEPS) * Math.PI * 2;
    const ux = Math.cos(t), uy = Math.sin(t);
    let h = 0;
    if (inside) h = rayOut(hull, cx, cy, ux, uy);
    else for (const edge of kids) for (const [x, y] of edge) h = Math.max(h, (x - cx) * ux + (y - cy) * uy);
    reach[j] = h;
  }
  const out = [];
  for (let j = 0; j < STEPS; j++) {
    const t = (j / STEPS) * Math.PI * 2;
    // Smoothed, so the edge between items is a curve, not a corner.
    const h = kids.length ? Math.max(reach[(j + STEPS - 1) % STEPS], reach[j], reach[(j + 1) % STEPS]) + margin : 0;
    const wander = 1 + waves.reduce((sum, w) => sum + w.a * Math.sin(w.f * t + w.p), 0);
    // Its edge bulges out from its items here and there, never in over them; a house's lot wanders less, its house filling most of it.
    const hug = h * (1 + Math.max(0, wander - 1) * 0.5);
    const rho = Math.min(r, Math.max(hug, small ? room * 0.97 * (1 + (wander - 1) * 0.4) : room * 0.92 * wander));
    out.push([cx + rho * Math.cos(t), cy + rho * Math.sin(t)]);
  }
  return out;
}

/** How far a ray from (cx, cy) inside `poly` runs before it leaves it. */
function rayOut(poly, cx, cy, ux, uy) {
  let best = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const ex = bx - ax, ey = by - ay;
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((ax - cx) * ey - (ay - cy) * ex) / den;
    const u = ((ax - cx) * uy - (ay - cy) * ux) / den;
    if (t > best && u >= -1e-9 && u <= 1 + 1e-9) best = t;
  }
  return best;
}

function describe(poly) {
  const area = Math.abs(polygonArea(poly));
  const size = Math.sqrt(area);
  const p = polylabel([poly], Math.max(size / 60, 0.01));
  return { poly, area, size, bbox: bounds(poly), label: [p[0], p[1]], labelR: p.distance };
}
