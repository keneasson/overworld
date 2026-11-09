// Secrets and machine-local settings live in .conf/, which git ignores as a whole.
// deploy.json records the last deploy: stack, region, URL, table name and the access key.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../.conf/', import.meta.url).pathname;
export const DEPLOY_CONFIG = `${dir}deploy.json`;

export function readDeployConfig() {
  return existsSync(DEPLOY_CONFIG) ? JSON.parse(readFileSync(DEPLOY_CONFIG, 'utf8')) : {};
}

export function writeDeployConfig(data) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(DEPLOY_CONFIG, JSON.stringify(data, null, 2));
  chmodSync(DEPLOY_CONFIG, 0o600);
}

// The GitHub App sync writes as (#3): github-app.json holds its ids, github-app.pem its private key,
// and github-webhook-secret the secret GitHub signs webhooks with. Only paths and ids leave this file.
export const GITHUB_APP_CONFIG = `${dir}github-app.json`;
export const GITHUB_APP_KEY = `${dir}github-app.pem`;
export const GITHUB_WEBHOOK_SECRET = `${dir}github-webhook-secret`;

/** The App's ids and slug, or null when this checkout has none. The key is read only when it is needed. */
export function readGitHubApp() {
  if (!existsSync(GITHUB_APP_CONFIG) || !existsSync(GITHUB_APP_KEY)) return null;
  const { appId, installationId, slug } = JSON.parse(readFileSync(GITHUB_APP_CONFIG, 'utf8'));
  return { appId, installationId, slug, privateKey: async () => readFileSync(GITHUB_APP_KEY, 'utf8') };
}
