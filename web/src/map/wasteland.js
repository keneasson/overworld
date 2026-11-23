// Wasteland (#24): code that is in use but damaged. The repository mapper reads the marks from the code (api/engine/
// wasteland.mjs) and puts them on the place that holds the file; here they become ground and a place card. It is its own
// ground, not Fog: the behaviour over it is clear, the code under it needs repair.

import { interpolateRgbBasis } from 'd3';
import { itemKeyOf } from '@shared/issue-shape.js';

export const WASTE_LABEL = {
  fixme: 'A FIXME comment',
  unreachable: 'Unreachable code',
  'ab-leftover': 'The leftover side of a decided A/B test',
  'resolved-flag': 'A resolved feature flag still in the code',
  'debt-comment': 'A comment calling it technical debt',
};

// Sound ground to scorched: dusty browns, far from Fog's grey-blue and the Progress lens's sand.
export const wasteColor = interpolateRgbBasis(['#e5eadc', '#d9c7a4', '#b08a64', '#7d5a43']);

/** The marks on a place's own code. */
export const marksOf = (n) => n.waste ?? [];
/** Does the place stand on marked code: its own, or the code region it sits in? */
export function onWaste(n) {
  for (let cur = n; cur; cur = cur.parent) if (marksOf(cur).length) return true;
  return false;
}

/**
 * How much of a place is wasteland, 0 to 1 (WASTE-01): all of marked code and what stands on it, and for a region the share
 * of its land that is, weighted by size like the Fog, so zooming in shows where it is without changing how much there is.
 */
const cache = new WeakMap();
export function wasteOver(n) {
  if (cache.has(n)) return cache.get(n);
  let w = 0;
  if (onWaste(n)) w = 1;
  else if (n.children.length) {
    let sum = 0;
    let total = 0;
    for (const c of n.children) {
      const size = Math.max(0.1, c.stats?.raw ?? 1);
      sum += wasteOver(c) * size;
      total += size;
    }
    w = total ? sum / total : 0;
  }
  cache.set(n, w);
  return w;
}

/** Every place with marked code inside n (n included). */
const markedIn = (n) => [...(marksOf(n).length ? [n] : []), ...n.children.flatMap(markedIn)];

/** The Wasteland lens (WASTE-01): its own ground and legend entry, distinct from Fog. */
export const WASTELAND_LENS = {
  id: 'wasteland',
  name: 'Wasteland',
  chip: 'Technical debt',
  icon: '🏚️',
  blurb: 'Code in use but damaged: FIXMEs, unreachable code, leftovers of decided A/B tests and resolved feature flags, and code called technical debt. Cracked ground needs repair. It is not Fog: the behaviour is clear.',
  fill: (n) => wasteColor(wasteOver(n)),
  cracks: (n) => onWaste(n),
  stat: (n) => {
    const own = marksOf(n).length;
    if (own) return `Wasteland · ${own} mark${own === 1 ? '' : 's'}`;
    if (onWaste(n)) return 'On wasteland';
    const places = markedIn(n).length;
    return places ? `${Math.round(wasteOver(n) * 100)}% wasteland · ${places} place${places === 1 ? '' : 's'} to repair` : 'Sound ground';
  },
  matches: (n) => marksOf(n).length > 0,
  sort: (a, b) => marksOf(b).length - marksOf(a).length,
  count: (tree) => markedIn(tree.root).length,
  legend: () => [
    { color: wasteColor(0), label: 'Sound ground' },
    { color: wasteColor(0.5), label: 'Partly wasteland' },
    { color: wasteColor(1), label: 'Wasteland: code marked as debt', cracks: true },
  ],
};

const MAX_IN_PROMPT = 12;

/**
 * What a wasteland place's card says (WASTE-03, WASTE-04): why the ground is waste, mark by mark and which kind marked it;
 * the behaviours that cross it (of the issues whose pull requests changed its files, and the issues on it); the repairs
 * already made, with their pull requests; and the prompt that hands the repair to an agent, with those behaviours' tests
 * as the safety net. Null for sound ground with no history.
 */
export function wasteCard(n, tree) {
  const marks = marksOf(n).map((m) => ({ ...m, label: WASTE_LABEL[m.mark] ?? m.mark }));
  const cleared = (n.wasteCleared ?? []).map((c) => ({ ...c, label: WASTE_LABEL[c.mark] ?? c.mark }));
  if (!marks.length && !cleared.length) return null;
  const issues = new Map();
  for (const num of n.wasteIssues ?? []) {
    const i = tree.byId.get(`issue-${num}`);
    if (i) issues.set(i.id, i);
  }
  const visit = (c) => {
    if (c !== n && c.behaviourRows?.length) issues.set(c.id, c);
    c.children.forEach(visit);
  };
  visit(n);
  const behaviours = [];
  const seen = new Set();
  for (const i of [...issues.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    for (const r of i.behaviourRows ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      behaviours.push({ id: r.id, words: r.words, item: itemKeyOf(i), title: i.title });
    }
  }
  const kinds = [...new Set(marks.map((m) => m.label))];
  const ids = behaviours.map((b) => b.id);
  const prompt = marks.length
    ? [
        `@Claude Please repair the wasteland in ${n.title}. It is marked as technical debt by:`,
        ...marks.slice(0, MAX_IN_PROMPT).map((m) => `- ${m.label}: ${m.path}:${m.line}, "${m.text}"`),
        ...(marks.length > MAX_IN_PROMPT ? [`- and ${marks.length - MAX_IN_PROMPT} more on the place card`] : []),
        '',
        ids.length
          ? `The behaviours that cross it are ${ids.join(', ')}. Their tests, named by those IDs, are the safety net: they pass before you change anything, and still pass, unchanged, after.`
          : 'No behaviour crosses this code yet, so no test guards it: write down what it does as behaviours, with their tests, before changing it.',
        'Repair it so that what marked it is gone, in one pull request; the next mapping clears the ground and shows that pull request.',
      ].join('\n')
    : '';
  return { marks, kinds, behaviours, cleared, prompt };
}
