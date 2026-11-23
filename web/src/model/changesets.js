import { compareItems, editableOf, itemKeyOf } from '@shared/issue-shape.js';
import { pathOf } from './tree.js';

// Which refinement a person's edits go into, and when a refused save leaves it alone (#41 EDIT-24).
// One refused edit must never cost the refinement: a new item belongs to the refinement it was made in, so moving
// to a fresh one would leave every later edit of it refused, and editing blocked even after a reload.

/** Who a changeset is by, as the API writes it: a person's name, or "Name (id)" for an agent. */
export const authorOf = (name) => String(name ?? '').trim().slice(0, 80) || 'Someone';

/** Your open refinement: the latest one of yours with edits in it, else the latest of yours, else none. */
export function yourChangeset(changesets, name) {
  const yours = changesets.filter((c) => c.status === 'open' && c.author === authorOf(name));
  return yours.filter((c) => c.items?.length).at(-1) ?? yours.at(-1) ?? null;
}

/** Whether a refused save means the refinement itself is gone (deleted, or already adopted or declined), so a new one is needed. */
export const refinementGone = (err) => err?.status === 404 || (err?.status === 409 && /already/.test(err.message ?? ''));

/** Whether an edit can be sent yet: an item always has a title, so one being retyped waits until it has one again. */
export const readyToSave = (after) => Boolean(after?.title?.trim());

/**
 * What the changeset's box holds (#62 SYNC-01), to review it as one: each item edited in it, or accepted and not on
 * GitHub yet, with the behaviours an edit adds, changes or removes; and the area they are all in, where comments on the
 * changeset as a whole are kept. Null while the box is empty.
 * @returns {{ area: object, items: { node, key, edited: boolean, new: boolean, added: string[], changed: string[], removed: string[] }[] } | null}
 */
export function changesetContents({ tree, edited = [], unsaved = [], drafts = new Map() }) {
  if (!tree) return null;
  const byKey = new Map(tree.list.map((n) => [itemKeyOf(n), n]));
  const items = [...new Set([...edited, ...unsaved])].flatMap((key) => {
    const node = byKey.get(key);
    if (!node) return [];
    const draft = edited.includes(key) && !node.refinement ? drafts.get(key) : null;
    const diff = draft ? compareItems(editableOf(node), draft).behaviours : [];
    const ids = (change) => diff.filter((b) => b.change === change && b.id).map((b) => b.id);
    return [{ node, key, edited: edited.includes(key), new: Boolean(node.refinement), added: ids('added'), changed: ids('changed'), removed: ids('removed') }];
  });
  if (!items.length) return null;
  // The deepest place every edited item's parent sits in: one issue's edits are in its parent's area.
  const paths = items.map((it) => pathOf(it.node.parent ?? it.node));
  let depth = 0;
  while (paths.every((p) => p[depth] && p[depth] === paths[0][depth])) depth++;
  return { area: paths[0][Math.max(0, depth - 1)], items };
}
