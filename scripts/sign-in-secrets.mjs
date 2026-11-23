// One-time setup for sign-in with GitHub (#52): the GitHub OAuth App's client secret and the bridge secret, as SecureString
// parameters in SSM, where the deployed function and its Cognito triggers read them. Neither is ever printed.
//
//   node scripts/sign-in-secrets.mjs            make .conf/sign-in-bridge-secret if there isn't one
//   node scripts/sign-in-secrets.mjs --push     also put both into SSM for the stack in .conf/deploy.json
//
// Put the OAuth App's client secret in .conf/github-oauth-secret first (pbpaste > .conf/github-oauth-secret).

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { SIGN_IN_BRIDGE_SECRET, SIGN_IN_GITHUB_SECRET, readDeployConfig } from './local-config.mjs';

if (!existsSync(SIGN_IN_BRIDGE_SECRET)) {
  writeFileSync(SIGN_IN_BRIDGE_SECRET, randomBytes(32).toString('hex'), { mode: 0o600 });
  chmodSync(SIGN_IN_BRIDGE_SECRET, 0o600);
  console.log('✔ Made .conf/sign-in-bridge-secret');
} else console.log('• .conf/sign-in-bridge-secret already exists; kept it');

if (process.argv.includes('--push')) {
  const { stack, region } = readDeployConfig();
  if (!stack || !region) {
    console.error('✖ No stack in .conf/deploy.json: deploy first.');
    process.exit(1);
  }
  if (!existsSync(SIGN_IN_GITHUB_SECRET)) {
    console.error('✖ No .conf/github-oauth-secret: put the GitHub OAuth App\'s client secret there first.');
    process.exit(1);
  }
  const profileArgs = process.env.AWS_PROFILE ? ['--profile', process.env.AWS_PROFILE] : [];
  for (const [name, file] of [
    ['github-client-secret', SIGN_IN_GITHUB_SECRET],
    ['bridge-secret', SIGN_IN_BRIDGE_SECRET],
  ]) {
    // file:// makes the CLI read the value itself, so it never appears in an argument list or a log.
    const res = spawnSync('aws', ['ssm', 'put-parameter', '--name', `/${stack}/sign-in/${name}`, '--type', 'SecureString', '--value', `file://${file}`, '--overwrite', '--region', region, ...profileArgs], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (res.status !== 0) process.exit(res.status ?? 1);
    console.log(`✔ /${stack}/sign-in/${name} is in SSM (${region})`);
  }
}
