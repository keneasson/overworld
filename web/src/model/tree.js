// Builds the in-memory tree from flat nodes and rolls up the numbers every
// zoom level needs: weight (map area), progress, health, bugs, definition…

import { ROOT_ID } from '@shared/schema.js';

const BASE_WEIGHT = { project: 8, area: 6, epic: 5, feature: 4, story: 3, task: 2, bug: 1.6, behavior: 1.2 };
const CONTAINER = new Set(['project', 'area', 'epic', 'feature']);
const SEVERITY = { off_track: 4, at_risk: 3, on_track: 2, not_started: 1, done: 0 };

export const isNewFeature = (n) => n.kind === 'story' && (n.tags?.includes('new-feature') || n.tags?.includes('new'));
export const isOpen = (n) => n.status !== 'done';

export function definitionScore(n, hasKids) {
  if (n.definition === 'clear') return 1;
  if (n.definition === 'vague') return 0.15;
  const summary = (n.summary ?? '').trim().length >= 8;
  const body = (n.body ?? '').trim();
  if (hasKids || CONTAINER.has(n.kind)) {
    return (summary ? 0.4 : 0) + (body.length >= 40 ? 0.2 : 0) + (hasKids ? 0.4 : 0);
  }
  const criteria = /- \[[ xX]\]|acceptance|steps to reproduce|expected/i.test(body);
  const sized = n.estimate != null || (n.kind === 'bug' && n.priority);
  return (summary ? 0.3 : 0) + (body.length >= 60 ? 0.2 : 0) + (criteria ? 0.3 : 0) + (sized ? 0.2 : 0);
}

const daysUntil = (date, today) => (Date.parse(date) - Date.parse(today)) / 86_400_000;

export function buildTree(rawNodes, today = new Date().toISOString().slice(0, 10)) {
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

  for (let i = list.length - 1; i >= 0; i--) rollup(list[i], today);

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
  return { root, byId, list, incoming, maxByDepth, owners, today };
}

function rollup(n, today) {
  const kids = n.children;
  const leaf = kids.length === 0;
  const done = n.status === 'done';
  // Rejected work stays on the map as a ruin, but no longer counts as work to do.
  const rejected = n.status === 'rejected';
  const overdue = Boolean(n.due) && n.due < today && !done;
  const def = definitionScore(n, !leaf);
  const s = {
    raw: 0,
    work: 0,
    // Lifecycle counts are about work; land mapped from the code (tagged 'code') has none of its own.
    states: leaf && !n.tags.includes('code') ? { [n.status]: 1 } : {},
    progress: 0,
    health: 'on_track',
    overdue,
    def,
    defAvg: def,
    vague: def < 0.5,
    items: 1,
    leaves: leaf ? 1 : 0,
    doneLeaves: leaf && done ? 1 : 0,
    openBugs: n.kind === 'bug' && !done ? 1 : 0,
    bugs: n.kind === 'bug' ? 1 : 0,
    newFeatures: isNewFeature(n) && !done ? 1 : 0,
    newFeaturesDone: isNewFeature(n) && done ? 1 : 0,
    poorlyDefined: def < 0.5 ? 1 : 0,
    blocked: n.status === 'blocked' ? 1 : 0,
    behaviours: n.kind === 'behavior' ? 1 : 0,
    behavioursKept: n.kind === 'behavior' && done ? 1 : 0,
    owners: new Map(),
    owner: n.assignee || '',
  };

  if (leaf) {
    const est = n.estimate != null ? 0.7 + Math.min(n.estimate, 13) * 0.1 : 1;
    s.raw = n.weight ?? (BASE_WEIGHT[n.kind] ?? 2) * est;
    s.work = rejected ? 0 : s.raw;
    s.progress = { done: 1, review: 0.85, in_progress: 0.45, blocked: 0.2 }[n.status] ?? 0;
    if (done || rejected) s.health = 'done';
    else if (n.status === 'blocked' || overdue) s.health = 'off_track';
    else if (['idea', 'planned', 'ready', 'needs_decision'].includes(n.status)) s.health = 'not_started';
    if (n.due && !done && s.health !== 'off_track' && daysUntil(n.due, today) <= 7 && s.progress < 0.5) s.health = 'at_risk';
    if (n.assignee) s.owners.set(n.assignee, s.raw);
  } else {
    let total = 0, progress = 0, defSum = 0;
    const weightBy = { off_track: 0, at_risk: 0, on_track: 0, not_started: 0, done: 0 };
    let area = 0;
    for (const c of kids) {
      const cs = c.stats;
      area += cs.raw;
      total += cs.work;
      progress += cs.progress * cs.work;
      defSum += cs.defAvg * cs.raw;
      weightBy[cs.health] += cs.work;
      for (const [k, v] of Object.entries(cs.states)) s.states[k] = (s.states[k] ?? 0) + v;
      for (const key of ['items', 'leaves', 'doneLeaves', 'openBugs', 'bugs', 'newFeatures', 'newFeaturesDone', 'poorlyDefined', 'blocked', 'behaviours', 'behavioursKept']) s[key] += cs[key];
      for (const [who, w] of cs.owners) s.owners.set(who, (s.owners.get(who) ?? 0) + w);
    }
    s.raw = n.weight ?? area;
    s.work = rejected ? 0 : total;
    s.progress = done || !total ? 1 : progress / total;
    s.defAvg = (def + defSum / area) / 2;
    if (done || weightBy.done === total) s.health = 'done';
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
