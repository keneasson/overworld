// The strict shape, kept by the document rather than by forms (EDIT-02, EDIT-07): headings outside the
// shape and behaviours without an ID are marked where they are, Given / When / Then are picked out, Enter
// at the end of a behaviour starts the next one with its ID, and comments show beside what they are on.
// Nothing here ever blocks typing.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { SECTIONS, hasOpenQuestions } from '@shared/issue-shape.js';
import { sectionAt } from './document.js';

const KEY = new PluginKey('issueShape');
const ID = /^([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+)\b/;
const GWT = /\b(given)\b[\s\S]*?\b(when)\b[\s\S]*?\b(then)\b/di;
const canonical = (name) => SECTIONS.find((s) => s.toLowerCase() === name.toLowerCase().replace(/^behaviors$/, 'behaviours')) ?? name;

/** A paragraph's text, with the document position of each character. */
function flatten(para, start) {
  let text = '';
  const at = [];
  para.descendants((n, pos) => {
    if (!n.isText) return;
    for (let i = 0; i < n.text.length; i++) at.push(start + pos + i);
    text += n.text;
  });
  return { text, at };
}

function noteButton(anchor, count, onThread) {
  return () => {
    const b = document.createElement('button');
    b.type = 'button';
    b.contentEditable = 'false';
    b.className = `note-btn${count ? ' has' : ''}`;
    b.setAttribute('aria-label', `${anchor.behaviour ?? anchor.section}: ${count || 'no'} comments`);
    b.textContent = count ? `💬 ${count}` : '💬';
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => onThread(anchor, b));
    return b;
  };
}

function decorate(doc, { counts, onThread }) {
  const out = [];
  const widget = (pos, anchor) => {
    const key = anchor.behaviour ? `b:${anchor.behaviour}` : `s:${anchor.section}`;
    const count = counts.get(key) ?? 0;
    out.push(Decoration.widget(pos, noteButton(anchor, count, onThread), { side: 1, key: `${key}:${count}`, ignoreSelection: true }));
  };
  let section = null;
  let questions = null;
  let questionText = '';
  doc.forEach((node, offset) => {
    if (node.type.name === 'heading' && node.attrs.level === 2) {
      section = canonical(node.textContent.trim());
      if (!SECTIONS.includes(section)) out.push(Decoration.node(offset, offset + node.nodeSize, { class: 'off-shape', 'data-note': 'Not in the shape' }));
      if (section === 'Open questions') questions = [offset, offset + node.nodeSize];
      widget(offset + node.nodeSize - 1, { section });
      return;
    }
    if (section === 'Open questions') questionText += `${node.textContent}\n`;
    if (section !== 'Behaviours' || node.type.name !== 'bulletList') return;
    node.forEach((item, itemOffset) => {
      const itemPos = offset + 1 + itemOffset;
      const para = item.firstChild;
      if (!para?.isTextblock) return;
      const { text, at } = flatten(para, itemPos + 2);
      const id = text.match(ID);
      if (!id) {
        if (text.trim()) out.push(Decoration.node(itemPos, itemPos + item.nodeSize, { class: 'no-id', title: 'No behaviour ID: tests and comments have nothing to hold on to' }));
        return;
      }
      out.push(Decoration.inline(at[0], at[id[1].length - 1] + 1, { class: 'bid' }));
      const g = text.match(GWT);
      if (g) for (const [s, e] of g.indices.slice(1)) out.push(Decoration.inline(at[s], at[e - 1] + 1, { class: 'kw' }));
      widget(itemPos + 1 + para.nodeSize - 1, { behaviour: id[1] });
    });
  });
  if (questions && hasOpenQuestions(questionText)) out.push(Decoration.node(questions[0], questions[1], { class: 'asking', 'data-note': '? Needs a decision' }));
  return DecorationSet.create(doc, out);
}

export const IssueShape = Extension.create({
  name: 'issueShape',

  addOptions() {
    // nextId(): the ID a new behaviour gets. onThread(anchor, button): open a comment thread.
    return { nextId: () => 'ITEM-01', onThread: () => {} };
  },

  addStorage() {
    return { counts: new Map() };
  },

  addProseMirrorPlugins() {
    const ext = this;
    const build = (doc) => decorate(doc, { counts: ext.storage.counts, onThread: (a, b) => ext.options.onThread(a, b) });
    return [
      new Plugin({
        key: KEY,
        state: {
          init: (_, state) => build(state.doc),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(KEY) ? build(tr.doc) : old),
        },
        props: { decorations: (state) => KEY.getState(state) },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      // At the end of a written behaviour, Enter starts the next one with its ID.
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.type.name !== 'paragraph' || $from.parentOffset !== $from.parent.content.size || !$from.parent.textContent.trim()) return false;
        if ($from.depth < 3 || $from.node(-1).type.name !== 'listItem' || $from.depth !== 3) return false;
        if (sectionAt(editor.state.doc, $from.before(1)) !== 'Behaviours') return false;
        return editor.chain().splitListItem('listItem').insertContent(`${this.options.nextId()} Given `).run();
      },
    };
  },
});

/** Show new comment counts without waiting for an edit. */
export function refreshNotes(editor, counts) {
  if (!editor || editor.isDestroyed) return;
  editor.storage.issueShape.counts = counts;
  editor.view.dispatch(editor.state.tr.setMeta(KEY, true));
}
