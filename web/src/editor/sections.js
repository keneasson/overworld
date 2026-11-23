// The shape's sections a document is missing, and adding one back (#41 EDIT-07, EDIT-25). The editor never enforces the
// shape: a missing section is only shown where it belongs, and one click (or the right-click menu) puts it there, empty.

import { TextSelection } from '@tiptap/pm/state';
import { SECTIONS } from '@shared/issue-shape.js';

const canonical = (name) => SECTIONS.find((s) => s.toLowerCase() === name.toLowerCase().replace(/^behaviors$/, 'behaviours')) ?? name;

/** Each shape section the document lacks, in the shape's order, with the position where it belongs. */
export function missingSections(doc) {
  const present = [];
  doc.forEach((node, offset) => {
    if (node.type.name !== 'heading' || node.attrs.level !== 2) return;
    const rank = SECTIONS.indexOf(canonical(node.textContent.trim()));
    if (rank >= 0) present.push({ rank, offset });
  });
  const have = new Set(present.map((p) => p.rank));
  return SECTIONS.flatMap((name, rank) => {
    if (have.has(rank)) return [];
    // Before the first section that comes after it in the shape, or else at the end.
    const next = present.find((p) => p.rank > rank);
    return [{ name, pos: next ? next.offset : doc.content.size }];
  });
}

/** A transaction adding the section `name` in its place, empty, with the cursor on its line; null when it is already there. */
export function addSection(state, name) {
  const gap = missingSections(state.doc).find((m) => m.name === name);
  if (!gap) return null;
  const { heading, paragraph } = state.schema.nodes;
  const tr = state.tr.insert(gap.pos, [heading.create({ level: 2 }, state.schema.text(name)), paragraph.create()]);
  const line = gap.pos + name.length + 2 + 1; // past the heading (its text and two tokens), into the paragraph
  return tr.setSelection(TextSelection.create(tr.doc, line)).scrollIntoView();
}
