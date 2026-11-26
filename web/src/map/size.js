// How big a place is, and what kind of place that makes it (#104 PLACE-01). Every item is a place whose size comes from
// what it holds, never from how deep it sits: a house is one behaviour, and a place is itself plus everything inside it.
//
// Two sizes: what is written under it, and what its words promise. The gap between them is open land, the room it has to
// grow into (PLACE-02, PLACE-10). Until the promise is judged from its words (from the stored embeddings), it is a
// stand-in: a leaf's scope in houses, and for a place with items, a share more for each part of it in the Fog.
//
// This is the one place the map reads sizes from, so the model's own rollup can replace it here alone.

import { HOUSE_WEIGHT } from '../model/tree.js';
import { lotsOf } from './houses.js';

/** The kinds of place, smallest first, with the written size each starts at (PLACE-02): a map legend, short and fixed. */
export const PLACE_KINDS = [
  { kind: 'house', from: 0 },
  { kind: 'block', from: 2 },
  { kind: 'neighbourhood', from: 8 },
  { kind: 'district', from: 20 },
  { kind: 'town', from: 45 },
  { kind: 'city', from: 100 },
  { kind: 'region', from: 220 },
  { kind: 'province', from: 450 },
  { kind: 'country', from: 900 },
];

/**
 * The kind of place for a size and how many levels sit under it (PLACE-01). Depth counts as well as number: a place one
 * level deep is at most a neighbourhood however many houses stand in it, two levels at most a town, and so on.
 */
export function placeKindOf(size, levels = 0) {
  const cap = Math.max(0, levels) * 2; // 1 level: neighbourhood, 2: town, 3: region, 4 or more: country
  let at = 0;
  for (let i = 0; i < PLACE_KINDS.length; i++) if (size >= PLACE_KINDS[i].from) at = i;
  return PLACE_KINDS[Math.min(at, cap)].kind;
}

/**
 * Every place's sizes, worked out once from the leaves up: `written` (itself plus what stands in it, a house being 1),
 * `expected` (what it promises, never less than written), `levels` (how many levels sit under it) and its `kind`.
 * `houses` is behaviourHouses(tree). Returns a Map by id, houses included.
 */
export function placeSizes(tree, houses) {
  const out = new Map();
  const visit = (n) => {
    const { lots } = lotsOf(n, houses);
    let written = 1;
    let levels = 0;
    let fog = 0;
    for (const c of lots) {
      const s = visit(c);
      written += s.written;
      levels = Math.max(levels, s.levels + 1);
    }
    let expected = written;
    if (!n.issue) {
      fog = n.stats?.fog ?? 0;
      const scope = (n.stats?.raw ?? 0) / HOUSE_WEIGHT;
      const own = houses.byIssue.get(n.id)?.length ?? 0;
      // A leaf's scope until its houses outgrow it (a new idea is open land, MARK-18); a place with items promises more for each part of it still in the Fog.
      expected = n.children.length ? written * (1 + fog) : Math.max(written, 1 + Math.max(scope, own));
    }
    const s = { written, expected, levels, kind: placeKindOf(written, levels), open: 1 - written / expected };
    out.set(n.id, s);
    return s;
  };
  visit(tree.root);
  return out;
}
