// Canvas renderer with semantic zoom.
//
// Every node has a screen size s = sqrt(area) * zoom. Two thresholds drive the map:
//   sub   — when a node is this big its children's borders and colours appear
//   yield — when a node is this big its own label steps aside (becoming a faint
//           watermark, like a country name) and its children's labels take over.
// So the amount of text on screen stays roughly constant while the subject
// shifts from macro (areas) to micro (a single task's acceptance criteria).

import { hsl, polygonContains } from 'd3';
import { isInside, pathOf } from '../model/tree.js';
import { LIGHT_COLORS } from './lenses.js';
import { labelFor, shortTitle } from './labels.js';
import { drawSymbol } from './symbols.js';
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
  let k = n.children.length ? Math.max(kFit, (1.22 * T.yld) / g.size) : Math.min(kFit * 1.15, (0.9 * T.vmin) / g.size);
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

function labelBlock(ctx, c, { k, theme, W, live }) {
  const { n, s, g } = c;
  const label = labelFor(n, s, live);
  const root = n.depth === 0;
  const r = root ? 18 : s >= 330 ? 15 : s >= 150 ? 13 : 11;
  const size = root ? Math.min(26, Math.max(19, s / 26)) : s >= 330 ? Math.min(17, Math.max(14, s / 26)) : s >= 150 ? 13.5 : s >= 95 ? 12 : 11;
  const font = `${root || s >= 150 ? 700 : 600} ${size}px ${FONT}`;
  const maxW = root ? Math.min(420, W * 0.7) : Math.max(60, Math.min(s >= 330 ? 260 : 190, g.labelR * k * 1.8));
  const lines = wrap(ctx, label.title, font, maxW, label.lines);
  ctx.font = font;
  const titleW = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
  ctx.font = `700 10.5px ${FONT}`;
  const badges = label.badges.map((b) => ({ ...b, w: 16 + (b.count > 1 ? ctx.measureText(String(b.count)).width + 3 : 0) + 6 }));
  const badgesW = badges.reduce((sum, b) => sum + b.w + 3, 0);
  const lh = Math.round(size * 1.25);
  const head = 2 * r + 4;
  // The symbol stays centred over the title; badges hang off its right side, balanced by empty room on the left.
  const w = Math.max(titleW, 2 * r + 2 * (badgesW ? badgesW + 4 : 0)) + (root ? 32 : 0);
  const h = head + lines.length * lh + (root ? 20 : 0);
  return { label, r, lines, font, lh, head, badges, w, h, panel: root };
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
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = theme.dark ? 'rgba(255,255,255,0.7)' : '#ffffff';
  ctx.stroke();
  drawSymbol(ctx, label.symbol, cx, cy, r * 1.15, inkOn(label.fill));

  let bx = cx + r + 4;
  for (const b of block.badges) {
    const by = cy - r * 0.35;
    ctx.beginPath();
    ctx.roundRect(bx, by - 8, b.w, 16, 8);
    ctx.fillStyle = theme.dark ? '#1f2a44' : '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.dark ? '#5d6f9e' : '#9aa0a6';
    ctx.stroke();
    drawSymbol(ctx, b.type, bx + 3 + 5.5, by, 11, BADGE_INK[b.type]);
    if (b.count > 1) {
      ctx.font = `700 10.5px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = theme.text;
      ctx.fillText(String(b.count), bx + 16, by + 0.5);
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
}

const BADGE_INK = { pull: '#8250df', agent: '#1a73e8', comment: '#e8710a', question: '#8b5cf6' };

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
  const subOf = (n, s = sizeOf(n)) => (n.children.length ? smoothstep(T.sub * 0.8, T.sub * 1.25, s) : 0);
  // A parent's label fades out completely before its children's labels fade in, so text never stacks.
  const yieldOut = (n, s = sizeOf(n)) => (n.children.length ? smoothstep(T.yld * 0.88, T.yld * 1.0, s) : 0);
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

  // Fills, recursively, crossfading children in as they grow.
  ctx.save();
  ctx.clip(coastPath);
  const drawn = [];
  const labelCands = [];
  const watermarks = [];
  let hatchPattern = null;
  const fogged = [];
  const walk = (n, alpha, parentYield) => {
    const g = geo.get(n.id);
    if (!inView(g.bbox)) return;
    const s = g.size * k;
    if (alpha > 0.01) {
      const path = pathFor(g);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = lens.fill(n, tree);
      ctx.fill(path);
      if (lens.hatch?.(n) && s > 14) {
        hatchPattern ??= hatch(ctx, theme.dark ? 'rgba(255,255,255,0.25)' : 'rgba(60,64,67,0.28)');
        hatchPattern.setTransform(new DOMMatrix().scale(1 / k));
        ctx.fillStyle = hatchPattern;
        ctx.fill(path);
      }
      drawn.push({ n, g, alpha });
    }
    const sub = subOf(n, s);
    const yld = yieldOf(n, s);
    // Fog belongs to what you can see: a region hands its cloud to its children as they fade in.
    const thick = lens.fog && alpha > 0.01 ? alpha * (1 - sub) * lens.fog(n) : 0;
    if (thick > 0.02) fogged.push({ g, s, w: thick });
    if (!thumbnail) {
      const own = (1 - yieldOut(n, s)) * parentYield * smoothstep(38, 62, s);
      if (own > 0.02) labelCands.push({ n, g, s, alpha: own });
      if (yld > 0.02 && n.depth > 0) {
        const wm = yld * (1 - smoothstep(T.yld * 1.7, T.yld * 2.8, s)) * parentYield;
        if (wm > 0.02) watermarks.push({ n, g, s, alpha: wm });
      }
    }
    if (sub > 0.01) for (const c of n.children) walk(c, sub, yld);
  };
  walk(tree.root, 1, 1);

  // Borders: deepest first so country lines sit on top of province lines.
  drawn.sort((a, b) => b.n.depth - a.n.depth);
  ctx.strokeStyle = theme.border;
  for (const { n, g, alpha } of drawn) {
    if (n.depth === 0) continue;
    const d = n.depth;
    ctx.globalAlpha = alpha * (d === 1 ? 0.85 : d === 2 ? 0.7 : 0.55);
    ctx.lineWidth = (d === 1 ? 2.2 : d === 2 ? 1.3 : 0.8) / k;
    ctx.setLineDash(d >= 3 ? [3 / k, 2.5 / k] : []);
    ctx.stroke(pathFor(g));
  }
  ctx.setLineDash([]);
  if (fogged.length) drawFog(ctx, fogged, k, time, theme.dark);

  const hovered = hoverId && tree.byId.get(hoverId);
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

  // Watermarks: yielded parents fade into big spaced capitals, like country names.
  // Deepest first; one never overprints another.
  watermarks.sort((a, b) => b.n.depth - a.n.depth);
  const wmPlaced = [];
  for (const wm of watermarks) {
    const [sx, sy] = toScreen(wm.g.label);
    if (!onScreen([sx, sy], 200)) continue;
    const size = Math.min(44, Math.max(15, wm.s / 18));
    ctx.font = `700 ${size}px ${FONT}`;
    ctx.letterSpacing = `${size * 0.14}px`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = wm.alpha * 0.4;
    ctx.fillStyle = theme.muted;
    const wmFont = ctx.font;
    const lines = wrap(ctx, shortTitle(wm.n).toUpperCase(), wmFont, Math.min(W * 0.8, wm.g.labelR * k * 1.6), 2);
    ctx.font = wmFont;
    const ww = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const box = { x: sx - ww / 2, y: sy - (lines.length * size * 1.2) / 2, w: ww, h: lines.length * size * 1.2 };
    if (wmPlaced.some((r) => rectsOverlap(r, box, 8))) continue;
    wmPlaced.push(box);
    lines.forEach((l, i) => ctx.fillText(l, sx, sy + (i - (lines.length - 1) / 2) * size * 1.2));
    ctx.letterSpacing = '0px';
  }
  ctx.globalAlpha = 1;

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

  // The project card sits in open sea beside the land, like the title cartouche on an
  // old map: west of it on wide screens, north of it on tall ones. As you zoom in it
  // slides along the coast, then waits at the screen edge until it fades.
  const ins = opts.insets ?? {};
  const cartouche = ([px, py], block) => {
    const m = 20;
    const minX = (ins.left ?? 0) + m + block.w / 2, maxX = Math.max(minX, W - m - block.w / 2);
    const minY = (ins.top ?? 0) + m + block.h / 2, maxY = Math.max(minY, H - (ins.bottom ?? 0) - m - block.h / 2);
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const wide = W - (ins.left ?? 0) >= H - (ins.top ?? 0) - (ins.bottom ?? 0);
    if (wide) return [Math.max(minX, Math.min(px, scene.world.x0 * k + x - m - block.w / 2)), clamp(py, minY, maxY)];
    return [clamp(px, minX, maxX), Math.max(minY, Math.min(py, scene.world.y0 * k + y - m - block.h / 2))];
  };

  // Labels with greedy collision avoidance: shallow and big first, selection always.
  labelCands.sort((a, b) => (b.n === selected) - (a.n === selected) || a.n.depth - b.n.depth || b.s - a.s);
  const placed = [];
  const labels = [];
  for (const c of labelCands) {
    let p = toScreen(c.g.label);
    if (!onScreen(p, c.n.depth ? 300 : Math.max(W, H))) continue;
    const block = labelBlock(ctx, c, { k, theme, W, live });
    if (c.n.depth === 0) p = cartouche(p, block);
    const rect = { x: p[0] - block.w / 2, y: p[1] - block.h / 2, w: block.w, h: block.h };
    if (c.n !== selected && placed.some((r) => rectsOverlap(r, rect, 3))) continue;
    if (c.alpha >= 0.3) placed.push(rect);
    drawBlock(ctx, block, rect, c.alpha, theme);
    labels.push({ id: c.n.id, rect, alpha: c.alpha });
  }

  if (selected) {
    const lbl = labels.find((l) => l.id === selected.id && l.alpha > 0.4);
    const p = lbl ? [lbl.rect.x + lbl.rect.w / 2, lbl.rect.y - 2] : toScreen(geo.get(selected.id).label);
    if (onScreen(p, 30)) drawPin(ctx, p[0], p[1]);
  }

  // Focus: the deepest region around the centre whose children are labelled.
  const c = opts.center ?? [W / 2, H / 2];
  const cw = [(c[0] - x) / k, (c[1] - y) / k];
  let focus = null;
  for (let cur = tree.root; cur && yieldOf(cur) >= 0.5; ) {
    focus = cur;
    cur = cur.children.find((ch) => polygonContains(geo.get(ch.id).poly, cw));
  }
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
 * What a pointer at a screen point lands on (SYM-08): the innermost item there. A visible label counts as
 * its item; where a label overlaps land whose items are drawn deeper, the deeper item wins. Hover and
 * click both ask this, so what lights up is what opens.
 */
export function hitTest(scene, view, info, sx, sy) {
  let byLabel = null;
  for (let i = (info?.labels.length ?? 0) - 1; i >= 0 && !byLabel; i--) {
    const l = info.labels[i];
    if (l.alpha >= 0.5 && sx >= l.rect.x && sx <= l.rect.x + l.rect.w && sy >= l.rect.y && sy <= l.rect.y + l.rect.h) byLabel = scene.tree.byId.get(l.id) ?? null;
  }
  const { tree, geo, land } = scene;
  const { x, y, k, width: W, height: H } = view;
  const T = thresholds(W, H);
  const p = [(sx - x) / k, (sy - y) / k];
  let byLand = null;
  if (land.some((ring) => polygonContains(ring, p))) {
    byLand = tree.root;
    while (byLand.children.length && geo.get(byLand.id).size * k >= T.sub * 1.02) {
      const next = byLand.children.find((c) => polygonContains(geo.get(c.id).poly, p));
      if (!next) break;
      byLand = next;
    }
  }
  const hit = byLabel && (!byLand || byLabel.depth >= byLand.depth) ? byLabel : byLand;
  return hit?.id ?? null;
}
