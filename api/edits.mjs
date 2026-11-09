// Changesets, applied to the map. A changeset holds, for each item it touches, the item as it was
// when editing began (`base`) and as the editor left it (`after`), both as { title, markdown }.
//
// Accepting one changes the map now. Reaching GitHub is the sync worker's job (see the changesets
// issue); until then an accepted changeset waits, and a refresh from GitHub keeps its edits on the
// map rather than wiping them. If GitHub has moved on from `base`, that item is a conflict, and a
// person decides; nothing is overwritten.

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
  return out;
}

/** Items whose node changed since editing began (or is gone): these need a person, not an overwrite. */
export function conflictsOf(changeset, nodes) {
  return changeset.items.filter((it) => {
    const node = findItem(nodes, it.key);
    return !node || (!same(editableOf(node), it.base) && !same(editableOf(node), it.after));
  });
}

/**
 * After a refresh from GitHub: put back the edits of accepted changesets that haven't reached GitHub.
 * @returns {{ nodes: object[], changed: object[] }} changed are the changesets whose items gained a conflict
 */
export function keepPendingEdits(nodes, changesets, now) {
  const byKey = new Map(nodes.map((n) => [itemKeyOf(n), n]));
  const changed = [];
  for (const cs of changesets) {
    if (cs.status !== 'accepted' || cs.sync !== 'waiting') continue;
    let touched = false;
    for (const it of cs.items) {
      const node = byKey.get(it.key);
      const current = node && editableOf(node);
      if (current && same(current, it.base)) byKey.set(it.key, applyTo(node, it.after, now));
      else if (!current || !same(current, it.after)) {
        if (!it.conflict) touched = true;
        it.conflict = true;
      }
    }
    if (touched) changed.push(cs);
  }
  return { nodes: nodes.map((n) => byKey.get(itemKeyOf(n)) ?? n), changed };
}
