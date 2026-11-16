// Annotations addressed to agents (#15): who an annotation is for (NOTE-14), the prompt it reaches an agent with
// (NOTE-18), and what adopting the refinement that acted on it settles (NOTE-19). Handing it over at once (NOTE-17)
// is agents.mjs's `addressed`; the API, the MCP tools and the standup all build the prompt here.

import { itemKeyOf } from '../shared/issue-shape.js';
import { NOTE_KIND_LABEL, isAgentAlias, kindOf, mentionsOf, threadsOf } from '../shared/annotations.js';
import { itemContext, quote } from './prompts.mjs';

/**
 * Who a comment is addressed to: each @mention, read against the project's agents. "@Claude" is any agent; an agent's
 * own name or id is that agent; anyone else is a person.
 * @returns {{ name: string, agent?: true, agentId?: string }[]}
 */
export function addresseesOf(text, agents = []) {
  return mentionsOf(text).map((m) => {
    const a = agents.find((x) => !x.revokedAt && (x.id === m || x.name.split(/\s+/)[0].toLowerCase() === m.toLowerCase()));
    if (a) return { name: `${a.name} (${a.id})`, agent: true, agentId: a.id };
    return isAgentAlias(m) ? { name: m, agent: true } : { name: m };
  });
}

const KIND_ASKS = {
  question: 'It is a Question. Answer it in the thread. If the answer changes the spec, write that in through a refinement as well.',
  problem: 'It is a Problem: a bug or a confusing spot right there. Fix it in the spec or the map. If it needs code, propose a child task for it in the strict shape.',
  change: 'It is a Change: make exactly that change.',
  refactor: 'It is a Refactor: a code task with its target. Write it into the spec as the work it is (a behaviour, or a child task in the strict shape), ready to build.',
  comment: 'It is a Comment. Reply in the thread, and change something only if it asks you to.',
};

function anchorWords(a = {}) {
  switch (a.on) {
    case 'place':
      return ['on its place on the map'];
    case 'section':
      return [`on the whole ${a.section} section`];
    case 'behaviour':
      return [`on behaviour ${a.behaviour}`];
    case 'image':
      return [`on an image in ${a.section} (${a.src}${a.quote ? `, "${a.quote}"` : ''})`];
    default:
      return a.quote ? [`on these words in ${a.behaviour ? `behaviour ${a.behaviour}` : a.section}:`, quote(a.quote)] : [`on ${a.behaviour ?? a.section}`];
  }
}

/**
 * The prompt an annotation reaches an agent with (NOTE-18): everything needed to act on it, with no chat history.
 * @param {{ nodes: object[], comments: object[], note: object }} o  `note` is the thread's first annotation
 */
export function notePrompt({ nodes, comments, note }) {
  const node = nodes.find((n) => itemKeyOf(n) === note.itemKey);
  if (!node) return '';
  const key = itemKeyOf(node);
  const kind = kindOf(note);
  const thread = threadsOf(comments.filter((c) => c.itemKey === note.itemKey)).find((t) => t.root.id === note.id);
  const replies = thread?.replies ?? [];
  const [where, ...quoted] = anchorWords(note.anchor);
  return [
    `${note.author} addressed you in an annotation on ${node.title} (${key}). Act on it now. This prompt holds everything you need.`,
    '',
    `The annotation, a ${NOTE_KIND_LABEL[kind]}, ${where}`,
    ...quoted,
    'It says:',
    quote(note.text),
    ...(note.value ? [`Its value, to apply exactly as it is: \`${note.value}\``] : []),
    ...(replies.length ? ['', 'The rest of its thread, oldest first:', ...replies.map((r) => `- ${r.author}: ${r.text.replace(/\n/g, ' ')}`)] : []),
    '',
    ...itemContext(nodes, node),
    '',
    'What to do:',
    KIND_ASKS[kind],
    '',
    `How: change the item, the spec or the map through a refinement, so everyone sees it at once. Open one with refine(place: "${key}"), then propose(refinement, item: "${key}", markdown: the whole new text in the strict shape, annotations: ["${note.id}"]); changes to other items go into the same refinement. The annotation is applied when a person adopts it. Then reply(annotation: "${note.id}", item: "${key}", text: what you changed, refinement: its id) in the thread. If nothing needs changing, just reply. If something can't be decided from here, say so in your reply rather than guessing.`,
  ].join('\n');
}

/** Adopting a refinement applies the annotations it acted on (NOTE-19, NOTE-05): each says which refinement did it. */
export async function settleNotes(model, pid, changeset, at, keys = changeset.items.map((it) => it.key)) {
  const applied = [];
  for (const item of changeset.items.filter((it) => keys.includes(it.key) && it.annotations?.length)) {
    for (const id of item.annotations) {
      const c = await model.comments.get(pid, { itemKey: item.key, id });
      if (!c || c.resolved) continue;
      const done = { ...c, resolved: true, outcome: { state: 'applied', by: changeset.author, at, refinement: changeset.id } };
      await model.comments.put(pid, done);
      await model.inbox.delete(pid, id);
      applied.push(done);
    }
  }
  return applied;
}
