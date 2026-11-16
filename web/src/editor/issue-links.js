// "#12" in the editor stands out as a link (#41 EDIT-14). A click in the text still edits there; with the caret on
// a link, a chip offers to follow it, and ⌘/Ctrl-click follows at once, the way Google Docs treats links.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { issueRefs } from '../model/links.js';

const key = new PluginKey('issueLinks');

const decorate = (doc) => {
  const marks = [];
  doc.descendants((node, pos) => {
    if (!node.isText || node.marks.some((m) => m.type.name === 'link' || m.type.name === 'code')) return;
    for (const r of issueRefs(node.text)) marks.push(Decoration.inline(pos + r.from, pos + r.to, { class: 'issue-ref', 'data-issue': String(r.number) }));
  });
  return DecorationSet.create(doc, marks);
};

/** The link at a position: "#12" or a link's href, with where it starts. Null when there is none. */
export function linkAt(state, pos) {
  const $pos = state.doc.resolve(pos);
  const link = $pos.marks().find((m) => m.type.name === 'link') ?? $pos.nodeAfter?.marks.find((m) => m.type.name === 'link');
  if (link) return { ref: link.attrs.href, at: pos };
  if (!$pos.parent.isTextblock) return null;
  const start = $pos.start();
  const offset = pos - start;
  let text = '';
  $pos.parent.forEach((n) => (text += n.isText && !n.marks.some((m) => m.type.name === 'code') ? n.text : '￼'.repeat(n.nodeSize)));
  const hit = issueRefs(text).find((r) => offset >= r.from && offset <= r.to);
  return hit ? { ref: `#${hit.number}`, at: start + hit.from } : null;
}

/** `onFollow(ref)` follows a link; it is asked on ⌘/Ctrl-click. */
export const IssueLinks = Extension.create({
  name: 'issueLinks',
  addOptions: () => ({ onFollow: () => {} }),
  addProseMirrorPlugins() {
    const { options } = this;
    return [
      new Plugin({
        key,
        state: { init: (_, { doc }) => decorate(doc), apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old) },
        props: {
          decorations: (state) => key.getState(state),
          handleClick: (view, pos, event) => {
            if (!(event.metaKey || event.ctrlKey)) return false;
            const link = linkAt(view.state, pos);
            if (!link) return false;
            options.onFollow(link.ref);
            return true;
          },
        },
      }),
    ];
  },
});
