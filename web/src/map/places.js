// Where things sit in the product. The Site projection uses this to shape the
// map like the product itself: top-level surfaces (web app, mobile app, API,
// services, third parties) are continents, and inside each one items sit roughly
// where you would look for them: header on top, footer at the bottom, filters on
// the left; in a service, endpoints on top and storage at the bottom.

import { polygonContains } from 'd3';
import { hashString, mulberry32 } from './geometry.js';

const SURFACE_RULES = [
  ['external', /\b(third[- ]party|integrations?|vendors?|providers?|stripe|paypal|adyen|auth0|okta|twilio|sendgrid|mailchimp|algolia|segment|shopify|salesforce|hubspot|firebase)\b/],
  ['mobile', /\b(mobile app|ios|android|react native|flutter|native app|app store|play store)\b/],
  ['email', /\b(email templates?|emails)\b/],
  ['api', /\b(apis?|gateway|graphql|bff)\b/],
  ['service', /\b(services?|micro-?services?|back-?end|servers?|workers?)\b/],
  ['web', /\b(web ?app|website|web site|storefront|web client|front-?end|front end)\b/],
];

// On a screen (web or mobile). First match wins.
const SCREEN_RULES = [
  [
    'offscreen',
    /\b(apis?|endpoints?|back-?end|servers?|database|db|schema|migrations?|infra(structure)?|devops|ci|pipelines?|deploy(ments?)?|monitoring|observability|logging|telemetry|analytics|performance|web vitals|cach(e|ing)|cdn|security|platform|sdk|webhooks?|cron|queues?|jobs?|workers?|design system|tokens)\b/,
  ],
  ['bottom', /\b(footer|legal|copyright|newsletter|cookies?|consent|bottom (bar|nav|navigation|sheet)|tab bar)\b/],
  ['left', /\b(sidebar|side ?nav|side bar|filters?|facets?|drawer|table of contents)\b/],
  ['top-left', /\b(logo|brand(ing)?|hamburger)\b/],
  ['top-right', /\b(accounts?|profile|sign[ -]?in|log[ -]?in|avatar|identity|user menu)\b/],
  ['top', /\b(header|top ?bar|nav ?bar|navigation|menus?|mega[ -]menu|banner|announcements?|search (bar|box|field)|toolbar|app bar)\b/],
  ['right', /\b(cart|basket|checkout|payments?|order summary)\b/],
];

// Behind the screen: the way architecture diagrams are drawn.
const BACK_RULES = [
  ['top', /\b(apis?|endpoints?|routes?|handlers?|controllers?|graphql|rest|webhooks?|gateway|auth(entication)?|contracts?)\b/],
  ['bottom', /\b(database|db|storage|schema|migrations?|cach(e|ing)|queues?|index(es|ing)?|data|backups?)\b/],
  ['right', /\b(jobs?|workers?|cron|sync|events?)\b/],
];

const textOf = ({ title = '', tags = [] }) => `${title} ${tags.join(' ')}`.toLowerCase();
const isScreen = (grammar) => grammar === 'web' || grammar === 'mobile';
// An email is read like a screen: header on top, footer at the bottom.
const grammarOf = (surface) => (surface === 'web' || surface === 'email' ? 'web' : surface === 'mobile' ? 'mobile' : 'back');

/** Is this top-level item a continent of its own, and what kind? 'none' if not. */
export function guessSurface(n) {
  const text = textOf(n);
  for (const [surface, re] of SURFACE_RULES) if (re.test(text)) return surface;
  return 'none';
}

/** Best guess for where an item sits inside a parent that follows `grammar`. */
export function guessPlace(n, grammar = 'web') {
  if (n.tags?.includes('page') || n.tags?.includes('template')) return 'center'; // pages are laid out in journey order
  const text = textOf(n);
  for (const [place, re] of isScreen(grammar) ? SCREEN_RULES : BACK_RULES) if (re.test(text)) return place;
  return 'center';
}

const chosen = (v) => v && v !== 'auto';

/**
 * Resolve the Site projection for a tree, top-down:
 *   continents — for each top-level item: its own continent (with a surface), or
 *                a share of the common "On screen" / "Behind the screen" land
 *   places     — where each item sits inside its parent
 *   grammar    — how each item's own interior is read (screen or back end)
 * A guess that only repeats the parent ("header" inside the header) is ignored.
 */
export function resolveSite(tree) {
  const places = new Map();
  const grammar = new Map();
  const continents = new Map();
  for (const n of tree.list) {
    if (!n.parent) {
      places.set(n.id, 'center');
      grammar.set(n.id, 'web');
      continue;
    }
    if (!n.parent.parent) {
      const surface = chosen(n.surface) ? n.surface : guessSurface(n);
      if (surface !== 'none') {
        continents.set(n.id, { surface, own: true });
        places.set(n.id, 'center');
        grammar.set(n.id, grammarOf(surface));
        continue;
      }
    }
    const g = grammar.get(n.parent.id);
    let p = chosen(n.place) ? n.place : guessPlace(n, g);
    if (!chosen(n.place) && n.parent.parent && p === places.get(n.parent.id)) p = 'center';
    places.set(n.id, p);
    grammar.set(n.id, p === 'offscreen' || !isScreen(g) ? 'back' : g);
    if (!n.parent.parent) continents.set(n.id, { surface: p === 'offscreen' ? 'backoffice' : 'web', own: false });
  }
  return { places, grammar, continents };
}

const CELL = {
  'top-left': [0, 0],
  top: [1, 0],
  'top-right': [2, 0],
  left: [0, 1],
  center: [1, 1],
  right: [2, 1],
  'bottom-left': [0, 2],
  bottom: [1, 2],
  'bottom-right': [2, 2],
  offscreen: [1, 2], // inside a region, "behind the screen" sinks to the bottom
};
const EDGE = [0, 0.22, 0.78, 1];

/**
 * Starting points for each child inside a parent polygon. The parent is split
 * into a 3×3 grid; a band stretches across empty neighbours (a header with no
 * logo beside it spans the full width). Siblings sharing a cell are spread out
 * in reading order, so the child order (e.g. the shopping journey) reads left
 * to right, top to bottom.
 */
export function anchorsFor(places, poly, seedKey) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const W = x1 - x0, H = y1 - y0;
  const cells = places.map((p) => CELL[p] ?? CELL.center);
  const used = new Set(cells.map(([c, r]) => `${c},${r}`));
  const has = (c, r) => used.has(`${c},${r}`);
  const rowUsed = (r) => has(0, r) || has(1, r) || has(2, r);
  const rowSpan = (r) => (r === 0 ? [0, EDGE[1]] : r === 2 ? [EDGE[2], 1] : [rowUsed(0) ? EDGE[1] : 0, rowUsed(2) ? EDGE[2] : 1]);
  const colSpan = (c, r) => (c === 0 ? [0, EDGE[1]] : c === 2 ? [EDGE[2], 1] : [has(0, r) ? EDGE[1] : 0, has(2, r) ? EDGE[2] : 1]);

  const groups = new Map();
  cells.forEach(([c, r], i) => {
    const key = `${c},${r}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });

  const rng = mulberry32(hashString(seedKey));
  const anchors = new Array(places.length);
  for (const [key, items] of groups) {
    const [c, r] = key.split(',').map(Number);
    const [u0, u1] = colSpan(c, r);
    const [v0, v1] = rowSpan(r);
    const cw = (u1 - u0) * W, ch = (v1 - v0) * H;
    const m = items.length;
    let cols = Math.max(1, Math.min(m, Math.round(Math.sqrt((m * cw) / Math.max(ch, 1e-6)))));
    const rows = Math.ceil(m / cols);
    cols = Math.ceil(m / rows);
    items.forEach((idx, j) => {
      const row = Math.floor(j / cols);
      const inRow = row === rows - 1 ? m - row * cols : cols;
      const col = j - row * cols;
      // A little jitter: perfectly aligned sites make degenerate power diagrams.
      const jx = (rng() - 0.5) * 0.04, jy = (rng() - 0.5) * 0.04;
      anchors[idx] = [x0 + u0 * W + ((col + 0.5 + jx) / inRow) * cw, y0 + v0 * H + ((row + 0.5 + jy) / rows) * ch];
    });
  }
  return anchors.map((a) => pullInside(a, poly));
}

/**
 * Bring an anchor that fell outside an irregular parent back in, keeping its
 * direction: snap to the nearest point on the border, then step a little inward.
 */
function pullInside(p, poly) {
  if (polygonContains(poly, p)) return p;
  let cx = 0, cy = 0;
  for (const [x, y] of poly) {
    cx += x;
    cy += y;
  }
  cx /= poly.length;
  cy /= poly.length;
  let best = null, bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
    const q = [ax + dx * t, ay + dy * t];
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
    if (d < bestD) [best, bestD] = [q, d];
  }
  for (const t of [0.12, 0.25, 0.5]) {
    const q = [best[0] + (cx - best[0]) * t, best[1] + (cy - best[1]) * t];
    if (polygonContains(poly, q)) return q;
  }
  return [cx, cy];
}
