// Changesets, applied to the map. A changeset holds, for each item it touches, the item as it was
// when editing began (`base`) and as the editor left it (`after`), both as { title, markdown }.
//
// A new item is made inside a refinement (NEW-02): it is on the map at once, carrying the refinement's id, and its
// edits change it in place, since no spec holds it yet. Its entry is { key, nodeTitle, new: true }. Adopting the
// refinement makes it part of the spec; dropping it, or discarding the refinement, removes it (NEW-06).
//
// Accepting one changes the map now. Its items reach GitHub only when they are saved (api/sync.mjs).
// Accepting takes only what each item's edit changed from `base` (#13 ADOPT-17): a part it didn't touch stays as the map has
// it now, whoever changed it. A part it touched that has also changed since is a conflict, and a person decides; nothing is overwritten.

import { changeKeys, compareItems, conflictKeys, editableOf, issueOf, itemKeyOf, mergeChanges, rebaseEdit, splitNote } from '../shared/issue-shape.js';
import { openQuestions } from './engine/lifecycle.mjs';
import { firstLine } from './engine/project.mjs';

export { editableOf, itemKeyOf };
export const findItem = (nodes, key) => nodes.find((n) => itemKeyOf(n) === key) ?? null;
export const same = (a, b) => a.title === b.title && a.markdown === b.markdown;

/** The node with an item's edits applied. An open question in the text means it needs a decision, as on GitHub. */
export function applyTo(node, after, now) {
  const issue = issueOf(node);
  const out = {
    ...node,
    title: (issue ? `#${issue.number} ${after.title}` : after.title).slice(0, 200),
    body: `${after.markdown}${splitNote(node.body ?? '').note}`.slice(0, 20000),
    summary: firstLine(after.markdown),
    updatedAt: now,
  };
  if (openQuestions(after.markdown)) out.status = 'needs_decision';
  // Its last open question answered, an item that only waited on a decision is ready (LIFE-09).
  else if (node.status === 'needs_decision') out.status = 'ready';
  return out;
}

/** An item's edit, part by part, against the item as the map has it now (ADOPT-17): what it changes, and which of those changed since. */
export const partsAgainst = (it, node) => compareItems(editableOf(node), it.after, it.base);

/** Items a part of whose edit has changed since editing began (or that are gone): these need a person, not an overwrite. */
export function conflictsOf(changeset, nodes) {
  return changeset.items.filter((it) => {
    if (it.new) return false; // a new item belongs to this refinement alone: nobody else can have changed it
    const node = findItem(nodes, it.key);
    return !node || conflictKeys(partsAgainst(it, node)).length > 0;
  });
}

/** The item now, with just what an edit changed from its base: the parts it didn't touch are never overwritten (ADOPT-17). */
export function mergedOnto(it, node) {
  const now = editableOf(node);
  return mergeChanges(now, it.after, changeKeys(partsAgainst(it, node)), it.base);
}

/**
 * A changeset with each edit that clashes with the item as it now is carried onto it, where the two changed different lines
 * (#13 ADOPT-17): the server's change is then in the refinement, and only edits to the same words stay a conflict.
 * @returns {object | null} the changeset carried, or null if nothing needed carrying
 */
export function rebaseChangeset(changeset, nodes) {
  let moved = false;
  const items = changeset.items.map((it) => {
    if (it.new || !it.base) return it;
    const node = findItem(nodes, it.key);
    if (!node || !conflictKeys(partsAgainst(it, node)).length) return it;
    const carried = rebaseEdit(editableOf(node), it.after, it.base);
    if (!carried) return it;
    moved = true;
    return { ...it, ...carried };
  });
  return moved ? { ...changeset, items } : null;
}
