// Canvas renderer with semantic zoom.
//
// Every node has a screen size s = sqrt(area) * zoom. Two thresholds drive the map:
//   sub   — when a node is this big its children's borders, colours and labels appear
//   yield — when a node is this big its children count as what is on screen (roads, focus)
// Zooming in, a region keeps its label as its children's labels join it, so the subject shifts from macro (areas)
// to micro (a single task); each kind of place is named over its own zoom range, and outer names fade as their items'
// items come to be named (MARK-13).

import { hsl, polygonContains } from 'd3';
import { isInside, pathOf } from '../model/tree.js';
import { LIGHT_COLORS } from './lenses.js';
import { LADDER, housesOf, labelFor, markersOf } from './labels.js';
import { drawSymbol } from './symbols.js';
import { lotsAt } from './lots.js';
import { HOUSE, housesAt, isHouse, lotsOf } from './houses.js';
import { placeNames } from './names.js';
import { rectsOverlap, smoothstep } from './geometry.js';

export const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
const ACCENT = '#1a73e8';
const LINK_COLOR = { navigates: '#1a73e8', depends: '#e8710a', relates: '#8e44ad' };
const LINK_COLOR_NIGHT = { navigates: '#8ab4f8', depends: '#fcad70', relates: '#d7aefb' };

export function thresholds(width, height) {
  const vmin = Math.min(width, height);
  const yld = Math.min(860, Math.max(380, vmin * 0.9));
  return { vmin, yld, sub: yld * 0.42 };
}

/**
 * Where each kind of place starts to be named (MARK-13): its screen size in pixels, the square root of its area. Like
 * a map naming countries, then cities, then streets: areas when zoomed out, then epics, then features, and houses
 * only on a street, once their lot holds a house (MARK-16).
 */
const NAME_FROM = { area: 14, epic: 20, feature: 28, story: 28, house: HOUSE.from };
export const nameFromOf = (n) => (isHouse(n) ? NAME_FROM.house : NAME_FROM[n.kind] ?? LADDER[0].from);

/** How far off screen (px) names still count. */
const EDGE = 200;

/**
 * Which regions are named at this view (MARK-01), and how strongly (0 to 1). Each kind of place is named over its
 * own zoom range (NAME_FROM), and what its label holds grows one step at a time with its size on screen (LADDER in
 * labels.js: there, kind, name, markers). Like a city on a map, a region keeps its pin as its items are named beside
 * it, and fades once the map is close enough to name its items' items, as a province's name goes once you're among a
 * city's streets (MARK-13). `holds` is how far its items are named; from then on its markers count only what is its
 * own, so nothing on screen is counted twice. `named` says its title shows. The selected region is always named.
 */
export function namesAt(scene, view, { selectedId = null, T = thresholds(view.width, view.height) } = {}) {
  const { tree, geo } = scene;
  const kidsOf = scene.kidsOf ?? ((n) => n.children);
  const { x, y, k, width: W, height: H } = view;
  // A little beyond the edges too: a name just off screen still makes its neighbours on it give way, until it's far off.
  const m = EDGE / k;
  const vp = [-x / k - m, -y / k - m, (W - x) / k + m, (H - y) / k + m];
  const inView = (bb) => bb[2] >= vp[0] && bb[0] <= vp[2] && bb[3] >= vp[1] && bb[1] <= vp[3];
  const name = LADDER.find((l) => l.stage === 'name').from;
  const labels = [];
  // How surely each place is named on screen, fully once its title shows: its grandparent's name gives way to it.
  const fits = new Map();
  const walk = (n, alpha) => {
    const g = geo.get(n.id);
    if (!inView(g.bbox)) return;
    const s = g.size * k;
    const sub = kidsOf(n).length ? smoothstep(T.sub * 0.8, T.sub * 1.25, s) : 0;
    // The project's own name is the card in the sea, so it steps aside once its land is well under way.
    const handover = n.depth === 0 && n.children.length ? smoothstep(T.yld * 0.88, T.yld, s) : 0;
    const from = n.depth ? nameFromOf(n) : LADDER[0].from;
    const own = alpha * (1 - handover) * smoothstep(from, from + 12, s);
    if (own > 0.02) {
      labels.push({ n, g, s, alpha: own, holds: n.depth > 0 && sub > 0.5, sub: n.depth > 0 ? sub : 0, named: n.depth === 0 || s >= name });
      // Counted as it comes onto the screen, not all at once as it crosses the edge.
      const [px, py] = g.label, sx = px * k + x, sy = py * k + y;
      const onScreen = smoothstep(0, 80, Math.min(sx, W - sx, sy, H - sy));
      if (onScreen > 0) fits.set(n.id, onScreen * own * smoothstep(name - 12, name, s));
    }
    if (sub > 0.01) for (const c of kidsOf(n)) walk(c, sub);
  };
  walk(tree.root, 1);
  // The project's card has its own handover (above).
  for (const l of labels) {
    if (!l.n.depth) continue;
    let below = 0;
    for (const c of kidsOf(l.n)) for (const gc of kidsOf(c)) below = Math.max(below, fits.get(gc.id) ?? 0);
    l.alpha *= 1 - below;
  }
  for (let i = labels.length - 1; i >= 0; i--) if (labels[i].alpha <= 0.02) labels.splice(i, 1);
  const selected = selectedId && tree.byId.get(selectedId);
  if (selected && inView(geo.get(selected.id).bbox)) {
    const at = labels.find((l) => l.n === selected);
    if (at) at.alpha = 1;
    else labels.push({ n: selected, g: geo.get(selected.id), s: Math.max(62, geo.get(selected.id).size * k), alpha: 1, named: true });
  }
  return { labels };
}

/** The zoom at which all the land fits the viewport. */
export function fitScale(width, height, world) {
  return Math.min(width / world.w, height / world.h) * 0.92;
}

const area = (insets, W, H) => {
  const l = insets?.left ?? 0, t = insets?.top ?? 0, b = insets?.bottom ?? 0;
  return { l, t, w: Math.max(120, W - l), h: Math.max(120, H - t - b) };
};

/** The "all the way out" view: all the land, project card readable. */
export function overviewView(scene, W, H, insets) {
  const a = area(insets, W, H);
  const { cx, cy } = scene.world;
  // Keep a strip of open sea for the project card: on the left of wide screens, on top of tall ones.
  const cardW = a.w > a.h * 1.2 ? Math.min(400, a.w * 0.3) : 0;
  const cardH = a.h > a.w * 1.2 ? Math.min(280, a.h * 0.36) : 0;
  const k = fitScale(a.w - cardW, a.h - cardH, scene.world) * 0.9;
  return { k, x: a.l + cardW + (a.w - cardW) / 2 - cx * k, y: a.t + cardH + (a.h - cardH) / 2 - cy * k };
}

/** Zoom so a node's children are labelled (containers) or its details show (leaves). */
export function nodeView(scene, n, W, H, insets) {
  const g = scene.geo.get(n.id);
  const a = area(insets, W, H);
  const T = thresholds(W, H);
  const [x0, y0, x1, y1] = g.bbox;
  const kFit = Math.min(a.w / (x1 - x0), a.h / (y1 - y0)) * 0.86;
  let k = (scene.kidsOf?.(n) ?? n.children).length ? Math.max(kFit, (1.22 * T.yld) / g.size) : Math.min(kFit * 1.15, (0.9 * T.vmin) / g.size);
  if (n.depth === 0) return overviewView(scene, W, H, insets);
  k = Math.min(k, scene.maxK ?? Infinity);
  const [cx, cy] = g.label;
  return { k, x: a.l + a.w / 2 - cx * k, y: a.t + a.h / 2 - cy * k };
}

const pathCache = new WeakMap();
function pathFor(g) {
  let p = pathCache.get(g);
  if (!p) {
    p = new Path2D();
    for (const ring of g.rings ?? [g.poly]) {
      ring.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
      p.closePath();
    }
    pathCache.set(g, p);
  }
  return p;
}

const hatchCache = new Map();
function hatch(ctx, color) {
  if (!hatchCache.has(color)) {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d');
    g.strokeStyle = color;
    g.lineWidth = 1.6;
    g.beginPath();
    for (let i = -16; i <= 32; i += 8) {
      g.moveTo(i, 16);
      g.lineTo(i + 16, 0);
    }
    g.stroke();
    hatchCache.set(color, c);
  }
  return ctx.createPattern(hatchCache.get(color), 'repeat');
}

// Wasteland (#24 WASTE-01): cracked, dried-out ground, so it reads as damage rather than weather (Fog) or a hatch's "none".
let cracksTile = null;
function cracks(ctx) {
  if (!cracksTile) {
    const c = document.createElement('canvas');
    c.width = c.height = 40;
    const g = c.getContext('2d');
    g.strokeStyle = 'rgba(70,45,25,0.42)';
    g.lineWidth = 1.3;
    g.lineJoin = 'round';
    for (const line of [
      [[0, 9], [8, 12], [14, 7], [22, 11], [30, 6], [40, 9]],
      [[14, 7], [16, 0]],
      [[8, 12], [10, 22], [5, 30], [7, 40]],
      [[22, 11], [25, 21], [33, 26], [40, 24]],
      [[25, 21], [20, 31], [24, 40]],
      [[10, 22], [20, 31]],
      [[0, 24], [5, 30]],
    ]) {
      g.beginPath();
      line.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
    }
    cracksTile = c;
  }
  return ctx.createPattern(cracksTile, 'repeat');
}

// ---------- houses: how much a place holds (MARK-09) ----------

// A small seeded random, so a place's houses stand in the same spots every time it is drawn.
function seeded(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_HOUSES = 300;
const houseSpots = new WeakMap();
/**
 * Where a place's houses stand, in world coordinates: gathered round its centre like a town, the town
 * spreading as it grows, and never in the sea or a neighbour's land.
 */
function lotsFor(n, g, scene) {
  const want = Math.min(MAX_HOUSES, housesOf(n));
  const key = `${want}`;
  const hit = houseSpots.get(g);
  if (hit?.key === key) return hit.points;
  // A block's only buildings are its behaviours' houses (MARK-16): before they can be read, its town is one small square
  // where each of them stands, its child blocks' too.
  if (n.issue) {
    houseSpots.set(g, { key, points: [g.label] });
    return [g.label];
  }
  if (scene?.houses && lotsOf(n, scene.houses).block) {
    const points = [];
    const gather = (p) => {
      for (const c of scene.kidsOf(p)) {
        if (c.issue) points.push(scene.geo.get(c.id).label);
        else gather(c);
      }
    };
    gather(n);
    houseSpots.set(g, { key, points });
    return points;
  }
  const rand = seeded(n.id);
  const [cx, cy] = g.label;
  const spread = g.labelR * Math.min(0.9, 0.3 + Math.sqrt(want) / 14);
  const points = [];
  for (let tries = 0; points.length < want && tries < want * 40; tries++) {
    // Box–Muller: most houses near the centre, a few out in the country.
    const r = spread * Math.sqrt(-2 * Math.log(1 - rand())) * 0.6, a = rand() * 2 * Math.PI;
    const p = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    if (polygonContains(g.poly, p)) points.push(p);
  }
  houseSpots.set(g, { key, points });
  return points;
}

/**
 * Busy places look like towns before anything in them can be read: one small house per thing the place holds.
 * Faint, under the fog and every label, so symbols and markers stay on top.
 */
function drawTowns(ctx, towns, k, dark, scene) {
  ctx.fillStyle = dark ? '#c8d2f0' : '#4a4740';
  for (const { n, g, w } of towns) {
    const size = 3 / k;
    ctx.globalAlpha = 0.36 * w;
    for (const [hx, hy] of lotsFor(n, g, scene)) ctx.fillRect(hx - size / 2, hy - size / 2, size, size);
  }
  ctx.globalAlpha = 1;
}

/** Houses (MARK-16): light grey building footprints with a slightly darker edge, like buildings on a street map. */
function drawBuildings(ctx, houses, k, dark) {
  ctx.lineJoin = 'miter';
  for (const { corners, alpha } of houses) {
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    corners.forEach(([hx, hy], i) => (i ? ctx.lineTo(hx, hy) : ctx.moveTo(hx, hy)));
    ctx.closePath();
    ctx.fillStyle = dark ? '#4a5470' : '#e8e7e3';
    ctx.fill();
    ctx.strokeStyle = dark ? '#6c7896' : '#c4c2bc';
    ctx.lineWidth = 1 / k;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineJoin = 'round';
}

/** A bulldozer on the lot of a house being coded (MARK-17): construction yellow, so it reads as work going on. */
function drawBulldozer(ctx, [bx, by], size, alpha) {
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(bx, by, size * 0.62, 0, Math.PI * 2);
  ctx.fillStyle = '#fbbc04';
  ctx.fill();
  ctx.lineWidth = size * 0.07;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  drawSymbol(ctx, 'bulldozer', bx, by, size * 0.78, '#3c2f00');
  ctx.globalAlpha = 1;
}

/** An hourglass on the lot of a house asked to be built and waiting for a builder (#14 HANDOFF-05): quiet, since nothing is happening yet. */
function drawWaiting(ctx, [bx, by], size, alpha, dark) {
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(bx, by, size * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = dark ? '#3c4043' : '#ffffff';
  ctx.fill();
  ctx.lineWidth = size * 0.07;
  ctx.strokeStyle = '#fbbc04';
  ctx.stroke();
  drawSymbol(ctx, 'waiting', bx, by, size * 0.62, dark ? '#fde293' : '#5f4b00');
  ctx.globalAlpha = 1;
}

// ---------- fog ----------
// Uncharted work is under cloud: soft, seamless cloud tiles in two layers that drift at different speeds,
// so the fog reads as weather moving over the land. Drawn over fills and borders, under every label and pin.
const fogTiles = new Map();
function fogTile(dark, seed) {
  const key = `${dark}|${seed}`;
  if (!fogTiles.has(key)) {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    let r = seed;
    const rand = () => (r = (r * 9301 + 49297) % 233280) / 233280;
    const tone = dark ? '205,214,228' : '255,255,255';
    const shade = dark ? '40,46,58' : '118,128,146';
    for (let i = 0; i < 30; i++) {
      const x = rand() * S;
      const y = rand() * S;
      const rad = S * (0.09 + rand() * 0.2);
      const a = 0.6 + rand() * 0.4;
      // Every blob is drawn wrapped around the edges, so the tile repeats without a seam.
      for (const dx of [-S, 0, S])
        for (const dy of [-S, 0, S]) {
          const cx = x + dx;
          const cy = y + dy;
          if (cx + rad < 0 || cx - rad > S || cy + rad < 0 || cy - rad > S) continue;
          // A shadowed underside, then the lit top: what makes a soft blob read as cloud.
          for (const [ox, oy, rgb, aa] of [
            [0.22, 0.3, shade, a * 0.7],
            [0, 0, tone, a],
          ]) {
            const px = cx + ox * rad;
            const py = cy + oy * rad;
            const gr = g.createRadialGradient(px, py, 0, px, py, rad);
            gr.addColorStop(0, `rgba(${rgb},${aa})`);
            gr.addColorStop(0.55, `rgba(${rgb},${aa * 0.45})`);
            gr.addColorStop(1, `rgba(${rgb},0)`);
            g.fillStyle = gr;
            g.fillRect(px - rad, py - rad, rad * 2, rad * 2);
          }
        }
    }
    fogTiles.set(key, c);
  }
  return fogTiles.get(key);
}
// Screen pixels per second: slow enough to notice only when you look.
const FOG_LAYERS = [
  { seed: 11, scale: 1, vx: 11, vy: 3.5, alpha: 1 },
  { seed: 71, scale: 2.4, vx: -6, vy: 2, alpha: 0.9 },
];

/**
 * Where the fog over a region lies (FOG-01): over the land of the parts nobody knows yet, not spread across all of it.
 * A region that is a third fog shows cloud over that third of its land, at any zoom; each patch is as thick as its
 * own part is uncharted. A part goes down to its own parts until it is all fog, or too small on screen to tell apart.
 * @returns {{ n, g, w }[]}  the parts, their geometry and how thick their fog is
 */
export function fogPatches(n, { fog, geo, k, inView = () => true }) {
  const out = [];
  (function visit(m) {
    const w = fog(m);
    const g = geo.get(m.id);
    if (w <= 0.02 || !inView(g.bbox)) return;
    if (!m.children.length || w >= 0.98 || g.size * k < 6) out.push({ n: m, g, w });
    else for (const c of m.children) visit(c);
  })(n);
  return out;
}

function drawFog(ctx, items, k, t, dark) {
  // A veil under the clouds, so even a gap between them still reads as fog.
  ctx.fillStyle = dark ? '#8d99ab' : '#eef1f5';
  for (const { g, w } of items) {
    ctx.globalAlpha = Math.min(1, w * 0.62);
    ctx.fill(pathFor(g));
  }
  for (const layer of FOG_LAYERS) {
    const p = ctx.createPattern(fogTile(dark, layer.seed), 'repeat');
    ctx.fillStyle = p;
    for (const { g, w, s } of items) {
      // Clouds shrink with the region on screen, so a small region zoomed out still shows whole clouds, not a tint.
      const f = Math.min(1, Math.max(0.18, s / 900)) * layer.scale;
      p.setTransform(new DOMMatrix().translate((t * layer.vx * f) / k, (t * layer.vy * f) / k).scale(f / k));
      ctx.globalAlpha = Math.min(1, w * layer.alpha);
      ctx.fill(pathFor(g));
    }
  }
}

// ---------- text helpers ----------

const wrapCache = new Map();
function wrap(ctx, text, font, maxW, maxLines) {
  const key = `${font}|${maxW >> 3}|${maxLines}|${text}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;
  if (wrapCache.size > 6000) wrapCache.clear();
  ctx.font = font;
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(test).width <= maxW || !line) line = test;
    else {
      lines.push(line);
      line = words[i];
      if (lines.length === maxLines) {
        line = '';
        lines[maxLines - 1] = ellipsize(ctx, `${lines[maxLines - 1]} ${words.slice(i).join(' ')}`, maxW);
        break;
      }
    }
  }
  if (line) lines.push(line);
  const out = lines.map((l) => (ctx.measureText(l).width > maxW ? ellipsize(ctx, l, maxW) : l));
  wrapCache.set(key, out);
  return out;
}

function ellipsize(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

// ---------- labels: a symbol, a short title and badges (#10) ----------

// A light fill gets a dark outline, a dark one a white outline.
const inkOn = (fill) => (hsl(fill).l > 0.72 ? '#3c4043' : '#ffffff');

// The sizes on screen where a label's block steps up: each LADDER stage, and its two larger type sizes below.
const BLOCK_STEPS = [...LADDER.map((l) => l.from), 150, 330];
function labelBlock(ctx, c, { k, theme, W, live }) {
  const { n, s, g } = c;
  const label = labelFor(n, s, live, c.holds);
  const root = n.depth === 0;
  // A dot says something is there; its symbol grows as there is room for one (MARK-10).
  const r = root ? 18 : !label.symbol ? 4.5 : !label.title ? 9 : s >= 330 ? 15 : s >= 150 ? 13 : 11;
  const size = root ? Math.min(26, Math.max(19, s / 26)) : s >= 330 ? Math.min(17, Math.max(14, s / 26)) : s >= 150 ? 13.5 : s >= 95 ? 12 : 11;
  const font = `${root || s >= 150 ? 700 : 600} ${size}px ${FONT}`;
  // A house's name stays on its own lot (#46 MARK-16): its ID always, its words below as the lot has room for them.
  const lot = g.footprint ? { w: (g.bbox[2] - g.bbox[0]) * k - 6, h: (g.bbox[3] - g.bbox[1]) * k - 4 } : null;
  const maxW = root ? Math.min(420, W * 0.7) : lot ? Math.max(40, lot.w) : Math.max(60, Math.min(s >= 330 ? 260 : 190, g.labelR * k * 1.8));
  const lh = Math.round(size * 1.25);
  const head = 2 * r + (label.title ? 4 : 2);
  const wordLines = lot && label.lines > 1 ? Math.min(2, Math.floor((lot.h - head) / lh) - 1) : 0;
  const lines = !lot || !label.title ? wrap(ctx, label.title, font, maxW, label.lines) : [n.behaviour, ...(wordLines > 0 ? wrap(ctx, label.title.slice(n.behaviour.length).trim(), font, maxW, wordLines) : [])];
  ctx.font = font;
  const titleW = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
  ctx.font = `700 10.5px ${FONT}`;
  const badges = label.badges.map((b) => ({ ...b, w: 16 + (b.on ? 12 : 0) + (b.count > 1 ? ctx.measureText(String(b.count)).width + 3 : 0) + 6 }));
  const badgesW = badges.reduce((sum, b) => sum + b.w + 3, 0);
  // The symbol stays centred over the title; badges hang off its right side, balanced by empty room on the left.
  const w = Math.max(titleW, 2 * r + 2 * (badgesW ? badgesW + 4 : 0)) + (root ? 32 : 0);
  const h = head + lines.length * lh + (root ? 20 : 0);
  // The room it takes from other names: as wide as its title could wrap to and as many lines as it might need, so it
  // changes smoothly as the zoom does, where the drawn title rewraps a word at a time.
  ctx.font = font;
  const fullW = label.title ? ctx.measureText(label.title).width : 0;
  const roomLines = lines.length ? Math.min(label.lines, fullW / maxW + 1) : 0;
  const room = lot
    ? { w, h }
    : {
        w: Math.max(w, Math.max(Math.min(maxW, fullW), 2 * r + 2 * (badgesW ? badgesW + 4 : 0)) + (root ? 32 : 0)),
        h: Math.max(h, head + roomLines * lh + (root ? 20 : 0)),
      };
  return { label, r, lines, font, lh, head, badges, w, h, room, panel: root };
}

function drawBlock(ctx, block, rect, alpha, theme) {
  ctx.globalAlpha = alpha;
  if (block.panel) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = theme.dark ? 'rgba(14,20,38,0.9)' : 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 14);
    ctx.fill();
    ctx.restore();
  }
  const cx = rect.x + rect.w / 2;
  const top = rect.y + (block.panel ? 10 : 0);
  const cy = top + block.r + 1;
  const { label, r } = block;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.22)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = label.fill;
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = label.symbol ? 1.5 : 1.2;
  ctx.strokeStyle = theme.dark ? 'rgba(255,255,255,0.7)' : '#ffffff';
  ctx.stroke();
  if (label.symbol) drawSymbol(ctx, label.symbol, cx, cy, r * 1.15, inkOn(label.fill));

  let bx = cx + r + 4;
  const hits = [];
  for (const b of block.badges) {
    const by = cy - r * 0.35;
    ctx.beginPath();
    ctx.roundRect(bx, by - 8, b.w, 16, 8);
    ctx.fillStyle = theme.dark ? '#1f2a44' : '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.dark ? '#5d6f9e' : '#9aa0a6';
    ctx.stroke();
    // Markers that combine say so (MARK-03): code with a fire is code with an open bug.
    let ix = bx + 3 + 5.5;
    if (b.on) {
      drawSymbol(ctx, b.on, ix, by, 11, theme.muted);
      ix += 12;
    }
    drawSymbol(ctx, b.type, ix, by, 11, BADGE_INK[b.type]);
    // Unread comments for whoever is looking (NOTE-03, NOTE-04): a dot on the badge's corner.
    if (b.unread) {
      ctx.beginPath();
      ctx.arc(bx + b.w - 3, by - 6, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = BADGE_INK.comment;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = theme.dark ? '#1f2a44' : '#ffffff';
      ctx.stroke();
    }
    if (b.target) hits.push({ target: b.target, type: b.type, rect: { x: bx, y: by - 8, w: b.w, h: 16 } });
    if (b.count > 1) {
      ctx.font = `700 10.5px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = theme.text;
      ctx.fillText(String(b.count), ix + 10.5, by + 0.5);
    }
    bx += b.w + 3;
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.font = block.font;
  let y = top + block.head;
  for (const line of block.lines) {
    if (!block.panel) {
      ctx.strokeStyle = theme.halo;
      ctx.lineWidth = 3.5;
      ctx.strokeText(line, cx, y + block.lh / 2);
    }
    ctx.fillStyle = theme.text;
    ctx.fillText(line, cx, y + block.lh / 2);
    y += block.lh;
  }
  ctx.globalAlpha = 1;
  return hits;
}

const BADGE_INK = { fire: '#d93025', fog: '#5f6b7a', pull: '#8250df', agent: '#1a73e8', comment: '#e8710a', question: '#8b5cf6' };

function drawPin(ctx, x, y) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x - 4, y - 9, x - 11, y - 14, x - 11, y - 23);
  ctx.arc(x, y - 23, 11, Math.PI, 0);
  ctx.bezierCurveTo(x + 11, y - 14, x + 4, y - 9, x, y);
  ctx.fillStyle = '#ea4335';
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = '#b31412';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y - 23, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#7d0a07';
  ctx.fill();
}

/** What makes a name more important than its neighbours: something going on there. */
const URGENT = new Set(['fire', 'question', 'agent']);

/**
 * The names drawn at this view, each with its block, the box it is drawn in (`drawn`), the room it takes from other
 * names (`rect`, around it) and how strongly it shows. They make room for each other (placeNames in names.js), and come
 * outer names first, so a name fading in over one fading out is drawn on top.
 */
export function namesOnScreen(ctx, scene, view, { selectedId = null, live, theme, insets = {}, T = thresholds(view.width, view.height) } = {}) {
  const { x, y, k, width: W, height: H } = view;
  const selected = selectedId && scene.tree.byId.get(selectedId);
  // The project card sits in open sea beside the land, like the title cartouche on an
  // old map: west of it on wide screens, north of it on tall ones. As you zoom in it
  // slides along the coast, then waits at the screen edge until it fades.
  const ins = insets ?? {};
  const cartouche = ([px, py], block) => {
    const m = 20;
    const minX = (ins.left ?? 0) + m + block.w / 2, maxX = Math.max(minX, W - m - block.w / 2);
    const minY = (ins.top ?? 0) + m + block.h / 2, maxY = Math.max(minY, H - (ins.bottom ?? 0) - m - block.h / 2);
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const wide = W - (ins.left ?? 0) >= H - (ins.top ?? 0) - (ins.bottom ?? 0);
    if (wide) return [Math.max(minX, Math.min(px, scene.world.x0 * k + x - m - block.w / 2)), clamp(py, minY, maxY)];
    return [clamp(px, minX, maxX), Math.max(minY, Math.min(py, scene.world.y0 * k + y - m - block.h / 2))];
  };
  const onScreen = ([sx, sy], m) => sx > -m && sx < W + m && sy > -m && sy < H + m;
  const cands = [];
  for (const c of namesAt(scene, view, { selectedId, T }).labels) {
    let p = [c.g.label[0] * k + x, c.g.label[1] * k + y];
    if (!onScreen(p, c.n.depth ? 300 : Math.max(W, H))) continue;
    const block = labelBlock(ctx, c, { k, theme, W, live });
    if (c.n.depth === 0) p = cartouche(p, block);
    // A block's name hangs from its top edge, in the strip kept clear of its houses (MARK-16).
    else if (c.g.top != null) p = [p[0], Math.max(p[1], c.g.top * k + y + block.room.h / 2 + 2)];
    // The room it takes changes smoothly, never at once, so its neighbours never jump: as a region's items are named
    // its markers count only its own and it narrows; a label grows a step at a time (MARK-10), and its room grows
    // towards the next step before it gets there.
    const lerp = (a, b, t) => ({ w: Math.max(a.w, a.w + (b.w - a.w) * t), h: Math.max(a.h, a.h + (b.h - a.h) * t) });
    let room = block.room;
    if (c.holds) room = lerp(room, labelBlock(ctx, { ...c, holds: false }, { k, theme, W, live }).room, 1 - smoothstep(0.5, 1, c.sub));
    const next = c.n.depth ? BLOCK_STEPS.find((t) => t > c.s) : null;
    const t = next ? smoothstep(next / 1.25, next, c.s) : 0;
    if (t) room = lerp(room, labelBlock(ctx, { ...c, s: next }, { k, theme, W, live }).room, t);
    const rect = { x: p[0] - room.w / 2, y: p[1] - room.h / 2, w: room.w, h: room.h };
    cands.push({ ...c, block, at: p, rect, urgent: (!c.n.issue && c.n.status === 'in_progress') || markersOf(c.n, live).some((m) => URGENT.has(m.type)) });
  }
  return placeNames(cands, { selected })
    .map((c) => ({ ...c, drawn: { x: c.at[0] - c.block.w / 2, y: c.at[1] - c.block.h / 2, w: c.block.w, h: c.block.h } }))
    .sort((a, b) => a.n.depth - b.n.depth || (a.n === selected) - (b.n === selected));
}

/**
 * The place in view (MARK-19): the deepest region around the centre whose items are what is on screen: an issue among
 * its behaviours' houses, never a house. The header names it and the way to it, so a place whose name has faded off
 * the map is still named.
 */
export function placeInView(scene, view, { center, T = thresholds(view.width, view.height) } = {}) {
  const { tree, geo } = scene;
  const { x, y, k, width: W, height: H } = view;
  const [cx, cy] = center ?? [W / 2, H / 2];
  const cw = [(cx - x) / k, (cy - y) / k];
  const yields = (n) => (scene.kidsOf?.(n) ?? n.children).length && smoothstep(T.yld * 0.95, T.yld * 1.1, geo.get(n.id).size * k) >= 0.5;
  let focus = null;
  for (let cur = tree.root; cur && yields(cur); ) {
    focus = cur;
    cur = cur.children.find((ch) => polygonContains(geo.get(ch.id).poly, cw));
  }
  return focus;
}

// ---------- main draw ----------

/**
 * Draw the map. Returns what is on screen (labels, focus) for hit testing,
 * breadcrumbs and tooltips.
 */
export function drawMap(ctx, scene, view, opts) {
  const { tree, geo } = scene;
  const { x, y, k, width: W, height: H, dpr } = view;
  const { lens, selectedId = null, hoverId = null, showLinks = false, thumbnail = false, live, time = 0 } = opts;
  const theme = lens.theme;
  const T = opts.T ?? thresholds(W, H);
  const sizeOf = (n) => geo.get(n.id).size * k;
  const toScreen = ([wx, wy]) => [wx * k + x, wy * k + y];
  const vp = [-x / k, -y / k, (W - x) / k, (H - y) / k];
  const inView = (bb) => bb[2] >= vp[0] && bb[0] <= vp[2] && bb[3] >= vp[1] && bb[1] <= vp[3];
  // A parent's label fades out completely before its children's labels fade in, so text never stacks.
  const yieldOf = (n, s = sizeOf(n)) => (n.children.length ? smoothstep(T.yld * 0.95, T.yld * 1.1, s) : 0);

  // Ocean with a little bathymetry (shallow water) around every coast.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.ocean;
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
  scene.coastPath ??= pathFor({ rings: scene.land });
  const coastPath = scene.coastPath;
  const shelf = Math.max(scene.world.w, scene.world.h) / 2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = theme.oceanRing;
  for (const [f, a] of [
    [0.12, 0.35],
    [0.055, 0.7],
  ]) {
    ctx.globalAlpha = a;
    ctx.lineWidth = 2 * f * shelf;
    ctx.stroke(coastPath);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.land;
  ctx.fill(coastPath);

  // Every place's ground, crossfading children in as they grow, then the streets between each place's lots (MARK-15).
  ctx.save();
  ctx.clip(coastPath);
  let hatchPattern = null;
  let crackPattern = null;
  const fogged = [];
  const towns = [];
  const { grounds, streets, parks } = lotsAt(scene, view, { lens, T });
  for (const { n, g, s, alpha, ground, here } of grounds) {
    const path = pathFor(g);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = ground;
    ctx.fill(path);
    if (lens.hatch?.(n) && s > 14) {
      hatchPattern ??= hatch(ctx, theme.dark ? 'rgba(255,255,255,0.25)' : 'rgba(60,64,67,0.28)');
      hatchPattern.setTransform(new DOMMatrix().scale(1 / k));
      ctx.fillStyle = hatchPattern;
      ctx.fill(path);
    }
    if (lens.cracks?.(n) && s > 14) {
      const before = ctx.globalAlpha;
      crackPattern ??= cracks(ctx);
      ctx.globalAlpha = before * (theme.dark ? 0.6 : 1);
      crackPattern.setTransform(new DOMMatrix().scale(1 / k));
      ctx.fillStyle = crackPattern;
      ctx.fill(path);
      ctx.globalAlpha = before;
    }
    // Houses and fog belong to what you can see: a region hands them to its children as they fade in.
    if (here > 0.02 && !thumbnail) towns.push({ n, g, w: here });
    // Fog lies over the unknown parts of what you can see, wherever they are inside it (FOG-01).
    if (lens.fog && here > 0.02) for (const f of fogPatches(n, { fog: lens.fog, geo, k, inView })) fogged.push({ g: f.g, s, w: here * f.w });
  }
  // A big issue's open land is park green in every lens (MARK-18).
  for (const p of parks) {
    ctx.globalAlpha = p.alpha;
    ctx.fillStyle = p.ground;
    ctx.fill(pathFor(p.g));
  }
  // Each lot is set back from its neighbours by a street of its parent's ground, inside its own edge. Drawn inside the
  // lot, so the two halves of a street between neighbours meet, and the parent's wider streets go over its lots' own.
  for (const { ground, alpha, width, lots, park } of streets) {
    for (const lot of park ? [...lots, park] : lots) {
      const path = pathFor(lot.g);
      ctx.save();
      ctx.clip(path);
      ctx.globalAlpha = alpha * Math.min(1, lot.alpha / alpha);
      ctx.strokeStyle = lot.edge;
      ctx.lineWidth = (width + 2.4) / k;
      ctx.stroke(path);
      ctx.strokeStyle = ground;
      ctx.lineWidth = width / k;
      ctx.stroke(path);
      ctx.restore();
    }
  }

  // Country borders on top of the lots inside them.
  ctx.strokeStyle = theme.border;
  for (const { n, g, alpha } of grounds) {
    if (n.depth !== 1) continue;
    ctx.globalAlpha = alpha * 0.85;
    ctx.lineWidth = 2.2 / k;
    ctx.stroke(pathFor(g));
  }
  // A house holds what its town stood for (MARK-16): its own small squares hand over to the building as it appears.
  const houses = thumbnail ? [] : housesAt(grounds, { geo, k, live });
  const built = new Map(houses.map((h) => [h.n.id, h.alpha]));
  for (const t of towns) t.w *= 1 - (built.get(t.n.id) ?? 0);
  if (towns.length) drawTowns(ctx, towns, k, theme.dark, scene);
  if (houses.length) drawBuildings(ctx, houses, k, theme.dark);
  if (fogged.length) drawFog(ctx, fogged, k, time, theme.dark);
  // Bulldozers stand above the fog: work going on is news, however little is known about the land (MARK-17).
  for (const h of houses) if (h.bulldozer) drawBulldozer(ctx, h.bulldozer, h.size / k, h.alpha);
  for (const h of houses) if (h.waiting) drawWaiting(ctx, h.waiting, h.size / k, h.alpha, theme.dark);

  const hovered = hoverId && (scene.nodeOf?.(hoverId) ?? tree.byId.get(hoverId));
  if (hovered && !thumbnail) {
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = theme.dark ? '#ffffff' : '#202124';
    ctx.lineWidth = 2 / k;
    ctx.stroke(pathFor(geo.get(hovered.id)));
  }
  const selected = selectedId && tree.byId.get(selectedId);
  if (selected) {
    const p = pathFor(geo.get(selected.id));
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = ACCENT;
    ctx.fill(p);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 3 / k;
    ctx.stroke(p);
  }
  ctx.restore();

  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.coast;
  ctx.lineWidth = 1.5 / k;
  ctx.stroke(coastPath);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (thumbnail) return null;

  // The stand-in for a node at this zoom: the shallowest ancestor whose children aren't labelled yet
  // (for routes), or whose children aren't drawn yet (for incident dots).
  const repCache = new Map();
  const rep = (n, drawnOnly = false) => {
    const key = drawnOnly ? `d${n.id}` : n.id;
    if (repCache.has(key)) return repCache.get(key);
    let r = n;
    for (const a of pathOf(n)) {
      if (a === n || (drawnOnly ? sizeOf(a) < T.sub * 1.02 : yieldOf(a) < 0.5)) {
        r = a;
        break;
      }
    }
    repCache.set(key, r);
    return r;
  };
  const onScreen = ([sx, sy], m = 40) => sx > -m && sx < W + m && sy > -m && sy < H + m;

  // Sea captions name the continents, like ocean names on a map: above the coast, or
  // below it when a neighbour's name is in the way. A continent that is itself an item
  // hands over to its own label once you zoom past the overview.
  if (scene.notes?.length) {
    const handover = yieldOf(tree.root);
    const font = `italic 600 12.5px ${FONT}`;
    const lh = 15;
    const taken = [];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.water;
    for (const note of scene.notes) {
      const alpha = note.own ? 1 - handover : 1;
      if (alpha < 0.02 || !onScreen(toScreen(note.at), 160)) continue;
      ctx.letterSpacing = '2px';
      const lines = wrap(ctx, note.text.toUpperCase(), font, Math.max(130, note.w * k * 1.2), 3);
      ctx.font = font;
      const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
      let box = null;
      for (const [pos, above] of [
        [note.at, true],
        [note.below, false],
      ]) {
        const [px, py] = toScreen(pos);
        const b = { x: px - tw / 2, y: above ? py + lh / 2 - lines.length * lh : py - lh / 2, w: tw, h: lines.length * lh };
        if (!taken.some((r) => rectsOverlap(r, b, 6))) {
          box = b;
          break;
        }
      }
      if (!box) continue;
      taken.push(box);
      ctx.globalAlpha = alpha * 0.9;
      lines.forEach((l, i) => ctx.fillText(l, box.x + tw / 2, box.y + lh / 2 + i * lh));
    }
    ctx.letterSpacing = '0px';
    ctx.globalAlpha = 1;
  }

  // Routes: links aggregated to whatever is visible at this zoom level.
  if (showLinks) {
    const sel = selected;
    const colors = theme.dark ? LINK_COLOR_NIGHT : LINK_COLOR;
    for (const e of roads(tree, rep, sel)) {
      const p0 = toScreen(geo.get(e.a.id).label);
      const p1 = toScreen(geo.get(e.b.id).label);
      const minX = Math.min(p0[0], p1[0]), maxX = Math.max(p0[0], p1[0]);
      const minY = Math.min(p0[1], p1[1]), maxY = Math.max(p0[1], p1[1]);
      if (maxX < -50 || minX > W + 50 || maxY < -50 || minY > H + 50) continue;
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      const len = Math.hypot(dx, dy);
      if (len < 24) continue;
      const cx = (p0[0] + p1[0]) / 2 - dy * 0.18, cy = (p0[1] + p1[1]) / 2 + dx * 0.18;
      // Trim the ends so arrows stop short of label centres.
      const trim = Math.min(18, len * 0.2);
      const t0 = trim / len, t1 = 1 - trim / len;
      const q = (t) => [
        (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * cx + t * t * p1[0],
        (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * cy + t * t * p1[1],
      ];
      const s0 = q(t0), s1 = q(t1), sm = q(0.5);
      const w = 1.6 + Math.min(4, (e.count - 1) * 0.8);
      ctx.globalAlpha = sel && !e.hot ? 0.22 : 0.92;
      // Control point for the trimmed sub-curve.
      const ccx = 2 * sm[0] - (s0[0] + s1[0]) / 2, ccy = 2 * sm[1] - (s0[1] + s1[1]) / 2;
      const curve = new Path2D();
      curve.moveTo(s0[0], s0[1]);
      curve.quadraticCurveTo(ccx, ccy, s1[0], s1[1]);
      // Road casing first, like a map's white outline around highways.
      ctx.strokeStyle = theme.halo;
      ctx.lineWidth = w + 3;
      ctx.stroke(curve);
      ctx.strokeStyle = colors[e.type];
      ctx.lineWidth = w + (sel && e.hot ? 1 : 0);
      ctx.setLineDash(e.type === 'relates' ? [6, 5] : []);
      ctx.stroke(curve);
      ctx.setLineDash([]);
      const ang = Math.atan2(s1[1] - ccy, s1[0] - ccx);
      const ah = 7 + w;
      ctx.fillStyle = colors[e.type];
      ctx.beginPath();
      ctx.moveTo(s1[0], s1[1]);
      ctx.lineTo(s1[0] - ah * Math.cos(ang - 0.45), s1[1] - ah * Math.sin(ang - 0.45));
      ctx.lineTo(s1[0] - ah * Math.cos(ang + 0.45), s1[1] - ah * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
      if (e.count > 1 && len > 80) {
        ctx.globalAlpha = 1;
        ctx.font = `700 11px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = colors[e.type];
        ctx.beginPath();
        ctx.arc(sm[0], sm[1], 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(String(e.count), sm[0], sm[1] + 0.5);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Night lights: additive glows, so clusters of new features shine brighter.
  if (lens.lights) {
    ctx.globalCompositeOperation = 'lighter';
    for (const n of tree.list) {
      if (!lens.lights(n)) continue;
      const g = geo.get(n.id);
      const p = toScreen(g.label);
      if (!onScreen(p, 60)) continue;
      const color = LIGHT_COLORS[n.status] ?? '#ffbf5e';
      const r = Math.min(46, Math.max(12, Math.sqrt(sizeOf(n)) * 2.4));
      const grad = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r);
      grad.addColorStop(0, color);
      grad.addColorStop(0.18, `${color}cc`);
      grad.addColorStop(0.5, `${color}33`);
      grad.addColorStop(1, `${color}00`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // Incident dots for items too small to label at this zoom.
  if (lens.dots) {
    for (const n of tree.list) {
      if (!lens.dots(n)) continue;
      if (rep(n, true) === n && sizeOf(n) >= 62) continue;
      const p = toScreen(geo.get(n.id).label);
      if (!onScreen(p, 10)) continue;
      const r = n.priority === 'P0' ? 5.5 : n.priority === 'P1' ? 4.6 : 3.8;
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fillStyle = lens.dotColor?.(n) ?? '#d93025';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
  }

  const shown = namesOnScreen(ctx, scene, view, { selectedId, live, theme, insets: opts.insets, T });
  const labels = [];
  for (const c of shown) {
    const markers = drawBlock(ctx, c.block, c.drawn, c.alpha, theme);
    labels.push({ id: c.n.id, rect: c.drawn, alpha: c.alpha, markers });
  }

  if (selected) {
    const lbl = labels.find((l) => l.id === selected.id && l.alpha > 0.4);
    const p = lbl ? [lbl.rect.x + lbl.rect.w / 2, lbl.rect.y - 2] : toScreen(geo.get(selected.id).label);
    if (onScreen(p, 30)) drawPin(ctx, p[0], p[1]);
  }

  const focus = placeInView(scene, view, { center: opts.center, T });
  return { labels, focusId: focus?.id ?? null, drifting: fogged.length > 0 };
}

/**
 * The roads on screen (SYM-05): every link drawn between the visible stand-ins of its two ends, merged
 * when several links join the same two places. `visible(n)` is what stands for n at this zoom.
 * @returns {{ a, b, type, count, hot }[]}  hot when the link touches the selection
 */
export function roads(tree, visible, selected) {
  const agg = new Map();
  for (const n of tree.list) {
    for (const l of n.links) {
      const target = tree.byId.get(l.to);
      if (!target) continue;
      const a = visible(n), b = visible(target);
      if (a === b || isInside(a, b) || isInside(b, a)) continue;
      const key = `${a.id}>${b.id}:${l.type}`;
      const e = agg.get(key) ?? { a, b, type: l.type, count: 0, hot: false };
      e.count++;
      if (selected && (isInside(n, selected) || isInside(target, selected))) e.hot = true;
      agg.set(key, e);
    }
  }
  return [...agg.values()];
}

/**
 * The item a marker under a screen point stands for (MARK-05), or null: choosing a marker goes straight to
 * the item it counts (for a rolled-up cluster, the most urgent of them).
 */
export function markerAt(info, sx, sy) {
  for (let i = (info?.labels.length ?? 0) - 1; i >= 0; i--) {
    const l = info.labels[i];
    if (l.alpha < 0.5) continue;
    const m = l.markers?.find(({ rect: r }) => sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h);
    if (m) return m.target;
  }
  return null;
}

/**
 * What a pointer at a screen point lands on (SYM-08): a pin under it is that pin's item, since a region keeps
 * its pin over its items' land (MARK-13); elsewhere it is the innermost item whose land is there. Hover and
 * click both ask this, so what lights up is what opens.
 */
export function hitTest(scene, view, info, sx, sy) {
  const marker = markerAt(info, sx, sy);
  if (marker) return marker;
  let byLabel = null;
  for (let i = (info?.labels.length ?? 0) - 1; i >= 0 && !byLabel; i--) {
    const l = info.labels[i];
    if (l.alpha >= 0.5 && sx >= l.rect.x && sx <= l.rect.x + l.rect.w && sy >= l.rect.y && sy <= l.rect.y + l.rect.h) byLabel = scene.nodeOf?.(l.id) ?? scene.tree.byId.get(l.id) ?? null;
  }
  const { tree, geo, land } = scene;
  const { x, y, k, width: W, height: H } = view;
  const T = thresholds(W, H);
  const p = [(sx - x) / k, (sy - y) / k];
  let byLand = null;
  if (land.some((ring) => polygonContains(ring, p))) {
    byLand = tree.root;
    const kidsOf = scene.kidsOf ?? ((n) => n.children);
    while (kidsOf(byLand).length && (geo.get(byLand.id)?.size ?? 0) * k >= T.sub * 1.02) {
      // A lot the layout drew no land for (a park, a lot still being laid out) is never under the pointer.
      const next = kidsOf(byLand).find((c) => geo.get(c.id)?.poly && polygonContains(geo.get(c.id).poly, p));
      if (!next) break;
      byLand = next;
    }
  }
  return (byLabel ?? byLand)?.id ?? null;
}
