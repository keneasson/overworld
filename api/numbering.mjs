// Behaviour IDs are given by the server (#13 ADOPT-11). A draft holds a placeholder (AREA-?N), never a number; the
// first save of its text to Overworld swaps it for the area's next number, from one counter per prefix, so two people
// or agents adding behaviours at once never get the same one, and an abandoned draft uses none. The counter starts above
// the highest number ever seen for its prefix: in the text being saved, on the map, and in every refinement, open or closed, so a number still
// visible anywhere, a dropped behaviour's included, is never given again.

import { highestIds, unnumbered, withIds } from '../shared/issue-shape.js';

/**
 * Number the behaviours in `markdown` that have none yet.
 * @param {object} o
 * @param {object[]} o.nodes the map
 * @param {Record<string, string>} [o.memo] placeholder -> ID already given to this item: a save sent again before the
 *   editor showed the number (an autosave queued behind the first) gets the same one, unless that ID is already in the text
 * @param {boolean} [o.bare] number behaviours written without an ID too, those `previous` didn't have (from the store)
 * @returns {Promise<{ markdown: string, given: { placeholder: string|null, id: string }[] }>} given: in the order written
 */
export async function numberNew(model, projectId, { markdown, title = '', nodes, memo = {}, bare = false, previous = null }) {
  const todo = unnumbered(markdown, { title, bare, previous });
  if (!todo.length) return { markdown, given: [] };
  const inText = new Set([...String(markdown).matchAll(/\b[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+\b/g)].map((m) => m[0]));
  const twice = new Set(todo.map((u) => u.placeholder).filter((p, i, all) => p && all.indexOf(p) !== i));
  const ids = new Map();
  const fresh = [];
  for (const u of todo) {
    const kept = u.placeholder && !twice.has(u.placeholder) ? memo[u.placeholder] : null;
    if (kept && !inText.has(kept)) ids.set(u.line, kept);
    else fresh.push(u);
  }
  if (fresh.length) {
    const seen = highestIds([markdown, ...nodes.map((n) => n.body), ...seenInRefinements(await model.changesets.list(projectId))]);
    for (const prefix of new Set(fresh.map((u) => u.prefix))) {
      const mine = fresh.filter((u) => u.prefix === prefix);
      const numbers = await model.ids.take(projectId, prefix, mine.length, seen.get(prefix) ?? 0);
      mine.forEach((u, i) => ids.set(u.line, `${prefix}-${String(numbers[i]).padStart(2, '0')}`));
    }
  }
  return { markdown: withIds(markdown, ids), given: todo.map((u) => ({ placeholder: u.placeholder, id: ids.get(u.line) })) };
}

/** What a placeholder was given, kept on the item's entry in its refinement for the next save of it. */
export const memoOf = (given, memo = {}) => ({ ...memo, ...Object.fromEntries(given.filter((g) => g.placeholder).map((g) => [g.placeholder, g.id])) });

// Every text a refinement holds or held: each item's base and proposal, and the behaviours adopted and declined in it.
const seenInRefinements = (changesets) =>
  changesets.flatMap((cs) => [
    ...cs.items.flatMap((it) => [it.base?.markdown, it.after?.markdown, it.theirs?.markdown]),
    ...[...(cs.adopted ?? []), ...(cs.declined ?? [])].flatMap((d) => d.behaviours ?? []),
  ]);
