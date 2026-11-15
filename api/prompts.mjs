// What every prompt to an agent says about the item it is about: the whole item in the strict shape, its parent and its
// neighbours on the map. Applying an answer (#68), acting on an annotation (#15) and handing off an issue (#14) all
// build on this, so an agent gets the same picture of an item however the work reaches it.

import { STATUS_LABEL } from '../shared/schema.js';
import { editableOf, itemKeyOf } from '../shared/issue-shape.js';

const SIBLINGS_SHOWN = 30;

export const quote = (s) => String(s).split('\n').map((l) => `> ${l}`).join('\n');
export const stateWords = (status) => (STATUS_LABEL[status] ?? status).toLowerCase();

/** The item as it stands, then where it sits: lines of a prompt. */
export function itemContext(nodes, node) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parent = byId.get(node.parentId);
  const siblings = nodes.filter((n) => n.parentId === node.parentId && n.id !== node.id && n.kind !== 'behavior');
  const { title, markdown } = editableOf(node);
  return [
    `The item as it stands: its title is "${title}", and its text, in the strict shape, is:`,
    '',
    '~~~markdown',
    markdown.trim(),
    '~~~',
    '',
    parent ? `Its parent: ${parent.title} (${itemKeyOf(parent)}).` : 'It sits at the top of the map.',
    ...(siblings.length ? ['Its siblings:', ...siblings.slice(0, SIBLINGS_SHOWN).map((s) => `- ${s.title} (${itemKeyOf(s)}), ${stateWords(s.status)}`), ...(siblings.length > SIBLINGS_SHOWN ? [`- and ${siblings.length - SIBLINGS_SHOWN} more`] : [])] : ['It has no siblings.']),
  ];
}
