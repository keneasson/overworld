// Links between items (#41 EDIT-14): "#12" in an item's text, or a link to the issue on GitHub, is the item on the
// map when it is there, so the hierarchy can be walked by its links; anything else stays a plain link to GitHub.
// Each link followed is an entry in the browser's history, so Back returns to the item and the view it left.

import { issueOf } from '@shared/issue-shape.js';

// "#12", but not "a#12", "&#39;" or the "#12" in a URL.
export const ISSUE_REF = /(?<![\w&#/])#(\d+)\b/g;

/** Every "#N" in some text, with where it is. */
export const issueRefs = (text = '') => [...text.matchAll(ISSUE_REF)].map((m) => ({ number: Number(m[1]), from: m.index, to: m.index + m[0].length }));

/** The repository a map was read from ("owner/name"), or null for a map made here. */
export function repoOf(tree) {
  const root = String(tree?.root?.url ?? '').match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/?$/);
  return root ? root[1] : (tree?.list.map(issueOf).find(Boolean)?.repo ?? null);
}

const byNumber = new WeakMap();
const numbered = (tree) => {
  if (!byNumber.has(tree)) byNumber.set(tree, new Map(tree.list.flatMap((n) => (issueOf(n) ? [[issueOf(n).number, n]] : []))));
  return byNumber.get(tree);
};

/**
 * Where a link goes: `ref` is an issue number, "#12" or a link's href. `node` is the item on the map it is, if any,
 * and `url` where it is on GitHub. Null when it is not a link to an issue of this map's repository.
 */
export function linkTarget(tree, ref) {
  if (!tree) return null;
  const repo = repoOf(tree);
  let number = typeof ref === 'number' ? ref : Number(String(ref ?? '').match(/^#(\d+)$/)?.[1]);
  if (!number) {
    const issue = issueOf({ url: String(ref ?? '').replace(/[?#].*$/, '') });
    if (!issue || !repo || issue.repo.toLowerCase() !== repo.toLowerCase()) return null;
    number = issue.number;
  }
  return { number, node: numbered(tree).get(number) ?? null, url: repo ? `https://github.com/${repo}/issues/${number}` : null };
}

/** "#12" in markdown as a link to the issue, for a `marked` instance; the click that follows it is the app's. */
export const issueRefExtension = (repo) => ({
  name: 'issueRef',
  level: 'inline',
  start(src) {
    const at = src.search(/(?<![\w&#/])#\d/);
    return at < 0 ? undefined : at;
  },
  tokenizer(src) {
    const m = /^#(\d+)\b/.exec(src);
    return m && !this.lexer.state.inLink ? { type: 'issueRef', raw: m[0], number: m[1] } : undefined;
  },
  renderer: (t) => (repo ? `<a class="issue-ref" data-issue="${t.number}" href="https://github.com/${repo}/issues/${t.number}">#${t.number}</a>` : `<span class="issue-ref" data-issue="${t.number}">#${t.number}</span>`),
});

/**
 * Follow a link: the entry being left keeps its address (`from`, with the view as it is now), and a new entry is the
 * item followed to (`to`). The new entry remembers which item it came from, for the panel's Back.
 */
export function followLink(history, { fromId, from, to }) {
  history.replaceState(history.state, '', from);
  history.pushState({ trail: (history.state?.trail ?? 0) + 1, back: fromId ?? null }, '', to);
}

/** Where Back goes from this history entry, when it was reached by following a link: { id } of the item it came from. */
export const backOf = (state) => (state?.trail ? { id: state.back ?? null } : null);
