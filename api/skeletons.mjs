// Test skeletons from adopted behaviours (#23). A skeleton is a test named by its behaviour's ID, with its Given / When /
// Then, that fails until someone fills it in: the builder's job becomes "make it pass". It is written in the style of the
// project's existing tests (SKETCH-01), or best practice for its language when it has none (SKETCH-04), and a behaviour
// that already has a test gets a pointer to it, never a second one (SKETCH-03). The build prompt carries them (SKETCH-02).
// Writing the body is the builder's job, not this file's.

import { editableOf, parseBehaviours, parseIssue, sectionText } from '../shared/issue-shape.js';

const FOG = /^not worked out yet\b/i;
const STATEMENT_WORDS = 10;
const LOOSE = /^(a|an|the|its|their|and|or|but|of|by|to|in|on|at|for|with|from|as|is|are|be|that|which|who)$/i;

// Best practice for requirement-driven tests, by language, when a project has no tests to learn from (SKETCH-04).
const JS = { call: 'test', quote: "'", semi: true, indent: '  ', async: false, arrow: true };
const BEST = {
  node: { ...JS, runner: 'node', imports: ["import { test } from 'node:test';", "import assert from 'node:assert/strict';"], fail: 'assert.fail', suffix: '.test.mjs' },
  vitest: { ...JS, runner: 'vitest', imports: ["import { test } from 'vitest';"], fail: null, suffix: '.test.js' },
  jest: { ...JS, runner: 'jest', imports: [], fail: null, suffix: '.test.js' },
  mocha: { ...JS, call: 'it', runner: 'mocha', imports: ["import assert from 'node:assert/strict';"], fail: 'assert.fail', suffix: '.test.js' },
};

/** A behaviour's short statement for a test name: the start of its Then, since the issue holds the detail (NAMING-01). */
export function statementOf(b) {
  const said = (b.then || b.text || '').replace(/\s+/g, ' ').trim();
  const first = said.split(/[.;:](?:\s|$)|,\s+(?:and|but|so|or)\s|\s[—–]\s|\s\(/)[0].replace(/^then\s+/i, '').replace(/[,.\s]+$/, '');
  const words = first.split(' ');
  if (words.length <= STATEMENT_WORDS) return first;
  const cut = words.slice(0, STATEMENT_WORDS);
  while (cut.length > 3 && (LOOSE.test(cut.at(-1)) || !/\w/.test(cut.at(-1)))) cut.pop(); // never end on "and its" or a slash
  return cut.join(' ');
}

/** The item's behaviours with their Given / When / Then, leaving out those still in the Fog. */
function rowsOf(node) {
  return parseBehaviours(sectionText(parseIssue(editableOf(node).markdown), 'Behaviours'))
    .filter((r) => r.id && !FOG.test(r.text || r.given))
    .map((r) => ({ id: r.id, given: r.given, when: r.when, then: r.then, text: r.text }));
}

const prefixOf = (id) => id.replace(/-\d+$/, '');
const dirOf = (file) => file.replace(/[^/]*$/, '');
const most = (list) => [...list.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];

/** Where a behaviour's test belongs: beside its family's tests, else its issue's, else in the tests' usual place. */
function fileFor(id, ids, testing, style) {
  const files = (want) => Object.entries(testing?.at ?? {}).filter(([k]) => want(k)).flatMap(([, ts]) => ts.map((t) => t.file));
  const near = most(files((k) => prefixOf(k) === prefixOf(id))) ?? most(files((k) => ids.includes(k)));
  if (near) return near;
  const name = prefixOf(id).toLowerCase();
  if (testing?.learned?.length) return `${most(testing.learned.map(dirOf))}${name}${style.suffix}`;
  return { typescript: `test/${name}.test.ts`, python: `tests/test_${name}.py`, go: `${name}_test.go`, rust: `tests/${name}.rs`, ruby: `spec/${name}_spec.rb` }[testing?.language] ?? `test/${name}${style.suffix}`;
}

/** The style a project's skeletons follow, and why. */
export function styleFor(testing) {
  if (testing?.style) {
    const from = testing.learned;
    return { style: testing.style, language: 'javascript', how: `In the style of the project's existing tests (${from.length} file${from.length === 1 ? '' : 's'}: ${from.slice(0, 3).join(', ')}${from.length > 3 ? ', …' : ''}).` };
  }
  const language = testing?.language ?? null;
  const runner = testing?.runner ?? (language === 'typescript' ? 'vitest' : 'node');
  const style = { ...(BEST[runner] ?? BEST.node), ...(language === 'typescript' ? { suffix: '.test.ts' } : {}) };
  const how = testing?.other
    ? `The project's tests are ${testing.other}, which aren't read here yet: these follow best practice, so match them to its existing tests.`
    : !testing
      ? "This project's tests haven't been read: these follow best practice for JavaScript, so match them to its existing tests if it has any."
      : `The project has no tests yet: best practice for requirement-driven tests in ${language ?? 'JavaScript'}, one test per behaviour, named by its ID, with its Given / When / Then.`;
  return { style, language, how };
}

const clauses = (b) => (b.given || b.when || b.then ? [`Given ${b.given},`, `when ${b.when},`, `then ${b.then}`] : [b.text]).map((s) => s.replace(/\s+/g, ' ').trim());
const notYet = (id) => `${id} is not proven yet: write this test`;

/** One skeleton's code, in the project's language and style. */
function codeOf(b, { style, language }, newFile) {
  const name = `${b.id} ${statementOf(b)}`;
  const lines = clauses(b);
  if (language === 'python') {
    const fn = `test_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`.slice(0, 80);
    return [...(newFile ? ['import pytest', '', ''] : []), `def ${fn}():`, `    """${name.replace(/"""/g, "'''")}"""`, ...lines.map((l) => `    # ${l}`), `    pytest.fail(${JSON.stringify(notYet(b.id))})`, ''].join('\n');
  }
  if (language === 'go') {
    return [...(newFile ? ['package main // the package under test', '', 'import "testing"', ''] : []), `func Test${b.id.replace(/\W/g, '')}(t *testing.T) {`, `\tt.Run(${JSON.stringify(name)}, func(t *testing.T) {`, ...lines.map((l) => `\t\t// ${l}`), `\t\tt.Fatal(${JSON.stringify(notYet(b.id))})`, '\t})', '}', ''].join('\n');
  }
  if (language === 'rust') {
    const fn = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 80);
    return ['#[test]', `/// ${name}`, `fn ${fn}() {`, ...lines.map((l) => `    // ${l}`), `    todo!(${JSON.stringify(notYet(b.id))});`, '}', ''].join('\n');
  }
  if (language === 'ruby') {
    return [`RSpec.describe ${JSON.stringify(prefixOf(b.id))} do`, `  it ${JSON.stringify(name)} do`, ...lines.map((l) => `    # ${l}`), `    raise ${JSON.stringify(notYet(b.id))}`, '  end', 'end', ''].join('\n');
  }
  const s = style;
  const q = s.quote;
  const str = (t) => `${q}${t.replace(/\\/g, '\\\\').replaceAll(q, `\\${q}`)}${q}`;
  const end = s.semi ? ';' : '';
  const fn = `${s.async ? 'async ' : ''}${s.arrow ? '() =>' : 'function ()'}`;
  const fail = s.fail ? `${s.fail}(${str(notYet(b.id))})${end}` : `throw new Error(${str(notYet(b.id))})${end}`;
  return [...(newFile && s.imports.length ? [...s.imports, ''] : []), `${s.call}(${str(name)}, ${fn} {`, ...lines.map((l) => `${s.indent}// ${l}`), `${s.indent}${fail}`, `})${end}`, ''].join('\n');
}

/**
 * Skeletons for an item's behaviours: the named ones, or all that aren't in the Fog.
 * @param {{ node: object, testing?: object|null, tested?: string[], ids?: string[] }} o testing as the mapper read it, tested the IDs with a test
 * @returns {{ how: string, skeletons: { id: string, name: string, file: string, new_file: boolean, code: string }[], existing: { id: string, tests: { file: string, name: string }[] }[] }}
 */
export function skeletonsOf({ node, testing = null, tested = [], ids }) {
  const rows = rowsOf(node).filter((b) => !ids?.length || ids.includes(b.id));
  const own = rowsOf(node).map((b) => b.id);
  const known = new Set(tested);
  const look = styleFor(testing);
  const skeletons = [];
  const existing = [];
  for (const b of rows) {
    const tests = testing?.at?.[b.id];
    if (tests?.length || known.has(b.id)) {
      existing.push({ id: b.id, tests: tests?.length ? tests : [{ file: '(on the default branch)', name: `a test named by ${b.id}` }] });
      continue;
    }
    const file = fileFor(b.id, own, testing, look.style);
    const newFile = !testing?.learned?.includes(file) && !skeletons.some((k) => k.file === file);
    skeletons.push({ id: b.id, name: `${b.id} ${statementOf(b)}`, file, new_file: newFile, code: codeOf(b, look, newFile) });
  }
  return { how: look.how, skeletons, existing };
}

/** Skeletons as lines of a prompt: the tests the builder must make pass, and the ones that already exist (SKETCH-02, SKETCH-03). */
export function skeletonLines(s) {
  if (!s.skeletons.length && !s.existing.length) return [];
  const fence = (code, file) => [`In ${file}:`, '~~~', code.trimEnd(), '~~~'];
  return [
    ...(s.skeletons.length
      ? [
          `Start from these test skeletons: one per behaviour, named by its ID, failing until filled in. ${s.how} Fill each in so it proves its behaviour through what the product does, then build until they pass; they must all pass before the pull request opens. Keep the names.`,
          '',
          ...s.skeletons.flatMap((k) => [...fence(k.code, `${k.file}${k.new_file ? ' (a new file)' : ''}`), '']),
        ]
      : []),
    ...(s.existing.length ? ['These already have a test, so extend it rather than writing another:', ...s.existing.map((e) => `- ${e.id}: ${e.tests.map((t) => `"${t.name}" in ${t.file}`).join('; ')}`), ''] : []),
  ];
}
