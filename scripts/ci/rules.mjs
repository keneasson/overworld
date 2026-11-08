// The delivery rules (#27): when a preview may run, when it is torn down, which deployment records
// go, and which version a failed production deploy rolls back to. Pure functions of what GitHub and
// AWS report, so the rules are tested without either; scripts/ci/run.mjs gathers the facts and acts.

export const PREVIEW_LABEL = 'preview';
export const PREVIEW_PREFIX = 'projectmap-pr-';
export const PRODUCTION_STACK = 'projectmap';
export const MAX_PREVIEWS = 3;
export const PREVIEW_TTL_DAYS = 7;

const DAY = 24 * 60 * 60 * 1000;

export const previewStack = (number) => `${PREVIEW_PREFIX}${number}`;
export const previewNumber = (stack) => (stack.startsWith(PREVIEW_PREFIX) && /^\d+$/.test(stack.slice(PREVIEW_PREFIX.length)) ? Number(stack.slice(PREVIEW_PREFIX.length)) : null);

/** Only a preview's table may be deleted; production's never is. */
export const canDropTable = (stack) => previewNumber(stack) != null;

const labelled = (pr) => pr.labels.includes(PREVIEW_LABEL);

/**
 * Should this pull request get a preview now?
 * pr: { number, labels, fromFork }; running: the preview stack names that exist.
 * -> { action: 'deploy' | 'refuse' | 'skip', reason, running }
 */
export function planPreview(pr, running) {
  const others = running.filter((s) => s !== previewStack(pr.number)).sort();
  if (pr.fromFork) return { action: 'skip', reason: 'pull requests from forks never deploy', running: others };
  if (!labelled(pr)) return { action: 'skip', reason: `not labelled \`${PREVIEW_LABEL}\``, running: others };
  if (running.includes(previewStack(pr.number))) return { action: 'deploy', reason: 'updating its preview', running: others };
  if (others.length >= MAX_PREVIEWS) return { action: 'refuse', reason: `${MAX_PREVIEWS} previews are already running`, running: others };
  return { action: 'deploy', reason: 'new preview', running: others };
}

/**
 * Which previews to tear down.
 * stacks: [{ name, lastDeployed }] for every stack named like a preview.
 * prs: Map(number -> { state: 'open' | 'closed', labels }).
 * -> [{ stack, reason }]
 */
export function planSweep(stacks, prs, now) {
  const out = [];
  for (const { name, lastDeployed } of stacks) {
    const number = previewNumber(name);
    if (number == null) continue;
    const pr = prs.get(number);
    const reason = !pr
      ? 'its pull request was not found'
      : pr.state !== 'open'
        ? 'its pull request is closed'
        : !labelled(pr)
          ? `the \`${PREVIEW_LABEL}\` label was removed`
          : now - new Date(lastDeployed).getTime() >= PREVIEW_TTL_DAYS * DAY
            ? `no deploy for ${PREVIEW_TTL_DAYS} days`
            : null;
    if (reason) out.push({ stack: name, reason });
  }
  return out;
}

/**
 * Deployment records in the preview environment whose preview no longer runs.
 * deployments: [{ id, ref }]; running: [{ number, headRef }] for each preview that still exists.
 * A record may carry the branch or the pull request's merge ref, so both count.
 */
export function staleDeployments(deployments, running) {
  const keep = new Set(running.flatMap(({ number, headRef }) => [headRef, `refs/heads/${headRef}`, `refs/pull/${number}/merge`, `refs/pull/${number}/head`]));
  return deployments.filter((d) => !keep.has(d.ref)).map((d) => d.id);
}

export const PRODUCTION_RECORDS_KEPT = 20;

/** Production deployment records beyond the newest 20 (enough to roll back from). deployments: [{ id, createdAt }]. */
export function oldProductionRecords(deployments, keep = PRODUCTION_RECORDS_KEPT) {
  return [...deployments].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(keep).map((d) => d.id);
}

/**
 * The version a failed production deploy rolls back to: the newest deploy that passed its smoke
 * test, other than the commit that just failed. deployments: [{ sha, createdAt, state }].
 */
export function lastGood(deployments, failedSha) {
  return [...deployments]
    .filter((d) => d.state === 'success' && d.sha !== failedSha)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0]?.sha ?? null;
}
