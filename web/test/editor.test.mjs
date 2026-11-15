import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { liftListItem, sinkListItem } from '@tiptap/pm/schema-list';
import { newItemMarkdown, parseIssue, sectionText } from '@shared/issue-shape.js';
import { EXTENSIONS, parseMarkdown, throughEditor } from '../src/editor/rich-text.js';
import { fromDocument, toDocument } from '../src/editor/document.js';
import { openWithBodies, sectionBodies } from '../src/editor/shape-extension.js';
import { commentHtml } from '../src/editor/comment-text.js';

const schema = getSchema(EXTENSIONS);
const md = new MarkdownManager({ extensions: EXTENSIONS });
const markdownOf = (state) => md.serialize(state.doc.toJSON());

/** The document as the editor opens it, with a stand-in for its view: what a person types goes through the same plugin. */
function open(markdown) {
  const plugin = sectionBodies();
  let state = EditorState.create({ doc: schema.nodeFromJSON(openWithBodies(parseMarkdown(markdown), schema)), plugins: [plugin] });
  const view = {
    get state() {
      return state;
    },
    dispatch: (tr) => (state = state.apply(tr)),
  };
  const at = (pos) => view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)));
  const headingEnd = (name) => {
    let end = null;
    state.doc.forEach((n, offset) => n.type.name === 'heading' && n.textContent === name && (end = offset + n.nodeSize - 1));
    return end;
  };
  const type = (text) => {
    const { from, to } = state.selection;
    if (!plugin.props.handleTextInput(view, from, to, text)) view.dispatch(state.tr.insertText(text));
  };
  const enter = () => {
    if (plugin.props.handleKeyDown(view, { key: 'Enter' })) return;
    view.dispatch(state.tr.split(state.selection.from));
  };
  return { view, at, headingEnd, type, enter };
}

test('EDIT-16 a new item: clicking into a section and typing writes its text, never its heading', () => {
  const item = newItemMarkdown({ kind: 'task', partOf: '#26' });
  const original = toDocument(item);
  const doc = open(original);
  const opened = markdownOf(doc.view.state);
  for (const name of ['Why', 'Acceptance']) {
    doc.at(doc.headingEnd(name));
    doc.type(`The ${name.toLowerCase()} of it.`);
    doc.enter();
    doc.type('A second paragraph.');
  }
  const saved = parseIssue(fromDocument(item, opened, markdownOf(doc.view.state)));
  assert.deepEqual(saved.sections.map((s) => s.name), ['Why', 'Behaviours', 'Acceptance', 'Out of scope', 'Open questions'], 'no new headings');
  assert.equal(sectionText(saved, 'Why'), 'The why of it.\n\nA second paragraph.');
  assert.equal(sectionText(saved, 'Acceptance'), 'The acceptance of it.\n\nA second paragraph.');
});

test('EDIT-16 an existing item: every empty section has a line to type on, and opening it changes nothing', () => {
  const body = 'Kind: Task · Place: web\n\n## Why\n\nBecause.\n\n## Behaviours\n\n## Acceptance\n';
  const opened = markdownOf(open(toDocument(body)).view.state);
  assert.equal(fromDocument(body, opened, opened), body);
  const doc = open(toDocument(body));
  doc.at(doc.headingEnd('Behaviours') - 3); // the middle of the name
  doc.type('- ');
  doc.type('EDIT-01 Given a, when b, then c.');
  assert.equal(doc.headingEnd('Behaviours') != null, true, 'the heading keeps its name');
  assert.equal(sectionText(parseIssue(fromDocument(body, opened, markdownOf(doc.view.state))), 'Behaviours'), '- EDIT-01 Given a, when b, then c.');
});

test('EDIT-17 nested lists save as nested markdown and read back as sub-items, both ways', () => {
  for (const list of ['- a\n  - b\n    - c\n- d', '1. a\n   1. b\n2. c', '- a\n  1. b\n  2. c']) assert.equal(throughEditor(list), list);
  assert.equal(throughEditor('- a\n    - b\n- c'), '- a\n  - b\n- c', 'a four-space indent is still a sub-item');
});

test('EDIT-17 an item made a sub-item of the one above (Tab) saves nested, and lifting it (Shift+Tab) puts it back', () => {
  let state = EditorState.create({ doc: schema.nodeFromJSON(md.parse('- one\n- two\n- three')) });
  const into = (text) => {
    let pos = null;
    state.doc.descendants((n, p) => {
      if (n.isText && n.text === text) pos = p;
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos + 1)));
  };
  const run = (cmd) => assert.ok(cmd(schema.nodes.listItem)(state, (tr) => (state = state.apply(tr))));
  into('two');
  run(sinkListItem);
  assert.equal(markdownOf(state), '- one\n  - two\n- three');
  into('two');
  run(liftListItem);
  assert.equal(markdownOf(state), '- one\n- two\n- three');
});

test('EDIT-15 a comment written with the menu is kept as markdown and shown formatted, mentions still standing out', () => {
  const said = '**Bold** and *italic* with `code`, [a link](https://example.com) for @Claude:\n\n- one\n  - two';
  assert.equal(throughEditor(said), said, 'what the comment box writes is the markdown kept');
  const html = commentHtml(said);
  for (const bit of ['<strong>Bold</strong>', '<em>italic</em>', '<code>code</code>', '<a href="https://example.com">a link</a>', '<span class="note-mention">@Claude</span>', '<li>two</li>'])
    assert.ok(html.includes(bit), `shows ${bit}`);
  assert.ok(commentHtml('a plain line\nand the next').includes('<br>'), 'a plain comment keeps its line breaks');
});
