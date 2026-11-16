import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { liftListItem, sinkListItem } from '@tiptap/pm/schema-list';
import { firstPlace, isWellFormed, newItemMarkdown, parseIssue, placeOf, sectionText } from '@shared/issue-shape.js';
import { EXTENSIONS, parseMarkdown, throughEditor } from '../src/editor/rich-text.js';
import { fromDocument, toDocument } from '../src/editor/document.js';
import { hintAt, openWithBodies, sectionBodies, textAgain } from '../src/editor/shape-extension.js';
import { commentHtml } from '../src/editor/comment-text.js';
import { linkAt } from '../src/editor/issue-links.js';
import { backOf, followLink, linkTarget } from '../src/model/links.js';
import { buildTree } from '../src/model/tree.js';

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

// Words saved as headings, the way #78 and #81 were written before EDIT-16.
const STRAY = [
  'Part of #26',
  'Kind: Task · Place: web',
  '',
  '## Why issues are not always visible on the map. Tasks should be houses, not countries.',
  '',
  '## Behaviours',
  '',
  '## As a user I want to zoom into an issue and see the tasks as properties.',
  '',
  '## Map zoom',
  '',
  '##   ',
  '',
  '## Acceptance: as a user I zoom into a behaviour and see its tasks.',
  '',
  '## Out of scope',
  '',
  '## Open questions',
  '',
  '## Acceptance',
  '',
  'Screenshots in the pull request.',
  '',
].join('\n');

test('EDIT-18 words saved as headings open as the text of their section; opening changes nothing, the first edit saves the shape', () => {
  const opened = markdownOf(open(toDocument(STRAY)).view.state);
  assert.equal(fromDocument(STRAY, opened, opened), STRAY, 'opening it changes nothing');
  const doc = open(toDocument(STRAY));
  const headings = [];
  doc.view.state.doc.forEach((n) => n.type.name === 'heading' && n.attrs.level === 2 && headings.push(n.textContent));
  assert.deepEqual(headings, ['Why', 'Behaviours', 'Acceptance', 'Out of scope', 'Open questions'], 'no "## " heading outside the shape');
  doc.at(doc.headingEnd('Out of scope'));
  doc.type('Moving issues.');
  const saved = parseIssue(fromDocument(STRAY, opened, markdownOf(doc.view.state)));
  assert.ok(isWellFormed(saved), saved.sections.map((s) => s.name).join(', '));
  assert.equal(sectionText(saved, 'Why'), 'issues are not always visible on the map. Tasks should be houses, not countries.');
  assert.equal(sectionText(saved, 'Behaviours'), 'As a user I want to zoom into an issue and see the tasks as properties.\n\n### Map zoom');
  assert.equal(sectionText(saved, 'Acceptance'), 'as a user I zoom into a behaviour and see its tasks.\n\nScreenshots in the pull request.', 'both Acceptances are one');
  assert.equal(sectionText(saved, 'Out of scope'), 'Moving issues.');
  assert.match(saved.head, /^Part of #26\nKind: Task · Place: web/);
});

test('EDIT-19 a heading typed outside the shape is text again at a press of its marker', () => {
  const doc = open(toDocument('## Why\n\nBecause.\n\n## Acceptance\n'));
  const state = doc.view.state;
  let pos = null;
  state.doc.forEach((n, offset) => n.textContent === 'Because.' && (pos = offset));
  doc.view.dispatch(state.tr.setNodeMarkup(pos, schema.nodes.heading, { level: 2 })); // "## " typed before it
  assert.equal(textAgain(doc.view.state, 0), null, 'a section of the shape stays a heading');
  doc.view.state.doc.forEach((n, offset) => n.textContent === 'Because.' && (pos = offset));
  doc.view.dispatch(textAgain(doc.view.state, pos));
  assert.equal(markdownOf(doc.view.state).includes('## Because.'), false);
  assert.equal(sectionText(parseIssue(markdownOf(doc.view.state)), 'Why'), 'Because.');
});

test('EDIT-20 an empty section shows its hint, and only while nothing is written there', () => {
  const doc = open(toDocument('## Why\n\n## Behaviours\n\n- EDIT-01 Given a, when b, then c.\n\n## Acceptance\n'));
  const hints = [];
  const { doc: d } = doc.view.state;
  d.forEach((n, offset) => n.type.name === 'paragraph' && hints.push(hintAt(d, n, offset)));
  assert.deepEqual(hints.filter(Boolean), ['The problem, for whom, and why now.', 'How everyone will know it is done.', 'What this deliberately leaves out.', 'Anything listed here needs a decision first.']);
  // An empty first line above written text is not an empty section.
  const behaviours = d.childAfter(doc.headingEnd('Behaviours') + 1);
  const line = schema.nodes.paragraph.create();
  const state = doc.view.state.apply(doc.view.state.tr.insert(behaviours.offset, line));
  assert.equal(hintAt(state.doc, line, behaviours.offset), '');
});

test('EDIT-22 a new item takes the first of its parent\'s places, not all of them', () => {
  const parent = 'Kind: Epic · Place: the area editor (`web/src/editor`), the changeset API and sync (#3)';
  assert.equal(placeOf(newItemMarkdown({ kind: 'task', partOf: '#26', place: placeOf(parent) })), 'the area editor (`web/src/editor`)');
  assert.equal(firstPlace('checkout'), 'checkout');
  assert.equal(firstPlace('`a, b` and c'), '`a, b`');
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

test('EDIT-14 "#N" in an item\'s text, a child\'s summary or a comment is that item on the map; following it keeps the way back', () => {
  const url = (n) => `https://github.com/o/r/issues/${n}`;
  const tree = buildTree([
    { id: 'root', kind: 'project', title: 'o/r', url: 'https://github.com/o/r' },
    { id: 'e', parentId: 'root', kind: 'epic', title: '#12 Walk the map', url: url(12), body: '## Behaviours\n\n- #13 Follow a link' },
    { id: 't', parentId: 'e', kind: 'task', title: '#13 Follow a link', url: url(13) },
  ]);

  // In the editor, the caret on "#13" in the child's one-line summary is on a link to that item.
  const doc = getSchema(EXTENSIONS).nodeFromJSON(parseMarkdown(tree.byId.get('e').body));
  let at = null;
  doc.descendants((n, pos) => {
    if (n.isText && n.text.includes('#13')) at = pos + n.text.indexOf('#13') + 2;
  });
  assert.equal(linkTarget(tree, linkAt({ doc }, at).ref).node.id, 't');
  // Shown as written (a comment, a read-only item), it is a link to the issue, and the issue is the item.
  const a = /<a [^>]*data-issue="13"[^>]*href="([^"]+)"/.exec(commentHtml('Done in #13.', 'o/r'));
  assert.equal(linkTarget(tree, a[1]).node.id, 't');
  assert.equal(linkTarget(tree, 13).node.id, 't');
  // Not on the map: a plain link to GitHub.
  assert.deepEqual(linkTarget(tree, '#99'), { number: 99, node: null, url: url(99) });

  // Following it is a new history entry that knows where it came from; Back returns to the item and view it left.
  const entries = [{ state: null, url: '#n=e' }];
  let i = 0;
  const history = {
    get state() {
      return entries[i].state;
    },
    replaceState: (state, _, u) => (entries[i] = { state, url: u }),
    pushState: (state, _, u) => (entries.splice(++i), entries.push({ state, url: u })),
    back: () => i--,
  };
  followLink(history, { fromId: 'e', from: '#n=e&v=1,2,3', to: '#n=t' });
  assert.deepEqual(backOf(history.state), { id: 'e' });
  history.back();
  assert.equal(entries[i].url, '#n=e&v=1,2,3');
  assert.equal(backOf(history.state), null);
});
