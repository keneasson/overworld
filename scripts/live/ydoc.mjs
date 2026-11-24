// Reading and writing a live item document (prototype) straight through Yjs, for collaborators that have no editor of
// their own: the collaboration server, the agent client and the store simulation. The shape is ProseMirror's as Yjs
// keeps it: elements named after nodes, and each paragraph's words in one Y.XmlText whose formatting attributes are marks.

import * as Y from 'yjs';

export const FIELD = 'default';

/** A Y.XmlText's words, without its formatting. */
export const textOf = (t) =>
  t
    .toDelta()
    .map((d) => (typeof d.insert === 'string' ? d.insert : ''))
    .join('');

/** Every paragraph in the document, in order, with its words' Y.XmlText and the section ("## " heading) it is in. */
export function paragraphs(doc) {
  const out = [];
  let section = null;
  const walk = (el, top) => {
    for (const child of el.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (top && child.nodeName === 'heading') {
        const t = child.toArray().find((c) => c instanceof Y.XmlText);
        if (Number(child.getAttribute('level')) === 2) section = t ? textOf(t).trim() : null;
        continue;
      }
      if (child.nodeName === 'paragraph') {
        const text = child.toArray().find((c) => c instanceof Y.XmlText);
        if (text) out.push({ el: child, text, section, words: textOf(text) });
      } else walk(child, false);
    }
  };
  walk(doc.getXmlFragment(FIELD), true);
  return out;
}

/** The paragraph a behaviour is written in: the one in Behaviours that starts with its ID. */
export const behaviourParagraph = (doc, id) => paragraphs(doc).find((p) => /^behaviou?rs$/i.test(p.section ?? '') && (p.words === id || p.words.startsWith(`${id} `)));

/** The first paragraph of a section. */
export const sectionParagraph = (doc, name) => paragraphs(doc).find((p) => (p.section ?? '').toLowerCase() === name.toLowerCase());

/** A position in a paragraph's words, as an awareness cursor holds it, so other editors draw the caret there. */
export const cursorAt = (text, index) => {
  const rel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index));
  return { anchor: rel, head: rel };
};

/** Replace each `from` with its `to` where a paragraph starts with it (a behaviour's placeholder ID taking its number). */
export function swapStarts(doc, swaps, origin) {
  if (!swaps.length) return 0;
  let n = 0;
  doc.transact(() => {
    for (const { from, to } of swaps) {
      const p = paragraphs(doc).find((x) => x.words === from || x.words.startsWith(`${from} `));
      if (!p) continue;
      const attrs = p.text.toDelta()[0]?.attributes ?? {};
      p.text.delete(0, from.length);
      p.text.insert(0, to, attrs);
      n++;
    }
  }, origin);
  return n;
}

/** A word-sized piece at a time: how a stream of text arrives when nothing streams it (the scripted collaborators). */
export const pieces = (s) => s.match(/\S+\s*|\s+/g) ?? [];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
