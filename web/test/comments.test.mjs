// The comment control, box and markers in the editor (#15): NOTE-10, NOTE-12, NOTE-13 and NOTE-16, read from what they render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getSchema } from '@tiptap/core';
import { quoteOf } from '@shared/annotations.js';
import { EXTENSIONS, parseMarkdown } from '../src/editor/rich-text.js';
import { describe, rangeOf, sectionTexts } from '../src/editor/targets.js';
import { notes } from '../src/editor/shape-extension.js';
import { Composer, posts } from '../src/editor/Annotate.jsx';
import { CommentToggle, escapeDoes } from '../src/components/Chrome.jsx';

const schema = getSchema(EXTENSIONS);
const docOf = (markdown) => schema.nodeFromJSON(parseMarkdown(markdown));
const doc = docOf('## Why\n\nThe map is shaped like the product.\n\n## Behaviours\n\n- MAP-01 Given a project, when it opens, then it is a map.\n');
const why = sectionTexts(doc).get('Why');
const start = why.text.indexOf('shaped like');
const onWords = { on: 'phrase', section: 'Why', ...quoteOf(why.text, start, start + 'shaped like the product'.length) };
const box = (props) => renderToStaticMarkup(h(Composer, { onPost: async () => true, onCancel: () => {}, ...props }));

test('NOTE-10 one Comment control; the box it opens is headed by where the comment goes and quotes what was picked', () => {
  const off = renderToStaticMarkup(h(CommentToggle, { on: false, onToggle: () => {} }));
  const on = renderToStaticMarkup(h(CommentToggle, { on: true, onToggle: () => {} }));
  assert.match(off, /aria-pressed="false"/);
  assert.match(on, /aria-pressed="true"/);
  assert.equal((on.match(/<button/g) ?? []).length, 1, 'a single control');

  // Picked words, and a picked behaviour, each say where they are and quote what was picked.
  const r = rangeOf(doc, onWords);
  const words = describe({ state: { doc } }, { on: 'phrase', from: r.from, to: r.to, anchor: onWords });
  assert.deepEqual([words.where, words.quote], ['Why', 'shaped like the product']);
  const b = rangeOf(doc, { on: 'behaviour', section: 'Behaviours', behaviour: 'MAP-01' });
  const behaviour = describe({ state: { doc } }, { on: 'behaviour', from: b.from, to: b.to, anchor: { on: 'behaviour', section: 'Behaviours', behaviour: 'MAP-01' } });
  assert.equal(behaviour.where, 'MAP-01');
  assert.match(behaviour.quote, /^MAP-01 Given a project/);

  const html = box({ heading: `#12 The map · ${words.where}`, quote: words.quote });
  assert.match(html, /aria-label="Comment on #12 The map · Why"/);
  assert.match(html, /<strong>#12 The map · Why<\/strong>/, 'headed by the item and section');
  assert.match(html, /<blockquote>shaped like the product<\/blockquote>/, 'quoting what was picked');
  assert.match(box({ heading: 'Search', what: 'The place on the map' }), /<strong>Search<\/strong><span class="note-what">The place on the map<\/span>/, 'a place on the map, by its name');
});

test('NOTE-12 ⌘/Ctrl+Enter posts; the Comment button looks unavailable while there is nothing to post', () => {
  assert.ok(posts({ key: 'Enter', metaKey: true }));
  assert.ok(posts({ key: 'Enter', ctrlKey: true }));
  assert.ok(!posts({ key: 'Enter' }), 'Enter alone is a new line');
  assert.match(box({ heading: 'Why' }), /<button type="submit" disabled="" aria-disabled="true">Comment<\/button>/);
  assert.match(box({ heading: 'Why' }), /⌘\/Ctrl\+Enter/, 'the box says how');
});

test('NOTE-13 a comment is a marker with its author\'s initials at its words, which stay highlighted; choosing the marker opens its thread', () => {
  const opened = [];
  const thread = { id: 'c1', author: 'Ada Lovelace', text: 'Roughly, not exactly.', anchor: onWords };
  const decorations = notes(doc, { threads: [thread], onThread: (id) => opened.push(id) });
  const r = rangeOf(doc, onWords);
  const highlight = decorations.find((d) => d.type.attrs?.class === 'noted');
  assert.deepEqual([highlight.from, highlight.to], [r.from, r.to]);
  assert.equal(doc.textBetween(highlight.from, highlight.to), 'shaped like the product', 'the words it is about');
  const widget = decorations.find((d) => d.type.toDOM);
  assert.equal(widget.from, highlight.to, 'the marker sits at the words');

  // The marker as the page draws it.
  const made = [];
  globalThis.document = {
    createElement: () => {
      const el = { dataset: {}, listeners: {}, setAttribute: (k, v) => (el[k] = v), addEventListener: (k, f) => (el.listeners[k] = f) };
      made.push(el);
      return el;
    },
  };
  try {
    const marker = widget.type.toDOM();
    assert.equal(marker.textContent, 'AL');
    assert.match(marker['aria-label'], /Comment from Ada Lovelace/);
    marker.listeners.click({ stopPropagation() {} });
    assert.deepEqual(opened, ['c1']);
  } finally {
    delete globalThis.document;
  }
  assert.equal(notes(doc, { threads: [{ ...thread, anchor: { on: 'place' } }] }).length, 0, 'a comment on the map has its marker there, not in the text');
});

test('NOTE-16 Esc switches the Comment control off, before it closes anything; in a comment box, the box has it', () => {
  assert.equal(escapeDoes({ commenting: true, inBox: false }), 'stop commenting');
  assert.equal(escapeDoes({ commenting: true, inBox: true }), null, 'the box closes itself, and the control stays on');
  assert.equal(escapeDoes({ commenting: false, inBox: false }), 'close');
});
