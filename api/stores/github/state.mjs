// How an item's state is written in GitHub's own terms (SYNC-08): open or closed, and the status label.
// This is the only place that knows. The new lifecycle (#32) and SYNC-13 will change it here; until
// then it writes today's lifecycle (api/engine/lifecycle.mjs), so the issue reads as it always has.
//
// A GitHub state is { open, reason, label }:
//   open    true or false
//   reason  why it's closed: 'completed' or 'not_planned' ('' while open)
//   label   its status label, or null in a repository that doesn't use them (status labels are left alone there)
//
// A version's priority ('P0' to 'P3', or '') is a priority label, read the way the mapper reads it, in any
// repository (SYNC-15). Saving sets that one label and drops other priority labels; other labels are left alone.

import { priorityFrom } from '../../engine/project.mjs';

const STATUS_LABEL = /^status:/i;
const LABEL_OF = { idea: 'status:draft', needs_decision: 'status:needs-decision', ready: 'status:ready', in_progress: 'status:in-progress' };
const CLOSED = { done: 'completed', rejected: 'not_planned' };
const PRIORITY_LABEL = /^p([0-3])\b/i; // as priorityFrom reads it
const names = (labels = []) => labels.map((l) => (typeof l === 'string' ? l : l.name));

/** Labels carrying `priority` and no other: a priority label already saying it is kept as it is written, else `P<n>` is added. */
function withPriority(labels, priority) {
  const kept = priority ? labels.find((l) => l.match(PRIORITY_LABEL)?.[1] === priority.slice(1)) : undefined;
  const others = labels.filter((l) => !PRIORITY_LABEL.test(l) || l === kept);
  return kept || !priority ? others : [...others, priority];
}

/** The priority an item on the map should have on GitHub. */
export const priorityOf = (node) => node.priority ?? '';

/** The priority it had when last read: its labels are in its tags. */
export const priorityAsRead = (node) => priorityFrom(node.tags ?? []);

/** A GitHub issue (REST shape): its text, and its state. */
export function versionOnGitHub(gh, { strict }) {
  const labels = names(gh.labels)
    .filter((l) => STATUS_LABEL.test(l))
    .map((l) => l.toLowerCase());
  const open = gh.state !== 'closed';
  const reason = open ? '' : ['not_planned', 'duplicate'].includes(gh.state_reason) ? 'not_planned' : 'completed';
  return { title: gh.title, markdown: gh.body ?? '', priority: priorityFrom(names(gh.labels)), state: { open, reason, label: strict ? labels.sort().join(' ') || null : null } };
}

/** The state an item on the map should have on GitHub. */
export function stateOf(node, { strict }) {
  const reason = CLOSED[node.status] ?? '';
  return { open: !reason, reason, label: strict && !reason ? (LABEL_OF[node.status] ?? 'status:draft') : null };
}

/** The state an item had on GitHub when it was last read: the map's status came from it, its labels are in its tags. */
export function stateAsRead(node, { strict }) {
  const reason = CLOSED[node.status] ?? '';
  const labels = (node.tags ?? []).filter((t) => STATUS_LABEL.test(t));
  return { open: !reason, reason, label: strict ? labels.sort().join(' ') || null : null };
}

/** Two versions read the same on GitHub. A version kept from before priorities were saved has none, and matches any. */
export const sameVersion = (a, b) =>
  a.title === b.title &&
  a.markdown === b.markdown &&
  (a.priority === undefined || b.priority === undefined || a.priority === b.priority) &&
  a.state.open === b.state.open && a.state.reason === b.state.reason && (a.state.label ?? null) === (b.state.label ?? null);

/** What to send GitHub to make `gh` read as `want`: only the fields that differ. */
export function patchFor(gh, want, { strict }) {
  const now = versionOnGitHub(gh, { strict });
  const patch = {};
  if (now.title !== want.title) patch.title = want.title;
  if (now.markdown !== want.markdown) patch.body = want.markdown;
  if (now.state.open !== want.state.open || now.state.reason !== want.state.reason) Object.assign(patch, want.state.open ? { state: 'open' } : { state: 'closed', state_reason: want.state.reason });
  let labels = names(gh.labels);
  if (strict && now.state.label !== want.state.label) labels = [...labels.filter((l) => !STATUS_LABEL.test(l)), ...(want.state.label ? [want.state.label] : [])];
  if (want.priority !== undefined) labels = withPriority(labels, want.priority); // a job saved before priorities were saved leaves them alone
  if (labels.join('\n') !== names(gh.labels).join('\n')) patch.labels = labels;
  return patch;
}

/** The labels a new issue is created with. */
export const labelsForNew = (want, { epic }) => [...(want.state.label ? [want.state.label] : []), ...(want.priority ? [want.priority] : []), ...(epic ? ['epic'] : [])];
