// Answering an open question (#68): a person's reply in its thread is the answer (ANSWER-01). The one place that builds
// the prompt handing it to an agent (ANSWER-02), and what adopting the refinement that applied it records (ANSWER-04).
// The API's routes, the standup and the MCP tools all call this, so the web app shows a person the prompt an agent gets.

import { editableOf, itemKeyOf } from '../shared/issue-shape.js';
import { itemContext, quote, stateWords } from './prompts.mjs';
import { openQuestions } from './engine/lifecycle.mjs';
import { isDismissed, isQuestion, whereOf } from '../shared/annotations.js';

export { isQuestion };
/**
 * Answered, and waiting for an agent to write the answer into the spec (ANSWER-01). Applying it is a fact on the answer,
 * not a state of the thread: it stops the answer going to agents again, and the thread stays where it is (NOTE-05).
 */
export const awaitsApplying = (c) => isQuestion(c) && Boolean(c.answer) && !c.answer.appliedAt && !isDismissed(c);
/** A question still waiting on its answer: not dismissed, and nothing applied yet. */
const unsettled = (c) => isQuestion(c) && !isDismissed(c) && !c.answer?.appliedAt;


/**
 * The state the item would reach once this question is settled: ready when nothing else is open, else what still is.
 * @returns {{ status: string, others: string[] }}
 */
export function wouldBecome(node, comments, question) {
  const others = comments.filter((c) => unsettled(c) && c.id !== question.id && c.itemKey === question.itemKey).map((c) => c.text);
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
  const { markdown } = editableOf(node);
  const next = wouldBecome(node, comments, question);
  const textQuestions = openQuestions(markdown);
  const where = question.anchor?.behaviour ? `behaviour ${question.anchor.behaviour}` : whereOf(question.anchor);
  return [
    `An open question on ${node.title} (${key}) has been answered. Write the answer into the spec. This prompt holds everything you need.`,
    '',
    `The question, in ${where}, asked by ${question.author}:`,
    quote(question.text),
    ...(question.anchor?.quote ? ['It is about these words there:', quote(question.anchor.quote)] : []),
    '',
    `The answer${answeredBy ? `, from ${answeredBy}` : ''}:`,
    quote(answer),
    '',
    ...itemContext(nodes, node),
    '',
    `Its state now: ${stateWords(node.status)}. Once this question is settled, it would be ${stateWords(next.status)}${next.others.length ? `, because these questions are still open: ${next.others.map((q) => `"${q}"`).join('; ')}` : ''}.`,
    ...(textQuestions ? ['Its Open questions section says:', quote(textQuestions), 'Anything there that this answer settles goes too; anything it leaves open stays.'] : []),
    '',
    'What to do:',
    '1. Write the decision where it belongs: in the behaviour it settles, in the Why, or, if it holds for the whole project, as a standing decision (remember(), AGENT-07).',
    '2. Clear the question from Open questions. Write "None" there if nothing else is open.',
    '3. Change whatever else the answer implies: behaviours to add, reword or split, items to split or move, links to other items.',
    `4. Mark the item ready if nothing else is open${next.others.length ? ' (here something is, so leave it needing a decision)' : ''}.`,
    '',
    `How: open a refinement with refine(place: "${key}"), then propose(refinement, item: "${key}", markdown: the whole new text in the strict shape, answers: ["${question.id}"], item_ready: ${next.others.length ? 'false' : 'true'}). Changes to other items go into the same refinement. Then reply(annotation: "${question.id}", item: "${key}", text: what you changed, refinement: its id) in the question's thread. A person adopts the refinement, and that applies the answer. If the answer leaves something you can't decide, say so in your reply, or ask() it on ${key}, instead of guessing.`,
  ].join('\n');
}

/** The prompt an answered question goes out with: the one the person sent, or, if they left it as built, built again now. */
export const promptOf = ({ nodes, comments, question }) => question.answer.prompt ?? answerPrompt({ nodes, comments, question, answer: question.answer.text, answeredBy: question.answer.by });

/**
 * Adopting a refinement applies the answers it carries (ANSWER-04): each answer records the refinement, so it never goes
 * to an agent again, and its thread stays open until someone dismisses it (NOTE-05). An item proposed as ready becomes
 * ready if its text and its other questions have nothing left open. Returns the questions applied and the items to mark ready.
 */
export async function settleAnswers(model, pid, changeset, nodes, at) {
  const applied = [];
  const ready = [];
  for (const item of changeset.items) {
    if (!item.answers?.length && !item.itemReady) continue;
    const thread = await model.comments.list(pid, item.key);
    for (const c of thread.filter((x) => item.answers?.includes(x.id) && x.answer && !x.answer.appliedAt)) {
      const done = { ...c, answer: { ...c.answer, appliedAt: at, appliedBy: changeset.id } };
      await model.comments.put(pid, done);
      applied.push(done);
    }
    const node = nodes.find((n) => itemKeyOf(n) === item.key);
    const stillOpen = thread.some((x) => unsettled(x) && !item.answers?.includes(x.id));
    if (item.itemReady && node && !openQuestions(editableOf(node).markdown) && !stillOpen) ready.push(node);
  }
  return { applied, ready };
}
