import { issueOf } from '@shared/issue-shape.js';

/** Is this map read from a store (a GitHub repository), rather than made by hand? */
export const isMapped = (tree) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(tree.root.url ?? '');

/** An item made in Overworld that the store doesn't hold yet: new in a refinement, or adopted and waiting for a save. */
export const isMadeHere = (n) => Boolean(n.refinement) || (!issueOf(n) && Boolean(n.sync));

/** Whether an item has text to edit: an issue on a mapped repository or one made here for it, anything but the project on a hand-made map. */
export function isEditable(tree, n) {
  return n.depth > 0 && (isMapped(tree) ? Boolean(issueOf(n)) || isMadeHere(n) : true);
}
