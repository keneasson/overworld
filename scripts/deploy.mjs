// Build the web app + API bundle and deploy them to AWS with SAM.
//
//   npm run deploy                       # uses your default AWS profile/region
//   AWS_PROFILE=x AWS_REGION=y npm run deploy
//   STACK_NAME=projectmap-dev npm run deploy
//
// The access key is generated on first deploy and kept in .projectmap.local.json
// (git-ignored). Set PROJECTMAP_ACCESS_KEY to choose your own.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { APP_NAME } from '../shared/brand.js';

const root = new URL('..', import.meta.url).pathname;
const localFile = `${root}.projectmap.local.json`;
const local = existsSync(localFile) ? JSON.parse(readFileSync(localFile, 'utf8')) : {};

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

console.log('→ sam deploy');
run('sam', [
  'deploy',
  '--template-file', 'template.yaml',
  '--stack-name', stack,
  '--region', region,
  '--resolve-s3',
  '--capabilities', 'CAPABILITY_IAM',
  '--no-confirm-changeset',
  '--no-fail-on-empty-changeset',
  '--tags', 'app=projectmap',
  '--parameter-overrides', `AccessKey=${accessKey}`,
  ...profileArgs,
]);

const outputs = JSON.parse(
  run('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--region', region, '--query', 'Stacks[0].Outputs', '--output', 'json', ...profileArgs], {
    capture: true,
  }),
);
const out = Object.fromEntries(outputs.map((o) => [o.OutputKey, o.OutputValue]));
const url = out.Url.replace(/\/$/, '');

writeFileSync(localFile, JSON.stringify({ stack, region, url, accessKey, tableName: out.TableName, account: identity.Account }, null, 2));
chmodSync(localFile, 0o600);

const health = await fetch(`${url}/api/health`).then((r) => r.status).catch((e) => e.message);
console.log(`\n✔ ${APP_NAME} is live: ${url}`);
console.log(`  health check: ${health}`);
console.log(`  access key:   saved in .projectmap.local.json (enter it once per browser)`);
