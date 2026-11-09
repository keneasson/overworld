// How an item's state is written in GitHub's own terms (SYNC-08): open or closed, and the status label.
// This is the only place that knows. The new lifecycle (#32) and SYNC-13 will change it here; until
// then it writes today's lifecycle (api/engine/lifecycle.mjs), so the issue reads as it always has.
//
// A version of an item is { title, markdown, open, reason, label }:
//   open    true or false
//   reason  why it's closed: 'completed' or 'not_planned' ('' while open)
//   label   its status label, or null in a repository that doesn't use them (labels are left alone there)

const STATUS_LABEL = /^status:/i;
const LABEL_OF = { idea: 'status:draft', needs_decision: 'status:needs-decision', ready: 'status:ready', in_progress: 'status:in-progress' };
const CLOSED = { done: 'completed', rejected: 'not_planned' };

/** A GitHub issue (REST shape) as a version. */
export function versionOnGitHub(gh, { strict }) {
  const labels = (gh.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
    .filter((l) => STATUS_LABEL.test(l))
    .map((l) => l.toLowerCase());
  const open = gh.state !== 'closed';
  return { title: gh.title, markdown: gh.body ?? '', open, reason: open ? '' : ['not_planned', 'duplicate'].includes(gh.state_reason) ? 'not_planned' : 'completed', label: strict ? labels.sort().join(' ') || null : null };
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

/** Two versions say the same thing on GitHub. */
export const sameVersion = (a, b) => a.title === b.title && a.markdown === b.markdown && a.open === b.open && a.reason === b.reason && (a.label ?? null) === (b.label ?? null);

/** What to send GitHub to make `issue` read as `want`: only the fields that differ. */
export function patchFor(gh, want, { strict }) {
  const now = versionOnGitHub(gh, { strict });
  const patch = {};
  if (now.title !== want.title) patch.title = want.title;
  if (now.markdown !== want.markdown) patch.body = want.markdown;
  if (now.open !== want.open || now.reason !== want.reason) Object.assign(patch, want.open ? { state: 'open' } : { state: 'closed', state_reason: want.reason });
  if (strict && now.label !== want.label) {
    const others = (gh.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter((l) => !STATUS_LABEL.test(l));
    patch.labels = [...others, ...(want.label ? [want.label] : [])];
  }
  return patch;
}

/** The labels a new issue is created with. */
export const labelsForNew = (want, { epic }) => [...(want.label ? [want.label] : []), ...(epic ? ['epic'] : [])];
