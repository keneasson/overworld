// What the Comment control would comment on (#15 NOTE-15), and where an annotation's words are now (NOTE-01).
// A target is a range of the document and the anchor it would be saved with: a word, a phrase, a paragraph,
// a behaviour, a section or an image. Anchors on words keep the words and a little either side, found again
// by the shared `locate`, so an edit around them never moves them.

import { SECTIONS } from '@shared/issue-shape.js';
import { locate, quoteOf } from '@shared/annotations.js';

const ID = /^([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+)\b/;
const HEAD = 'Head'; // what comes before the first section: "Part of", Kind and Place
const OBJECT = '￼'; // an image, in a section's text
const wordy = (ch) => Boolean(ch) && /[\p{L}\p{N}_#'’-]/u.test(ch) && ch !== OBJECT;
export const canonical = (name) => SECTIONS.find((s) => s.toLowerCase() === name.toLowerCase().replace(/^behaviors$/, 'behaviours')) ?? name;

/**
 * Every section's text as the editor holds it, and the document position of each character: blocks are joined by
 * a line break (position -1) and an image is one character. The same text an anchor's quote was taken from.
 * @returns {Map<string, { name: string, text: string, at: number[], heading: number|null, from: number, to: number }>}
 */
export function sectionTexts(doc) {
  const out = new Map();
  let cur = { name: HEAD, text: '', at: [], heading: null, from: 0, to: 0 };
  out.set(HEAD, cur);
  const walk = (block, start) => {
    if (cur.text) (cur.text += '\n'), cur.at.push(-1);
    block.forEach((child, offset) => {
      if (child.isText) for (let i = 0; i < child.text.length; i++) cur.at.push(start + offset + i);
      else cur.at.push(start + offset);
      cur.text += child.isText ? child.text : OBJECT;
    });
  };
  doc.forEach((node, offset) => {
    if (node.type.name === 'heading' && node.attrs.level === 2) {
      cur = { name: canonical(node.textContent.trim()), text: '', at: [], heading: offset, from: offset, to: offset + node.nodeSize };
      out.set(cur.name, cur);
      return;
    }
    cur.to = offset + node.nodeSize;
    if (node.isTextblock) walk(node, offset + 1);
    else
      node.descendants((n, pos) => {
        if (!n.isTextblock) return true;
        walk(n, offset + 1 + pos + 1);
        return false;
      });
  });
  return out;
}

const sectionOf = (texts, pos) => [...texts.values()].reverse().find((s) => s.from <= pos) ?? texts.get(HEAD);

/** The behaviour a position is in: the list item in Behaviours whose text starts with an ID. */
function behaviourAt(doc, pos, section) {
  if (section !== 'Behaviours') return null;
  const $p = doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) {
    if ($p.node(d).type.name !== 'listItem') continue;
    const id = $p.node(d).firstChild?.textContent.match(ID)?.[1];
    return id ? { id, from: $p.before(d), to: $p.after(d) } : null;
  }
  return null;
}

/** The anchor a range of the document is saved with. */
function anchorOf(doc, texts, on, from, to) {
  const s = sectionOf(texts, from);
  const b = behaviourAt(doc, from, s.name);
  const base = { on, section: s.name, ...(b ? { behaviour: b.id } : {}) };
  if (on === 'section') return { on, section: s.name };
  if (on === 'behaviour') return base;
  const start = s.at.findIndex((p) => p >= from);
  let end = start;
  while (end < s.at.length && (s.at[end] === -1 || s.at[end] < to)) end++;
  while (end > start && s.at[end - 1] === -1) end--;
  return { ...base, ...quoteOf(s.text, start, end) };
}

const target = (doc, texts, on, from, to, extra = {}) => ({ on, from, to, anchor: { ...anchorOf(doc, texts, on, from, to), ...extra.anchor }, ...extra, key: `${on}:${from}:${to}` });

/** A whole section: its heading and everything to the next one. */
function sectionTarget(doc, texts, name) {
  const s = texts.get(name);
  return s?.heading == null ? null : target(doc, texts, 'section', s.heading, s.to);
}

/** A block: the behaviour it is, or the paragraph; an empty one stands for its section. */
function blockTarget(doc, texts, pos) {
  const s = sectionOf(texts, pos);
  const b = behaviourAt(doc, pos, s.name);
  if (b) return target(doc, texts, 'behaviour', b.from, b.to);
  const $p = doc.resolve(pos);
  if (!$p.parent.isTextblock || !$p.parent.textContent.trim()) return sectionTarget(doc, texts, s.name);
  return target(doc, texts, 'paragraph', $p.start(), $p.end());
}

/** The word at a position in a text block, as [from, to) in the document. */
function wordAt(doc, pos) {
  const $p = doc.resolve(pos);
  if (!$p.parent.isTextblock) return null;
  const text = $p.parent.textBetween(0, $p.parent.content.size, undefined, OBJECT);
  let a = $p.parentOffset;
  let b = a;
  while (a > 0 && wordy(text[a - 1])) a--;
  while (b < text.length && wordy(text[b])) b++;
  if (a === b) return null;
  return { from: $p.start() + a, to: $p.start() + b };
}

/** What the Comment control would comment on at a point on screen (NOTE-15), or null outside the text. */
export function targetAt(view, x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || !view.dom.contains(el) || el.closest('.note-marker')) return null;
  const { doc } = view.state;
  const texts = sectionTexts(doc);
  const img = el.closest('img');
  if (img) {
    const pos = view.posAtDOM(img, 0);
    const node = doc.nodeAt(pos);
    if (node?.type.name === 'image') return target(doc, texts, 'image', pos, pos + 1, { anchor: { src: node.attrs.src, quote: node.attrs.alt || undefined, prefix: undefined, suffix: undefined } });
  }
  const h2 = el.closest('h2');
  if (h2) return sectionTarget(doc, texts, sectionOf(texts, view.posAtDOM(h2, 0)).name);
  const hit = view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  if (el.closest('.bid')) return blockTarget(doc, texts, hit.pos);
  const w = wordAt(doc, hit.pos);
  if (w) {
    const a = view.coordsAtPos(w.from);
    const b = view.coordsAtPos(w.to, -1);
    const oneLine = Math.abs(a.top - b.top) < 2;
    if (!oneLine || (x >= a.left - 2 && x <= b.right + 2 && y >= a.top - 3 && y <= a.bottom + 3)) return target(doc, texts, 'word', w.from, w.to);
  }
  return blockTarget(doc, texts, hit.pos);
}

/** The words selected in the text, exactly (NOTE-15), kept within one section. Null when nothing is selected. */
export function selectedTarget(view) {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!view.dom.contains(r.commonAncestorContainer)) return null;
  let from;
  let to;
  try {
    from = view.posAtDOM(r.startContainer, r.startOffset);
    to = view.posAtDOM(r.endContainer, r.endOffset);
  } catch {
    return null;
  }
  const { doc } = view.state;
  const texts = sectionTexts(doc);
  const s = sectionOf(texts, from);
  to = Math.min(to, s.to);
  const text = doc.textBetween(from, to, '\n', OBJECT);
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  if (!text.trim()) return null;
  // A drag that stops part way through a word takes the whole word.
  const a = wordAt(doc, from + lead);
  const b = wordAt(doc, to - trail);
  return target(doc, texts, 'phrase', Math.min(from + lead, a?.from ?? Infinity), Math.max(to - trail, b?.to ?? -Infinity));
}

/** The next wider thing around a target: a word's paragraph or behaviour, then its section. Null at a section. */
export function widen(view, t) {
  const { doc } = view.state;
  const texts = sectionTexts(doc);
  if (t.on === 'section') return null;
  if (['word', 'phrase', 'image'].includes(t.on)) {
    const b = blockTarget(doc, texts, t.from);
    if (b && b.key !== t.key) return b;
  }
  return sectionTarget(doc, texts, sectionOf(texts, t.from).name);
}

/**
 * Where an annotation is in the document now: the range to highlight, and where its marker goes. A quote whose
 * words have gone is shown at its section's heading, and says so (`moved`).
 * @returns {{ from: number, to: number, marker: number, inline: boolean, moved?: boolean } | null}
 */
export function rangeOf(doc, anchor, texts = sectionTexts(doc)) {
  const s = texts.get(anchor.section ?? (anchor.behaviour ? 'Behaviours' : 'Why'));
  const atHeading = (moved) => (s?.heading == null ? null : { from: s.heading, to: s.heading + doc.nodeAt(s.heading).nodeSize, marker: s.heading + doc.nodeAt(s.heading).nodeSize - 1, inline: false, moved });
  if (!s) return null;
  if (anchor.on === 'image') {
    let found = null;
    doc.nodesBetween(s.from, s.to, (n, pos) => {
      if (!found && n.type.name === 'image' && n.attrs.src === anchor.src) found = { from: pos, to: pos + 1, marker: pos + 1, inline: true, image: true };
      return !found;
    });
    return found ?? atHeading(true);
  }
  if (anchor.quote) {
    const r = locate(s.text, anchor);
    if (!r) return atHeading(true);
    const from = s.at[r.start];
    let last = r.end - 1;
    while (last > r.start && s.at[last] === -1) last--;
    return { from, to: s.at[last] + 1, marker: s.at[last] + 1, inline: true };
  }
  if (anchor.behaviour) {
    let found = null;
    doc.nodesBetween(s.from, s.to, (n, pos) => {
      if (found) return false;
      if (n.type.name === 'listItem' && n.firstChild?.textContent.match(ID)?.[1] === anchor.behaviour) found = { from: pos, to: pos + n.nodeSize, marker: pos + 1 + n.firstChild.nodeSize - 1, inline: false };
      return !found;
    });
    return found ?? atHeading(true);
  }
  return atHeading(false);
}

/** The rectangles a target covers on screen, relative to `box`: a box per line for words, one box for a block. */
export function rectsOf(view, t, box) {
  const rel = (r) => ({ left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height });
  const { doc } = view.state;
  if (t.on === 'image') {
    const el = view.nodeDOM(t.from);
    return el?.getBoundingClientRect ? [rel(el.getBoundingClientRect())] : [];
  }
  if (['word', 'phrase'].includes(t.on)) {
    const range = document.createRange();
    const a = view.domAtPos(t.from);
    const b = view.domAtPos(t.to);
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return [...range.getClientRects()].filter((r) => r.width > 0).map(rel);
  }
  // A block or a run of blocks: one box around all of them.
  let rect = null;
  doc.nodesBetween(t.from, t.to, (n, pos) => {
    if (pos < t.from) return true;
    const el = view.nodeDOM(pos);
    if (el?.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      rect = rect ? { left: Math.min(rect.left, r.left), top: Math.min(rect.top, r.top), right: Math.max(rect.right, r.right), bottom: Math.max(rect.bottom, r.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    return false;
  });
  if (!rect && t.on === 'paragraph') {
    const el = view.domAtPos(t.from).node;
    const blockEl = el.nodeType === 1 ? el : el.parentElement;
    const r = blockEl.getBoundingClientRect();
    rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  return rect ? [rel({ left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top })] : [];
}

/** A short description of a target for the comment box's heading and quote (NOTE-10). */
export function describe(view, t) {
  const { doc } = view.state;
  const where = t.anchor.behaviour ?? t.anchor.section;
  if (t.on === 'section') return { where, quote: null, what: 'The whole section' };
  if (t.on === 'behaviour') return { where, quote: doc.textBetween(t.from, t.to, ' ').slice(0, 280), what: 'The behaviour' };
  if (t.on === 'image') return { where, quote: t.anchor.quote ?? null, what: 'The image', src: t.anchor.src };
  return { where, quote: t.anchor.quote, what: t.on === 'paragraph' ? 'The paragraph' : null };
}
