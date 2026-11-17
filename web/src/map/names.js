// Where names go on screen, and how they give way to each other (#46 MARK-13). No two names overlap: where they would,
// the more important one stays and the other fades as it comes in, so nothing pops. The selected item comes first,
// then items with something going on (fires, open questions, work under way), then bigger ones. A bigger place is
// bigger at every zoom, so who gives way never changes as you zoom.

import { smoothstep } from './geometry.js';

/**
 * Names start making room this close (px), and have made it by the time they touch: a big name, like the project's
 * card sliding along the coast, from further off, so it fades rather than vanishes.
 */
const ROOM = 12;
const gap = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
const near = (a, b) => 1 - smoothstep(0, Math.max(ROOM, 0.5 * Math.min(a.w, a.h), 0.5 * Math.min(b.w, b.h)), gap(a, b));

/**
 * Let the names at this view make room for each other. Each candidate (from `namesAt`) brings `rect`, the room it takes
 * on screen, and `urgent` when something is going on there. Returns those still showing, each with how strongly it now
 * shows (`shown` is how strongly it would without the others); the selected item always shows in full.
 */
export function placeNames(cands, { selected = null } = {}) {
  const rank = (c) => (c.n === selected ? 0 : c.urgent ? 1 : 2);
  const order = [...cands].sort((a, b) => rank(a) - rank(b) || b.g.size - a.g.size || (a.n.id < b.n.id ? -1 : 1));
  const placed = [];
  for (const c of order) {
    let keep = 1;
    // Houses on a block never crowd each other: each name stays on its own lot (MARK-16), and its lots are rows that don't overlap.
    if (c.n !== selected) for (const q of placed) if (!(q.g.footprint && c.g.footprint)) keep *= 1 - q.alpha * near(q.rect, c.rect);
    placed.push({ ...c, alpha: c.alpha * keep, shown: c.alpha });
  }
  return placed.filter((p) => p.alpha > 0.02);
}
