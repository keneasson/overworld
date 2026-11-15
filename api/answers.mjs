// Answering an open question (#68): the one place that builds the prompt handing an answer to an agent (ANSWER-02), and
// what adopting the refinement that applied it settles (ANSWER-04). The API's routes, the standup and the MCP tools all
// call this, so the web app shows a person the same prompt an agent gets.

import { STATUS_LABEL } from '../shared/schema.js';
import { editableOf, itemKeyOf } from '../shared/issue-shape.js';
import { openQuestions } from './engine/lifecycle.mjs';

const SIBLINGS_SHOWN = 30;

/** Is this comment an open question: anchored in Open questions and not resolved? */
export const isQuestion = (c) => c.anchor?.section === 'Open questions';
/** Answered, and waiting for an agent to write the answer into the spec (ANSWER-01). */
export const awaitsApplying = (c) => isQuestion(c) && Boolean(c.answer) && !c.resolved;

const quote = (s) => String(s).split('\n').map((l) => `> ${l}`).join('\n');
const stateWords = (status) => (STATUS_LABEL[status] ?? status).toLowerCase();

/**
 * The state the item would reach once this question is cleared: ready when nothing else is open, else what still is.
 * @returns {{ status: string, others: string[] }}
 */
export function wouldBecome(node, comments, question) {
  const others = comments.filter((c) => isQuestion(c) && !c.resolved && c.id !== question.id && c.itemKey === question.itemKey).map((c) => c.text);
  return { status: others.length ? 'needs_decision' : 'ready', others };
}

/**
 * The prompt that applies an answer (ANSWER-02): everything an agent needs, with no chat history.
 * @param {{ nodes: object[], comments: object[], question: object, answer: string, answeredBy?: string }} o
 */
export function answerPrompt({ nodes, comments, question, answer, answeredBy }) {
  const node = nodes.find((n) => itemKeyOf(n) === question.itemKey);
  if (!node) return '';
  const key = itemKeyOf(node);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parent = byId.get(node.parentId);
  const siblings = nodes.filter((n) => n.parentId === node.parentId && n.id !== node.id && n.kind !== 'behavior');
  const { title, markdown } = editableOf(node);
  const next = wouldBecome(node, comments, question);
  const textQuestions = openQuestions(markdown);
  const where = question.anchor?.behaviour ? `behaviour ${question.anchor.behaviour}` : 'Open questions';
  return [
    `An open question on ${node.title} (${key}) has been answered. Write the answer into the spec. This prompt holds everything you need.`,
    '',
    `The question, in ${where}, asked by ${question.author}:`,
    quote(question.text),
    '',
    `The answer${answeredBy ? `, from ${answeredBy}` : ''}:`,
    quote(answer),
    '',
    `The item as it stands: its title is "${title}", and its text, in the strict shape, is:`,
    '',
    '~~~markdown',
    markdown.trim(),
    '~~~',
    '',
    parent ? `Its parent: ${parent.title} (${itemKeyOf(parent)}).` : 'It sits at the top of the map.',
    ...(siblings.length ? ['Its siblings:', ...siblings.slice(0, SIBLINGS_SHOWN).map((s) => `- ${s.title} (${itemKeyOf(s)}), ${stateWords(s.status)}`), ...(siblings.length > SIBLINGS_SHOWN ? [`- and ${siblings.length - SIBLINGS_SHOWN} more`] : [])] : ['It has no siblings.']),
    '',
    `Its state now: ${stateWords(node.status)}. Once this question is cleared, it would be ${stateWords(next.status)}${next.others.length ? `, because these questions are still open: ${next.others.map((q) => `"${q}"`).join('; ')}` : ''}.`,
    ...(textQuestions ? ['Its Open questions section says:', quote(textQuestions), 'Anything there that this answer settles goes too; anything it leaves open stays.'] : []),
    '',
    'What to do:',
    '1. Write the decision where it belongs: in the behaviour it settles, in the Why, or, if it holds for the whole project, as a standing decision (remember(), AGENT-07).',
    '2. Clear the question from Open questions. Write "None" there if nothing else is open.',
    '3. Change whatever else the answer implies: behaviours to add, reword or split, items to split or move, links to other items.',
    `4. Mark the item ready if nothing else is open${next.others.length ? ' (here something is, so leave it needing a decision)' : ''}.`,
    '',
    `How: open a refinement with refine(place: "${key}"), then propose(refinement, item: "${key}", markdown: the whole new text in the strict shape, answers: ["${question.id}"], item_ready: ${next.others.length ? 'false' : 'true'}). Changes to other items go into the same refinement. A person adopts it, and the question resolves then. If the answer leaves something you can't decide, ask() it on ${key} instead of guessing.`,
  ].join('\n');
}

/** The prompt an answered question goes out with: the one the person sent, or, if they left it as built, built again now. */
export const promptOf = ({ nodes, comments, question }) => question.answer.prompt ?? answerPrompt({ nodes, comments, question, answer: question.answer.text, answeredBy: question.answer.by });

/**
 * Adopting a refinement settles the answers it applied (ANSWER-04): their questions resolve, and an item proposed as ready
 * becomes ready if its text and its threads have nothing else open. Returns the resolved questions and the items to mark ready.
 */
export async function settleAnswers(model, pid, changeset, nodes, at) {
  const resolved = [];
  const ready = [];
  for (const item of changeset.items) {
    if (!item.answers?.length && !item.itemReady) continue;
    const thread = await model.comments.list(pid, item.key);
    for (const c of thread.filter((x) => item.answers?.includes(x.id) && !x.resolved)) {
      const done = { ...c, resolved: true, answer: { ...c.answer, appliedAt: at, appliedBy: changeset.id } };
      await model.comments.put(pid, done);
      resolved.push(done);
    }
    const node = nodes.find((n) => itemKeyOf(n) === item.key);
    const stillOpen = thread.some((x) => isQuestion(x) && !x.resolved && !item.answers?.includes(x.id));
    if (item.itemReady && node && !openQuestions(editableOf(node).markdown) && !stillOpen) ready.push(node);
  }
  return { resolved, ready };
}
