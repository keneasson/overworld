// Coverage per behaviour (#20): the report scripts/coverage.mjs makes, run on a small suite of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { linesOf } from '../coverage/report.mjs';

const script = new URL('../coverage.mjs', import.meta.url).pathname;

// Two test files and the code they reach. `pick` takes a path by a random id, as the app's ids are random.
const SUITE = {
  'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test "*.test.mjs"' } }),
  'code.mjs': [
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    'export function shout(s) {',
    "  return s.toUpperCase() + '!';",
    '}',
    'export function pick() {',
    "  if (crypto.randomUUID() < '8') return 'low';",
    "  return 'high';",
    '}',
  ].join('\n'),
  'one.test.mjs': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add, pick } from './code.mjs';",
    "test('DEMO-01 adds', () => assert.equal(add(1, 2), 3));",
    "test('DEMO-02 DEMO-03 picks, and fails', () => { pick(); assert.equal(add(1, 1), 3); });",
  ].join('\n'),
  'two.test.mjs': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { shout } from './code.mjs';",
    "test('DEMO-03 shouts', () => assert.equal(shout('hi'), 'HI!'));",
  ].join('\n'),
};

async function suite() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'coverage-')));
  for (const [name, text] of Object.entries(SUITE)) await writeFile(join(dir, name), text);
  const report = async (...args) => {
    const out = join(dir, `report-${Math.random()}.json`);
    await promisify(execFile)(process.execPath, [script, '--root', dir, '--out', out, ...args], { env: { ...process.env, OVERWORLD_COMMIT: 'abc1234' } }).catch((e) => e); // its tests fail on purpose
    return JSON.parse(await readFile(out, 'utf8'));
  };
  return { report };
}

test('COVER-01 the report gives each behaviour ID its tests, pass or fail, and the files and lines they reached', async () => {
  const { report } = await suite();
  const r = await report();
  assert.equal(r.commit, 'abc1234');
  assert.equal(r.coverage, 'behaviour');
  assert.deepEqual(Object.keys(r.behaviours), ['DEMO-01', 'DEMO-02', 'DEMO-03']);
  const [one, two, three] = ['DEMO-01', 'DEMO-02', 'DEMO-03'].map((id) => r.behaviours[id]);
  assert.deepEqual(one.tests, [{ name: 'DEMO-01 adds', file: 'one.test.mjs', passed: true }]);
  assert.equal(one.passed, true);
  assert.equal(two.passed, false, 'a behaviour fails when any of its tests fails');
  assert.deepEqual(three.tests.map((t) => [t.file, t.passed]), [['one.test.mjs', false], ['two.test.mjs', true]], 'a test naming two IDs proves both');
  assert.deepEqual(Object.keys(one.files), ['code.mjs'], 'its code, never the tests themselves');
  assert.deepEqual(linesOf(one.files['code.mjs']), [1, 2, 3], 'only what its own tests reached');
  assert.ok(linesOf(three.files['code.mjs']).includes(5), 'everything its tests reached together');
});

test('COVER-02 the same commit gives the same report every time', async () => {
  const { report } = await suite();
  const first = await report();
  for (let i = 0; i < 3; i++) assert.deepEqual(await report(), first);
});

test('COVER-04 measured per test file, the report says so, and gives each behaviour what its file reached', async () => {
  const { report } = await suite();
  const r = await report('--by', 'file');
  assert.equal(r.coverage, 'file');
  assert.deepEqual(r.behaviours['DEMO-01'].files, r.behaviours['DEMO-02'].files, 'behaviours in one file share its coverage');
  assert.ok(linesOf(r.behaviours['DEMO-01'].files['code.mjs']).includes(8), 'DEMO-01 is given the lines DEMO-02 reached in its file');
});
