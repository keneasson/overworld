// Houses on their lots (#46 MARK-16, MARK-17). Zoomed in far enough, an issue that is work (a leaf: the issues an agent
// can code) is a house: a small grey building footprint on its own lot (MARK-15), not filling it, every house facing
// the same way. An issue's lots stand in rows along streets (streetRows in geometry.js), so its houses line up like a
// street's and a feature reads as a neighbourhood. The footprint grows with what the
// issue holds. A house whose behaviours are being coded (a live claim, MCP-04) has a bulldozer on its lot, which leaves
// when the claim ends.

import { polygonContains } from 'd3';
import { itemKeyOf } from '@shared/issue-shape.js';
import { smoothstep } from './geometry.js';
import { holdingsOf } from './labels.js';

// Places and spec rows are never houses; neither is land mapped from the code.
const NOT_HOUSES = new Set(['project', 'area', 'epic', 'behavior']);
/** Is this item a house: a leaf issue that is work? */
export const isHouse = (n) => n.depth > 0 && !n.children.length && !NOT_HOUSES.has(n.kind) && !n.tags?.includes('code');

/** A house shows once its lot is this big on screen (px), fully from the second: a footprint smaller than this can't be read. */
export const HOUSE = { from: 70, full: 100 };

/** Live claims (MCP-04) as how many agents are at work on each item, by node id. A claim that has run out holds nothing. */
export function claimsByNode(claims, tree, now = Date.now()) {
  const byKey = new Map(tree.list.map((n) => [itemKeyOf(n), n.id]));
  const who = new Map();
  for (const c of claims ?? []) {
    const id = byKey.get(c.item);
    if (!id || !(Date.parse(c.until) > now)) continue;
    if (!who.has(id)) who.set(id, new Set());
    who.get(id).add(c.owner ?? c.agentName);
  }
  return new Map([...who].map(([id, agents]) => [id, agents.size]));
}

// How much an issue holds, for the size of its house: more behaviours, questions, bugs and code make a bigger building.
const weightOf = (n) => {
  const h = holdingsOf(n);
  return (n.stats?.own ?? 0) + h.behaviours + h.questions + h.bugs + h.files / 4;
};

/**
 * The houses drawn at this view, from the lots on screen (`lotsAt(...).grounds`): each with its footprint's corners in
 * world coordinates, how strongly it shows, and where its bulldozer stands while it is being coded (`live.agents`).
 */
export function housesAt(grounds, { k, live = {} }) {
  const out = [];
  for (const { n, g, s, alpha } of grounds) {
    if (!isHouse(n)) continue;
    const show = alpha * smoothstep(HOUSE.from, HOUSE.full, s);
    if (show < 0.02) continue;
    // A house stands in the middle of its lot, never filling it: from a cottage to most of the room there is. Every house
    // faces the same way, wider than deep, so a block's houses line up like a street's.
    const grow = Math.min(1, Math.log1p(weightOf(n)) / Math.log1p(24));
    let hw = g.labelR * (0.5 + 0.35 * grow), hh = hw * 0.6;
    const [cx, cy] = g.label;
    const box = () => [
      [cx - hw, cy - hh],
      [cx + hw, cy - hh],
      [cx + hw, cy + hh],
      [cx - hw, cy + hh],
    ];
    // Borders bend after lots are cut, so a house that would cross its lot's edge is built smaller.
    let corners = box();
    for (let i = 0; i < 6 && !corners.every((p) => polygonContains(g.poly, p)); i++) {
      hw *= 0.85;
      hh *= 0.85;
      corners = box();
    }
    const coded = (live.agents?.get(n.id) ?? 0) > 0;
    // The bulldozer works on the lot beside the house, in the corner nearest the street.
    const bulldozer = coded ? [cx + hw + (g.labelR - hw) * 0.45, cy + hh + (g.labelR - hh) * 0.25] : null;
    out.push({ n, g, alpha: show, corners, area: 4 * hw * hh, bulldozer, size: Math.max(16, Math.min(28, g.labelR * k * 0.3)) });
  }
  return out;
}
