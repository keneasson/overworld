// The strict shape, kept by the document rather than by forms (EDIT-02, EDIT-07): headings outside the
// shape and behaviours without an ID are marked where they are, Given / When / Then are picked out, Enter
// at the end of a behaviour starts the next one with its ID, and each annotation (#15) is a marker with its
// author's initials at the words it is about, which stay highlighted (NOTE-13). Nothing here ever blocks typing.
// A section's heading holds only its name (EDIT-16): every section has a line to type on, and words typed, pasted or
// Entered into a shape heading go to that line instead. A section heading the shape doesn't have can't be made: one typed
// becomes a sub-heading of the section it's in (EDIT-19), and an empty section shows its hint until anything is written there (EDIT-20).

import { Extension } from '@tiptap/core';
import { EditorState, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { SECTIONS, hasOpenQuestions } from '@shared/issue-shape.js';
import { initials } from '@shared/annotations.js';
import { sectionAt } from './document.js';
import { rangeOf, sectionTexts } from './targets.js';

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

function marker(c, onThread, moved) {
  return () => {
    const b = document.createElement('button');
    b.type = 'button';
    b.contentEditable = 'false';
    b.className = `note-marker${c.unread ? ' unread' : ' read'}${moved ? ' moved' : ''}`;
    b.dataset.thread = c.id;
    b.setAttribute('aria-label', `${c.unread ? 'Unread comment' : 'Comment'} from ${c.author}: ${c.text.slice(0, 80)}`);
    b.title = `${c.author}${c.unread ? ' · unread' : ''}${moved ? ' · the words it was on have changed' : ''}`;
    b.textContent = initials(c.author);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onThread(c.id, b);
    });
    return b;
  };
}

/** Each annotation's highlight and marker, where its anchor is now (NOTE-01, NOTE-13). */
function notes(doc, { threads, active, onThread }) {
  const out = [];
  const texts = sectionTexts(doc);
  for (const c of threads) {
    if (c.anchor?.on === 'place') continue;
    const r = rangeOf(doc, c.anchor ?? {}, texts);
    if (!r) continue;
    const on = c.id === active ? ' on' : '';
    if (r.inline) out.push(r.image ? Decoration.node(r.from, r.to, { class: `noted-img${on}` }) : Decoration.inline(r.from, r.to, { class: `noted${on}` }));
    else if (!r.moved && c.anchor?.behaviour) out.push(Decoration.node(r.from, r.to, { class: `noted-block${on}` }));
    out.push(Decoration.widget(r.marker, marker(c, onThread, r.moved), { side: 1, key: `note:${c.id}:${Boolean(c.unread)}:${r.moved}:${on}`, ignoreSelection: true, stopEvent: () => true }));
  }
  return out;
}

export const HINTS = {
  Why: 'The problem, for whom, and why now.',
  Behaviours: 'AREA-01 Given …, when …, then …',
  Acceptance: 'How everyone will know it is done.',
  'Out of scope': 'What this deliberately leaves out.',
  'Open questions': 'Anything listed here needs a decision first.',
};

/** The hint an empty line shows (EDIT-20): only the first line of a section that has nothing else in it. */
export function hintAt(doc, node, pos) {
  if (node.type.name !== 'paragraph' || node.content.size || pos === 0) return '';
  const $pos = doc.resolve(pos);
  if ($pos.depth !== 0 || !isSection($pos.nodeBefore)) return '';
  const next = doc.nodeAt(pos + node.nodeSize);
  if (next && !isSection(next)) return '';
  return HINTS[sectionAt(doc, pos)] ?? '';
}

function decorate(doc, opts) {
  const out = notes(doc, opts);
  let section = null;
  let questions = null;
  let questionText = '';
  doc.forEach((node, offset) => {
    if (node.type.name === 'heading' && node.attrs.level === 2) {
      section = canonical(node.textContent.trim());
      if (section === 'Open questions') questions = [offset, offset + node.nodeSize];
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
    });
  });
  if (questions && hasOpenQuestions(questionText)) out.push(Decoration.node(questions[0], questions[1], { class: 'asking', 'data-note': '? Needs a decision' }));
  return DecorationSet.create(doc, out);
}

const isSection = (node) => node?.type.name === 'heading' && node.attrs.level === 2;
const inShape = (node) => isSection(node) && SECTIONS.includes(canonical(node.textContent.trim()));

const sectionCount = (doc) => {
  let n = 0;
  doc.forEach((node) => isSection(node) && n++);
  return n;
};

/**
 * A section heading the shape doesn't have, just made ("## " typed, or pasted), becomes a sub-heading of the section it is in, so
 * the shape can't be broken (EDIT-19). Only a heading that is new is changed, never one already there. Null when there is nothing to do.
 */
export function noStraySections(before, state) {
  if (sectionCount(state.doc) <= sectionCount(before.doc)) return null;
  const at = [];
  state.doc.forEach((node, offset) => isSection(node) && !inShape(node) && at.push(offset));
  if (!at.length) return null;
  const tr = state.tr;
  for (const pos of at) tr.setNodeMarkup(pos, null, { ...state.doc.nodeAt(pos).attrs, level: 3 });
  return tr;
}

/** Each section with nothing under it gets an empty line to type on; null when every section has one (EDIT-16). */
export function withBodies(state) {
  const at = [];
  state.doc.forEach((node, offset, index) => {
    const next = index + 1 < state.doc.childCount ? state.doc.child(index + 1) : null;
    if (isSection(node) && (!next || isSection(next))) at.push(offset + node.nodeSize);
  });
  if (!at.length) return null;
  const tr = state.tr;
  for (const pos of at.reverse()) tr.insert(pos, state.schema.nodes.paragraph.create());
  return tr;
}

/** A document (JSON) with a line under every section, for the editor to open on (EDIT-16). */
export function openWithBodies(json, schema) {
  const tr = withBodies(EditorState.create({ doc: schema.nodeFromJSON(json) }));
  return tr ? tr.doc.toJSON() : json;
}

/** Moves the cursor from a section's heading to the first line of its text, making that line if the text starts with something else. */
function toBody(tr, headingPos) {
  const heading = tr.doc.nodeAt(headingPos);
  const after = headingPos + heading.nodeSize;
  const next = tr.doc.nodeAt(after);
  if (!(next?.type.name === 'paragraph' && next.content.size === 0)) tr.insert(after, tr.doc.type.schema.nodes.paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, after + 1));
}

/** The heading's position when the selection is inside a section heading (`shapeOnly`: one the shape names), else null. */
function headingAt(state, shapeOnly) {
  const { $from, $to } = state.selection;
  if ($from.depth !== 1 || $to.depth !== 1 || $from.parent !== $to.parent || !isSection($from.parent)) return null;
  return shapeOnly && !inShape($from.parent) ? null : $from.before(1);
}

/** Keeps a section's words out of its heading (EDIT-16). */
export function sectionBodies() {
  return new Plugin({
    appendTransaction: (trs, before, state) => {
      if (!trs.some((t) => t.docChanged)) return null;
      const fixed = noStraySections(before, state);
      const next = fixed ? state.apply(fixed) : state;
      const bodies = withBodies(next);
      if (!fixed) return bodies;
      if (bodies) bodies.steps.forEach((step) => fixed.step(step));
      return fixed;
    },
    props: {
      handleTextInput(view, from, to, text) {
        const at = headingAt(view.state, true);
        if (at == null) return false;
        view.dispatch(toBody(view.state.tr, at).insertText(text).scrollIntoView());
        return true;
      },
      handlePaste(view, _, slice) {
        const at = headingAt(view.state, true);
        if (at == null) return false;
        view.dispatch(toBody(view.state.tr, at).replaceSelection(slice).scrollIntoView());
        return true;
      },
      // Enter in a section's name, or at the end of any section heading, goes to the section's text.
      handleKeyDown(view, e) {
        if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
        const { $from, empty } = view.state.selection;
        const at = headingAt(view.state, false);
        if (at == null || !(inShape($from.parent) || (empty && $from.parentOffset === $from.parent.content.size))) return false;
        view.dispatch(toBody(view.state.tr, at).scrollIntoView());
        return true;
      },
    },
  });
}

export const IssueShape = Extension.create({
  name: 'issueShape',

  addOptions() {
    // nextId(): the ID a new behaviour gets. onThread(id, marker): open an annotation's thread.
    return { nextId: () => 'ITEM-01', onThread: () => {} };
  },

  addStorage() {
    return { threads: [], active: null };
  },

  addProseMirrorPlugins() {
    const ext = this;
    const build = (doc) => decorate(doc, { threads: ext.storage.threads, active: ext.storage.active, onThread: (id, b) => ext.options.onThread(id, b) });
    return [
      new Plugin({
        key: KEY,
        state: {
          init: (_, state) => build(state.doc),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(KEY) ? build(tr.doc) : old),
        },
        props: { decorations: (state) => KEY.getState(state) },
      }),
      sectionBodies(),
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

/** Show annotations as they change, without waiting for an edit: each thread's first annotation, and the one open. */
export function refreshNotes(editor, threads, active = null) {
  if (!editor || editor.isDestroyed) return;
  editor.storage.issueShape.threads = threads;
  editor.storage.issueShape.active = active;
  try {
    editor.view.dispatch(editor.state.tr.setMeta(KEY, true));
  } catch {
    // Not mounted yet: the decorations are built from storage when it is.
  }
}
