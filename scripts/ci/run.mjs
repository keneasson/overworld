// Delivery steps that need GitHub and AWS. The decisions are in rules.mjs; this gathers the facts
// with the `gh` and `aws` CLIs (both on GitHub's runners) and acts on them. Run by the workflows:
//
//   node scripts/ci/run.mjs preview-plan <pr>          writes action, stack and message to $GITHUB_OUTPUT
//   node scripts/ci/run.mjs teardown <stack> [reason]  deletes a preview's stack, table and logs
//   node scripts/ci/run.mjs sweep                      tears down previews past their rules, trims deployment records
//   node scripts/ci/run.mjs last-good <failed-sha>     prints the commit to roll production back to
//   node scripts/ci/run.mjs comment <pr> <file>        writes the pull request's one preview comment
//
// Needs GITHUB_REPOSITORY, GH_TOKEN and AWS credentials for AWS_REGION.

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { canDropTable, lastGood, oldProductionRecords, planPreview, planSweep, previewNumber, PREVIEW_PREFIX, staleDeployments } from './rules.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const region = process.env.AWS_REGION;
const MARKER = '<!-- projectmap-preview -->';

function sh(cmd, args, { input, allowFail = false } = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', input, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'inherit'] });
  if (res.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed`);
  return res.status === 0 ? res.stdout.trim() : null;
}
const gh = (path, ...args) => JSON.parse(sh('gh', ['api', path, ...args]) || 'null');
const ghAll = (path) => JSON.parse(sh('gh', ['api', '--paginate', '--slurp', path])).flat();
const aws = (...args) => JSON.parse(sh('aws', [...args, '--region', region, '--output', 'json']) || 'null');
const output = (values) => {
  const lines = Object.entries(values).map(([k, v]) => (String(v).includes('\n') ? `${k}<<EOF\n${v}\nEOF` : `${k}=${v}`));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
};

/** Every preview stack that exists, with when it was last deployed. */
function previewStacks() {
  const live = ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'ROLLBACK_COMPLETE', 'CREATE_FAILED', 'UPDATE_ROLLBACK_FAILED', 'DELETE_FAILED', 'CREATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS'];
  const { StackSummaries } = aws('cloudformation', 'list-stacks', '--stack-status-filter', ...live);
  return StackSummaries.filter((s) => s.StackName.startsWith(PREVIEW_PREFIX)).map((s) => ({ name: s.StackName, lastDeployed: s.LastUpdatedTime ?? s.CreationTime }));
}

function pullRequest(number) {
  const pr = gh(`repos/${repo}/pulls/${number}`);
  return { number, state: pr.state, labels: pr.labels.map((l) => l.name), fromFork: pr.head.repo?.full_name !== repo, headRef: pr.head.ref };
}

function teardown(stack, reason = '') {
  if (previewNumber(stack) == null) throw new Error(`${stack} is not a preview; only previews are torn down here`);
  if (!previewStacks().some((s) => s.name === stack)) return console.log(`→ ${stack} isn't running; nothing to tear down`);
  const described = aws('cloudformation', 'describe-stacks', '--stack-name', stack);
  const table = described?.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'TableName')?.OutputValue;
  console.log(`→ Tearing down ${stack}${reason ? `: ${reason}` : ''}`);
  sh('aws', ['cloudformation', 'delete-stack', '--stack-name', stack, '--region', region]);
  sh('aws', ['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', stack, '--region', region]);
  // The template retains tables so production's survives a stack deletion; a preview's goes with it.
  if (table && canDropTable(stack)) sh('aws', ['dynamodb', 'delete-table', '--table-name', table, '--region', region], { allowFail: true });
}

function deleteDeployments(ids) {
  for (const id of ids) {
    sh('gh', ['api', '-X', 'POST', `repos/${repo}/deployments/${id}/statuses`, '-f', 'state=inactive'], { allowFail: true });
    sh('gh', ['api', '-X', 'DELETE', `repos/${repo}/deployments/${id}`], { allowFail: true });
  }
  if (ids.length) console.log(`→ Deleted ${ids.length} deployment record(s)`);
}

const commands = {
  'preview-plan'(number) {
    const pr = pullRequest(Number(number));
    const plan = planPreview(pr, previewStacks().map((s) => s.name));
    const running = plan.running.length ? plan.running.map((s) => `#${previewNumber(s)}`).join(', ') : 'none';
    output({
      action: plan.action,
      stack: `${PREVIEW_PREFIX}${pr.number}`,
      message: plan.action === 'refuse' ? `No preview: ${plan.reason} (${running}). Remove the \`preview\` label from one of them, or close it, and push again.` : plan.reason,
    });
  },

  teardown,

  sweep() {
    const stacks = previewStacks();
    const prs = new Map(stacks.map((s) => previewNumber(s.name)).filter((n) => n != null).map((n) => [n, gh(`repos/${repo}/pulls/${n}`)]).map(([n, pr]) => [n, { state: pr.state, labels: pr.labels.map((l) => l.name), headRef: pr.head.ref }]));
    const doomed = planSweep(stacks, prs, Date.now());
    for (const { stack, reason } of doomed) teardown(stack, reason);
    const running = stacks.filter((s) => !doomed.some((d) => d.stack === s.name)).map((s) => ({ number: previewNumber(s.name), headRef: prs.get(previewNumber(s.name))?.headRef }));
    deleteDeployments(staleDeployments(ghAll(`repos/${repo}/deployments?environment=preview&per_page=100`), running));
    deleteDeployments(oldProductionRecords(ghAll(`repos/${repo}/deployments?environment=production&per_page=100`).map((d) => ({ id: d.id, createdAt: d.created_at }))));
  },

  'last-good'(failedSha) {
    const deployments = ghAll(`repos/${repo}/deployments?environment=production&per_page=30`).map((d) => {
      const [status] = gh(`repos/${repo}/deployments/${d.id}/statuses?per_page=1`);
      return { sha: d.sha, createdAt: d.created_at, state: status?.state };
    });
    const sha = lastGood(deployments, failedSha);
    output({ sha: sha ?? '' });
  },

  comment(number, file) {
    const body = `${MARKER}\n${readFileSync(file, 'utf8')}`;
    const mine = ghAll(`repos/${repo}/issues/${number}/comments?per_page=100`).find((c) => c.body.startsWith(MARKER));
    if (mine) sh('gh', ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${mine.id}`, '--input', '-'], { input: JSON.stringify({ body }) });
    else sh('gh', ['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '--input', '-'], { input: JSON.stringify({ body }) });
  },
};

const [command, ...args] = process.argv.slice(2);
if (!commands[command]) {
  console.error(`Usage: node scripts/ci/run.mjs ${Object.keys(commands).join(' | ')}`);
  process.exit(2);
}
commands[command](...args);
