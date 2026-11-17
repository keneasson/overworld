// Two projections of the same project, like two ways of flattening a globe.
//
// Site (default): the map is shaped like the product. Top-level surfaces are
// continents with outlines you can recognise: a wide web screen, a tall phone,
// a thin API strip, back-end services, third-party islands. They are stacked the
// way data flows: clients, then APIs, then services. Inside every region children
// sit roughly where they live (header on top, filters on the left…) while their
// area still follows the amount of work, like a cartogram.
//
// Organic: a nested Voronoi treemap. The project is one island of free-form
// territories.
//
// Both return geometry for every node ({ poly, bbox, area, size, label, labelR }),
// the land outlines, the world bounds and any sea captions.

import { voronoiMapSimulation } from 'd3-voronoi-map';
import { weightedVoronoi } from 'd3-weighted-voronoi';
import { polygonArea, polygonCentroid, polygonContains } from 'd3';
import polylabel from 'polylabel';
import { bounds, circle, densify, ensureOrientation, hashString, inscribedRect, makeWarp, mulberry32, rectPoly, roundedRect, scalePolygon, splitByWeights, streetRows } from './geometry.js';
import { anchorsFor, resolveSite } from './places.js';
import { HOUSE_WEIGHT } from '../model/tree.js';
import { behaviourHouses, lotsOf } from './houses.js';

export const PROJECTIONS = [
  { id: 'site', name: 'Site layout', blurb: 'Shaped like the product: screens, apps and services, with each part where you would look for it.' },
  { id: 'organic', name: 'Organic', blurb: 'One island of free-form territories, sized by work.' },
];

const DAMPING = 0.8;
/** The geometry key of an issue's open land (MARK-18). */
export const parkId = (n) => `${n.id}:park`;
const weightOf = (n) => Math.pow(Math.max(n.stats.raw, 0.1), DAMPING);
// A house is a lot of one behaviour's size (HOUSE_WEIGHT in tree.js).
const lotWeight = (c) => (c.issue ? Math.pow(HOUSE_WEIGHT, DAMPING) : weightOf(c));

export function computeLayout(tree, projectId, { projection = 'site', site, houses = behaviourHouses(tree) } = {}) {
  const out = projection === 'organic' ? organicLayout(tree, projectId, houses) : siteLayout(tree, projectId, site ?? resolveSite(tree), houses);
  const [x0, y0, x1, y1] = out.land.map(bounds).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
  out.world = { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
  return out;
}

function describe(poly) {
  const area = Math.abs(polygonArea(poly));
  const size = Math.sqrt(area);
  const p = polylabel([poly], Math.max(size / 60, 0.01));
  return { poly, area, size, bbox: bounds(poly), label: [p[0], p[1]], labelR: p.distance };
}

/**
 * Lay out a subtree inside poly; split(n, kids, weights, poly) divides a parent among its lots: its child issues and its
 * behaviours' houses (lotsOf in houses.js). A block's lots stand in rows along streets (MARK-16).
 */
function placeTree(geo, n, poly, split, houses) {
  const g = describe(poly);
  geo.set(n.id, g);
  const { lots, block } = lotsOf(n, houses);
  if (!lots.length) return;
  // Scope the houses don't fill yet is open land among them: a park, its own lot at the end of the rows (MARK-18).
  const park = n.stats.open > 0 ? { id: parkId(n), children: [] } : null;
  if (lots.length === 1 && !park && !lots[0].issue) {
    placeTree(geo, lots[0], scalePolygon(poly, g.label, 0.78), split, houses);
    return;
  }
  const all = park ? [...lots, park] : lots;
  const weights = [...lots.map(lotWeight), ...(park ? [Math.pow(n.stats.open, DAMPING)] : [])];
  const polys = (block ? streetRows(poly, weights) : split(n, all, weights, poly)) ?? splitByWeights(poly, weights);
  lots.forEach((c, i) => {
    if (c.issue) geo.set(c.id, describe(ensureOrientation(polys[i])));
    else placeTree(geo, c, ensureOrientation(polys[i]), split, houses);
  });
  if (park) geo.set(park.id, describe(ensureOrientation(polys[lots.length])));
}

const NOT_BLOCKS = new Set(['project', 'area']);

// ---------- Blocks: an issue's houses in rows (#46 MARK-15, MARK-16, MARK-18) ----------

// The street round a block, and between a block and the blocks inside it, as a share of its short side.
const KERB = 0.035;
// The strip along the top of a block where its name stands, like a street name, clear of its houses.
const NAME_BAND = 0.16;

/**
 * Lay out every issue that is a block (lotsOf in houses.js) as a clean rectangle inside the land it was given, after the
 * warp has bent the borders around it: its houses in straight rows in ID order, its child issues as smaller blocks in the
 * same rows, and what is left over as park. Borders wander between places; a street of houses is straight.
 */
function squareBlocks(geo, n, houses) {
  const { lots, block } = lotsOf(n, houses);
  // An issue is a block: one of houses, or a plain issue's empty lot. A place, or an issue made of issues, keeps its land.
  if (block || (!lots.length && n.depth > 0 && !NOT_BLOCKS.has(n.kind) && !n.tags?.includes('code'))) {
    const land = geo.get(n.id);
    const r = inscribedRect(land.poly);
    if (r) {
      const m = KERB * Math.min(r[2] - r[0], r[3] - r[1]);
      placeBlock(geo, n, [r[0] + m, r[1] + m, r[2] - m, r[3] - m], houses, land.area);
      return;
    }
  }
  for (const c of lots) if (!c.issue) squareBlocks(geo, c, houses);
}

/** A block inside its land: `area` is that land's, the street round the block included, so its size is still its work's. */
function placeBlock(geo, n, rect, houses, area) {
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0, h = y1 - y0;
  // `top` is where its name hangs from: inside the block, never over the row above it.
  const g = { ...describe(rectPoly(rect)), area, size: Math.sqrt(area), top: y0 };
  geo.set(n.id, g);
  geo.delete(parkId(n));
  const { lots } = lotsOf(n, houses);
  if (!lots.length) return;
  // Its name stands in a strip along the top, so no house sits under it.
  const band = Math.min(h * NAME_BAND, w * 0.3);
  g.label = [(x0 + x1) / 2, y0 + band / 2];
  g.labelR = w / 2;
  const rows = [x0, y0 + band, x1, y1];
  const weights = lots.map(lotWeight);
  // A leaf's scope its houses don't fill yet is park (MARK-18), and so is the rest of the last row: a block is full.
  const unit = Math.pow(HOUSE_WEIGHT, DAMPING);
  const total = weights.reduce((s, v) => s + v, 0) + Math.pow(n.stats.open, DAMPING) * (n.stats.open > 0);
  const [rw, rh] = [rows[2] - rows[0], rows[3] - rows[1]];
  const count = Math.max(1, Math.round(Math.sqrt((1.3 * (total / unit) * Math.min(rw, rh)) / Math.max(rw, rh))));
  const cells = total / unit, fill = (count * Math.ceil(cells / count) - cells) * unit;
  const park = total - weights.reduce((s, v) => s + v, 0) + (fill > unit * 0.3 ? fill : 0);
  const all = park > 0 ? [...weights, park] : weights;
  // As many rows as its weight in houses needs, so a behaviour that grows into an issue doesn't reflow the street (MARK-20).
  const polys = streetRows(rectPoly(rows), all, count);
  let foot = Infinity;
  lots.forEach((c, i) => {
    const [a0, b0, a1, b1] = bounds(polys[i]);
    if (c.issue) {
      geo.set(c.id, describe(ensureOrientation(polys[i])));
      foot = Math.min(foot, a1 - a0, (b1 - b0) / 0.6);
    } else {
      const m = KERB * Math.min(a1 - a0, b1 - b0);
      placeBlock(geo, c, [a0 + m, b0 + m, a1 - m, b1 - m], houses, Math.abs(polygonArea(polys[i])));
    }
  });
  if (park > 0) geo.set(parkId(n), describe(ensureOrientation(polys[lots.length])));
  // Every house on a block is the same size, so its rows read as a street whatever its lots are.
  for (const c of lots) if (c.issue) geo.get(c.id).footprint = [foot * 0.34, foot * 0.34 * 0.6];
}

/** Bend every outline with one smooth warp so straight cuts read as borders and coasts. */
function warpAll(geo, land, notes, warp) {
  for (const g of geo.values()) {
    g.poly = densify(g.poly, 3).map(warp);
    g.label = warp(g.label);
    if (g.rings) g.rings = g.rings.map((r) => densify(r, 3).map(warp));
    // The project spans every continent, so its box must too (or the renderer skips it).
    g.bbox = bounds(g.rings ? g.rings.flat() : g.poly);
  }
  for (const note of notes) {
    note.at = warp(note.at);
    note.below = warp(note.below);
  }
  return land.map((r) => densify(r, 3).map(warp));
}

// ---------- Site projection ----------

const SITE_AREA = 640_000;
const SHAPES = {
  web: { aspect: 1.6, round: 0.05, tier: 0 },
  mobile: { aspect: 0.52, round: 0.17, tier: 0 },
  email: { aspect: 0.72, round: 0.03, tier: 0 },
  api: { aspect: 4.2, round: 0.5, tier: 1 },
  service: { aspect: 1.3, round: 0.14, tier: 2 },
  backoffice: { aspect: 2, round: 0.1, tier: 2 },
  external: { aspect: 1.15, round: 0.42, tier: 2 },
  uncharted: { aspect: 1.3, round: 0.45, tier: 3 },
};
const SHARED_CAPTION = { web: 'On screen', backoffice: 'Behind the screen' };

function siteLayout(tree, projectId, site, houses) {
  const geo = new Map();
  const root = tree.root;

  // Group top-level items into continents.
  const continents = [];
  const shared = {};
  for (const k of root.children) {
    const c = site.continents.get(k.id) ?? { surface: 'web', own: false };
    if (c.own) continents.push({ surface: c.surface, kids: [k], own: k });
    else {
      if (!shared[c.surface]) continents.push((shared[c.surface] = { surface: c.surface, kids: [], own: null }));
      shared[c.surface].kids.push(k);
    }
  }
  if (!continents.length) continents.push({ surface: 'web', kids: [], own: null });
  // Third parties sit at the far end of the back-end row.
  continents.sort((a, b) => SHAPES[a.surface].tier - SHAPES[b.surface].tier || (a.surface === 'external') - (b.surface === 'external'));

  // Size each continent by its share of the work, shaped by what it is.
  const total = continents.reduce((s, c) => s + c.kids.reduce((t, k) => t + weightOf(k), 0), 0) || 1;
  for (const c of continents) {
    const share = c.kids.length ? c.kids.reduce((t, k) => t + weightOf(k), 0) / total : 1;
    // Even an empty continent is visible; an island with nothing on it stays a dot.
    const area = SITE_AREA * Math.max(share, c.surface === 'external' ? 0.006 : 0.02);
    const { aspect } = SHAPES[c.surface];
    c.w = Math.sqrt(area * aspect);
    c.h = c.w / aspect;
  }

  // Rows by tier (clients, APIs, services), wrapping very long rows, centred.
  const unit = Math.sqrt(SITE_AREA);
  const gap = unit * 0.08;
  const rows = [];
  for (const c of continents) {
    const tier = SHAPES[c.surface].tier;
    let row = rows.at(-1);
    const width = row ? row.items.reduce((s, it) => s + it.w + gap, 0) + c.w : 0;
    if (!row || row.tier !== tier || width > unit * 2) rows.push((row = { tier, items: [] }));
    row.items.push(c);
  }
  let y = 0;
  for (const row of rows) {
    const rowW = row.items.reduce((s, c) => s + c.w, 0) + gap * (row.items.length - 1);
    const rowH = Math.max(...row.items.map((c) => c.h));
    let x = -rowW / 2;
    for (const c of row.items) {
      c.x = x;
      // Clients rest on the row's bottom edge, facing the API below them.
      c.y = row.tier === 0 ? y + rowH - c.h : y + (rowH - c.h) / 2;
      x += c.w + gap;
    }
    y += rowH + gap * 1.5;
  }
  const dy = 500 - (y - gap * 1.5) / 2;

  const split = (n, kids, weights, poly) => anchoredCells(anchorsFor(kids.map((k) => site.places.get(k.id)), poly, n.id), weights, poly);
  const land = [];
  const notes = [];
  for (const c of continents) {
    const { round } = SHAPES[c.surface];
    const poly = roundedRect(c.x + 500, c.y + dy, c.w, c.h, round * Math.min(c.w, c.h));
    c.poly = poly;
    land.push(poly);
    const mid = c.x + 500 + c.w / 2;
    notes.push({ text: c.own ? c.own.title : SHARED_CAPTION[c.surface], at: [mid, c.y + dy - gap * 0.5], below: [mid, c.y + dy + c.h + gap * 0.5], w: c.w, own: Boolean(c.own) });
    if (c.own) placeTree(geo, c.own, poly, split, houses);
    else if (c.kids.length === 1) placeTree(geo, c.kids[0], poly, split, houses);
    else if (c.kids.length) {
      const weights = c.kids.map(weightOf);
      const places = c.surface === 'backoffice' ? c.kids.map(() => 'center') : c.kids.map((k) => site.places.get(k.id));
      const polys = anchoredCells(anchorsFor(places, poly, `${root.id}:${c.surface}`), weights, poly) ?? splitByWeights(poly, weights);
      c.kids.forEach((k, i) => placeTree(geo, k, ensureOrientation(polys[i]), split, houses));
    }
  }

  // The project itself spans every continent; its card sits on the largest.
  const main = continents.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  const rootGeo = describe(main.poly);
  rootGeo.rings = land.slice();
  rootGeo.area = land.reduce((s, r) => s + Math.abs(polygonArea(r)), 0);
  rootGeo.size = Math.sqrt(rootGeo.area);
  geo.set(root.id, rootGeo);

  // A gentle warp: coastlines wander, but a screen still looks like a screen.
  const all = land.flat();
  const [bx0, by0, bx1, by1] = bounds(all);
  const warp = makeWarp((bx0 + bx1) / 2, (by0 + by1) / 2, hashString(projectId ?? 'map'), { lobes: 0.15, waves: 0.7 });
  const warped = warpAll(geo, land, notes, warp);
  squareBlocks(geo, root, houses);
  return { geo, land: warped, notes, projection: 'site' };
}

const PIN = 0.4;

/**
 * A power diagram whose cells keep near their anchors: each round, sites move to
 * their cell's centroid but are pulled back toward the anchor, while weights grow
 * or shrink until every cell's area matches its share. Returns null if it can't.
 */
function anchoredCells(anchors, weights, clip) {
  const count = anchors.length;
  const clipArea = Math.abs(polygonArea(clip));
  const total = weights.reduce((s, w) => s + w, 0);
  const sites = anchors.map(([x, y], i) => ({ i, x, y, ax: x, ay: y, target: (clipArea * weights[i]) / total, weight: clipArea / count / 8 }));
  const diagram = weightedVoronoi()
    .x((d) => d.x)
    .y((d) => d.y)
    .weight((d) => d.weight)
    .clip(clip);
  let best = null;
  let bestErr = Infinity;
  for (let it = 0; it < 120; it++) {
    let cells;
    try {
      cells = diagram(sites);
    } catch {
      break;
    }
    const byIndex = new Array(count).fill(null);
    for (const c of cells) if (c && c.length >= 3) byIndex[c.site.originalObject.i] = c;
    let err = 0;
    let complete = true;
    for (const s of sites) {
      const c = byIndex[s.i];
      if (!c) complete = false;
      err += Math.abs((c ? Math.abs(polygonArea(c)) : 0) - s.target);
    }
    err /= 2 * clipArea;
    if (complete && err < bestErr) {
      bestErr = err;
      best = byIndex.map((c) => c.map(([x, y]) => [x, y]));
    }
    if (complete && err < 0.006) break;
    for (const s of sites) {
      const c = byIndex[s.i];
      if (!c) {
        s.weight *= 1.25;
        s.x = s.ax;
        s.y = s.ay;
        continue;
      }
      const [cx, cy] = polygonCentroid(c);
      s.x = cx + (s.ax - cx) * PIN;
      s.y = cy + (s.ay - cy) * PIN;
      const ratio = Math.min(1.12, Math.max(0.88, s.target / Math.abs(polygonArea(c))));
      s.weight = Math.max(1e-9, s.weight * ratio);
    }
    limitWeights(sites);
  }
  return best;
}

// A site heavier than a neighbour by more than their squared distance swallows that neighbour's cell.
function limitWeights(sites) {
  for (let pass = 0; pass < 60; pass++) {
    let fixed = false;
    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        const a = sites[i], b = sites[j];
        const [hi, lo] = a.weight > b.weight ? [a, b] : [b, a];
        const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
        if (d2 < hi.weight - lo.weight) {
          hi.weight = d2 + lo.weight / 2;
          fixed = true;
        }
      }
    }
    if (!fixed) return;
  }
}

// ---------- Organic projection ----------

const ISLAND = { cx: 500, cy: 500, r: 470 };
const sitesByProject = new Map();

function organicLayout(tree, projectId, houses) {
  const sites = sitesByProject.get(projectId) ?? new Map();
  sitesByProject.set(projectId, sites);
  const geo = new Map();
  const rootPoly = ensureOrientation(circle(ISLAND.cx, ISLAND.cy, ISLAND.r, 128));
  placeTree(geo, tree.root, rootPoly, (n, kids, weights, poly) => voronoi(kids, weights, poly, n.id, sites), houses);
  // Bend every border with the same smooth warp so the map reads as terrain, not a diagram.
  const warp = makeWarp(ISLAND.cx, ISLAND.cy, hashString(projectId ?? 'map'));
  warpAll(geo, [], [], warp);
  squareBlocks(geo, tree.root, houses);
  return { geo, land: [geo.get(tree.root.id).poly], notes: [], projection: 'organic' };
}

function voronoi(kids, weights, clip, seedKey, sites) {
  const rng = mulberry32(hashString(seedKey));
  const [x0, y0, x1, y1] = bounds(clip);
  const randomInside = () => {
    for (let i = 0; i < 200; i++) {
      const p = [x0 + rng() * (x1 - x0), y0 + rng() * (y1 - y0)];
      if (polygonContains(clip, p)) return p;
    }
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  };
  const data = kids.map((k, i) => {
    const prev = sites.get(k.id);
    return { id: k.id, w: weights[i], start: prev && polygonContains(clip, prev) ? prev : randomInside() };
  });
  // Jitter duplicates: coincident sites break the power diagram.
  const seen = new Set();
  for (const d of data) {
    const key = `${d.start[0].toFixed(3)},${d.start[1].toFixed(3)}`;
    if (seen.has(key)) d.start = randomInside();
    seen.add(key);
  }
  try {
    const sim = voronoiMapSimulation(data)
      .clip(clip)
      .weight((d) => d.w)
      .prng(rng)
      .initialPosition((d) => d.start)
      .maxIterationCount(80)
      .convergenceRatio(0.004)
      .stop();
    let state = sim.state();
    while (!state.ended) {
      sim.tick();
      state = sim.state();
    }
    const byId = new Map();
    for (const poly of state.polygons) {
      if (!poly) continue;
      const d = poly.site.originalObject.data.originalData;
      byId.set(d.id, poly.map(([x, y]) => [x, y]));
      sites.set(d.id, [poly.site.x, poly.site.y]);
    }
    const out = kids.map((k) => byId.get(k.id));
    if (out.some((p) => !p || p.length < 3 || Math.abs(polygonArea(p)) < 1e-9)) return null;
    return out;
  } catch {
    return null;
  }
}
