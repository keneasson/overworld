// The proof layer (#21): whether a behaviour is proven, from the latest coverage report (#20) and anything viewable its
// own line in the spec links to. "Trust me" isn't proof: a test is, and so is a screenshot or another thing that can be
// viewed. Proven is part of done (#32 STATE-12): a behaviour is done only when its issue is done and its proof passes.
// Used by the API (api/work.mjs, which says what state a behaviour is in) and the map alike.

const IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
const LINK = /(?<!!)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
const NAMED_PROOF = /\b(proof|proven|screenshot|screen ?shot|recording|video|demo)\b/i;

/**
 * What a behaviour's own line in the spec links to that can be viewed as proof: each image, and each link named as proof
 * ("[screenshot](…)", "[proof](…)"), as { kind: 'image' | 'link', url, label }.
 */
export function viewableIn(raw) {
  const text = String(raw ?? '');
  const out = [];
  for (const [, label, url] of text.matchAll(IMAGE)) out.push({ kind: 'image', url, label: label.trim() || 'Screenshot' });
  for (const [, label, url] of text.matchAll(LINK)) if (NAMED_PROOF.test(label)) out.push({ kind: 'link', url, label: label.trim() });
  return out;
}

/**
 * A behaviour's proof. `state` is what the latest report says (PROVEN-02): untested, passing or failing. `proven` is
 * whether its proof can be viewed and passes: its tests all pass, or with no tests, something viewable shows it.
 * @param {string} id the behaviour ID
 * @param {{ report?: object | null, raw?: string, aliases?: string[] }} o the latest coverage report, the behaviour's line in its
 *   issue, and its other names (its store ID, when it is its own issue)
 */
export function proofOf(id, { report = null, raw = '', aliases = [] } = {}) {
  // A behaviour's tests may name it by any of its names: its own ID, or its store's (#574) (#571 BEH-07).
  const found = [id, ...aliases].map((k) => report?.behaviours?.[k]).filter(Boolean);
  const b = found.length > 1 ? { passed: found.every((f) => f.passed), tests: found.flatMap((f) => f.tests ?? []), files: Object.assign({}, ...found.map((f) => f.files ?? {})) } : found[0];
  const tests = b?.tests ?? [];
  const viewable = viewableIn(raw);
  const state = !tests.length ? 'untested' : b.passed ? 'passing' : 'failing';
  return { state, proven: state === 'passing' || (state === 'untested' && viewable.length > 0), measured: Boolean(report), tests, files: b?.files ?? {}, viewable };
}

/**
 * Where a behaviour stands, proof included: 'done' only when its issue is done and its proof passes (PROVEN-01); a done
 * issue's behaviour with nothing viewable is 'unproven', not done (PROVEN-06); one whose proof now fails is 'broken'
 * (PROVEN-07), and is work again. Anything else is still being built: null. Until a project has its first report, done
 * is what its issues say.
 */
export function doneOf(issueDone, proof) {
  if (!issueDone) return null;
  // A project with no coverage report yet has nothing to judge by, so its done items stay done.
  if (!proof.measured) return 'done';
  if (proof.state === 'failing') return 'broken';
  return proof.proven ? 'done' : 'unproven';
}

/**
 * Is the report older than the code it describes (PROVEN-05)? It is when the code has moved on to another commit since.
 * @param {object | null} report the latest report, with its `commit`
 * @param {string} [code] the commit the code is at now: the last deploy's
 */
export const isStale = (report, code) => Boolean(report?.commit && code && !code.startsWith(report.commit) && !report.commit.startsWith(code));

/** The behaviours whose tests reach a file, in ID order (PROVEN-04). */
export function behavioursReaching(report, path) {
  return Object.entries(report?.behaviours ?? {})
    .filter(([, b]) => Object.hasOwn(b.files ?? {}, path))
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** A report's line ranges as line numbers: '1-3,7' -> [1, 2, 3, 7]. */
export function linesOf(ranges) {
  return String(ranges || '')
    .split(',')
    .filter(Boolean)
    .flatMap((r) => {
      const [a, b = a] = r.split('-').map(Number);
      return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    });
}

/** The store's name for the behaviour an item is the own node of (#571 BEH-07): `#574` for an issue holding one behaviour. */
export const storeAliases = (issueNumber, rowCount) => (issueNumber && rowCount === 1 ? [`#${issueNumber}`] : []);
