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
