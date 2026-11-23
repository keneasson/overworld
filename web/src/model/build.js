// Whether a card offers Build (#14 HANDOFF-03, HANDOFF-12). The server says what is work and what an item lacks
// (api/work.mjs); the card holds that work to the fog line. Fog is the Fog lens's own (#44 FOG-05): it comes only from
// behaviours, so Build is offered only for work whose behaviours are worked out, and the card says which aren't.

import { itemKeyOf } from '@shared/issue-shape.js';
import { fogOver, fogReason } from '../map/fog.js';

// Only work under this much fog is offered to build (maintainer, 2026-11-18). One number, so the line can be tuned.
export const BUILD_FOG = 15;

const pctOf = (n) => Math.round(fogOver(n) * 100);

/**
 * What the card says about building an item.
 * @param {object} node  an item of the tree, with its stats
 * @param {{ buildable?: object, missing?: object }} builds  what GET /builds said
 * @returns {{ fog: number, offer: string[], foggy: boolean, missing: string[], why: string[] }}
 *   fog: how foggy it is, as a whole percentage; offer: the behaviours Build is offered for; foggy: there is work, but
 *   too much fog over it to offer; missing: what the server says it lacks; why: what the fog is, in the lens's words: a
 *   leaf's own behaviours, or a parent's foggiest parts
 */
export function buildOffer(node, builds) {
  const key = itemKeyOf(node);
  const fog = pctOf(node);
  const can = builds?.buildable?.[key] ?? [];
  const missing = builds?.missing?.[key] ?? [];
  const clear = fog < BUILD_FOG;
  let why = [];
  if (!clear) {
    const parts = node.children.filter((c) => pctOf(c) >= BUILD_FOG).sort((a, b) => fogOver(b) - fogOver(a));
    const own = node.stats?.foggy ? [fogReason({ ...node, children: [] })] : [];
    why = node.children.length ? [...own, ...parts.slice(0, 5).map((c) => `${c.title}: ${fogReason(c)}`)] : [fogReason(node)];
  }
  return { fog, offer: clear ? can : [], foggy: !clear && can.length > 0, missing, why };
}
