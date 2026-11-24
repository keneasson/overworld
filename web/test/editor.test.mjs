import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { liftListItem, sinkListItem } from '@tiptap/pm/schema-list';
import { editableOf, firstPlace, isWellFormed, itemKeyOf, newItemMarkdown, parseIssue, placeOf, sectionText } from '@shared/issue-shape.js';
import { EXTENSIONS, parseMarkdown, throughEditor } from '../src/editor/rich-text.js';
import { fromDocument, toDocument } from '../src/editor/document.js';
import { hintAt, openWithBodies, questionPlaces, sectionBodies } from '../src/editor/shape-extension.js';
import { questionsIn } from '@shared/questions.js';
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

test('EDIT-19 a section heading the shape does not have cannot be made: typed, it becomes a sub-heading of its section', () => {
  const doc = open(toDocument('## Why\n\nBecause.\n\n## Acceptance\n'));
  let pos = null;
  doc.view.state.doc.forEach((n, offset) => n.textContent === 'Because.' && (pos = offset));
  doc.view.dispatch(doc.view.state.tr.setNodeMarkup(pos, schema.nodes.heading, { level: 2 })); // "## " typed before it
  const markdown = markdownOf(doc.view.state);
  assert.doesNotMatch(markdown, /^## Because\./m, 'no section the shape does not have');
  assert.match(markdown, /### Because\./);
  assert.match(sectionText(parseIssue(markdown), 'Why'), /Because\./, 'still in its section');
  assert.match(markdown, /## Acceptance/, 'the sections already there are left alone');
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

test('EDIT-22 a new item\'s title is a placeholder: it opens empty, waiting, and a title left empty saves as the one it stands in for', async () => {
  const { titleShown, titleToSave } = await import('../src/editor/title.js');
  assert.equal(titleShown('New task', 'New task'), '', 'opens empty, with "New task" shown faintly');
  assert.equal(titleToSave('', 'New task'), 'New task', 'abandoned empty, it is still "New task"');
  assert.equal(titleToSave('  ', 'New task'), 'New task');
  assert.equal(titleToSave('Refund to the card', 'New task'), 'Refund to the card');
  assert.equal(titleShown('Refund to the card', 'New task'), 'Refund to the card', 'once titled, it shows its title');
  assert.equal(titleShown('Card tokens', null), 'Card tokens', 'an item with a title opens with it');
  assert.equal(titleToSave('', 'Card tokens'), 'Card tokens', 'a title cleared and left empty comes back');
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

test('EDIT-24 one refused edit never blocks editing a new item: its refinement is kept, and a title being retyped waits', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createApi } = await import('../../api/app.mjs');
  const { createModel } = await import('../../api/model/index.mjs');
  const { readyToSave, refinementGone, yourChangeset } = await import('../src/model/changesets.js');
  const model = await createModel({ DATA_FILE: join(await mkdtemp(join(tmpdir(), 'projectmap-')), 'db.json') });
  const api = createApi({ model, accessKey: 'k', log: { error() {} } });
  // What the app's request() does with a refusal: an error carrying its status and message.
  const call = async (method, path, body) => {
    const res = await api({ method, path, body, headers: { 'x-projectmap-key': 'k' } });
    if (res.status >= 400) throw Object.assign(new Error(res.body?.error ?? ''), { status: res.status });
    return res.body;
  };
  const pid = (await call('POST', '/api/projects', { title: 'Shop' })).project.id;
  const cs = (await call('POST', `/api/projects/${pid}/changesets`, { author: 'Ken' })).changeset;
  const { node } = await call('POST', `/api/projects/${pid}/changesets/${cs.id}/new`, { parentId: 'root', kind: 'task' });
  const key = itemKeyOf(node);
  const markdown = editableOf(node).markdown;

  assert.equal(readyToSave({ title: '  ', markdown }), false, 'a title deleted to be retyped is not sent');
  const refused = await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key, title: '', markdown }).catch((err) => err);
  assert.equal(refused.status, 400);
  assert.equal(refinementGone(refused), false, 'a refused edit keeps the refinement');
  const done = await call('PUT', `/api/projects/${pid}/changesets/${cs.id}/items`, { key, title: 'Refund to the card', markdown });
  assert.equal(done.node.title, 'Refund to the card', 'the next edit goes in');

  // Someone stuck before this fix has an empty refinement of theirs opened after the refused edit: picking up again chooses the one holding their work.
  await call('POST', `/api/projects/${pid}/changesets`, { author: 'Ken' });
  const { changesets } = await call('GET', `/api/projects/${pid}/changesets`);
  assert.equal(yourChangeset(changesets, 'Ken').id, cs.id);
  const elsewhere = await call('PUT', `/api/projects/${pid}/changesets/${changesets.at(-1).id}/items`, { key, title: 'x', markdown }).catch((err) => err);
  assert.equal(elsewhere.status, 409, 'a new item is only edited in its own refinement');
  assert.equal(refinementGone(elsewhere), false);
});

test('ANSWER-01 each unanswered question has its Answer control directly under it, in the item\'s own Open questions with its links; an answered one shows its answer', () => {
  const markdown = [
    'Part of #1',
    '',
    '## Why',
    '',
    'Because.',
    '',
    '## Open questions',
    '',
    '- Which store keeps the drafts, given [#13](https://github.com/o/r/issues/13)?',
    '- Who signs off?',
    'Answer: Ken does.',
    '- Tabbed or **multi** page?',
    '',
  ].join('\n');
  const doc = schema.nodeFromJSON(openWithBodies(parseMarkdown(markdown), schema));
  const questions = questionsIn('issue-20', markdown);
  const places = questionPlaces(doc, questions);
  const under = (p) => {
    const $p = doc.resolve(p.pos);
    return { item: $p.parent.type.name, text: $p.parent.textContent, last: $p.index() === $p.parent.childCount };
  };
  assert.deepEqual(
    places.map(under),
    [
      { item: 'listItem', text: 'Which store keeps the drafts, given #13?', last: true },
      { item: 'listItem', text: 'Tabbed or multi page?', last: true },
    ],
    'one control under each unanswered question, at the end of its own list item',
  );
  assert.deepEqual(places.map((p) => p.id), [questions[0].id, questions[2].id], 'each answers its own question');
  assert.match(doc.textContent, /Ken does/, 'the answer is in the text, under its question');

  const prose = '## Open questions\n\nWhich embeddings provider?\n';
  const pdoc = schema.nodeFromJSON(parseMarkdown(prose));
  assert.equal(questionPlaces(pdoc, questionsIn('issue-20', prose)).length, 1, 'a question written as prose has one too');
  assert.deepEqual(questionPlaces(doc, []), [], 'a question only in a draft waits until it is accepted');
});
