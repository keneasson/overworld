// Delivery (#27). The rules are tested directly; promises that only the configuration can keep are
// checked by reading the workflows and templates. Deploys themselves are proven by live runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { canDropTable, lastGood, MAX_PREVIEWS, oldProductionRecords, planPreview, planSweep, previewStack, PRODUCTION_STACK, staleDeployments } from '../ci/rules.mjs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const workflows = readdirSync(new URL('.github/workflows/', root))
  .filter((f) => f.endsWith('.yml'))
  .map((f) => ({ file: f, text: read(`.github/workflows/${f}`) }));

/** A workflow's jobs, as { name, text }: each job is the block under `jobs:` indented by two spaces. */
const jobsOf = (text) => {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  return body.split(/\n(?=  [\w-]+:\n)/).map((block) => ({ name: block.match(/^ {2}([\w-]+):/)?.[1], text: block })).filter((j) => j.name);
};

const pr = (number, extra = {}) => ({ number, labels: ['preview'], fromFork: false, ...extra });
const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-11-20T12:00:00Z');
const ago = (days) => new Date(now - days * DAY).toISOString();

test('SHIP-03 a failed deploy rolls back to the newest version that passed, never the one that failed', () => {
  const deployments = [
    { sha: 'a', createdAt: '2026-11-01T00:00:00Z', state: 'success' },
    { sha: 'b', createdAt: '2026-11-02T00:00:00Z', state: 'success' },
    { sha: 'c', createdAt: '2026-11-03T00:00:00Z', state: 'failure' },
    { sha: 'd', createdAt: '2026-11-04T00:00:00Z', state: 'in_progress' },
  ];
  assert.equal(lastGood(deployments, 'd'), 'b', 'c failed its smoke test, so it is skipped');
  assert.equal(lastGood([...deployments, { sha: 'd', createdAt: '2026-11-04T00:00:00Z', state: 'success' }], 'd'), 'b');
  assert.equal(lastGood([], 'd'), null, 'the first deploy has nothing to go back to');
});

test('SHIP-04 a labelled pull request from this repository gets a preview, and keeps it on every push', () => {
  assert.equal(planPreview(pr(12), []).action, 'deploy');
  const full = [previewStack(1), previewStack(2), previewStack(12)];
  assert.equal(planPreview(pr(12), full).action, 'deploy', 'a running preview updates even when the limit is reached');
  assert.equal(planPreview(pr(12, { labels: ['bug'] }), []).action, 'skip', 'no label, no preview');
  assert.equal(previewStack(12), 'projectmap-pr-12');
});

test('SHIP-05 pull requests from forks never deploy and never see secrets', () => {
  assert.equal(planPreview(pr(12, { fromFork: true }), []).action, 'skip');
  for (const { file, text } of workflows) {
    // pull_request_target runs with our secrets, so it may never check out a pull request's code (cla.yml doesn't).
    if (/pull_request_target/.test(text)) assert.doesNotMatch(text, /actions\/checkout|id-token: write|run:/, `${file}: pull_request_target with code from the pull request`);
    if (!/\n {2}pull_request:/.test(text)) continue;
    for (const job of jobsOf(text)) {
      if (!/secrets\.|id-token: write|environment:/.test(job.text)) continue;
      assert.match(job.text, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/, `${file}: job ${job.name} must not run for forks`);
    }
  }
});

test('SHIP-06 a fourth preview is refused, and the pull request is told which are running', () => {
  const running = [previewStack(3), previewStack(1), previewStack(2)];
  assert.equal(MAX_PREVIEWS, 3);
  const plan = planPreview(pr(9), running);
  assert.equal(plan.action, 'refuse');
  assert.deepEqual(plan.running, [previewStack(1), previewStack(2), previewStack(3)]);
  assert.equal(planPreview(pr(9), running.slice(0, 2)).action, 'deploy');
});

test('SHIP-07 a preview goes when its pull request closes, loses its label or goes 7 days without a deploy', () => {
  const stacks = [1, 2, 3, 4, 5, 6].map((n) => ({ name: previewStack(n), lastDeployed: n === 4 ? ago(7) : n === 5 ? ago(6.9) : ago(1) }));
  stacks.push({ name: PRODUCTION_STACK, lastDeployed: ago(400) }, { name: 'projectmap-pr-x', lastDeployed: ago(400) });
  const prs = new Map([
    [1, { state: 'open', labels: ['preview'] }],
    [2, { state: 'closed', labels: ['preview'] }],
    [3, { state: 'open', labels: [] }],
    [4, { state: 'open', labels: ['preview'] }],
    [5, { state: 'open', labels: ['preview'] }],
  ]);
  assert.deepEqual(planSweep(stacks, prs, now), [
    { stack: 'projectmap-pr-2', reason: 'its pull request is closed' },
    { stack: 'projectmap-pr-3', reason: 'the `preview` label was removed' },
    { stack: 'projectmap-pr-4', reason: 'no deploy for 7 days' },
    { stack: 'projectmap-pr-6', reason: 'its pull request was not found' },
  ]);
  // Production's table is never deleted: not by the rules, and not by CI's permissions.
  assert.equal(canDropTable(PRODUCTION_STACK), false);
  assert.equal(canDropTable('projectmap-pr-x'), false);
  assert.equal(canDropTable(previewStack(2)), true);
  const bootstrap = read('infra/ci-bootstrap.yaml');
  const deletes = bootstrap.match(/Action: 'dynamodb:DeleteTable'\n\s+Resource: \[(.*)\]/);
  assert.ok(deletes && deletes[1].includes('table/projectmap-pr-*'), 'CI can delete only preview tables');
  assert.doesNotMatch(bootstrap.replace(deletes[0], ''), /dynamodb:\*|dynamodb:DeleteTable/);
});

test('SHIP-08 what a build leaves behind has a limit, and records of gone previews are deleted', () => {
  const deployments = [
    { id: 1, ref: 'feature-a' },
    { id: 2, ref: 'refs/pull/7/merge' },
    { id: 3, ref: 'feature-gone' },
    { id: 4, ref: 'refs/pull/8/merge' },
  ];
  assert.deepEqual(staleDeployments(deployments, [{ number: 7, headRef: 'feature-a' }]), [3, 4]);
  const production = Array.from({ length: 25 }, (_, i) => ({ id: i, createdAt: new Date(now - i * DAY).toISOString() }));
  assert.deepEqual(oldProductionRecords(production), [20, 21, 22, 23, 24], 'the newest 20 stay, to roll back from');

  for (const { file, text } of workflows) {
    for (const step of text.split(/\n\s+- /).filter((s) => s.includes('actions/upload-artifact'))) {
      const days = Number(step.match(/retention-days:\s*(\d+)/)?.[1]);
      assert.ok(days > 0 && days <= 3, `${file}: every artifact is kept 3 days at most`);
    }
  }
  const template = read('template.yaml');
  assert.match(template, /RetentionInDays: !If \[IsPreview, 3, 14\]/, 'preview logs 3 days, production 14');
  assert.doesNotMatch(template, /AutoPublishAlias|AutoPublishCodeSha256|VersionDescription/, 'no Lambda versions are kept');
  assert.match(read('infra/ci-bootstrap.yaml'), /ExpirationInDays: 7/, 'deploy bundles expire after 7 days');
});

test('SHIP-09 CI reaches AWS only with short-lived OIDC credentials, and cannot change its own permissions', () => {
  for (const { file, text } of workflows) {
    assert.doesNotMatch(text, /aws-access-key-id|aws-secret-access-key|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID/i, `${file}: no long-lived AWS keys`);
    for (const step of text.split(/\n\s+- /).filter((s) => s.includes('configure-aws-credentials'))) assert.match(step, /role-to-assume:/, `${file}: credentials come from the OIDC role`);
  }
  const bootstrap = read('infra/ci-bootstrap.yaml');
  for (const name of bootstrap.matchAll(/(?:RoleName|ManagedPolicyName|BucketName): !?S?u?b? ?(\S+)/g)) assert.doesNotMatch(name[1], /^projectmap/, `${name[1]} must sit outside the projectmap* resources CI controls`);
  assert.match(bootstrap, /iam:CreateRole'.*\n(.*\n){1,3}.*iam:PermissionsBoundary: !Ref Boundary/, 'every role CI creates carries the boundary');
});
