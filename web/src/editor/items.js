import { issueOf } from '@shared/issue-shape.js';

/** Whether an item has text to edit: an issue on a mapped repository (or one made here, on its way to being one), anything but the project on a hand-made map. */
export function isEditable(tree, n) {
  const mapped = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(tree.root.url ?? '');
  return n.depth > 0 && (mapped ? Boolean(issueOf(n) || n.madeHere) : true);
}
