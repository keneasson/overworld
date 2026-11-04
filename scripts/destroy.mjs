// Remove the stack. The DynamoDB table is retained on purpose so
// your maps survive; the command to delete it is printed at the end.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const localFile = `${root}.projectmap.local.json`;
const local = existsSync(localFile) ? JSON.parse(readFileSync(localFile, 'utf8')) : {};
const stack = process.env.STACK_NAME ?? local.stack ?? 'projectmap';
const region = process.env.AWS_REGION ?? local.region;
const profileArgs = process.env.AWS_PROFILE ? ['--profile', process.env.AWS_PROFILE] : [];

const res = spawnSync('sam', ['delete', '--stack-name', stack, ...(region ? ['--region', region] : []), '--no-prompts', ...profileArgs], {
  cwd: root,
  stdio: 'inherit',
});
if (res.status !== 0) process.exit(res.status ?? 1);
if (local.tableName) {
  console.log(`\nThe data table was kept. To delete it too:\n  aws dynamodb delete-table --table-name ${local.tableName}${region ? ` --region ${region}` : ''}`);
}
