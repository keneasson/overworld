// Coverage per behaviour (#20): runs the test suite once, as `npm test` does, and writes the report.
//
//   node scripts/coverage.mjs [--by file] [--out <path>] [--root <dir>] [test files…]
//
// With no test files it runs `npm test`'s own (those of the package.json in --root, this repository by default). --by file measures per test file instead of per test (COVER-04).
// Exits as the tests did, so CI fails when a test fails, once the report is written. CI then saves it to Overworld (COVER-03).

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from './coverage/report.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args.splice(i, 2)[1];
};
const root = resolve(flag('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const hook = fileURLToPath(new URL('./coverage/hook.mjs', import.meta.url));
const by = flag('--by') ?? 'behaviour';
const out = resolve(flag('--out') ?? join(root, '.coverage', 'report.json'));

// `npm test`'s own command, so the coverage run is the same run: "node <flags> --test <globs>".
const testScript = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test;
const words = [...testScript.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]).slice(1);
const at = words.indexOf('--test');
const nodeArgs = [...words.slice(0, at), '--import', hook, '--test', ...(args.length ? args : words.slice(at + 1))];

const dir = mkdtempSync(join(tmpdir(), 'coverage-'));
const started = Date.now();
const env = { ...process.env, OVERWORLD_COVERAGE_DIR: dir, OVERWORLD_COVERAGE_BY: by };
delete env.NODE_TEST_CONTEXT; // when run from inside a test, its suite is a run of its own
const run = spawnSync(process.execPath, nodeArgs, { cwd: root, stdio: 'inherit', env });
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const runs = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
rmSync(dir, { recursive: true, force: true });

const commit = process.env.OVERWORLD_COMMIT || gitHead();
const report = buildReport(runs, { commit, relative: (p) => relative(root, p).split(sep).join('/') });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
console.log(`Coverage per ${report.coverage} for ${Object.keys(report.behaviours).length} behaviours in ${seconds}s: ${relative(process.cwd(), out)}`);

process.exit(run.status ?? 1);

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
