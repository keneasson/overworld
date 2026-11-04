// 2026-11-03: move the deployed table to entity keys (see api/model/README.md).
//
//   node scripts/migrations/001-single-table-keys.mjs           # back up, copy to the new keys, verify
//   node scripts/migrations/001-single-table-keys.mjs --prune   # then delete the old-format items
//
// Old layout:  PROJECTS / <id>       a project summary
//              PROJECTS / #<flag>    a flag
//              P#<id>   / N#<node>   a node
//
// Run the copy before deploying code that reads the new keys, and prune once the app checks out.
// It's safe to repeat: a project already in the new layout is never copied over again.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dynamoTable } from '../../api/model/table.mjs';
import { modelFor } from '../../api/model/index.mjs';

const root = new URL('../../', import.meta.url).pathname;
const local = JSON.parse(readFileSync(`${root}.projectmap.local.json`, 'utf8'));
const prune = process.argv.includes('--prune');
const table = await dynamoTable(local.tableName, { region: local.region });
const model = modelFor(table);

const items = await table.scan();
mkdirSync(`${root}.data/backups`, { recursive: true });
const backup = `${root}.data/backups/${local.tableName}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(backup, JSON.stringify(items));
console.log(`Backed up ${items.length} items to ${backup}`);

const strip = ({ PK, SK, ...rest }) => rest;
const oldProjects = items.filter((i) => i.PK === 'PROJECTS' && !i.SK.startsWith('#'));
const oldFlags = items.filter((i) => i.PK === 'PROJECTS' && i.SK.startsWith('#'));
const oldNodes = (id) => items.filter((i) => i.PK === `P#${id}` && i.SK.startsWith('N#'));
const orphans = items.filter((i) => i.PK.startsWith('P#') && !oldProjects.some((p) => i.PK === `P#${p.SK}`));
const sameIds = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

const moved = [];
for (const p of oldProjects) {
  const id = p.SK;
  const nodes = oldNodes(id).map(strip);
  let now = await model.projects.getWithNodes(id);
  if (!now) {
    await model.nodes.put(id, nodes);
    await model.projects.put(strip(p));
    now = await model.projects.getWithNodes(id);
  }
  const ok = now && sameIds(now.nodes.map((n) => n.id), nodes.map((n) => n.id));
  console.log(`${ok ? '✔' : '✘'} ${p.title} (${id}): ${nodes.length} nodes before, ${now?.nodes.length ?? 0} in the new layout`);
  if (ok) moved.push(p);
}
for (const f of oldFlags) if (!(await model.flags.has(f.SK.slice(1)))) await model.flags.set(f.SK.slice(1));
if (orphans.length) console.log(`${orphans.length} old nodes belong to no project; they are left alone.`);
if (moved.length < oldProjects.length) process.exit(1);

if (!prune) {
  console.log('Old items kept. Deploy, check the app, then run again with --prune.');
} else {
  const doomed = [...moved.flatMap((p) => [p, ...oldNodes(p.SK)]), ...oldFlags].map(({ PK, SK }) => ({ PK, SK }));
  await table.write({ deletes: doomed });
  console.log(`Pruned ${doomed.length} old-format items.`);
}
