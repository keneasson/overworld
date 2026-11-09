// Build the web app + API bundle and deploy them to AWS with SAM.
//
//   npm run deploy                       # uses your default AWS profile/region
//   AWS_PROFILE=x AWS_REGION=y npm run deploy
//   STACK_NAME=projectmap-dev npm run deploy -- --new   # a second stack
//
// The access key is generated on first deploy and kept in .conf/deploy.json
// (git-ignored). Set PROJECTMAP_ACCESS_KEY to choose your own.
//
// CI (#27) has no .conf/: it names everything itself, and nothing is written locally.
//   CI=true STACK_NAME=… AWS_REGION=… PROJECTMAP_ACCESS_KEY=… [STAGE=preview] [ARTIFACT_BUCKET=…] [PERMISSIONS_BOUNDARY=…]
//   [SYNC_APP_ID=… SYNC_INSTALLATION_ID=… SYNC_APP_SLUG=…]   production only: previews never sync with GitHub

import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { APP_NAME } from '../shared/brand.js';
import { readDeployConfig, readGitHubApp, writeDeployConfig } from './local-config.mjs';

const root = new URL('..', import.meta.url).pathname;
const local = readDeployConfig();
const fromCi = Boolean(process.env.CI && process.env.STACK_NAME && process.env.AWS_REGION && process.env.PROJECTMAP_ACCESS_KEY);

// A checkout without .conf/ (a worktree, a fresh clone) doesn't know the live stack's region or
// access key: deploying from it would replace the key, or create a second stack elsewhere.
if (!local.stack && !fromCi && !process.argv.includes('--new')) {
  console.error('✖ No .conf/deploy.json in this checkout.\n  Copy .conf/ from the checkout you deploy from, or run `npm run deploy -- --new` to create a new stack.');
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`\n✖ ${cmd} ${args[0]} failed`);
    process.exit(res.status ?? 1);
  }
  return res.stdout?.trim();
}

const stack = process.env.STACK_NAME ?? local.stack ?? 'projectmap';
const region =
  process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? local.region ?? (run('aws', ['configure', 'get', 'region'], { capture: true }) || 'us-east-1');
const accessKey = process.env.PROJECTMAP_ACCESS_KEY ?? local.accessKey ?? randomBytes(18).toString('base64url');
const profileArgs = process.env.AWS_PROFILE ? ['--profile', process.env.AWS_PROFILE] : [];
// The GitHub App's ids aren't secret. Without them sync stays off; its key and webhook secret go to SSM once (scripts/github-app-secrets.mjs).
const app = readGitHubApp();
const appParams = app ? [`GitHubAppId=${app.appId}`, `GitHubInstallationId=${app.installationId}`, `GitHubAppSlug=${app.slug}`] : [];

const identity = JSON.parse(run('aws', ['sts', 'get-caller-identity', '--output', 'json', ...profileArgs], { capture: true }));
console.log(`→ Deploying stack "${stack}" to account ${identity.Account} in ${region}`);

console.log('→ Building web app');
run('npx', ['vite', 'build', '--logLevel', 'warn']);

console.log('→ Bundling API');
rmSync(`${root}.build`, { recursive: true, force: true });
mkdirSync(`${root}.build/lambda`, { recursive: true });
await build({
  entryPoints: [`${root}api/handler.mjs`],
  outfile: `${root}.build/lambda/index.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external: ['@aws-sdk/*'], // provided by the Lambda runtime
  logLevel: 'warning',
});
cpSync(`${root}web/dist`, `${root}.build/lambda/public`, { recursive: true });

// The GitHub App that sync (#3) writes as. Passed only to a template that declares them; a parameter
// left out keeps its previous value, so a local deploy doesn't turn sync off.
const declared = readFileSync(`${root}template.yaml`, 'utf8');
const sync = [
  ['GitHubAppId', process.env.SYNC_APP_ID],
  ['GitHubInstallationId', process.env.SYNC_INSTALLATION_ID],
  ['GitHubAppSlug', process.env.SYNC_APP_SLUG],
].filter(([name, value]) => value && new RegExp(`\\n  ${name}:\\n`).test(declared)).map(([name, value]) => `${name}=${value}`);

console.log('→ sam deploy');
run('sam', [
  'deploy',
  '--template-file', 'template.yaml',
  '--stack-name', stack,
  '--region', region,
  // CI's bundles go to a bucket that expires them after 7 days; a local deploy keeps SAM's own bucket.
  ...(process.env.ARTIFACT_BUCKET ? ['--s3-bucket', process.env.ARTIFACT_BUCKET, '--s3-prefix', stack] : ['--resolve-s3']),
  '--capabilities', 'CAPABILITY_IAM',
  '--no-confirm-changeset',
  '--no-fail-on-empty-changeset',
  '--tags', 'app=projectmap', ...(process.env.STAGE ? [`stage=${process.env.STAGE}`] : []),
  '--parameter-overrides', `AccessKey=${accessKey}`,
  ...(process.env.STAGE ? [`Stage=${process.env.STAGE}`] : []),
  ...(process.env.PERMISSIONS_BOUNDARY ? [`PermissionsBoundary=${process.env.PERMISSIONS_BOUNDARY}`] : []),
  // CI passes the App's ids in the environment; a local deploy reads them from .conf/.
  ...(sync.length ? sync : appParams),
  ...profileArgs,
]);

const outputs = JSON.parse(
  run('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--region', region, '--query', 'Stacks[0].Outputs', '--output', 'json', ...profileArgs], {
    capture: true,
  }),
);
const out = Object.fromEntries(outputs.map((o) => [o.OutputKey, o.OutputValue]));
const url = out.Url.replace(/\/$/, '');

if (fromCi) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\n`);
} else {
  writeDeployConfig({ stack, region, url, accessKey, tableName: out.TableName, account: identity.Account });
}

const health = await fetch(`${url}/api/health`).then((r) => r.status).catch((e) => e.message);
console.log(`\n✔ ${APP_NAME} is live: ${url}`);
console.log(`  health check: ${health}`);
if (!fromCi) console.log(`  access key:   saved in .conf/deploy.json (enter it once per browser)`);
