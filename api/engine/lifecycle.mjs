// The lifecycle: where an issue stands, read deterministically from GitHub (see CONTRIBUTING.md).
//
//   Draft           open, status:draft             -> idea
//   Needs decision  open, status:needs-decision    -> needs_decision, in the Fog
//   Ready           open, status:ready             -> ready
//   In progress     open, status:in-progress       -> in_progress
//   Done            closed as completed            -> done
//   Rejected        closed as not planned          -> rejected (drawn as a ruin)
//
// Evidence beats labels: an open "## Open questions" section means a decision is needed, and an
// open pull request that closes the issue means it is in progress, whatever the label says.
// Repositories that use no status labels keep the older reading of labels and assignees.

const STATUS_LABEL = /^status:\s*(draft|needs[- ]decision|ready|in[- ]progress)$/i;
const FROM_LABEL = { draft: 'idea', 'needs-decision': 'needs_decision', ready: 'ready', 'in-progress': 'in_progress' };
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;

const has = (labels, re) => labels.some((l) => re.test(l));

/** Does any issue in the repository carry a status: label? Then every open one should. */
export const usesLifecycle = (issues) => issues.some((i) => has(i.labels, STATUS_LABEL));

/** Issue numbers that open pull requests will close ("Closes #12", "fixes #3"). */
export function closedByOpenPrs(prs) {
  const out = new Set();
  for (const pr of prs) for (const m of `${pr.title ?? ''}\n${pr.body ?? ''}`.matchAll(CLOSES)) out.add(Number(m[1]));
  return out;
}

/** The text of the "## Open questions" section, without comments or "None". */
export function openQuestions(body = '') {
  const m = body.match(/^##\s+Open questions\s*$([\s\S]*?)(?=^##\s|^---\s*$|(?![\s\S]))/im);
  if (!m) return '';
  const text = m[1].replace(/<!--[\s\S]*?-->/g, '').trim();
  return /^(none|n\/a|no open questions)\b/i.test(text) ? '' : text;
}

/**
 * @returns {{ status: string, definition: string, unclear: string }} unclear says why the state is uncertain ('' when it's not)
 */
export function lifecycleOf(issue, { strict = false, inProgress = new Set() } = {}) {
  if (issue.state === 'closed') {
    const reason = String(issue.stateReason ?? '').toLowerCase();
    return { status: reason === 'not_planned' || reason === 'duplicate' ? 'rejected' : 'done', definition: 'auto', unclear: '' };
  }
  const labels = issue.labels.map((l) => l.match(STATUS_LABEL)?.[1].toLowerCase().replace(/\s/, '-')).filter(Boolean);
  const unclear = !strict ? '' : labels.length === 0 ? 'it has no status label' : labels.length > 1 ? `it has ${labels.length} status labels` : '';
  if (openQuestions(issue.body)) return { status: 'needs_decision', definition: 'vague', unclear };
  if (inProgress.has(issue.number)) return { status: 'in_progress', definition: 'auto', unclear };
  if (labels.length === 1) return { status: FROM_LABEL[labels[0]], definition: labels[0] === 'needs-decision' ? 'vague' : 'auto', unclear };
  return { status: legacyStatus(issue), definition: 'auto', unclear };
}

function legacyStatus(issue) {
  if (has(issue.labels, /blocked/i)) return 'blocked';
  if (has(issue.labels, /in[ -]?progress|doing|wip/i) || issue.assignees.length) return 'in_progress';
  if (has(issue.labels, /review/i)) return 'review';
  return 'planned';
}
