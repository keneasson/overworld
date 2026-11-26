// Every item is its own lot (#46 MARK-15). Once a place is big enough on screen for its items' outlines to be read,
// each item is drawn as a property of its own: its own ground, shaded apart from every lot it touches, and its own
// edge, set back from its neighbours by a street of its parent's ground. A region reads as a block of distinct
// properties rather than one colour, and a parent's lot visibly holds its children's lots, streets inside streets.
// The lens still decides the colour of the land; lots only shade it, so they work the same in every lens.

import { hsl, interpolateRgb } from 'd3';
import { smoothstep } from './geometry.js';

// Open land is park green in every lens, like a park on a street map (MARK-18): it says "not built yet", not what the lens measures.
export const PARK = { light: '#c8ecc4', dark: '#2e5b3d' };
// Wide open country at the vague edges of a place that promises far more than is written in it (PLACE-02).
export const DESERT = { light: '#efe2bf', dark: '#5b5136' };

/** The open land between a place's items: desert where it is mostly unwritten, park where it is well defined. */
export const openLandOf = (n, geo, dark) => ((geo.get(n.id)?.open ?? 0) > 0.45 ? (dark ? DESERT.dark : DESERT.light) : dark ? PARK.dark : PARK.light);

// Lightness steps for neighbouring lots. Siblings that touch never share one; a handful is enough for any map.
const SHADES = [0, 0.075, -0.065, 0.14, -0.12, 0.2, -0.17];

const neighbourCache = new WeakMap();
// How far apart two outlines may be and still share a border, in world units: borders are bent after lots are cut.
const NEAR = 0.05;
const onOutline = ([px, py], poly) => {
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    if (Math.hypot(ax + t * dx - px, ay + t * dy - py) < NEAR) return true;
  }
  return false;
};
/** Do two lots share a border: at least two of one's corners on the other's outline? (Lots meeting at a point don't.) */
function touching(a, b) {
  const [x0, y0, x1, y1] = b.bbox;
  if (a.bbox[0] > x1 + NEAR || a.bbox[2] < x0 - NEAR || a.bbox[1] > y1 + NEAR || a.bbox[3] < y0 - NEAR) return false;
  let on = 0;
  for (const p of a.poly) {
    if (p[0] < x0 - NEAR || p[0] > x1 + NEAR || p[1] < y0 - NEAR || p[1] > y1 + NEAR) continue;
    if (onOutline(p, b.poly) && ++on >= 2) return true;
  }
  return false;
}
/** Which of a parent's children touch each other: their outlines share a border. */
export function neighboursOf(geo, parent) {
  let byParent = neighbourCache.get(geo);
  if (!byParent) neighbourCache.set(geo, (byParent = new Map()));
  if (byParent.has(parent.id)) return byParent.get(parent.id);
  const kids = parent.children;
  const near = new Map(kids.map((c) => [c.id, new Set()]));
  for (let i = 0; i < kids.length; i++)
    for (let j = i + 1; j < kids.length; j++) {
      const [a, b] = [geo.get(kids[i].id), geo.get(kids[j].id)];
      if (touching(a, b) || touching(b, a)) {
        near.get(kids[i].id).add(kids[j].id);
        near.get(kids[j].id).add(kids[i].id);
      }
    }
  byParent.set(parent.id, near);
  return near;
}

const shadeCache = new WeakMap();
/** A lot's shade among its siblings: the first step none of the lots it touches has taken. */
export function shadeOf(geo, n) {
  if (!n.parent || n.parent.children.length < 2) return 0;
  let shades = shadeCache.get(geo);
  if (!shades) shadeCache.set(geo, (shades = new Map()));
  if (!shades.has(n.id)) {
    const near = neighboursOf(geo, n.parent);
    // The most crowded lots choose first, so a few steps go round.
    const order = [...n.parent.children].sort((a, b) => near.get(b.id).size - near.get(a.id).size || (a.id < b.id ? -1 : 1));
    const step = new Map();
    for (const c of order) {
      const taken = new Set([...near.get(c.id)].map((id) => step.get(id)).filter((s) => s !== undefined));
      let s = 0;
      while (taken.has(s) && s < SHADES.length - 1) s++;
      step.set(c.id, s);
    }
    for (const [id, s] of step) shades.set(id, SHADES[s]);
  }
  return shades.get(n.id);
}

/** The lens's colour for the land, shaded by its step: lighter or darker, staying within what reads as land. */
export function shaded(fill, shade) {
  if (!shade) return fill;
  const c = hsl(fill);
  if (Number.isNaN(c.l)) return fill;
  let l = c.l + shade;
  if (l > 0.96 || l < 0.12) l = c.l - shade;
  c.l = Math.min(0.96, Math.max(0.12, l));
  return c.formatHex();
}

/** A lot's edge: a firmer line in its own colour, so the property line reads on any ground. */
export function edgeOf(ground, dark) {
  const c = hsl(ground);
  if (Number.isNaN(c.l)) return dark ? '#ffffff' : '#3c4043';
  c.l = dark ? Math.min(0.92, c.l + 0.22) : Math.max(0.12, c.l - 0.24);
  c.s = Math.min(1, (c.s || 0) * 0.8);
  return c.formatHex();
}

/** How wide the street between a parent's lots is on screen: wider between big lots, so the nesting reads. */
export const streetOf = (parentSize) => Math.min(7, Math.max(1.5, parentSize * 0.007));

/**
 * The lots drawn at this view, in paint order (MARK-15, crossfading in as MARK-10 lets each layer appear): every place
 * on screen with its ground, and every group of lots with the street between them and their edges. `here` is how much
 * of a place is its own land at this zoom rather than its children's, for what is drawn on it (houses, fog). `parks` is
 * the open land of big issues with few houses (MARK-18), drawn over their parent's ground like a lot.
 */
export function lotsAt(scene, view, { lens, T }) {
  const { tree, geo } = scene;
  const kidsOf = scene.kidsOf ?? ((n) => n.children);
  const { x, y, k, width: W, height: H } = view;
  const vp = [-x / k, -y / k, (W - x) / k, (H - y) / k];
  const inView = (bb) => bb[2] >= vp[0] && bb[0] <= vp[2] && bb[3] >= vp[1] && bb[1] <= vp[3];
  const grounds = [];
  const streets = [];
  const parks = [];
  const walk = (n, alpha, ground) => {
    const g = geo.get(n.id);
    if (!inView(g.bbox)) return;
    const s = g.size * k;
    const sub = kidsOf(n).length ? smoothstep(T.sub * 0.8, T.sub * 1.25, s) : 0;
    // As its items come into view, its own ground turns into the open land between them (PLACE-02, PLACE-03).
    const open = sub > 0.01 ? interpolateRgb(ground, openLandOf(n, geo, lens.theme.dark))(sub) : ground;
    if (alpha > 0.01) grounds.push({ n, g, s, alpha, ground: open, here: alpha * (1 - sub) });
    if (sub <= 0.01) return;
    const lots = [];
    for (const c of kidsOf(n)) {
      const before = grounds.length;
      // A behaviour's house stands on its own lot of its block's colour (MARK-16); a child issue is land of its own.
      walk(c, sub, c.issue ? ground : shaded(lens.fill(c, tree), shadeOf(geo, c)));
      if (grounds.length > before) lots.push(grounds[before]);
    }
    // The root's children are the islands, drawn with their own coasts; lots start inside them.
    if (n.depth > 0 && lots.length) streets.push({ of: n, ground: open, alpha: sub, width: streetOf(s), lots: lots.map((l) => ({ ...l, edge: edgeOf(l.ground, lens.theme.dark) })), park: null });
  };
  walk(tree.root, 1, lens.fill(tree.root, tree));
  return { grounds, streets, parks };
}
