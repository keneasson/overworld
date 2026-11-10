// An issue as one document (EDIT-01): the head, then every section of the shape as a "## " heading.
// Saving compares the document with how it opened and writes back only the sections that changed, so
// the rest of the issue keeps its markdown exactly, whatever the editor would have made of it.

import { SECTIONS, contentOf, parseIssue, writeIssue } from '@shared/issue-shape.js';

/** The markdown the editor opens: the head, then each section without its template hints. Missing shape sections are there, empty, to be filled in. */
export function toDocument(markdown = '') {
  const shape = parseIssue(markdown);
  const names = shape.sections.map((s) => s.name);
  const all = [...shape.sections];
  for (const [rank, name] of SECTIONS.entries()) {
    if (names.includes(name)) continue;
    const after = all.findLastIndex((s) => SECTIONS.indexOf(s.name) >= 0 && SECTIONS.indexOf(s.name) < rank);
    all.splice(after + 1, 0, { name, raw: '' });
  }
  const head = shape.head.replace(/<!--[\s\S]*?-->/g, '').trim();
  return [head, ...all.map((s) => `## ${s.name}\n\n${contentOf(s.raw)}`.trim())].filter(Boolean).join('\n\n');
}

const read = (doc) => {
  const shape = parseIssue(doc);
  return { head: shape.head.trim(), sections: shape.sections.map((s) => ({ name: s.name, text: contentOf(s.raw) })) };
};

/**
 * The issue's markdown after editing. `opened` and `edited` are the document as the editor serialised it
 * when it opened and now. Sections whose text is unchanged keep the issue's original markdown.
 */
export function fromDocument(markdown, opened, edited) {
  if (opened === edited) return markdown;
  const was = read(opened);
  const now = read(edited);
  const shape = parseIssue(markdown);
  const known = new Set([...shape.sections.map((s) => s.name), ...SECTIONS]);
  // Headings renamed, removed or added outside the shape: the document is the truth, written as it stands.
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (!same(was.sections.map((s) => s.name), now.sections.map((s) => s.name)) || now.sections.some((s) => !known.has(s.name))) return `${edited.trim()}\n`;
  const before = new Map(was.sections.map((s) => [s.name, s.text]));
  const edits = Object.fromEntries(now.sections.filter((s) => before.get(s.name) !== s.text).map((s) => [s.name, s.text]));
  const headed = now.head === was.head ? shape : { ...shape, head: now.head ? `${now.head}\n\n` : '' };
  return writeIssue(headed, edits);
}

/** The section a position falls in: the last "## " heading before it. */
export function sectionAt(doc, pos) {
  let name = null;
  doc.forEach((node, offset) => {
    if (offset < pos && node.type.name === 'heading' && node.attrs.level === 2) name = node.textContent.trim();
  });
  return name && (SECTIONS.find((s) => s.toLowerCase() === name.toLowerCase().replace(/^behaviors$/, 'behaviours')) ?? name);
}
