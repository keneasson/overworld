// Builds the in-memory tree from flat nodes and rolls up the numbers every
// zoom level needs: weight (map area), progress, health, bugs, definition…

import { ROOT_ID } from '@shared/schema.js';
import { editableOf, notWorkedOut, parseBehaviours, parseIssue, sectionText } from '@shared/issue-shape.js';
import { doneOf, proofOf } from '@shared/proof.js';

// Each behaviour an issue lists is a house on its own lot in the issue's block (#46 MARK-16), and weighs this much of
// the map. A leaf issue's block is its scope: with few behaviours it is mostly open land, a park, and houses fill it as
// behaviours are added (MARK-18). An issue's own houses come on top of its child issues' blocks.
export const HOUSE_WEIGHT = 0.6;
const PLACES = new Set(['project', 'area']);
const inIdOrder = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
// An issue's behaviours are adopted once it is ready (CONTRIBUTING.md): only those can be built, proven and done (#21 PROVEN-01).
const ADOPTED = new Set(['ready', 'in_progress', 'review', 'done']);
/**
 * Every behaviour an issue lists itself, as { id, words, fog }: each one written as an item of its Behaviours list. Each
 * with an ID carries its proof from the latest coverage report (shared/proof.js) and, for a done issue, whether it is
 * done, unproven or broken.
 */
const specOf = (n, report) =>
  n.tags.includes('code') || PLACES.has(n.kind) || n.kind === 'behavior'
    ? []
    : parseBehaviours(sectionText(parseIssue(editableOf(n).markdown), 'Behaviours'))
        .filter((r) => /^\s*[-*]\s/.test(r.raw ?? ''))
        .map((r) => {
          const row = { id: r.id, words: (r.then || r.text || r.when || r.given || '').trim(), said: [r.given, r.when, r.then, r.text].filter(Boolean).join(' '), fog: notWorkedOut(r) };
          if (!r.id) return row;
          const proof = proofOf(r.id, { report, raw: r.raw });
          return { ...row, proof, done: doneOf(n.status === 'done', proof) };
        });
const BASE_WEIGHT = { project: 8, area: 6, epic: 5, feature: 4, story: 3, task: 2, bug: 1.6, behavior: 1.2 };
const SEVERITY = { off_track: 4, at_risk: 3, on_track: 2, not_started: 1, done: 0 };

export const isNewFeature = (n) => n.kind === 'story' && (n.tags?.includes('new-feature') || n.tags?.includes('new'));
export const isOpen = (n) => n.status !== 'done';

/** Is this an issue, the only thing whose behaviours can be unknown? Places, code mapped from the repository and behaviours aren't. */
const isIssue = (n) => n.depth > 0 && !PLACES.has(n.kind) && n.kind !== 'behavior' && !n.tags.includes('code');

const daysUntil = (date, today) => (Date.parse(date) - Date.parse(today)) / 86_400_000;

/** @param {{ report?: object | null }} [o] the latest coverage report (#20): with it, only proven behaviours count as done (#21) */
export function buildTree(rawNodes, today = new Date().toISOString().slice(0, 10), { report = null } = {}) {
  const byId = new Map();
  for (const raw of rawNodes) byId.set(raw.id, { ...raw, tags: raw.tags ?? [], links: raw.links ?? [], children: [], parent: null, depth: 0 });
  const root = byId.get(ROOT_ID) ?? [...byId.values()].find((n) => !n.parentId);
  if (!root) return null;
  root.parentId = null;

  for (const n of byId.values()) {
    if (n === root) continue;
    const p = byId.get(n.parentId);
    n.parent = p && p !== n ? p : root;
    n.parent.children.push(n);
  }
  // Anything not reachable from the root sits in a parent cycle: re-home it under the root.
  const reached = new Set();
  const mark = (n) => {
    reached.add(n);
    for (const c of n.children) if (!reached.has(c)) mark(c);
  };
  mark(root);
  for (const n of byId.values()) {
    if (reached.has(n)) continue;
    n.parent.children = n.parent.children.filter((c) => c !== n);
    n.parent = root;
    root.children.push(n);
    mark(n);
  }

  const list = [];
  (function order(n, depth) {
    n.depth = depth;
    list.push(n);
    n.children.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
    n.children.forEach((c, i) => {
      c.index = i;
      order(c, depth + 1);
    });
  })(root, 0);

  for (let i = list.length - 1; i >= 0; i--) rollup(list[i], today, report);

  const incoming = new Map();
  for (const n of list) {
    n.links = n.links.filter((l) => byId.has(l.to) && l.to !== n.id);
    for (const l of n.links) {
      if (!incoming.has(l.to)) incoming.set(l.to, []);
      incoming.get(l.to).push({ from: n.id, type: l.type });
    }
  }

  // Per-depth maxima let lenses normalise colours within each zoom level.
  const maxByDepth = { openBugs: [], newFeatures: [] };
  for (const n of list) {
    for (const key of Object.keys(maxByDepth)) {
      maxByDepth[key][n.depth] = Math.max(maxByDepth[key][n.depth] ?? 0, n.stats[key]);
    }
  }

  const owners = [...new Set(list.map((n) => n.assignee).filter(Boolean))].sort();
  return { root, byId, list, incoming, maxByDepth, owners, today, report };
}

function rollup(n, today, report) {
  const spec = specOf(n, report);
  // The behaviours with an ID, in ID order, are the houses on its block.
  n.behaviourRows = spec.filter((r) => r.id).sort(inIdOrder);
  const adopted = ADOPTED.has(n.status) ? n.behaviourRows.filter((b) => !b.fog) : [];
  const kids = n.children;
  const leaf = kids.length === 0;
  const done = n.status === 'done';
  // Rejected work stays on the map as a ruin, but no longer counts as work to do.
  const rejected = n.status === 'rejected';
  const overdue = Boolean(n.due) && n.due < today && !done;
  // Fog is behaviour nobody knows yet, measured from the behaviours alone (#44 FOG-05): an issue with none is all fog,
  // and otherwise its fog is the share of its behaviours marked "Not worked out yet". Estimates, summaries, body length
  // and checklists never count, and open questions are their own "?" badge.
  const foggyOwn = spec.filter((b) => b.fog).length;
  const own = spec.length;
  let fog = 0;
  if (rejected) fog = 0;
  else if (n.kind === 'behavior') fog = n.definition === 'vague' ? 1 : 0;
  else if (leaf) fog = isIssue(n) ? (own ? foggyOwn / own : 1) : 0;
  else {
    // A parent's fog is the size-weighted average of its children's and its own behaviours' (FOG-01): land for land.
    let sum = foggyOwn * HOUSE_WEIGHT, weight = own * HOUSE_WEIGHT;
    for (const c of kids) {
      sum += c.stats.fog * c.stats.raw;
      weight += c.stats.raw;
    }
    fog = weight ? sum / weight : 0;
  }
  // In the Fog of its own: an issue with no behaviours, or with one not worked out yet.
  const vague = !rejected && (leaf ? fog > 0 : foggyOwn > 0);
  const s = {
    raw: 0,
    work: 0,
    // Lifecycle counts are about work; land mapped from the code (tagged 'code') has none of its own.
    states: leaf && !n.tags.includes('code') ? { [n.status]: 1 } : {},
    progress: 0,
    health: 'on_track',
    overdue,
    fog,
    foggy: foggyOwn,
    // Behaviours written without an ID have no house, so their fog lies over the whole block.
    unhoused: own - n.behaviourRows.length,
    behaviourCount: own,
    vague,
    items: 1,
    leaves: leaf ? 1 : 0,
    doneLeaves: leaf && done ? 1 : 0,
    openBugs: n.kind === 'bug' && !done ? 1 : 0,
    bugs: n.kind === 'bug' ? 1 : 0,
    newFeatures: isNewFeature(n) && !done ? 1 : 0,
    newFeaturesDone: isNewFeature(n) && done ? 1 : 0,
    poorlyDefined: vague ? 1 : 0,
    blocked: n.status === 'blocked' ? 1 : 0,
    behaviours: n.kind === 'behavior' ? 1 : 0,
    behavioursKept: n.kind === 'behavior' && done ? 1 : 0,
    // Adopted behaviours, and those done: built and proven (#21 PROVEN-01), or done but whose proof now fails (PROVEN-07).
    adopted: adopted.length,
    proven: adopted.filter((b) => b.done === 'done').length,
    broken: adopted.filter((b) => b.done === 'broken').length,
    // The behaviours the issue lists itself, and how much of its scope isn't built into houses yet (MARK-18).
    own: n.behaviourRows.length,
    open: 0,
    owners: new Map(),
    owner: n.assignee || '',
  };

  s.measured = Boolean(report);
  // Done, but its proof now fails: broken wherever done shows (PROVEN-07), the Lifecycle layer included.
  if (s.broken && s.states.done) s.states = { broken: 1 };
  const houses = s.own * HOUSE_WEIGHT;
  if (leaf) {
    const est = n.estimate != null ? 0.7 + Math.min(n.estimate, 13) * 0.1 : 1;
    const scope = (BASE_WEIGHT[n.kind] ?? 2) * est;
    // Its scope until its houses outgrow it; whatever the houses don't fill yet is park.
    s.open = houses ? Math.max(0, scope - houses) : 0;
    s.raw = n.weight ?? Math.max(scope, houses);
    s.work = rejected ? 0 : s.raw;
    s.progress = { done: 1, review: 0.85, in_progress: 0.45, blocked: 0.2 }[n.status] ?? 0;
    // Measured, a done issue is as done as its proven behaviours (PROVEN-01, PROVEN-06).
    if (done && report && s.adopted) s.progress = s.proven / s.adopted;
    if (s.broken) s.health = 'off_track';
    else if (done || rejected) s.health = 'done';
    else if (n.status === 'blocked' || overdue) s.health = 'off_track';
    else if (['idea', 'planned', 'ready', 'needs_decision'].includes(n.status)) s.health = 'not_started';
    if (n.due && !done && s.health !== 'off_track' && daysUntil(n.due, today) <= 7 && s.progress < 0.5) s.health = 'at_risk';
    if (n.assignee) s.owners.set(n.assignee, s.raw);
  } else {
    let total = 0, progress = 0;
    const weightBy = { off_track: 0, at_risk: 0, on_track: 0, not_started: 0, done: 0 };
    let area = 0;
    for (const c of kids) {
      const cs = c.stats;
      area += cs.raw;
      total += cs.work;
      progress += cs.progress * cs.work;
      weightBy[cs.health] += cs.work;
      for (const [k, v] of Object.entries(cs.states)) s.states[k] = (s.states[k] ?? 0) + v;
      for (const key of ['items', 'leaves', 'doneLeaves', 'openBugs', 'bugs', 'newFeatures', 'newFeaturesDone', 'poorlyDefined', 'blocked', 'behaviours', 'behavioursKept', 'adopted', 'proven', 'broken']) s[key] += cs[key];
      for (const [who, w] of cs.owners) s.owners.set(who, (s.owners.get(who) ?? 0) + w);
    }
    s.raw = n.weight ?? area + houses;
    s.work = rejected ? 0 : total;
    s.progress = (done && !report) || !total ? 1 : progress / total;
    if ((done && !s.broken) || weightBy.done === total) s.health = 'done';
    else if (weightBy.off_track / total >= 0.25) s.health = 'off_track';
    else if (weightBy.off_track > 0 || weightBy.at_risk / total >= 0.2) s.health = 'at_risk';
    else if (weightBy.not_started === total) s.health = 'not_started';
    else s.health = 'on_track';
    if (!done && (n.status === 'blocked' || overdue)) s.health = 'off_track';
    if (!s.owner) {
      let best = 0;
      for (const [who, w] of s.owners) if (w > best) [best, s.owner] = [w, who];
    }
  }
  if (n.health && n.health !== 'auto' && !done) s.health = n.health;
  n.stats = s;
}

export function pathOf(n) {
  const path = [];
  for (let cur = n; cur; cur = cur.parent) path.unshift(cur);
  return path;
}

export function isInside(n, ancestor) {
  for (let cur = n; cur; cur = cur.parent) if (cur === ancestor) return true;
  return false;
}

export function worstHealth(a, b) {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export const HEALTH_LABEL = {
  on_track: 'On target',
  at_risk: 'At risk',
  off_track: 'Off target',
  not_started: 'Not started',
  done: 'Done',
};

export const HEALTH_COLOR = {
  on_track: '#1e8e3e',
  at_risk: '#e37400',
  off_track: '#d93025',
  not_started: '#80868b',
  done: '#1a73e8',
};
