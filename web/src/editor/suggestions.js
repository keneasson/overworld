// Suggestions in the live document (prototype): a collaborator who suggests (an agent, or GitHub when asked to) writes
// words marked as an insertion and marks the words it would remove as a deletion, both carrying who suggested it.
// Nothing changes until someone accepts: Accept keeps the insertion and drops the deletion, Reject does the opposite.
// The marks live in the shared document, so every tab sees the same suggestion and its controls.

import { Extension, Mark } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const attrs = () => ({ id: { default: null }, author: { default: null }, color: { default: null } });
const style = (color) => (/^#[0-9a-f]{6}$/i.test(color ?? '') ? `--sugg:${color}` : '');

// Not inclusive: typing at the edge of a suggestion is the typist's own text, not part of it.
export const SuggestionInsert = Mark.create({
  name: 'suggestionInsert',
  inclusive: false,
  excludes: '',
  addAttributes: attrs,
  parseHTML: () => [{ tag: 'ins[data-suggestion]', getAttrs: (el) => ({ id: el.dataset.suggestion, author: el.dataset.author, color: el.dataset.color }) }],
  renderHTML: ({ mark }) => ['ins', { class: 'sugg-ins', 'data-suggestion': mark.attrs.id, 'data-author': mark.attrs.author, 'data-color': mark.attrs.color, style: style(mark.attrs.color), title: `${mark.attrs.author} suggests adding this` }, 0],
});

export const SuggestionDelete = Mark.create({
  name: 'suggestionDelete',
  inclusive: false,
  excludes: '',
  addAttributes: attrs,
  parseHTML: () => [{ tag: 'del[data-suggestion]', getAttrs: (el) => ({ id: el.dataset.suggestion, author: el.dataset.author, color: el.dataset.color }) }],
  renderHTML: ({ mark }) => ['del', { class: 'sugg-del', 'data-suggestion': mark.attrs.id, 'data-author': mark.attrs.author, 'data-color': mark.attrs.color, style: style(mark.attrs.color), title: `${mark.attrs.author} suggests removing this` }, 0],
});

/** Every suggestion in a document, by id: its author, colour, and the ranges it inserts and deletes. */
export function suggestionsIn(doc) {
  const out = new Map();
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const m of node.marks) {
      const kind = m.type.name === 'suggestionInsert' ? 'ins' : m.type.name === 'suggestionDelete' ? 'del' : null;
      if (!kind || !m.attrs.id) continue;
      const s = out.get(m.attrs.id) ?? { id: m.attrs.id, author: m.attrs.author, color: m.attrs.color, ins: [], del: [], end: 0 };
      s[kind].push({ from: pos, to: pos + node.nodeSize });
      s.end = Math.max(s.end, pos + node.nodeSize);
      out.set(m.attrs.id, s);
    }
  });
  return out;
}

/** The transaction that accepts (or rejects) one suggestion, or null when it is gone. */
export function settle(state, id, accept) {
  const s = suggestionsIn(state.doc).get(id);
  if (!s) return null;
  const { suggestionInsert, suggestionDelete } = state.schema.marks;
  const tr = state.tr;
  const keep = accept ? s.ins : s.del;
  const drop = accept ? s.del : s.ins;
  for (const r of keep) tr.removeMark(r.from, r.to, accept ? suggestionInsert : suggestionDelete);
  for (const r of [...drop].sort((a, b) => b.from - a.from)) tr.delete(r.from, r.to);
  return tr;
}

/**
 * A document (JSON) as it would be with every open suggestion rejected: what is saved while suggestions wait, so an
 * unaccepted suggestion never reaches the item's text.
 */
export function withoutSuggestions(json) {
  const walk = (node) => {
    if (node.type === 'text') {
      const marks = node.marks ?? [];
      if (marks.some((m) => m.type === 'suggestionInsert')) return null;
      const rest = marks.filter((m) => m.type !== 'suggestionDelete');
      const { marks: _, ...plain } = node;
      return rest.length ? { ...plain, marks: rest } : plain;
    }
    if (!node.content) return node;
    const content = node.content.map(walk).filter(Boolean);
    // Adjacent text nodes with the same marks stay separate in JSON; ProseMirror joins them when it reads the document.
    return { ...node, content };
  };
  return walk(json);
}

const KEY = new PluginKey('suggestions');

function controls(s) {
  return (view) => {
    const wrap = document.createElement('span');
    wrap.className = 'sugg-controls';
    wrap.contentEditable = 'false';
    if (style(s.color)) wrap.setAttribute('style', style(s.color));
    const who = document.createElement('span');
    who.className = 'sugg-who';
    who.textContent = s.author ?? 'Suggestion';
    const button = (label, title, accept) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `sugg-btn ${accept ? 'accept' : 'reject'}`;
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', `${title} from ${s.author}`);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const tr = settle(view.state, s.id, accept);
        if (tr) view.dispatch(tr);
      });
      return b;
    };
    wrap.append(who, button('✓', 'Accept the suggestion', true), button('✕', 'Reject the suggestion', false));
    return wrap;
  };
}

/** Each suggestion's Accept and Reject controls, at its end. */
export const Suggestions = Extension.create({
  name: 'suggestions',
  addProseMirrorPlugins() {
    const build = (doc) => DecorationSet.create(doc, [...suggestionsIn(doc).values()].map((s) => Decoration.widget(s.end, controls(s), { side: 1, key: `sugg:${s.id}:${s.author}`, ignoreSelection: true, stopEvent: () => true })));
    return [
      new Plugin({
        key: KEY,
        state: { init: (_, state) => build(state.doc), apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old) },
        props: { decorations: (state) => KEY.getState(state) },
      }),
    ];
  },
  addCommands() {
    return {
      acceptSuggestion: (id) => ({ state, dispatch }) => {
        const tr = settle(state, id, true);
        if (tr && dispatch) dispatch(tr);
        return Boolean(tr);
      },
      rejectSuggestion: (id) => ({ state, dispatch }) => {
        const tr = settle(state, id, false);
        if (tr && dispatch) dispatch(tr);
        return Boolean(tr);
      },
    };
  },
});
