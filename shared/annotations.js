// Annotations (#15): comments with an intent, anchored where they apply. The one place that says what kinds there are,
// what an annotation can be anchored to, and how an anchor on some words finds those words again after the text
// around them is edited (NOTE-01). The API, the MCP server and the editor all read annotations through this.

import { ValidationError } from './schema.js';

export const NOTE_KINDS = ['question', 'problem', 'change', 'refactor', 'comment'];
export const NOTE_KIND_LABEL = { question: 'Question', problem: 'Problem', change: 'Change', refactor: 'Refactor', comment: 'Comment' };
export const NOTE_KIND_HINT = {
  question: 'Needs an answer. Shows as a question until it has one.',
  problem: 'A bug or a confusing spot. Can become a task.',
  change: 'A concrete instruction, with its value.',
  refactor: 'A code task, with its target.',
  comment: 'Just saying. Nothing expected.',
};

// What an annotation can be about (NOTE-15). Words, a phrase and a paragraph quote their text; the rest name it.
export const ANCHOR_ON = ['word', 'phrase', 'paragraph', 'behaviour', 'section', 'image', 'place'];
const QUOTED = new Set(['word', 'phrase', 'paragraph']);
const CONTEXT = 32; // characters kept on each side of a quote, to tell repeated words apart

/** What an anchor is on. Comments from before annotations (#5) name only a section or a behaviour. */
export const onOf = (a = {}) => (ANCHOR_ON.includes(a.on) ? a.on : a.behaviour ? 'behaviour' : 'section');

/** An annotation's kind. Comments from before annotations are Comments (NOTE-09), except questions asked in Open questions. */
export const kindOf = (c) => (NOTE_KINDS.includes(c?.kind) ? c.kind : c?.anchor?.section === 'Open questions' && !c?.replyTo ? 'question' : 'comment');

/** Is this an open question's thread: a Question, not a reply in someone's thread? */
export const isQuestion = (c) => !c.replyTo && kindOf(c) === 'question';

/** An annotation as everyone reads it: old comments carry their kind like new ones (NOTE-09). */
export const annotationOf = (c) => ({ ...c, kind: kindOf(c), anchor: { ...c.anchor, on: onOf(c.anchor) } });

/** Where an anchor sits, in words: "Why", "NOTE-01", "an image in Why", "the place on the map". */
export function whereOf(a = {}) {
  const on = onOf(a);
  if (on === 'place') return 'the place on the map';
  if (on === 'image') return `an image in ${a.section ?? 'the text'}`;
  return a.behaviour ?? a.section ?? 'the text';
}

/** Initials for a marker (NOTE-13): "Ken Easson" is KE, an agent "Claude Code (a58a2)" is CC. */
export function initials(name = '') {
  const words = String(name).replace(/\s*\([^)]*\)\s*$/, '').trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}

/** An anchor on text[start, end): the words, and a little of what is either side (NOTE-01). */
export const quoteOf = (text, start, end) => ({ quote: text.slice(start, end), prefix: text.slice(Math.max(0, start - CONTEXT), start), suffix: text.slice(end, end + CONTEXT) });

const commonEnd = (a, b) => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};
const commonStart = (a, b) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};
const wordy = (ch) => Boolean(ch) && /[\p{L}\p{N}_]/u.test(ch);

/**
 * Where an anchor's words are in the text now (NOTE-01): every place the quote occurs, scored by how much of the text
 * either side still matches, and by whether it stands as whole words. Null when the words themselves are gone.
 * @returns {{ start: number, end: number } | null}
 */
export function locate(text, a) {
  const quote = a?.quote;
  if (!quote || !text) return null;
  let best = null;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    const end = at + quote.length;
    const whole = (wordy(quote[0]) ? !wordy(text[at - 1]) : 1) && (wordy(quote.at(-1)) ? !wordy(text[end]) : 1);
    const score = commonEnd(text.slice(Math.max(0, at - CONTEXT), at), a.prefix ?? '') + commonStart(text.slice(end, end + CONTEXT), a.suffix ?? '') + (whole ? 0.5 : 0);
    if (!best || score > best.score) best = { start: at, end, score };
  }
  return best && { start: best.start, end: best.end };
}

const str = (v, max, what) => {
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string') throw new ValidationError(`${what}: expected text`);
  if (v.length > max) throw new ValidationError(`${what}: at most ${max} characters`);
  return v;
};

/** An anchor as the API keeps it: what it is on, and only what that needs. */
export function cleanAnchor(a = {}) {
  const on = onOf(a);
  if (on === 'place') return { on };
  const behaviour = str(a.behaviour, 40, 'anchor.behaviour');
  const out = { on, section: str(a.section, 60, 'anchor.section') ?? (behaviour ? 'Behaviours' : 'Why'), ...(behaviour ? { behaviour } : {}) };
  if (on === 'behaviour' && !behaviour) throw new ValidationError('anchor.behaviour: required');
  if (on === 'image') {
    out.src = str(a.src, 2000, 'anchor.src');
    if (!out.src) throw new ValidationError('anchor.src: required');
    const alt = str(a.quote, 300, 'anchor.quote');
    if (alt) out.quote = alt;
  }
  if (QUOTED.has(on)) {
    out.quote = str(a.quote, 2000, 'anchor.quote');
    if (!out.quote?.trim()) throw new ValidationError('anchor.quote: required');
    out.prefix = str(a.prefix, CONTEXT * 2, 'anchor.prefix') ?? '';
    out.suffix = str(a.suffix, CONTEXT * 2, 'anchor.suffix') ?? '';
  }
  return out;
}

/**
 * Each annotation is its own thread, at its own words (NOTE-11): the annotation, then the replies to it, in order.
 * A reply whose annotation has gone stands on its own, so nothing is lost.
 * @returns {{ root: object, replies: object[] }[]}
 */
export function threadsOf(comments) {
  const ids = new Set(comments.map((c) => c.id));
  const threads = new Map();
  for (const c of comments) if (!c.replyTo || !ids.has(c.replyTo)) threads.set(c.id, { root: c, replies: [] });
  for (const c of comments) if (c.replyTo && threads.has(c.replyTo)) threads.get(c.replyTo).replies.push(c);
  return [...threads.values()];
}

/** Who a comment mentions (NOTE-14): each @name once, in order. */
export const mentionsOf = (text = '') => [...new Set([...String(text).matchAll(/(?:^|[^\w@])@([A-Za-z][\w.-]*)/g)].map((m) => m[1].replace(/[.-]+$/, '')))];
/** "@Claude" (or "@agent") is any agent, whichever comes first. */
export const isAgentAlias = (name) => /^(claude|agents?)$/i.test(name);
/** Is an annotation addressed to an agent? */
export const toAgent = (c) => (c?.to ?? []).some((t) => t.agent);

/** A Change's value, read for showing it: a colour gets a swatch. */
export const isColour = (v) => /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(v ?? '').trim());
