// Everything waiting on someone's review (#62): proposed changes not yet adopted or declined, and questions waiting to be
// answered or written in. The Review lens, its list and the "to review" marker all read this
// one list, so they never disagree (REVIEW-01 to REVIEW-05).

import { compareItems, editableOf, itemKeyOf } from '@shared/issue-shape.js';

const BLANK = { title: '', markdown: '' };
const time = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : Infinity;
};
const add = (list, id) => id && !list.includes(id) && list.push(id);

/**
 * One entry per issue with something waiting, the longest waiting first (REVIEW-02).
 * @param {{ changesets: object[], notes?: object, tree: object }} o  the open changesets of everyone but you; the
 *   project's notes by item key (`asked` and `answered` questions, waiting `since`)
 * @returns {{ node, key, since: number, by: string[], added: string[], changed: string[], removed: string[], ready: string[],
 *   changes: number, refinement: string|null, asked: number, answered: number }[]}
 */
export function waitingForReview({ changesets = [], notes = {}, tree }) {
  if (!tree) return [];
  const byKey = new Map(tree.list.map((n) => [itemKeyOf(n), n]));
  const out = new Map();
  const entryOf = (node) => {
    if (!out.has(node.id))
      out.set(node.id, { node, key: itemKeyOf(node), since: Infinity, by: [], added: [], changed: [], removed: [], ready: [], changes: 0, refinement: null, asked: 0, answered: 0 });
    return out.get(node.id);
  };
  for (const cs of changesets) {
    if (cs.status && cs.status !== 'open') continue;
    for (const it of cs.items ?? []) {
      const node = byKey.get(it.key);
      if (!node || (!it.new && !it.after)) continue;
      const e = entryOf(node);
      const diff = it.new ? compareItems(BLANK, editableOf(node)) : compareItems(editableOf(node), it.after, it.base);
      for (const b of diff.behaviours) add(e[b.change], b.id);
      for (const id of it.readyForAdoption ?? []) add(e.ready, id);
      add(e.by, cs.author);
      e.changes += 1;
      e.since = Math.min(e.since, time(it.at ?? cs.createdAt));
      e.refinement ??= cs.id;
    }
  }
  for (const [key, v] of Object.entries(notes)) {
    const node = byKey.get(key);
    if (!node || !(v.asked || v.answered)) continue;
    const e = entryOf(node);
    e.asked += v.asked ?? 0;
    e.answered += v.answered ?? 0;
    e.since = Math.min(e.since, time(v.since));
  }
  return [...out.values()].sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
}

/**
 * Where the person stands while reviewing one issue opened from the Review list (REVIEW-03): whether it is still waiting,
 * how many others are, and the one offered next, the longest waiting. Once it is decided it has left the list.
 * @returns {{ here: boolean, more: number, next: object|null }}
 */
export function reviewingAt(review, nodeId) {
  const here = review.some((e) => e.node.id === nodeId);
  const next = review.find((e) => e.node.id !== nodeId) ?? null;
  return { here, more: review.length - (here ? 1 : 0), next };
}

/** How long something has waited, in a few words: "just now", "5 min", "3 h", "2 days". */
export function waitedFor(since, now = Date.now()) {
  if (!Number.isFinite(since)) return '';
  const mins = Math.max(0, Math.round((now - since) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h`;
  return `${Math.round(mins / 1440)} days`;
}

/** What an entry waits for, in words, for its row in the list. */
export function waitingWords(e) {
  const parts = [];
  if (e.added.length) parts.push(`new ${e.added.join(', ')}`);
  if (e.changed.length) parts.push(`changed ${e.changed.join(', ')}`);
  if (e.removed.length) parts.push(`removed ${e.removed.join(', ')}`);
  if (e.changes && !parts.length) parts.push('other changes');
  if (e.answered) parts.push(`${e.answered} answer${e.answered === 1 ? '' : 's'} to write in`);
  if (e.asked) parts.push(`${e.asked} question${e.asked === 1 ? '' : 's'} to answer`);
  return parts.join(' · ');
}

/** An item's title with its issue number, as Overworld names it to people ("#62 Review and discuss…"). */
export function titleWithNumber(n) {
  const number = String(n.url ?? '').match(/\/issues\/(\d+)$/)?.[1];
  const title = String(n.title ?? '');
  return number && !title.startsWith(`#${number} `) ? `#${number} ${title}` : title;
}
