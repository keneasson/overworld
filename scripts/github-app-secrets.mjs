// One-time setup for sync (#3): the GitHub App's private key and webhook secret, as SecureString
// parameters in SSM, where the deployed function reads them. Neither is ever printed.
//
//   node scripts/github-app-secrets.mjs            make .conf/github-webhook-secret if there isn't one
//   node scripts/github-app-secrets.mjs --push     also put both into SSM for the stack in .conf/deploy.json
//
// Paste the webhook secret into the App's settings from the file (pbcopy < .conf/github-webhook-secret).

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { GITHUB_APP_KEY, GITHUB_WEBHOOK_SECRET, readDeployConfig } from './local-config.mjs';

if (!existsSync(GITHUB_WEBHOOK_SECRET)) {
  writeFileSync(GITHUB_WEBHOOK_SECRET, randomBytes(32).toString('hex'), { mode: 0o600 });
  chmodSync(GITHUB_WEBHOOK_SECRET, 0o600);
  console.log('✔ Made .conf/github-webhook-secret');
} else console.log('• .conf/github-webhook-secret already exists; kept it');

if (process.argv.includes('--push')) {
  const { stack, region } = readDeployConfig();
  if (!stack || !region) {
    console.error('✖ No stack in .conf/deploy.json: deploy first.');
    process.exit(1);
  }
  if (!existsSync(GITHUB_APP_KEY)) {
    console.error('✖ No .conf/github-app.pem.');
    process.exit(1);
  }
  const profileArgs = process.env.AWS_PROFILE ? ['--profile', process.env.AWS_PROFILE] : [];
  for (const [name, file] of [
    ['private-key', GITHUB_APP_KEY],
    ['webhook-secret', GITHUB_WEBHOOK_SECRET],
  ]) {
    // file:// makes the CLI read the value itself, so it never appears in an argument list or a log.
    const res = spawnSync('aws', ['ssm', 'put-parameter', '--name', `/${stack}/github-app/${name}`, '--type', 'SecureString', '--value', `file://${file}`, '--overwrite', '--region', region, ...profileArgs], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (res.status !== 0) process.exit(res.status ?? 1);
    console.log(`✔ /${stack}/github-app/${name} is in SSM (${region})`);
  }
}
