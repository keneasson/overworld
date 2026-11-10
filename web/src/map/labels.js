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

// ---------- markers: what a place holds (#46) ----------

// In the order they sit beside a symbol: what needs someone first.
export const MARKERS = ['fire', 'fog', 'question', 'pull', 'agent', 'comment'];
export const MARKER_LABEL = { fire: 'Open bug', fog: 'Fog: behaviour nobody has defined yet', ...BADGE_LABEL };
const CODE_FIRE_LABEL = 'Code with an open bug';
const PRIORITY = { P0: 0, P1: 1, P2: 2, P3: 3 };
const settled = (n) => n.status === 'done' || n.status === 'rejected';
const isCode = (n) => n.tags?.includes('code');

/** What one item holds itself, by marker type: { fire: 1, question: 2, … }. */
function ownCounts(n, live) {
  const counts = Object.fromEntries(badgesOf(n, live).map((b) => [b.type, b.count]));
  if (n.kind === 'bug' && !settled(n)) counts.fire = 1;
  // Fog is work nobody has defined yet: an unsettled leaf that is poorly defined. Land mapped from the code is not work.
  if (!n.children.length && n.stats?.vague && !settled(n) && !isCode(n)) counts.fog = 1;
  return counts;
}

const rollups = new WeakMap();
/**
 * What an item holds (MARK-02), and for a region everything inside it rolled up into one marker per kind
 * with a count (MARK-04): [{ type, count, target, on }]. `target` is the item choosing the marker goes to
 * (the most urgent bug, else the first in map order); `on` is 'code' when an open bug sits in code (MARK-03).
 */
export function markersOf(n, live) {
  if (!live && rollups.has(n)) return rollups.get(n);
  const totals = new Map();
  const add = (type, count, item) => {
    const t = totals.get(type);
    if (!t) totals.set(type, { type, count, target: item.id, rank: PRIORITY[item.priority] ?? 9 });
    else {
      t.count += count;
      const rank = PRIORITY[item.priority] ?? 9;
      if (type === 'fire' && rank < t.rank) Object.assign(t, { target: item.id, rank });
    }
  };
  (function visit(m) {
    for (const [type, count] of Object.entries(ownCounts(m, live))) add(type, count, m);
    for (const c of m.children) visit(c);
  })(n);
  const out = MARKERS.filter((t) => totals.has(t)).map((t) => {
    const { rank, ...m } = totals.get(t);
    return t === 'fire' && isCode(n) ? { ...m, on: 'code' } : m;
  });
  if (!live) rollups.set(n, out);
  return out;
}

/** What a marker means, for the legend and for screen readers. */
export const markerLabel = (m) => (m.type === 'fire' && m.on === 'code' ? CODE_FIRE_LABEL : MARKER_LABEL[m.type]);

// ---------- one layer of detail per zoom step (MARK-10) ----------

/**
 * What an item shows as it grows on screen (`from` is its screen size in pixels, the square root of its
 * area): first that something is there, then what kind of thing it is, then its name, then its markers.
 * After that come its items, named beside it when its land splits into theirs (see namesAt in renderer.js).
 * Nothing appears before it can be read; this table is the whole rule.
 */
export const LADDER = [
  { stage: 'there', from: 14 },
  { stage: 'kind', from: 28 },
  { stage: 'name', from: 48 },
  { stage: 'markers', from: 95 },
];
const reached = (s, stage) => s >= LADDER.find((l) => l.stage === stage).from;

/**
 * What an item holds itself, without what is inside it: the markers a region shows once its items are named
 * beside it, so each marker on screen is counted once (MARK-13).
 */
export function ownMarkersOf(n, live) {
  const counts = ownCounts(n, live);
  return MARKERS.filter((t) => counts[t]).map((type) => ({ type, count: counts[type], target: n.id, ...(type === 'fire' && isCode(n) ? { on: 'code' } : {}) }));
}

/**
 * What an item shows at screen size `s`: { symbol, fill, title, lines, badges }. Below the 'kind' step the
 * symbol is null (a dot says something is there); below 'name' the title is empty; below 'markers' it has none.
 * `badges` are its markers: its own for an item, rolled up for a region until its items are named beside it (`holds`).
 * The project's card always shows everything.
 */
export function labelFor(n, s, live, holds = false) {
  const at = n.depth === 0 ? Infinity : s;
  const named = reached(at, 'name'), marked = reached(at, 'markers');
  return {
    symbol: reached(at, 'kind') ? n.kind : null,
    fill: statusColor(n),
    title: named ? shortTitle(n) : '',
    lines: marked ? 2 : named ? 1 : 0,
    badges: !marked ? [] : holds ? ownMarkersOf(n, live) : markersOf(n, live),
  };
}

// ---------- how much a place holds (MARK-09) ----------

const filesIn = (n) => Number((n.body ?? '').match(/\*\*Code here\*\* \((\d+) files?\)/)?.[1] ?? 0);
const holdings = new WeakMap();
/**
 * What a place holds, counted from what the map knows: { items, behaviours, questions, files, bugs }.
 * A region holds everything inside it, so zooming in shares its holdings out without changing the total.
 */
export function holdingsOf(n) {
  if (holdings.has(n)) return holdings.get(n);
  const h = { items: n.depth > 0 ? 1 : 0, behaviours: n.kind === 'behavior' ? 1 : 0, questions: openQuestionCount(n), files: filesIn(n), bugs: n.kind === 'bug' ? 1 : 0 };
  for (const c of n.children) for (const [key, v] of Object.entries(holdingsOf(c))) h[key] += v;
  holdings.set(n, h);
  return h;
}

/**
 * How many houses a place gets on the map: three per item, behaviour, open question or bug, and one per two
 * files of code. A new idea is open country with a few houses; a busy feature is a town.
 */
export function housesOf(n) {
  const h = holdingsOf(n);
  return 3 * (h.items + h.behaviours + h.questions + h.bugs) + Math.ceil(h.files / 2);
}

/** Every symbol, fill, badge and marker this map uses, for the legend (SYM-04): nothing that isn't on it. */
export function symbolsInUse(tree, live) {
  const kinds = new Set(), fills = new Set(), badges = new Set(), markers = new Map();
  for (const n of tree.list) {
    kinds.add(n.kind);
    fills.add(statusKey(n));
    for (const b of badgesOf(n, live)) badges.add(b.type);
    for (const m of markersOf(n, live)) if (!BADGES.includes(m.type)) markers.set(`${m.type}${m.on ?? ''}`, m);
  }
  return {
    kinds: Object.keys(KIND_SYMBOL_LABEL).filter((k) => kinds.has(k)).map((k) => ({ symbol: k, label: KIND_SYMBOL_LABEL[k] })),
    fills: STATUS_FILLS.filter((f) => fills.has(f.key)).map(({ color, label }) => ({ color, label })),
    badges: BADGES.filter((b) => badges.has(b)).map((b) => ({ symbol: b, label: BADGE_LABEL[b] })),
    markers: [...markers.values()].sort((a, b) => MARKERS.indexOf(a.type) - MARKERS.indexOf(b.type) || (a.on ? 1 : 0) - (b.on ? 1 : 0)).map((m) => ({ symbol: m.type, on: m.on, label: markerLabel(m) })),
  };
}
