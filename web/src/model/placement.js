// Where a bug report lands (#9 REPORT-02, REPORT-03): the items whose behaviours are closest to what the reporter wrote,
// and the items and behaviours in view when the map is zoomed in. Closeness is meaning, from the embedding model the
// project's behaviour vectors are kept in, plus the words the report shares with each behaviour and its item's title; with
// no model, it is the shared words alone. The model itself is loaded elsewhere (embedder.js), so this stays pure.

import { itemKeyOf } from '@shared/issue-shape.js';

const STOP = new Set(
  "the a an and or of to in on is it its it's be been for with when then given that this as at by from are was were not no i my me we you our your there here do does did doesn't don't can can't won't into after before".split(' '),
);
/** A text's content words, roughly stemmed, so "questions" meets "question" and "showing" meets "show". */
export const wordsOf = (s) => new Set((String(s ?? '').toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, '')).filter((w) => w.length > 1));

const WORDS_WEIGHT = 0.15; // shared words lift a near tie in meaning; they never outweigh it
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
// A bug lands under the work that owns what it breaks, never under another bug.
const isItem = (n) => n.depth > 0 && !['project', 'area', 'behavior', 'bug'].includes(n.kind) && !n.tags?.includes('code');

/**
 * The places a report is closest to, best first.
 * @param {object} tree from buildTree
 * @param {string} text what the reporter wrote, title included
 * @param {{ vector?: number[] | null, vectors?: Map<string, number[]> }} [o] the report's vector and each behaviour's, by `${itemKey}:${id}`
 * @returns {{ by: 'meaning' | 'words', places: { node: object, score: number, behaviours: { id: string, words: string, score: number }[] }[] }}
 */
export function placeReport(tree, text, { vector = null, vectors = new Map(), limit = 5 } = {}) {
  const asked = wordsOf(text);
  const byMeaning = Boolean(vector) && vectors.size > 0;
  if (!tree || (!asked.size && !byMeaning)) return { by: byMeaning ? 'meaning' : 'words', places: [] };
  const shared = (s) => (asked.size ? [...asked].filter((w) => s.has(w)).length / asked.size : 0);
  const places = [];
  for (const node of tree.list) {
    if (!isItem(node) || node.refinement) continue;
    const key = itemKeyOf(node);
    const title = wordsOf(node.title);
    const scored = (node.behaviourRows ?? [])
      .map((b) => {
        const v = byMeaning ? vectors.get(`${key}:${b.id}`) : null;
        if (byMeaning && !v) return null;
        const w = shared(new Set([...title, ...wordsOf(b.said ?? b.words)]));
        return { id: b.id, words: b.words, score: (v ? dot(vector, v) : 0) + WORDS_WEIGHT * w };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    // An item with no behaviours can still be named by its title.
    if (!scored.length && !byMeaning) {
      const w = shared(title);
      if (w) places.push({ node, score: WORDS_WEIGHT * w, behaviours: [] });
      continue;
    }
    if (!scored.length || (!byMeaning && !scored[0].score)) continue;
    // An item is as close as its two closest behaviours together: one stray sentence doesn't carry it.
    const score = (scored[0].score + (scored[1]?.score ?? scored[0].score)) / 2;
    places.push({ node, score, behaviours: scored.slice(0, 3).filter((b) => b.score > 0) });
  }
  places.sort((a, b) => b.score - a.score || a.node.title.localeCompare(b.node.title));
  return { by: byMeaning ? 'meaning' : 'words', places: places.slice(0, limit) };
}

/**
 * What the map shows when it is zoomed in (REPORT-03): the place in focus, then the items in view, each with its
 * behaviours, for one-tap links. Nothing at the overview, where everything is in view.
 * @param {object} tree
 * @param {string | null} focusId the place the map is zoomed in on
 * @param {(node: object) => boolean} inView
 */
export function nearView(tree, focusId, inView, limit = 6) {
  const focus = focusId ? tree?.byId.get(focusId) : null;
  if (!tree || !focus || focus === tree.root) return [];
  const seen = new Set();
  const out = [];
  const add = (n) => {
    if (!n || seen.has(n.id) || !isItem(n) || n.refinement) return;
    seen.add(n.id);
    out.push({ node: n, behaviours: (n.behaviourRows ?? []).map((b) => ({ id: b.id, words: b.words })) });
  };
  add(focus);
  for (const n of tree.list) if (out.length < limit && n.depth > focus.depth && inView(n)) add(n);
  return out.slice(0, limit);
}
