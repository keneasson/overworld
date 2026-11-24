// The strict shape, kept by the document rather than by forms (EDIT-02, EDIT-07): a missing section and a behaviour
// without an ID are marked where they are, Given / When / Then are picked out, Enter
// at the end of a behaviour starts the next one with its ID, and each annotation (#15) is a marker with its
// author's initials at the words it is about, which stay highlighted (NOTE-13). Nothing here ever blocks typing.
// A section's heading holds only its name (EDIT-16): every section has a line to type on, and words typed, pasted or
// Entered into a shape heading go to that line instead. A section heading the shape doesn't have can't be made: one typed
// becomes a sub-heading of the section it's in (EDIT-19), and an empty section shows its hint until anything is written there (EDIT-20).

import { Extension } from '@tiptap/core';
import { EditorState, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { SECTIONS } from '@shared/issue-shape.js';
import { initials } from '@shared/annotations.js';
import { sectionAt } from './document.js';
import { rangeOf, sectionTexts } from './targets.js';
import { addSection, missingSections } from './sections.js';

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

/** Each annotation's highlight and marker, where its anchor is now (NOTE-01, NOTE-13): decorations for the document. */
export function notes(doc, { threads, active = null, onThread = () => {} }) {
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

/**
 * Where a document departs from the shape (EDIT-07): each section it is missing, where it belongs, and each behaviour written
 * without an ID. Shown in the document, never enforced.
 */
export function gaps(doc) {
  const out = missingSections(doc).map(({ name, pos }) => ({ on: 'section', name, pos }));
  let section = null;
  doc.forEach((node, offset) => {
    if (node.type.name === 'heading' && node.attrs.level === 2) section = canonical(node.textContent.trim());
    if (section !== 'Behaviours' || node.type.name !== 'bulletList') return;
    node.forEach((item, itemOffset) => {
      const text = item.firstChild?.isTextblock ? item.firstChild.textContent : '';
      if (text.trim() && !ID.test(text)) out.push({ on: 'behaviour', from: offset + 1 + itemOffset, to: offset + 1 + itemOffset + item.nodeSize });
    });
  });
  return out;
}

// A missing section's place, marked in the text: pressing it adds the section there (EDIT-25 is the same from a right-click).
function sectionGap(name) {
  return (view) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.contentEditable = 'false';
    b.className = 'section-gap';
    b.textContent = `+ ${name}`;
    b.title = `This item has no ${name} section. Add it here`;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const tr = addSection(view.state, name);
      if (tr) view.dispatch(tr);
      view.focus();
    });
    return b;
  };
}

// What a question's words come to once its markdown is written as text: links, emphasis and spacing aside.
const plain = (s) =>
  String(s ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~\\<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
const ANSWER_LINE = /^\s*answer:/i;

/**
 * Where each unanswered question is in the item's own Open questions section (#68 ANSWER-01), so its Answer control sits
 * directly under it and the questions are never listed a second time. `questions` are the item's as the map has them
 * (questionsIn), matched to the document by their words; one only in a draft has none until it is accepted.
 * @returns {{ id: string, pos: number }[]} `pos`: just after the question's own text, inside its list item
 */
export function questionPlaces(doc, questions = []) {
  const open = questions.filter((q) => !q.answer);
  if (!open.length) return [];
  const out = [];
  const used = new Set();
  const place = (text, pos) => {
    const t = plain(text);
    if (!t || ANSWER_LINE.test(t)) return;
    const q = open.find((x) => !used.has(x.id) && plain(x.text) && (t.startsWith(plain(x.text.split('\n')[0])) || plain(x.text).startsWith(t)));
    if (!q) return;
    used.add(q.id);
    out.push({ id: q.id, pos });
  };
  let section = null;
  doc.forEach((node, offset) => {
    if (node.type.name === 'heading' && node.attrs.level === 2) section = canonical(node.textContent.trim());
    else if (section !== 'Open questions') return;
    else if (node.type.name === 'bulletList' || node.type.name === 'orderedList') node.forEach((item, at) => place(item.firstChild?.textContent, offset + 1 + at + item.nodeSize - 1));
    else if (node.isTextblock) place(node.textContent, offset + node.nodeSize);
  });
  return out;
}

// A question's Answer control (ANSWER-01), directly under it in the text.
function answerControl(id, onAnswer) {
  return () => {
    const wrap = document.createElement('div');
    wrap.className = 'answer-control';
    wrap.contentEditable = 'false';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link-btn';
    b.dataset.question = id;
    b.textContent = 'Answer';
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onAnswer(id, b);
    });
    wrap.append(b);
    return wrap;
  };
}

function decorate(doc, opts) {
  const out = notes(doc, opts);
  for (const g of gaps(doc)) {
    if (g.on === 'section') out.push(Decoration.widget(g.pos, sectionGap(g.name), { side: -1, key: `gap:${g.name}`, ignoreSelection: true, stopEvent: () => true }));
    else out.push(Decoration.node(g.from, g.to, { class: 'no-id', title: 'No behaviour ID: tests and comments have nothing to hold on to' }));
  }
  for (const q of questionPlaces(doc, opts.questions)) out.push(Decoration.widget(q.pos, answerControl(q.id, opts.onAnswer), { side: 1, key: `answer:${q.id}`, ignoreSelection: true, stopEvent: () => true }));
  let section = null;
  doc.forEach((node, offset) => {
    if (node.type.name === 'heading' && node.attrs.level === 2) {
      section = canonical(node.textContent.trim());
      return;
    }
    if (section !== 'Behaviours' || node.type.name !== 'bulletList') return;
    node.forEach((item, itemOffset) => {
      const itemPos = offset + 1 + itemOffset;
      const para = item.firstChild;
      if (!para?.isTextblock) return;
      const { text, at } = flatten(para, itemPos + 2);
      const id = text.match(ID);
      if (!id) return; // marked as a gap (EDIT-07)
      out.push(Decoration.inline(at[0], at[id[1].length - 1] + 1, { class: 'bid' }));
      const g = text.match(GWT);
      if (g) for (const [s, e] of g.indices.slice(1)) out.push(Decoration.inline(at[s], at[e - 1] + 1, { class: 'kw' }));
    });
  });
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
    // nextId(): the ID a new behaviour gets. onThread(id, marker): open an annotation's thread. onAnswer(id, control): answer a question.
    return { nextId: () => 'ITEM-01', onThread: () => {}, onAnswer: () => {} };
  },

  addStorage() {
    return { threads: [], active: null, questions: [] };
  },

  addProseMirrorPlugins() {
    const ext = this;
    const build = (doc) =>
      decorate(doc, { threads: ext.storage.threads, active: ext.storage.active, onThread: (id, b) => ext.options.onThread(id, b), questions: ext.storage.questions, onAnswer: (id, b) => ext.options.onAnswer(id, b) });
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
export function refreshNotes(editor, threads, active = null, questions = editor?.storage.issueShape.questions) {
  if (!editor || editor.isDestroyed) return;
  editor.storage.issueShape.threads = threads;
  editor.storage.issueShape.active = active;
  editor.storage.issueShape.questions = questions ?? [];
  try {
    editor.view.dispatch(editor.state.tr.setMeta(KEY, true));
  } catch {
    // Not mounted yet: the decorations are built from storage when it is.
  }
}
