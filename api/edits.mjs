// Changesets, applied to the map. A changeset holds, for each item it touches, the item as it was
// when editing began (`base`) and as the editor left it (`after`), both as { title, markdown }.
//
// A new item is made inside a refinement (NEW-02): it is on the map at once, carrying the refinement's id, and its
// edits change it in place, since no spec holds it yet. Its entry is { key, nodeTitle, new: true }. Adopting the
// refinement makes it part of the spec; dropping it, or discarding the refinement, removes it (NEW-06).
//
// Accepting one changes the map now. Its items reach GitHub only when they are saved (api/sync.mjs).
// If the map has moved on from `base` since editing began, that item is a conflict, and a person
// decides; nothing is overwritten.

import { editableOf, issueOf, itemKeyOf, splitNote } from '../shared/issue-shape.js';
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

/** Items whose node changed since editing began (or is gone): these need a person, not an overwrite. */
export function conflictsOf(changeset, nodes) {
  return changeset.items.filter((it) => {
    if (it.new) return false; // a new item belongs to this refinement alone: nobody else can have changed it
    const node = findItem(nodes, it.key);
    return !node || (!same(editableOf(node), it.base) && !same(editableOf(node), it.after));
  });
}
