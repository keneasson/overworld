// Coverage per behaviour (#20): loaded with --import into each test file's process by scripts/coverage.mjs.
//
// V8's precise coverage resets its counters every time it is taken, so taking it before and after each test gives what
// that test alone reached (COVER-01), in one run of the suite. Tests in a file run one after another, so nothing overlaps.
// With OVERWORLD_COVERAGE_BY=file it is taken once, after the file's last test, which is cheaper (COVER-04).
// Each process writes what it measured to OVERWORLD_COVERAGE_DIR as it exits; the report is put together from those.

import { Session } from 'node:inspector/promises';
import { after, afterEach, beforeEach } from 'node:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linesReached } from './lines.mjs';

const dir = process.env.OVERWORLD_COVERAGE_DIR;
const byFile = process.env.OVERWORLD_COVERAGE_BY === 'file';

// Only in a test file's own process: the runner that starts them loads this too.
if (dir && process.env.NODE_TEST_CONTEXT) {
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

  // Random ids are made in order instead, so a test takes the same path every time it runs (COVER-02).
  let made = 0;
  globalThis.crypto.randomUUID = () => {
    const h = createHash('sha256').update(`${process.argv[1]}#${++made}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };

  const root = process.cwd();
  const tests = [];
  const reached = new Map(); // each test, by its place in the file (or '*' for the whole file) -> Map(path -> Set(line))
  // Work a test leaves running (a save finishing after its response, say) is given time to end, so it isn't counted
  // as the next test's: without it the same commit could give a different report (COVER-02).
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 1));
  };
  const take = async () => (await settle(), (await session.post('Profiler.takePreciseCoverage')).result);
  const keep = (key, result) => {
    const lines = reached.get(key) ?? new Map();
    for (const [path, set] of linesReached(result, root)) lines.set(path, new Set([...(lines.get(path) ?? []), ...set]));
    reached.set(key, lines);
  };

  if (!byFile) beforeEach(async () => void (await take()));
  afterEach(async (t) => {
    tests.push({ name: t.name, passed: t.passed });
    if (!byFile) keep(tests.length - 1, await take());
  });
  if (byFile) after(async () => keep('*', await take()));

  process.on('exit', () => {
    const lines = (key) => Object.fromEntries([...(reached.get(key) ?? [])].map(([p, s]) => [p, [...s]]));
    const out = { file: process.argv[1], byFile, tests: tests.map((t, i) => ({ ...t, ...(byFile ? {} : { lines: lines(i) }) })), ...(byFile ? { lines: lines('*') } : {}) };
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify(out));
  });
}
