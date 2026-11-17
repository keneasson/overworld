// Small polygon toolkit. Polygons are open arrays of [x, y] with positive
// d3.polygonArea (the orientation d3-voronoi-map expects).

import { polygonArea } from 'd3';

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function circle(cx, cy, r, n = 96) {
  return Array.from({ length: n }, (_, i) => {
    const a = (-i / n) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

/** A rectangle with rounded corners, as a polygon with positive area. */
export function roundedRect(x, y, w, h, r, steps = 6) {
  const out = [];
  const corners = [
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, Math.PI / 2],
    [x + r, y + r, Math.PI],
    [x + w - r, y + r, (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (i / steps) * (Math.PI / 2);
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return ensureOrientation(out);
}

export function ensureOrientation(poly) {
  return polygonArea(poly) < 0 ? poly.slice().reverse() : poly;
}

export function bounds(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function scalePolygon(poly, [cx, cy], f) {
  return poly.map(([x, y]) => [cx + (x - cx) * f, cy + (y - cy) * f]);
}

/** Keep the part of a convex polygon where a·x + b·y <= c (Sutherland–Hodgman, one edge). */
export function clipHalfPlane(poly, a, b, c) {
  const out = [];
  const inside = ([x, y]) => a * x + b * y <= c;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const pin = inside(p);
    const qin = inside(q);
    if (pin) out.push(p);
    if (pin !== qin) {
      const dp = a * p[0] + b * p[1] - c;
      const dq = a * q[0] + b * q[1] - c;
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/**
 * Fallback treemap for convex polygons: recursively cut along the longer axis
 * so each side's area matches its share of the weight.
 */
export function splitByWeights(poly, weights) {
  const idx = weights.map((_, i) => i);
  const result = new Array(weights.length);
  (function split(poly, items) {
    if (items.length === 1) {
      result[items[0]] = poly;
      return;
    }
    const total = items.reduce((s, i) => s + weights[i], 0);
    let acc = 0;
    let cut = 1;
    for (; cut < items.length - 1; cut++) {
      if (acc + weights[items[cut - 1]] >= total / 2) break;
      acc += weights[items[cut - 1]];
    }
    acc = items.slice(0, cut).reduce((s, i) => s + weights[i], 0);
    const share = acc / total;
    const [x0, y0, x1, y1] = bounds(poly);
    const horizontal = x1 - x0 >= y1 - y0;
    const area = Math.abs(polygonArea(poly));
    let lo = horizontal ? x0 : y0;
    let hi = horizontal ? x1 : y1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const left = horizontal ? clipHalfPlane(poly, 1, 0, mid) : clipHalfPlane(poly, 0, 1, mid);
      if (Math.abs(polygonArea(left)) / area < share) lo = mid;
      else hi = mid;
    }
    const c = (lo + hi) / 2;
    const a = horizontal ? clipHalfPlane(poly, 1, 0, c) : clipHalfPlane(poly, 0, 1, c);
    const b = horizontal ? clipHalfPlane(poly, -1, 0, -c) : clipHalfPlane(poly, 0, -1, -c);
    split(a, items.slice(0, cut));
    split(b, items.slice(cut));
  })(poly, idx);
  return result;
}

/** The cut across `poly` (normal (a, b), cut at a·x + b·y = c) that leaves `share` of its area on the low side. */
function cutAt(poly, a, b, share) {
  const area = Math.abs(polygonArea(poly));
  const ds = poly.map(([x, y]) => a * x + b * y);
  let lo = Math.min(...ds), hi = Math.max(...ds);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (Math.abs(polygonArea(clipHalfPlane(poly, a, b, mid))) / area < share) lo = mid;
    else hi = mid;
  }
  const c = (lo + hi) / 2;
  return [clipHalfPlane(poly, a, b, c), clipHalfPlane(poly, -a, -b, -c)];
}

/**
 * Lots in rows along streets, like houses on a residential block (#46 MARK-16): rows run along the block's long side,
 * as many as keep each lot a little wider than deep, and each row is cut into lots in order, sized by weight.
 */
export function streetRows(poly, weights, rowCount = null) {
  const n = weights.length;
  const [x0, y0, x1, y1] = bounds(poly);
  const across = x1 - x0 >= y1 - y0;
  const long = across ? x1 - x0 : y1 - y0, short = across ? y1 - y0 : x1 - x0;
  const rows = Math.max(1, Math.min(n, rowCount ?? Math.round(Math.sqrt((1.3 * n * short) / long))));
  // Fill rows in order, each about an equal share of the weight.
  const total = weights.reduce((s, w) => s + w, 0);
  const groups = [[]];
  let acc = 0;
  weights.forEach((w, i) => {
    if (groups.at(-1).length && groups.length < rows && acc + w / 2 > (total * groups.length) / rows) groups.push([]);
    groups.at(-1).push(i);
    acc += w;
  });
  const bands = groups;
  const out = new Array(n);
  // Rows are cut across the short side (a: the row direction's normal), lots along the long side.
  const [ra, rb, la, lb] = across ? [0, 1, 1, 0] : [1, 0, 0, 1];
  let rest = poly;
  let left = total;
  bands.forEach((items, r) => {
    const w = items.reduce((s, i) => s + weights[i], 0);
    let band = rest;
    if (r < bands.length - 1) [band, rest] = cutAt(rest, ra, rb, w / left);
    left -= w;
    let along = w;
    items.forEach((i, j) => {
      let lot = band;
      if (j < items.length - 1) [lot, band] = cutAt(band, la, lb, weights[i] / along);
      along -= weights[i];
      out[i] = lot;
    });
  });
  return out;
}

/**
 * A smooth, position-only warp of the plane. Applied to every polygon after
 * layout, it turns straight Voronoi edges into wandering borders and the
 * circular root into a continent. Because it depends only on position,
 * neighbouring cells (and children along a parent's edge) still share borders.
 */
export function makeWarp(cx, cy, seed, { lobes: lobeAmp = 1, waves: waveAmp = 1 } = {}) {
  const rng = mulberry32(seed);
  const lobes = [2, 3, 4, 5, 7].map((k) => ({ k, phase: rng() * Math.PI * 2, amp: (lobeAmp * 0.085) / Math.pow(k, 0.75) }));
  const waves = [];
  for (const lambda of [380, 150, 60, 24]) {
    for (let j = 0; j < 3; j++) {
      const a = rng() * Math.PI * 2;
      waves.push({ ux: Math.cos(a), uy: Math.sin(a), f: (Math.PI * 2) / lambda, amp: waveAmp * lambda * 0.03, px: rng() * 7, py: rng() * 7 });
    }
  }
  return ([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const theta = Math.atan2(dy, dx);
    let f = 1;
    for (const l of lobes) f += l.amp * Math.sin(l.k * theta + l.phase);
    let ox = 0;
    let oy = 0;
    for (const w of waves) {
      const t = (x * w.ux + y * w.uy) * w.f;
      ox += w.amp * Math.sin(t + w.px);
      oy += w.amp * Math.sin(t * 1.13 + w.py);
    }
    return [cx + dx * f + ox, cy + dy * f + oy];
  };
}

/** Insert points so no edge is longer than maxSeg (so a warp can bend it). */
export function densify(poly, maxSeg) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / maxSeg));
    for (let j = 0; j < n; j++) out.push([p[0] + ((q[0] - p[0]) * j) / n, p[1] + ((q[1] - p[1]) * j) / n]);
  }
  return out;
}

export function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function rectsOverlap(a, b, pad = 0) {
  return a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;
}

/**
 * The largest upright rectangle inside a polygon, near enough: [x0, y0, x1, y1]. A block is drawn square inside the land
 * it is given, however that land's border wanders (#46 MARK-16), like a city block inside a district. No longer than
 * `aspect` times its width, so it reads as a block rather than a strip.
 */
export function inscribedRect(poly, { cells = 28, aspect = 2.4 } = {}) {
  const [x0, y0, x1, y1] = bounds(poly);
  const dx = (x1 - x0) / cells, dy = (y1 - y0) / cells;
  const inside = ([px, py]) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[j];
      if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) hit = !hit;
    }
    return hit;
  };
  // A cell counts when its corners and middle are all on the land.
  const corner = Array.from({ length: cells + 1 }, (_, j) => Array.from({ length: cells + 1 }, (_, i) => inside([x0 + i * dx, y0 + j * dy])));
  const ok = Array.from({ length: cells }, (_, j) =>
    Array.from({ length: cells }, (_, i) => corner[j][i] && corner[j][i + 1] && corner[j + 1][i] && corner[j + 1][i + 1] && inside([x0 + (i + 0.5) * dx, y0 + (j + 0.5) * dy])),
  );
  let best = null, bestScore = 0;
  const run = new Array(cells).fill(0);
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) run[i] = ok[j][i] ? run[i] + 1 : 0;
    // Every rectangle ending on this row: for each column span, as tall as its shortest column.
    for (let a = 0; a < cells; a++) {
      let h = Infinity;
      for (let b = a; b < cells && run[b]; b++) {
        h = Math.min(h, run[b]);
        const w = (b - a + 1) * dx, hh = h * dy;
        const long = Math.max(w, hh) / Math.min(w, hh);
        const score = w * hh * Math.min(1, aspect / long);
        if (score > bestScore) [bestScore, best] = [score, [x0 + a * dx, y0 + (j - h + 1) * dy, x0 + (b + 1) * dx, y0 + (j + 1) * dy]];
      }
    }
  }
  if (!best) return null;
  // Too long a rectangle is trimmed to the aspect, keeping its middle.
  let [rx0, ry0, rx1, ry1] = best;
  const w = rx1 - rx0, h = ry1 - ry0;
  if (w > h * aspect) [rx0, rx1] = [rx0 + (w - h * aspect) / 2, rx1 - (w - h * aspect) / 2];
  if (h > w * aspect) [ry0, ry1] = [ry0 + (h - w * aspect) / 2, ry1 - (h - w * aspect) / 2];
  return [rx0, ry0, rx1, ry1];
}

/** A rectangle [x0, y0, x1, y1] as a polygon with positive area. */
export const rectPoly = ([x0, y0, x1, y1]) => ensureOrientation([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
