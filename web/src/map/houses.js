// Houses on their lots (#46 MARK-16, MARK-17, MARK-20). An issue is a block, and each behaviour it lists is a house on
// its own lot in that block (MARK-15), in rows along streets (streetRows in geometry.js), named by its ID: an issue with 19
// behaviours is a street of 19 houses. A child issue is a block within its parent's, holding its own behaviours' houses,
// so a behaviour that grows into its own issue becomes a block where its house stood. Every house is a small grey
// building footprint facing the same way. A house whose behaviour is being coded (a live claim, MCP-04) has a bulldozer
// on its lot, which leaves when the claim ends.

import { polygonContains } from 'd3';
import { itemKeyOf } from '@shared/issue-shape.js';
import { smoothstep } from './geometry.js';

/** Is this item a house: a behaviour, written in its issue or mapped as an item of its own? */
export const isHouse = (n) => n.kind === 'behavior' && n.depth > 0;

/** The id of the house a behaviour stands in, on its issue's block. */
export const houseId = (n, behaviour) => `${n.id}~${behaviour}`;
/** What an id on the map opens: the item, and the behaviour when it is a house (choosing a house opens its issue there). */
export function openedBy(id) {
  const at = id?.indexOf('~') ?? -1;
  return at < 0 ? { id: id ?? null, behaviour: null } : { id: id.slice(0, at), behaviour: id.slice(at + 1) };
}

/**
 * The houses on each issue's block, from the behaviours it lists (tree.js `behaviourRows`), in behaviour ID order: by
 * issue id, each house a stand-in for one behaviour that the map draws, names and points at like an item of its own.
 * `byId` finds a house by its id.
 */
export function behaviourHouses(tree) {
  const byIssue = new Map(), byId = new Map();
  for (const n of tree.list) {
    if (!n.behaviourRows?.length) continue;
    const houses = n.behaviourRows.map((b) => ({
      id: houseId(n, b.id),
      kind: 'behavior',
      title: b.words ? `${b.id} ${b.words}` : b.id,
      depth: n.depth + 1,
      parent: n,
      children: [],
      tags: [],
      links: [],
      status: n.status,
      // The issue's own measures, for lenses, except that a house is never fog of its own: the issue carries that.
      stats: { ...n.stats, vague: false, own: 0, open: 0 },
      behaviour: b.id,
      issue: n,
    }));
    byIssue.set(n.id, houses);
    for (const h of houses) byId.set(h.id, h);
  }
  return { byIssue, byId };
}

// Places hold their parts where you'd look for them; only an issue can be a street of houses.
const NOT_BLOCKS = new Set(['project', 'area']);
const BEHAVIOUR_ID = /^([A-Z][A-Z0-9]*-\d+)\b/;
// Where a lot stands in its block: a house by its behaviour's ID, and a child issue by the first behaviour it holds, so a
// behaviour that grows into its own issue keeps its place (its ID moves with it). Anything else keeps its order, after.
const placeKey = (c) => c.behaviour ?? c.behaviourRows?.[0]?.id ?? (c.kind === 'behavior' ? String(c.title ?? '').match(BEHAVIOUR_ID)?.[1] : null) ?? null;
const inIdOrder = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b, undefined, { numeric: true }));

const lotCache = new WeakMap();
/**
 * The lots in an issue's block, in the order they are laid out and drawn: its child issues and its behaviours' houses
 * (`houses` from behaviourHouses). `block` says they stand in street rows: an issue whose lots are mostly houses.
 */
export function lotsOf(n, houses) {
  let byNode = lotCache.get(houses);
  if (!byNode) lotCache.set(houses, (byNode = new WeakMap()));
  if (byNode.has(n)) return byNode.get(n);
  const own = houses.byIssue.get(n.id) ?? [];
  let lots = [...n.children, ...own];
  const block = lots.length > 0 && !NOT_BLOCKS.has(n.kind) && !n.tags?.includes('code') && lots.filter(isHouse).length * 2 >= lots.length;
  if (block) lots = lots.map((c, i) => ({ c, i, key: placeKey(c) })).sort((a, b) => inIdOrder(a.key, b.key) || a.i - b.i).map((x) => x.c);
  const out = { lots, block };
  byNode.set(n, out);
  return out;
}

/** A house shows once its lot is this big on screen (px), fully from the second: a footprint smaller than this can't be read. */
export const HOUSE = { from: 70, full: 100 };

/**
 * Live claims (MCP-04) as how many agents are at work, by node id for each item and by house id for each behaviour: claims
 * are per behaviour, so the bulldozer stands on the house of the behaviour being coded. A claim that has run out holds nothing.
 */
export function claimsByNode(claims, tree, now = Date.now()) {
  const byKey = new Map(tree.list.map((n) => [itemKeyOf(n), n]));
  const who = new Map();
  const add = (id, owner) => {
    if (!who.has(id)) who.set(id, new Set());
    who.get(id).add(owner);
  };
  for (const c of claims ?? []) {
    const n = byKey.get(c.item);
    if (!n || !(Date.parse(c.until) > now)) continue;
    const owner = c.owner ?? c.agentName;
    add(n.id, owner);
    if (c.behaviour && n.behaviourRows?.some((b) => b.id === c.behaviour)) add(houseId(n, c.behaviour), owner);
  }
  return new Map([...who].map(([id, agents]) => [id, agents.size]));
}

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
    // A house stands in the middle of its lot, never filling it, leaving room for a bulldozer beside it. Every house
    // faces the same way, wider than deep, so a block's houses line up like a street's.
    let hw = g.labelR * 0.62, hh = hw * 0.6;
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
