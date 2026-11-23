// The editor's one document: its one menu at a selection, and the shape's sections it is missing (#41).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { SECTIONS, parseIssue, sectionText } from '@shared/issue-shape.js';
import { EXTENSIONS, parseMarkdown } from '../src/editor/rich-text.js';
import { fromDocument } from '../src/editor/document.js';
import { gaps, openWithBodies, sectionBodies } from '../src/editor/shape-extension.js';
import { addSection, missingSections } from '../src/editor/sections.js';
import { menuAt } from '../src/editor/SelectionMenu.jsx';

const schema = getSchema(EXTENSIONS);
const md = new MarkdownManager({ extensions: EXTENSIONS });
const markdownOf = (state) => md.serialize(state.doc.toJSON());
const open = (markdown) => EditorState.create({ doc: schema.nodeFromJSON(openWithBodies(parseMarkdown(markdown), schema)), plugins: [sectionBodies()] });
const textAt = (state, text) => {
  let at = null;
  state.doc.descendants((n, pos) => {
    if (at == null && n.isText && n.text.includes(text)) at = pos + n.text.indexOf(text);
  });
  return at;
};
const select = (state, from, to = from) => state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
const headings = (state) => {
  const out = [];
  state.doc.forEach((n) => n.type.name === 'heading' && n.attrs.level === 2 && out.push(n.textContent));
  return out;
};

const NO_SCOPE = 'Kind: Task · Place: web\n\n## Why\n\nBecause.\n\n## Behaviours\n\n- EDIT-01 Given a, when b, then c.\n- and one written without an ID\n\n## Acceptance\n\nIt works.\n\n## Open questions\n';

test('EDIT-06 one small menu at a selection, with bold, italic, code, links and lists, and nothing without one', () => {
  let state = open(NO_SCOPE);
  assert.deepEqual(menuAt(select(state, textAt(state, 'Because')))?.length, 0, 'no selection, no menu');
  const at = textAt(state, 'Because');
  state = select(state, at, at + 7);
  const tools = menuAt(state).map((t) => t.icon);
  assert.deepEqual(tools, ['bold', 'italic', 'code', 'link', 'list', 'numbered'], 'the same menu in every section; indenting only in a list');
  state = state.apply(state.tr.addMark(at, at + 7, schema.marks.bold.create()));
  assert.equal(menuAt(state).find((t) => t.icon === 'bold').on, true, 'it shows what is on');
  const li = textAt(state, 'and one written');
  assert.ok(menuAt(select(state, li, li + 3)).some((t) => t.icon === 'indent'), 'in a list it can make a sub-item');
});

test('EDIT-07 a missing section and a behaviour without an ID are shown where they are, and typing and saving still work', () => {
  let state = open(NO_SCOPE);
  const found = gaps(state.doc);
  const acceptance = textAt(state, 'It works.');
  const questions = textAt(state, 'Open questions') - 1;
  assert.deepEqual(found.filter((g) => g.on === 'section').map((g) => g.name), ['Out of scope']);
  const gap = found.find((g) => g.on === 'section');
  assert.ok(gap.pos > acceptance && gap.pos <= questions, 'between Acceptance and Open questions, where it belongs');
  const loose = found.filter((g) => g.on === 'behaviour');
  assert.equal(loose.length, 1);
  assert.equal(state.doc.nodeAt(loose[0].from).textContent, 'and one written without an ID');
  const opened = markdownOf(state);
  const at = textAt(state, 'It works.') + 'It works.'.length;
  state = select(state, at);
  state = state.apply(state.tr.insertText(' Still.'));
  const saved = parseIssue(fromDocument(NO_SCOPE, opened, markdownOf(state)));
  assert.equal(sectionText(saved, 'Acceptance'), 'It works. Still.', 'typing works');
  assert.ok(!saved.sections.some((s) => s.name === 'Out of scope'), 'and saving never adds what nobody wrote');
});

test('EDIT-25 a missing section is added from the right-click menu in its place in the shape, empty, ready to type in', () => {
  let state = open('## Why\n\nBecause.\n\n## Acceptance\n\nIt works.\n');
  assert.deepEqual(missingSections(state.doc).map((m) => m.name), ['Behaviours', 'Out of scope', 'Open questions'], 'the menu lists only what is missing');
  const opened = markdownOf(state);
  state = state.apply(addSection(state, 'Out of scope'));
  assert.deepEqual(headings(state), ['Why', 'Acceptance', 'Out of scope']);
  state = state.apply(addSection(state, 'Behaviours'));
  assert.deepEqual(headings(state), ['Why', 'Behaviours', 'Acceptance', 'Out of scope'], 'each in its place');
  assert.equal(state.selection.$from.parent.type.name, 'paragraph', 'the cursor is on its empty line');
  assert.equal(state.selection.$from.parent.textContent, '');
  state = state.apply(state.tr.insertText('- EDIT-01 Given a, when b, then c.'));
  const saved = parseIssue(fromDocument('## Why\n\nBecause.\n\n## Acceptance\n\nIt works.\n', opened, markdownOf(state)));
  assert.deepEqual(saved.sections.map((s) => s.name), SECTIONS.slice(0, 4));
  assert.match(sectionText(saved, 'Behaviours'), /EDIT-01 Given a/);
  assert.equal(sectionText(saved, 'Acceptance'), 'It works.', 'the rest is left as it was');
  assert.equal(addSection(state, 'Why'), null, 'a section already there is not added twice');
  state = state.apply(addSection(state, 'Open questions'));
  assert.deepEqual(missingSections(state.doc), [], 'with nothing missing, the browser keeps its own menu');
});
