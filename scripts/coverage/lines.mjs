// Which source lines a V8 coverage result reached, by repository path (#20 COVER-01).

import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_PATH } from '../../api/engine/behaviours.mjs';

const TRANSFORMED = /\.[jt]sx$/;
const anchors = new Map(); // path -> where each line that isn't blank starts: { offsets, lines }, in order

function anchorsOf(path) {
  if (anchors.has(path)) return anchors.get(path);
  const offsets = [];
  const lines = [];
  let at = 0;
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const lead = line.search(/\S/);
      if (lead >= 0) offsets.push(at + lead) && lines.push(i + 1);
      at += line.length + 1;
    });
  const out = { offsets, lines };
  anchors.set(path, out);
  return out;
}

/** The repository's own code, by path from the root: not its tests, its dependencies or anything outside it. */
export function codePathOf(url, root) {
  if (!url.startsWith('file://')) return null;
  const rel = relative(root, fileURLToPath(url)).split(sep).join('/');
  if (rel.startsWith('..') || rel.includes('node_modules/') || TEST_PATH.test(rel) || rel.startsWith('scripts/coverage/')) return null;
  return rel;
}

/**
 * @param {object[]} result Profiler.takePreciseCoverage's result
 * @returns {Map<string, Set<number>>} each file's reached lines, numbered from 1
 */
export function linesReached(result, root) {
  const out = new Map();
  for (const script of result) {
    const rel = codePathOf(script.url, root);
    if (!rel) continue;
    // JSX runs as the loader rewrote it, so its offsets aren't the file's: it was reached, but which lines can't be said.
    if (TRANSFORMED.test(rel)) {
      if (script.functions.some((f, i) => i > 0 && f.ranges[0].count > 0)) out.set(rel, new Set());
      continue;
    }
    let at;
    try {
      at = anchorsOf(fileURLToPath(script.url));
    } catch {
      continue;
    }
    // A line counts as its innermost range counts it at its first character. V8's ranges nest, so painting outer ones
    // first and inner ones over them leaves each line with its innermost count.
    const { offsets, lines } = at;
    const ranges = script.functions.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
    const count = new Array(offsets.length).fill(0);
    for (const r of ranges) for (let i = firstAtOrAfter(offsets, r.startOffset); i < offsets.length && offsets[i] < r.endOffset; i++) count[i] = r.count;
    const reached = new Set();
    count.forEach((c, i) => c > 0 && reached.add(lines[i]));
    // A range that ran from part-way along a line reaches it too: `export function f() {`, or `} else {`.
    for (const r of ranges) {
      const i = firstAtOrAfter(offsets, r.startOffset + 1) - 1;
      if (r.count > 0 && i >= 0) reached.add(lines[i]);
    }
    if (reached.size) out.set(rel, reached);
  }
  return out;
}

function firstAtOrAfter(offsets, offset) {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
