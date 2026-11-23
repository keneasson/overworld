// Open questions (#68): each is a line in the item's "## Open questions" section, and its answer is written directly under
// it as "Answer: …" (ANSWER-01), by the Answer control or by hand: both read the same. Who asked and answered, and when, are
// kept beside the text by Overworld, never in it; they find their question by its id, from the item and the question's words.
// A comment is never an open question, wherever it is anchored (NOTE-22). The API, the MCP server and the panel read questions
// through this.

import { contentOf, parseIssue, sectionText, writeIssue } from './issue-shape.js';

export const SECTION = 'Open questions';
const NONE = /^(none|n\/a|no open questions)\b/i;
const ITEM = /^( {0,1})(?:[-*+]|\d+[.)])\s+(.*)$/; // a question: a list item at the top level
const ANSWER = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?answer:\s*(.*)$/i; // its answer, as a line or a list item of its own

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * The questions in an item's markdown, in order: each with its words and its answer ('' while unanswered). A list item is a
 * question, with whatever is written under it (a follow-up, a nested list) until its answer; prose with no list is one.
 * "None." is none.
 * @returns {{ text: string, answer: string, lines: [number, number] }[]} `lines`: where it is in the section's content
 */
export function questionsOf(markdown = '') {
  const content = contentOf(sectionOf(markdown));
  if (!content || NONE.test(content)) return [];
  const out = [];
  let cur = null;
  let inAnswer = false;
  content.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    const answer = line.match(ANSWER);
    const item = !answer && line.match(ITEM);
    if (answer && cur) {
      cur.answer = cur.answer ? `${cur.answer}\n${answer[1]}` : answer[1];
      inAnswer = true;
    } else if (item || (!cur && line.trim())) {
      cur = { text: item ? item[2] : line.trim(), answer: '', lines: [i, i + 1] };
      out.push(cur);
      inAnswer = false;
      return;
    } else if (!line.trim() || !cur) return;
    else if (inAnswer) cur.answer += `\n${line.trim()}`;
    else cur.text += `\n${line.trim()}`;
    cur.lines[1] = i + 1;
  });
  return out.map((q) => ({ ...q, text: q.text.trim(), answer: q.answer.trim() }));
}

const sectionOf = (markdown) => parseIssue(markdown).sections.find((s) => s.name === SECTION)?.raw ?? '';

// A short, stable hash (cyrb53): the same in Node and the browser, with nothing to import.
function hash(s) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A question's id (ANSWER-04): from its item and its words, so the same question always has the same one. */
export const questionId = (itemKey, text) => `q${hash(`${itemKey}\n${oneLine(text).toLowerCase()}`)}`;

/** An item's questions, each with its id. */
export const questionsIn = (itemKey, markdown) => questionsOf(markdown).map((q) => ({ ...q, id: questionId(itemKey, q.text) }));

/** The markdown with a question added to Open questions, in place of "None." (ANSWER-07). */
export function withQuestion(markdown, question) {
  const shape = parseIssue(markdown);
  const content = sectionText(shape, SECTION);
  const line = `- ${oneLine(question)}`;
  return writeIssue(shape, { [SECTION]: !content || NONE.test(content) ? line : `${content}\n${line}` });
}

/**
 * The markdown with an answer written directly under its question, as "Answer: …" (ANSWER-01), in place of any answer it
 * had. It is one line, the way the editor keeps it under a list item. Null if the question isn't there.
 */
export function withAnswer(markdown, itemKey, id, answer) {
  const shape = parseIssue(markdown);
  const content = sectionText(shape, SECTION);
  const q = questionsIn(itemKey, markdown).find((x) => x.id === id);
  if (!q) return null;
  const lines = content.split('\n');
  // The question's own lines stay; an answer it had goes, with every line written under that answer.
  const firstAnswer = lines.slice(q.lines[0] + 1, q.lines[1]).findIndex((l) => ANSWER.test(l));
  const kept = lines.slice(q.lines[0], firstAnswer < 0 ? q.lines[1] : q.lines[0] + 1 + firstAnswer);
  lines.splice(q.lines[0], q.lines[1] - q.lines[0], ...kept, `Answer: ${oneLine(answer)}`);
  return writeIssue(shape, { [SECTION]: lines.join('\n') });
}
