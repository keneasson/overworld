// What each item says on the map (#10). At every zoom an item contributes at most its symbol, its short
// title and its badges; the summary and the body belong to the place card (#11). The renderer measures
// and draws what this module decides, so this is where "less text on the map" is kept.

import { hasOpenQuestions, parseIssue, sectionText, splitNote } from '@shared/issue-shape.js';
import { STATUS_FILLS, statusColor, statusKey } from './lenses.js';

// Badges in the order they sit beside a symbol.
export const BADGES = ['pull', 'agent', 'comment', 'question'];
export const BADGE_LABEL = { pull: 'Open pull request', agent: 'Agent working on it', comment: 'Unresolved comments', question: 'Open questions' };
export const KIND_SYMBOL_LABEL = { project: 'Project', area: 'Area', epic: 'Epic', feature: 'Feature', story: 'Story', task: 'Task', bug: 'Bug', behavior: 'Behaviour' };

/** The title without the "#12 " an issue's title starts with on the map. */
export const shortTitle = (n) => String(n.title ?? '').replace(/^#\d+\s+/, '').trim();

const questionCache = new Map();
/** How many open questions an item's "Open questions" section holds: one per list item, or one for prose. */
export function openQuestionCount(n) {
  const key = `${n.id}|${n.updatedAt}|${n.body?.length}`;
  if (questionCache.has(key)) return questionCache.get(key);
  if (questionCache.size > 5000) questionCache.clear();
  const text = /^##\s+Open questions/im.test(n.body ?? '') ? sectionText(parseIssue(splitNote(n.body).markdown), 'Open questions') : '';
  const items = text.split('\n').filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l)).length;
  const count = hasOpenQuestions(text) ? Math.max(1, items) : 0;
  questionCache.set(key, count);
  return count;
}

/**
 * The badges an item carries, in order, each with its count.
 * @param {object} live   what the map knows beyond the nodes, by node id: { agents: Map<id, n>, comments: Map<id, n> }
 */
export function badgesOf(n, live = {}) {
  const counts = {
    // Pull requests that close an item still matter while the item is open; a done item's are history.
    pull: n.status === 'done' || n.status === 'rejected' ? 0 : (n.pulls?.length ?? 0),
    agent: live.agents?.get(n.id) ?? 0,
    comment: live.comments?.get(n.id) ?? 0,
    question: openQuestionCount(n),
  };
  return BADGES.filter((b) => counts[b] > 0).map((type) => ({ type, count: counts[type] }));
}

/**
 * What an item shows at screen size `s` (the square root of its area on screen, in pixels):
 * { symbol, fill, title, lines, badges }. Small items get one line of title and no badges.
 */
export function labelFor(n, s, live) {
  const roomy = n.depth === 0 || s >= 95;
  return { symbol: n.kind, fill: statusColor(n), title: shortTitle(n), lines: roomy ? 2 : 1, badges: roomy ? badgesOf(n, live) : [] };
}

/** Every symbol, fill and badge this map uses, for the legend (SYM-04): nothing that isn't on it. */
export function symbolsInUse(tree, live) {
  const kinds = new Set(), fills = new Set(), badges = new Set();
  for (const n of tree.list) {
    kinds.add(n.kind);
    fills.add(statusKey(n));
    for (const b of badgesOf(n, live)) badges.add(b.type);
  }
  return {
    kinds: Object.keys(KIND_SYMBOL_LABEL).filter((k) => kinds.has(k)).map((k) => ({ symbol: k, label: KIND_SYMBOL_LABEL[k] })),
    fills: STATUS_FILLS.filter((f) => fills.has(f.key)).map(({ color, label }) => ({ color, label })),
    badges: BADGES.filter((b) => badges.has(b)).map((b) => ({ symbol: b, label: BADGE_LABEL[b] })),
  };
}
