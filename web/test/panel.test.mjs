// The panel beside the map, where an item is read and edited (#41).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { prerender } from 'react-dom/static';
import { buildTree } from '../src/model/tree.js';
import { LENSES } from '../src/map/lenses.js';
import { afterHandle, fitWidth, keepMapStill, PANEL_MIN, readWidth, rememberWidth, sheetAfter } from '../src/model/panel.js';

const url = (n) => `https://github.com/o/r/issues/${n}`;
const tree = buildTree([
  { id: 'root', kind: 'project', title: 'o/r', url: 'https://github.com/o/r' },
  { id: 'e', parentId: 'root', kind: 'epic', title: '#12 Walk the map', url: url(12), status: 'ready' },
  { id: 't', parentId: 'e', kind: 'task', title: '#13 Follow a link', url: url(13), status: 'ready' },
  { id: 'n', parentId: 'e', kind: 'task', title: 'New task', status: 'idea', refinement: 'cs1' },
]);
const key = (n) => `issue-${n}`;
const editing = (more = {}) => ({
  others: [],
  changeset: { id: 'cs1', items: [] },
  drafts: new Map(),
  generation: 0,
  conflicts: new Set(),
  edited: [],
  unsaved: [],
  saving: false,
  onItsWay: 0,
  busy: false,
  name: 'Ken',
  splitOf: () => null,
  ...more,
});

/** The panel as it opens on `id`, once the document editor has loaded. */
async function panel(id, ed = editing()) {
  const { Details } = await import('../src/components/Panel.jsx');
  const noop = () => {};
  const { prelude } = await prerender(
    h(Details, { node: tree.byId.get(id), tree, lens: LENSES[0], editing: ed, onPick: noop, onFly: noop, onAdd: noop, onPatch: noop, onDelete: noop, onClose: noop, onCopyLink: noop }),
  );
  let html = '';
  for await (const chunk of prelude) html += Buffer.from(chunk).toString();
  return html;
}
const titleRow = (html) => /<div class="title-row">([\s\S]*?)<\/div>/.exec(html)[1];

test('EDIT-09 EDIT-11 an item open in the panel is edited right there: its text is the document, its properties change in place', async () => {
  const html = await panel('t');
  const doc = /<div class="doc">([\s\S]*?)<section>/.exec(html)[1];
  assert.match(doc, /<textarea class="issue-doc-title"[^>]*>Follow a link<\/textarea>/, 'the panel holds the editor, open on the item');
  assert.doesNotMatch(doc, /readOnly|readonly/);
  assert.doesNotMatch(html, />\s*Edit\s*</, 'no separate edit screen to go to');
  for (const name of ['Kind', 'Status', 'Priority']) assert.match(html, new RegExp(`<label for="[^"]+">${name}</label><select`), `${name} is changed where it is`);
  assert.match(html, /More properties/, 'place and the rest, one click away in the same panel');
  assert.match(html, /aria-label="Connect to"/, 'links too');
});

test('EDIT-13 the panel holds one item, and an edit not yet saved is still there when it is picked again', async () => {
  const ed = editing({ drafts: new Map([[key(13), { title: 'Follow a link, and back', markdown: '' }]]) });
  const first = await panel('t', ed);
  assert.equal(first.match(/class="issue-doc-title"/g).length, 1, 'one item, never several side by side');
  const other = await panel('e', ed);
  assert.match(other, />Walk the map<\/textarea>/, 'picking another replaces it');
  assert.match(await panel('t', ed), />Follow a link, and back<\/textarea>/, 'the edit waited in the changeset');
});

test('EDIT-21 the title comes after one line of where it is and its state, each fact once, and the changeset is one quiet line', async () => {
  const ready = titleRow(await panel('t'));
  assert.equal(ready.match(/Ready/g).length, 2, 'its status once (its dot\'s title and its word)');
  assert.doesNotMatch(ready, /On target|Not started|At risk/, 'a leaf not started has no health beside its status');
  const fresh = titleRow(await panel('n'));
  assert.match(fresh, />New</);
  assert.doesNotMatch(fresh, /status-text|Idea/, 'a new item is just new');
  const html = await panel('t', editing({ edited: [{ key: key(13) }] }));
  const bars = html.match(/<div class="edit-bar"/g) ?? [];
  assert.equal(bars.length, 1);
  assert.ok(html.indexOf('class="edit-bar"') > html.indexOf('class="issue-doc-title"'), 'under the text');
  assert.match(html, /1 edited/);
});

test('EDIT-10 the expand handle widens the panel and collapses it back, drags to any width with the map still beside it, and is remembered', () => {
  const viewport = 1440;
  const wide = afterHandle({ startW: PANEL_MIN, dx: 0, moved: false }, viewport);
  assert.ok(wide > PANEL_MIN + 200, 'a click widens it');
  assert.equal(afterHandle({ startW: wide, dx: 0, moved: false }, viewport), PANEL_MIN, 'and collapses it back');
  assert.equal(afterHandle({ startW: PANEL_MIN, dx: 150, moved: true }, viewport), PANEL_MIN + 150, 'dragged, it is as wide as it was dragged');
  assert.ok(afterHandle({ startW: PANEL_MIN, dx: 5000, moved: true }, viewport) < viewport - 200, 'the map is still beside it');
  assert.equal(fitWidth(100, viewport), PANEL_MIN);
  const kept = new Map();
  const store = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) };
  assert.equal(readWidth(store, viewport), PANEL_MIN, 'narrow until widened');
  rememberWidth(store, 700);
  assert.equal(readWidth(store, viewport), 700, 'it remembers');
  assert.equal(readWidth(store, 800), fitWidth(700, 800), 'in a smaller window, still with the map beside it');
  const blocked = { getItem: () => { throw new Error('private'); }, setItem: () => { throw new Error('private'); } };
  rememberWidth(blocked, 700);
  assert.equal(readWidth(blocked, viewport), PANEL_MIN, 'a private window still has a panel');
});

test('EDIT-12 on a phone the sheet pulls up to fill the screen and down to see the map', () => {
  assert.equal(sheetAfter(-120, false), true, 'pulled up');
  assert.equal(sheetAfter(140, true), false, 'pulled down');
  assert.equal(sheetAfter(-2, false), true, 'a tap on the handle switches');
  assert.equal(sheetAfter(3, true), false);
});

test('EDIT-23 scrolling or pinching inside the panel never reaches the map', () => {
  const app = new EventTarget();
  const panelEl = new EventTarget();
  const reached = [];
  for (const type of ['wheel', 'touchmove']) app.addEventListener(type, () => reached.push(type));
  // The panel sits in the app; events on it go on to the app, as they would in the page.
  const send = (type, props) => {
    const e = Object.assign(new Event(type, { cancelable: true }), props);
    panelEl.dispatchEvent(e);
    if (!e.cancelBubble) app.dispatchEvent(e);
    return e;
  };
  const undo = keepMapStill(panelEl);
  assert.equal(send('wheel', { ctrlKey: false }).defaultPrevented, false, 'a scroll scrolls the panel');
  assert.equal(send('wheel', { ctrlKey: true }).defaultPrevented, true, 'a trackpad pinch zooms nothing');
  assert.equal(send('touchmove', { touches: [{}, {}] }).defaultPrevented, true, 'nor a two-finger pinch');
  assert.equal(send('touchmove', { touches: [{}] }).defaultPrevented, false, 'one finger scrolls');
  assert.equal(send('gesturestart', {}).defaultPrevented, true);
  assert.deepEqual(reached, [], 'the map never hears them');
  undo();
  send('wheel', { ctrlKey: true });
  assert.deepEqual(reached, ['wheel']);
});

test('ADOPT-17 ADOPT-18 a refinement shows only what it changed: a behaviour as one text with its edits in place, and other changes as a line each', async () => {
  const { Details } = await import('../src/components/Panel.jsx');
  const { wordDiff } = await import('@shared/word-diff.js');
  assert.deepEqual(wordDiff('then it shows as Fog, because', 'then it shows as #22 STRAY-01 says, because'), [
    { kind: 'same', text: 'then it shows as ' },
    { kind: 'del', text: 'Fog,' },
    { kind: 'ins', text: '#22 STRAY-01 says,' },
    { kind: 'same', text: ' because' },
  ]);
  const { changeSummary } = await import('@shared/word-diff.js');
  const asked = '- Which vault? It matters.\n  Two sentences here.\n- How long? Two hours.\n- Who pays?';
  assert.equal(changeSummary({ name: 'Open questions', change: 'changed', before: asked, after: '- How long? Two hours.' }), '2 questions removed', 'a list counts its items');
  assert.equal(changeSummary({ name: 'Acceptance', change: 'changed', before: '- It holds.', after: '- It holds firm.\n- It ships.' }), '1 item reworded, 1 added');
  assert.equal(changeSummary({ name: 'Open questions', change: 'changed', before: asked, after: 'None' }), 'emptied');
  assert.equal(changeSummary({ name: 'Why', change: 'changed', before: 'Agents collide.\n\n- One point.', after: 'Agents collide.\n\n- One point.\n\nA new paragraph.' }), '1 sentence added', 'prose with a few points in it is read by sentence');
  const why = Array.from({ length: 40 }, (_, i) => `Word${i}`).join(' ');
  const base = { title: 'Proof', markdown: `Part of #1\n\n## Why\n\n${why}.\n\n## Behaviours\n\n- PR-01 Given a test, when it runs, then it shows as Fog, because nobody knows.\n\n## Open questions\n\nNone\n` };
  const after = { title: 'Proof', markdown: base.markdown.replace('as Fog,', 'as #22 STRAY-01 says,').replace('Word20', 'Twenty') };
  const t = buildTree([
    { id: 'root', kind: 'project', title: 'o/r', url: 'https://github.com/o/r' },
    // Since it was proposed, the item gained an Acceptance section: not the refinement's change.
    { id: 'p', parentId: 'root', kind: 'task', title: '#20 Proof', url: url(20), status: 'ready', body: base.markdown.replace('## Open questions', '## Acceptance\n\nIt holds.\n\n## Open questions') },
  ]);
  const cs = { id: 'cs9', author: 'Builder (a1)', status: 'open', updatedAt: new Date().toISOString(), items: [{ key: key(20), base, after }] };
  const noop = () => {};
  const { prelude } = await prerender(h(Details, { node: t.byId.get('p'), tree: t, lens: LENSES[0], editing: editing({ others: [cs] }), onPick: noop, onFly: noop, onAdd: noop, onPatch: noop, onDelete: noop, onClose: noop, onCopyLink: noop }));
  let html = '';
  for await (const chunk of prelude) html += Buffer.from(chunk).toString();
  const review = /<section class="refinement"[\s\S]*?<\/section>/.exec(html)[0];
  assert.match(review, /then it shows as <del class="diff-del">Fog,<\/del><ins class="diff-ins">#22 STRAY-01 says,<\/ins> because/, 'one text, its edits in place');
  assert.doesNotMatch(review, /class="change-before"/, 'never the old block above the new');
  assert.match(review, /<summary><span class="change-label">Why<\/span>: <!-- -->1 sentence reworded/, 'a line for what changed in the Why');
  assert.doesNotMatch(review, /It holds|Acceptance/, "an edit made since isn't the refinement's");
  assert.match(review, /diff-fold/, 'a long section folds what it left alone');
});
