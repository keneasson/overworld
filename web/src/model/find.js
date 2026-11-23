// Find (#53): a list of matches, from a search or a lens, the ones in view first (FIND-01), narrowed by filter chips built
// from what the matches in view carry (FIND-02). The chips chosen are kept here as keys, so they stay on as the map moves
// and the list follows the view (FIND-03).

import { KIND_LABEL, STATUS_LABEL } from '@shared/schema.js';

/** What a match carries that a chip can choose: its kind, its status, and its tags and labels. A behaviour is on its issue. */
export function facetsOf({ node, behaviour }) {
  return [`kind:${behaviour ? 'behavior' : node.kind}`, `status:${node.status}`, ...(node.tags ?? []).map((t) => `tag:${t}`)];
}

/** The words on a chip. */
export function chipLabel(key) {
  const [type, ...rest] = key.split(':');
  const value = rest.join(':');
  if (type === 'kind') return KIND_LABEL[value] ?? (value === 'behavior' ? 'Behaviour' : value);
  if (type === 'status') return STATUS_LABEL[value] ?? value;
  return value;
}

/** The matches that carry every chosen chip. */
export const narrow = (matches, chosen = []) => (chosen.length ? matches.filter((m) => chosen.every((k) => facetsOf(m).includes(k))) : matches);

/**
 * The chips for these matches, most carried first: a chip for each kind, status and tag at least one carries, but not one
 * every match carries, since it can't narrow anything.
 * @returns {{ key: string, label: string, count: number }[]}
 */
export function chipsOf(matches) {
  const counts = new Map();
  for (const m of matches) for (const k of new Set(facetsOf(m))) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count < matches.length)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, label: chipLabel(key), count }));
}

/**
 * The list as it shows now: the matches the chosen chips leave, the ones in view first (each group in its own order), the
 * chips to narrow it further, built from those in view (or from all of them when none is in view), and the items the
 * map marks.
 * @param {{ node: object, behaviour?: object }[]} matches  best first
 * @param {string[]} chosen  chip keys
 * @param {(node: object) => boolean} inView
 */
export function findList(matches, chosen, inView) {
  const left = narrow(matches, chosen);
  const here = left.filter((m) => inView(m.node));
  const away = left.filter((m) => !inView(m.node));
  return {
    rows: [...here, ...away],
    inView: here.length,
    chips: chipsOf(here.length ? here : left).filter((c) => !chosen.includes(c.key)),
    marked: new Set(left.map((m) => m.node.id)),
  };
}
