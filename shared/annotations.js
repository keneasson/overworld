// Comments (#15), anchored where they apply. A comment is just a comment: no kinds. The one place that says what a comment
// can be anchored to, how an anchor on some words finds those words again after the text around them is edited
// (NOTE-01), who has read a thread (NOTE-03) and which threads are dismissed (NOTE-05). The API, the MCP server and the
// editor all read comments through this.

import { ValidationError } from './schema.js';

// What an annotation can be about (NOTE-15). Words, a phrase and a paragraph quote their text; the rest name it.
export const ANCHOR_ON = ['word', 'phrase', 'paragraph', 'behaviour', 'section', 'image', 'place'];
const QUOTED = new Set(['word', 'phrase', 'paragraph']);
const CONTEXT = 32; // characters kept on each side of a quote, to tell repeated words apart

/** What an anchor is on. Comments from before annotations (#5) name only a section or a behaviour. */
export const onOf = (a = {}) => (ANCHOR_ON.includes(a.on) ? a.on : a.behaviour ? 'behaviour' : 'section');

/**
 * Is this thread a question, for answering it (#68)? One on the item's Open questions section is: that is where an
 * agent's ask() puts it, and where a person asks one. A stored `kind` from before is kept but means nothing.
 */
export const isQuestion = (c) => !c.replyTo && c.anchor?.section === 'Open questions';

/** Is this thread dismissed into the conversation log (NOTE-05)? Comments cleared before dismissing existed count as dismissed. */
export const isDismissed = (c) => Boolean(c?.dismissed || c?.resolved);

/** A comment as everyone reads it: its anchor says what it is on, and an old clearing reads as a dismissal. */
export function annotationOf(c) {
  const out = { ...c, anchor: { ...c.anchor, on: onOf(c.anchor) } };
  if (!c.dismissed && c.resolved) out.dismissed = { by: c.cleared?.by ?? 'Someone', at: c.cleared?.at ?? c.createdAt, ...(c.cleared?.task ? { task: c.cleared.task } : {}) };
  return out;
}

/** Where an anchor sits, in words: "Why", "NOTE-01", "an image in Why", "the place on the map". */
export function whereOf(a = {}) {
  const on = onOf(a);
  if (a.refinement) return `${a.behaviour ?? 'a change'} in a refinement`;
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
  // On a behaviour as a refinement proposes it (#13 ADOPT-14), not the adopted text: the thread stays with that behaviour
  // through every revision of the refinement.
  const refinement = str(a.refinement, 40, 'anchor.refinement');
  const out = { on, section: str(a.section, 60, 'anchor.section') ?? (behaviour ? 'Behaviours' : 'Why'), ...(behaviour ? { behaviour } : {}), ...(refinement ? { refinement } : {}) };
  if (refinement && !behaviour) throw new ValidationError('anchor.behaviour: required on a refinement');
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

/** Is this thread open: a comment, not a reply, and not dismissed (NOTE-05)? Nothing else ever closes one. */
export const isOpen = (c) => !c.replyTo && !isDismissed(c);

/**
 * Is a reply from `by` the answer to this thread's question (ANSWER-01)? A person's reply to an open question is, when
 * someone else asked it (an agent, through ask()) or it is addressed to an agent; the asker talking in their own thread is
 * not. Once its answer is applied, replies are just replies.
 */
export const answers = (root, by) => isQuestion(root) && isOpen(root) && !root.answer?.appliedAt && (root.author !== by || toAgent(root));

/**
 * Who has read a thread since its last word (NOTE-03): its author, then whoever opened it. A reply makes it unread again
 * for everyone but whoever wrote the reply. Reading never moves a comment anywhere.
 */
export const readersOf = (root) => root.readBy ?? [root.author];
export const isUnread = (root, by) => Boolean(String(by ?? '').trim()) && !readersOf(root).includes(by);

/**
 * What the map badges (NOTE-04): each item's comments that are not dismissed, and who has read every one of them, so a
 * viewer's badge is marked when any are unread for them.
 * @returns {Record<string, { count: number, read: string[] }>}
 */
export function notesByItem(comments) {
  const out = {};
  for (const c of comments) {
    if (!isOpen(c)) continue;
    const it = out[c.itemKey];
    if (!it) out[c.itemKey] = { count: 1, read: [...readersOf(c)] };
    else (it.count += 1), (it.read = it.read.filter((n) => readersOf(c).includes(n)));
  }
  return out;
}

/** Who a comment mentions (NOTE-14): each @name once, in order. */
export const mentionsOf = (text = '') => [...new Set([...String(text).matchAll(/(?:^|[^\w@])@([A-Za-z][\w.-]*)/g)].map((m) => m[1].replace(/[.-]+$/, '')))];
/** "@Claude" (or "@agent") is any agent, whichever comes first. */
export const isAgentAlias = (name) => /^(claude|agents?)$/i.test(name);
/** Is an annotation addressed to an agent? */
export const toAgent = (c) => (c?.to ?? []).some((t) => t.agent);

/**
 * The threads on a refinement's behaviours (#13 ADOPT-14), by behaviour ID, and which of them wait for its author: a
 * thread is unanswered while it is open and its last word isn't the author's. A person's question to an agent's
 * refinement waits for the agent; an agent's question on a person's, for the person.
 * @returns {Map<string, { threads: { root: object, replies: object[] }[], unanswered: number }>}
 */
export function refinementThreads(comments, refinement) {
  const out = new Map();
  for (const t of threadsOf(comments.filter((c) => c.anchor?.refinement === refinement.id))) {
    const id = t.root.anchor.behaviour;
    if (!out.has(id)) out.set(id, { threads: [], unanswered: 0 });
    const at = out.get(id);
    at.threads.push(t);
    if (!isDismissed(t.root) && (t.replies.at(-1) ?? t.root).author !== refinement.author) at.unanswered += 1;
  }
  return out;
}
