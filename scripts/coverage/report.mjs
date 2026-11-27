// The coverage report (#20): each behaviour ID, its tests, pass or fail, and the files and lines its tests reached.
// Nothing in it depends on when or where it was made, so the same commit always gives the same report (COVER-02).

const BEHAVIOUR_ID = /\b[A-Z][A-Z0-9]*-\d+\b|(?<![\w#])#\d+\b/g; // an ID, or a store's (#574, #571 BEH-07)

/** Line numbers as ranges: [1, 2, 3, 7] -> '1-3,7'. */
export function rangesOf(lines) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i];
    while (sorted[i + 1] === sorted[i] + 1) i++;
    out.push(from === sorted[i] ? `${from}` : `${from}-${sorted[i]}`);
  }
  return out.join(',');
}

export { linesOf } from '../../shared/proof.js';

const sortedObject = (entries) => Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * @param {{ file: string, byFile: boolean, tests: { name, passed, lines? }[], lines? }[]} runs what each test file's process measured
 * @param {{ commit: string, relative?: (path: string) => string }} o relative: a test file's path as the report shows it
 * @returns {{ commit: string, coverage: 'behaviour' | 'file', behaviours: Record<string, { passed: boolean, tests: { name, file, passed }[], files: Record<string, string> }> }}
 */
export function buildReport(runs, { commit, relative = (p) => p }) {
  const byFile = runs.some((r) => r.byFile);
  const found = new Map(); // id -> { tests, files: Map(path -> Set(line)) }
  for (const run of runs) {
    const file = relative(run.file);
    for (const t of run.tests) {
      for (const id of new Set(t.name.match(BEHAVIOUR_ID) ?? [])) {
        const b = found.get(id) ?? { tests: [], files: new Map() };
        b.tests.push({ name: t.name, file, passed: t.passed });
        // Per file (COVER-04), each behaviour in a file is given everything the file's tests reached together.
        for (const [path, lines] of Object.entries((byFile ? run.lines : t.lines) ?? {})) b.files.set(path, new Set([...(b.files.get(path) ?? []), ...lines]));
        found.set(id, b);
      }
    }
  }
  const behaviours = sortedObject(
    [...found].map(([id, b]) => {
      const tests = b.tests.sort((x, y) => (x.file + '\0' + x.name < y.file + '\0' + y.name ? -1 : 1));
      return [id, { passed: tests.every((t) => t.passed), tests, files: sortedObject([...b.files].map(([p, s]) => [p, rangesOf(s)])) }];
    }),
  );
  return { commit, coverage: byFile ? 'file' : 'behaviour', behaviours };
}
