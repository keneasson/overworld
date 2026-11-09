// Changesets, applied to the map. A changeset holds, for each item it touches, the item as it was
// when editing began (`base`) and as the editor left it (`after`), both as { title, markdown }.
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

/** The node with an item's edits applied. An open question in the text puts it in the Fog, as on GitHub. */
export function applyTo(node, after, now) {
  const issue = issueOf(node);
  const out = {
    ...node,
    title: (issue ? `#${issue.number} ${after.title}` : after.title).slice(0, 200),
    body: `${after.markdown}${splitNote(node.body ?? '').note}`.slice(0, 20000),
    summary: firstLine(after.markdown),
    updatedAt: now,
  };
  if (openQuestions(after.markdown)) Object.assign(out, { status: 'needs_decision', definition: 'vague' });
  return out;
}

/** Items whose node changed since editing began (or is gone): these need a person, not an overwrite. */
export function conflictsOf(changeset, nodes) {
  return changeset.items.filter((it) => {
    const node = findItem(nodes, it.key);
    return !node || (!same(editableOf(node), it.base) && !same(editableOf(node), it.after));
  });
}
