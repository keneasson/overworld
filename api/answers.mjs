// Answering an open question (#68). A question is a line in its item's Open questions section, and its answer is written
// directly under it as "Answer: …" (ANSWER-01, shared/questions.js); a comment never is one (NOTE-22). Who asked and
// answered, and when, are kept beside the text (model.questions). This is the one place that builds the prompt handing
// an answer to an agent (ANSWER-02), and that says what adopting the refinement that applied it records (ANSWER-04).
// The API's routes, the standup and the MCP tools all call this, so the web app shows a person the prompt an agent gets.

import { editableOf, itemKeyOf } from '../shared/issue-shape.js';
import { questionsIn } from '../shared/questions.js';
import { itemContext, quote, stateWords } from './prompts.mjs';
import { openQuestions } from './engine/lifecycle.mjs';
import { isFinished } from './work.mjs';

/**
 * An item's open questions, from its text, each with what Overworld knows of it: who asked it (`asked`), who answered it
 * (`answered`, only while the answer in the text is the one they wrote), the prompt they sent, and whether this answer
 * was applied. An answer typed by hand counts the same; it just has no `answered`.
 */
export function questionsOfNode(node, metas = []) {
  const key = itemKeyOf(node);
  return questionsIn(key, editableOf(node).markdown).map(({ id, text, answer }) => {
    const m = metas.find((x) => x.id === id) ?? {};
    return {
      id, itemKey: key, text, answer,
      ...(m.asked ? { asked: m.asked } : {}),
      ...(m.answered && answer && m.answered.text === answer ? { answered: m.answered } : {}),
      ...(m.handedAt ? { handedAt: m.handedAt } : {}),
      ...(m.refinement ? { refinement: m.refinement } : {}),
      ...(m.applied && m.applied.answer === answer ? { applied: m.applied } : {}),
    };
  });
}

/** Every open question on the map (or on one item), read from the items' text with what is kept beside it. */
export async function questionsOnMap(model, pid, nodes, itemKey = '') {
  const metas = await model.questions.list(pid, itemKey);
  const by = new Map();
  for (const m of metas) by.set(m.itemKey, [...(by.get(m.itemKey) ?? []), m]);
  return nodes.filter((n) => !itemKey || itemKeyOf(n) === itemKey).flatMap((n) => questionsOfNode(n, by.get(itemKeyOf(n))));
}

/** Answered, and waiting for an agent to write the answer into the spec (ANSWER-02); a finished item waits for nothing. */
export const awaitsApplying = (q, node) => Boolean(q.answer) && !q.applied && !(node && isFinished(node));

/**
 * The prompt that applies an answer (ANSWER-02): everything an agent needs, with no chat history.
 * @param {{ nodes: object[], question: { id: string, itemKey: string, text: string, asked?: object }, answer: string, answeredBy?: string }} o
 */
export function answerPrompt({ nodes, question, answer, answeredBy }) {
  const node = nodes.find((n) => itemKeyOf(n) === question.itemKey);
  if (!node) return '';
  const key = itemKeyOf(node);
  const others = questionsIn(key, editableOf(node).markdown).filter((q) => q.id !== question.id).map((q) => q.text);
  const next = others.length ? 'needs_decision' : 'ready for adoption, unless the answer opens something new';
  return [
    `An open question on ${node.title} (${key}) has been answered. Write the answer into the spec. This prompt holds everything you need.`,
    '',
    `The question, in its Open questions section${question.asked?.by ? `, asked by ${question.asked.by}` : ''}:`,
    quote(question.text),
    '',
    `The answer${answeredBy ? `, from ${answeredBy}` : ''}, written under it there:`,
    quote(answer),
    '',
    ...itemContext(nodes, node),
    '',
    `Its state now: ${stateWords(node.status)}. Once this question is settled, it would be ${others.length ? stateWords('needs_decision') : next}${others.length ? `, because these questions are still open: ${others.map((q) => `"${q}"`).join('; ')}` : ''}.`,
    '',
    'What to do:',
    '1. Write the decision where it belongs: in the behaviour it settles, in the Why, or, if it holds for the whole project, as a standing decision (remember(), AGENT-07).',
    '2. Take the question and its answer out of Open questions. Write "None." there if nothing else is open. Leave any other question, and its answer, where it is.',
    '3. Change whatever else the answer implies: behaviours to add, reword or split, items to split or move, links to other items.',
    '4. Then evaluate the whole item again, as it would read once adopted. Either it still needs refining, or it is ready for adoption:',
    `   - Still needs refining if anything is unclear: ${others.length ? 'the questions still open, ' : ''}anything the answer opens up, a behaviour that is vague or reads "Not worked out yet", or work too big for one go. ask() each new question on ${key}, so it is a line in Open questions, and leave the item needing a decision.`,
    '   - Ready for adoption if nothing is: every behaviour clear and testable, and nothing open. Then mark it so.',
    '',
    `How: open a refinement with refine(place: "${key}"), then propose(refinement, item: "${key}", markdown: the whole new text in the strict shape, answers: ["${question.id}"]), adding item_ready: true and ready_for_adoption: [every behaviour ID in it] when it is ready for adoption. Changes to other items go into the same refinement. A person adopts the refinement, and that applies the answer. Never guess at what the answer leaves open: ask() it.`,
  ].join('\n');
}

/** The prompt an answered question goes out with: the one the person sent, or, if they left it as built, built again now. */
export const promptOf = ({ nodes, question }) => question.answered?.prompt ?? answerPrompt({ nodes, question, answer: question.answer, answeredBy: question.answered?.by });

/**
 * Adopting a refinement applies the answers it carries (ANSWER-04): each question records that its answer was applied,
 * by which refinement, so it never goes to an agent again. An item proposed as ready becomes ready if its text has nothing
 * left open. `before` is the map as it was; `after`, the items adopted. Returns the questions applied and the items to mark ready.
 */
export async function settleAnswers(model, pid, changeset, before, after, at) {
  const applied = [];
  const ready = [];
  for (const item of changeset.items) {
    if (!item.answers?.length && !item.itemReady) continue;
    const was = before.find((n) => itemKeyOf(n) === item.key);
    const asked = was ? questionsIn(item.key, editableOf(was).markdown) : [];
    for (const id of item.answers ?? []) {
      const meta = (await model.questions.get(pid, { itemKey: item.key, id })) ?? { itemKey: item.key, id, text: asked.find((q) => q.id === id)?.text ?? '' };
      const answer = asked.find((q) => q.id === id)?.answer ?? meta.answered?.text ?? '';
      await model.questions.put(pid, { ...meta, applied: { at, by: changeset.id, answer } });
      applied.push(id);
    }
    const node = after.find((n) => itemKeyOf(n) === item.key);
    if (item.itemReady && node && !openQuestions(editableOf(node).markdown)) ready.push(node);
  }
  return { applied, ready };
}
