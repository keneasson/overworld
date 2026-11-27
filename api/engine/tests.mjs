// A repository's tests, read the way a test skeleton needs them (#23): where each behaviour's tests already are, and the
// style they are written in, learned from the tests themselves. Deterministic: the same tests always give the same style.
// A project with no tests we can read gets its language instead, so its skeletons follow best practice for it (SKETCH-04).

const TEST_CALL = /\b(test|it)(?:\.\w+)?\s*\(\s*(['"`])((?:(?!\2)[^\\]|\\.)*)\2/g;
const BEHAVIOUR_ID = /\b[A-Z][A-Z0-9]*-\d+\b|(?<![\w#])#\d+\b/g; // an ID, or a store's (#574, #571 BEH-07)
const RUNNERS = [
  ['node', /from\s+['"]node:test['"]|require\(\s*['"]node:test['"]\s*\)/],
  ['vitest', /from\s+['"]vitest['"]/],
  ['bun', /from\s+['"]bun:test['"]/],
  ['playwright', /from\s+['"]@playwright\/test['"]/],
  ['jest', /from\s+['"]@jest\/globals['"]/],
];
const RUNNER_IMPORT = /^\s*(?:import\s.+\sfrom\s+['"](?:node:test|vitest|bun:test|@playwright\/test|@jest\/globals)['"]|const\s.+=\s*require\(\s*['"]node:test['"]\s*\));?\s*$/;
const ASSERT_IMPORT = /^\s*(?:import\s.+\sfrom\s+['"](?:node:assert(?:\/strict)?|assert(?:\/strict)?|chai)['"]|const\s.+=\s*require\(\s*['"](?:node:)?assert(?:\/strict)?['"]\s*\));?\s*$/;
const SKIP = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.next|\.expo|\.turbo|\.vercel)\//;
// Test files in languages whose tests aren't read yet: we can see they exist, but not what they prove.
const OTHER_TESTS = [
  ['python', /(^|\/)(test_[^/]+|[^/]+_test)\.py$/],
  ['go', /_test\.go$/],
  ['rust', /(^|\/)tests\/[^/]+\.rs$/],
  ['ruby', /_(spec|test)\.rb$/],
];
const LANGUAGES = [
  ['typescript', /\.(ts|tsx|mts|cts)$/],
  ['javascript', /\.(js|jsx|mjs|cjs)$/],
  ['python', /\.py$/],
  ['go', /\.go$/],
  ['rust', /\.rs$/],
  ['ruby', /\.rb$/],
];
const MAX_PER_BEHAVIOUR = 3;
const MAX_NAME = 160;

const most = (counts, fallback) => [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] ?? fallback;
const tally = (list) => list.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());

/** Each test in a file's text: { name, ids }. */
export function testsIn(text) {
  return [...String(text ?? '').matchAll(TEST_CALL)].map(([, , , name]) => ({ name, ids: [...new Set(name.match(BEHAVIOUR_ID) ?? [])] }));
}

/** The project's main language, by its source files (and its manifests, for JavaScript without a file yet). */
export function languageOf(paths, manifests = new Map()) {
  const counts = new Map();
  for (const p of paths) {
    if (SKIP.test(p)) continue;
    const lang = LANGUAGES.find(([, re]) => re.test(p))?.[0];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  if (counts.has('typescript') && counts.has('javascript')) counts.set('typescript', counts.get('typescript') + counts.get('javascript') * 0.5);
  return most(counts, manifests.size ? 'javascript' : null);
}

/**
 * What a skeleton needs to know about a repository's tests.
 * @param {{ paths: string[], manifests?: Map<string, object>, tests: [string, string|null][] }} o test files and their text
 * @returns {{ language: string|null, runner: string|null, learned: string[], style: object|null, other: string|null, at: Record<string, { file: string, name: string }[]> }}
 */
export function testingOf({ paths, manifests = new Map(), tests }) {
  const read = tests.filter(([p, t]) => t && !SKIP.test(p));
  const at = {};
  const found = [];
  for (const [file, text] of read) {
    const ts = testsIn(text);
    if (ts.length) found.push([file, text, ts]);
    for (const { name, ids } of ts) for (const id of ids) if ((at[id] ??= []).length < MAX_PER_BEHAVIOUR) at[id].push({ file, name: name.slice(0, MAX_NAME) });
  }
  const other = OTHER_TESTS.find(([, re]) => paths.some((p) => re.test(p) && !SKIP.test(p)))?.[0] ?? null;
  const dev = Object.assign({}, ...[...manifests.values()].map((m) => ({ ...m?.dependencies, ...m?.devDependencies })));
  const runner = ['vitest', 'jest', 'mocha'].find((r) => dev[r]) ?? null; // what the project would run its first test with
  return { language: languageOf(paths, manifests), runner, learned: found.map(([f]) => f), style: found.length ? styleOf(found, manifests) : null, other: found.length ? null : other, at };
}

/** The style the existing tests are written in. */
function styleOf(found, manifests) {
  const texts = found.map(([, t]) => t);
  const all = texts.join('\n');
  const lines = all.split('\n');
  const dev = Object.assign({}, ...[...manifests.values()].map((m) => ({ ...m?.dependencies, ...m?.devDependencies })));
  const imported = tally(texts.map((t) => RUNNERS.find(([, re]) => re.test(t))?.[0]).filter(Boolean));
  const runner = most(imported, ['vitest', 'jest', 'mocha'].find((r) => dev[r]) ?? 'jest');
  const callCounts = tally([...all.matchAll(/^\s*(test|it)(?:\.\w+)?\s*\(/gm)].map((m) => m[1]));
  const quoteCounts = tally([...all.matchAll(/^\s*(?:test|it)(?:\.\w+)?\s*\(\s*(['"`])/gm)].map((m) => m[1]));
  const code = lines.filter((l) => l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l));
  const semi = code.filter((l) => /;\s*$/.test(l)).length > code.length / 4;
  const indents = tally(lines.map((l) => l.match(/^(\t+| +)\S/)?.[1]).filter(Boolean).map((w) => (w[0] === '\t' ? '\t' : ' '.repeat(Math.min(w.length, 8)))));
  const indent = indents.get('\t') > (indents.get('  ') ?? 0) + (indents.get('    ') ?? 0) ? '\t' : (indents.get('    ') ?? 0) > (indents.get('  ') ?? 0) * 1.5 ? '    ' : '  ';
  const asyncs = (all.match(/\(\s*(['"`]).*?\1\s*,\s*async\b/g) ?? []).length;
  const syncs = (all.match(/\(\s*(['"`]).*?\1\s*,\s*(?:\(\s*\w*\s*\)\s*=>|function\b)/g) ?? []).length;
  const arrows = (all.match(/\(\s*(['"`]).*?\1\s*,\s*(?:async\s*)?\(\s*\w*\s*\)\s*=>/g) ?? []).length;
  const functions = (all.match(/\(\s*(['"`]).*?\1\s*,\s*(?:async\s*)?function\b/g) ?? []).length;
  const imports = (re) => most(tally(lines.filter((l) => re.test(l)).map((l) => l.trim())), null);
  const runnerImport = imports(RUNNER_IMPORT);
  const assertImport = imports(ASSERT_IMPORT);
  const assertName = assertImport?.match(/import\s+(?:\*\s+as\s+)?(\w+)\s+from|const\s+(\w+)\s*=/)?.slice(1).find(Boolean) ?? null;
  const suffixes = tally(found.map(([f]) => f.match(/(\.(?:test|spec)\.[cm]?[jt]sx?|\.[cm]?[jt]sx?)$/)?.[1]).filter(Boolean));
  return {
    runner,
    call: most(callCounts, 'test'),
    quote: most(quoteCounts, "'"),
    semi,
    indent,
    async: asyncs > syncs,
    arrow: arrows >= functions,
    imports: [runnerImport, assertImport].filter(Boolean),
    fail: assertName && /assert/.test(assertImport) ? `${assertName}.fail` : /\bexpect\.fail\(/.test(all) ? 'expect.fail' : null,
    suffix: most(suffixes, '.test.js'),
  };
}
