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
