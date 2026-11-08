import { issueOf } from '@shared/issue-shape.js';
import { isInside } from '../model/tree.js';

/** Items with text worth editing, inside `scope`: issues on a mapped repository, everything on a hand-made map. */
export function editableItems(tree, scope) {
  const mapped = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(tree.root.url ?? '');
  return tree.list.filter((n) => n.depth > 0 && isInside(n, scope) && (mapped ? issueOf(n) : true));
}
