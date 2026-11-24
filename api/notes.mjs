// Comments addressed to agents (#15): who a comment is for (NOTE-14) and the prompt it reaches an agent with (NOTE-18).
// Handing it over at once (NOTE-17) is agents.mjs's `addressed`; the API, the MCP tools and the standup all build the
// prompt here. Adopting the refinement that acted on a comment changes nothing about the comment (NOTE-19).

import { OTHER_CHANGES, compareItems, editableOf, itemKeyOf } from '../shared/issue-shape.js';
import { isAgentAlias, isOpen, mentionsOf, threadsOf, whereOf } from '../shared/annotations.js';
import { anchorWords, itemContext, quote } from './prompts.mjs';

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

/**
 * The prompt an annotation reaches an agent with (NOTE-18): everything needed to act on it, with no chat history.
 * @param {{ nodes: object[], comments: object[], note: object, refinement?: object, photo?: object }} o  `note` is the thread's first
 *   annotation; `refinement` is the changeset it is on, when it is on a behaviour in one (#13 ADOPT-14); `photo` is the
 *   screenshot it is pinned on, when it is a pin (#16 SHOT-03)
 */
export function notePrompt({ nodes, comments, note, refinement = null, photo = null }) {
  const node = nodes.find((n) => itemKeyOf(n) === note.itemKey);
  if (!node) return '';
  const key = itemKeyOf(node);
  const threads = threadsOf(comments.filter((c) => c.itemKey === note.itemKey));
  const replies = threads.find((t) => t.root.id === note.id)?.replies ?? [];
  const others = threads.filter((t) => t.root.id !== note.id && isOpen(t.root));
  const [where, ...quoted] = anchorWords(note.anchor, photo);
  return [
    `${note.author} addressed you in a comment on ${node.title} (${key}). Act on it now. This prompt holds everything you need.`,
    '',
    `The comment, ${where}`,
    ...quoted,
    'It says:',
    quote(note.text),
    ...(replies.length ? ['', 'The rest of its thread, oldest first:', ...replies.map((r) => `- ${r.author}: ${r.text.replace(/\n/g, ' ')}`)] : []),
    ...(others.length ? ['', 'The other open comments on this item, for context:', ...others.slice(-10).map(({ root, replies: rs }) => `- ${root.author}, on ${whereOf(root.anchor)}${root.anchor?.quote ? ` ("${root.anchor.quote.slice(0, 120)}")` : ''}: ${root.text.replace(/\n/g, ' ')}${rs.length ? ` (${rs.length} repl${rs.length === 1 ? 'y' : 'ies'}, last from ${rs.at(-1).author})` : ''}`)] : []),
    ...(refinement ? proposedWords(refinement, node, note.anchor.behaviour) : []),
    '',
    ...itemContext(nodes, node),
    '',
    ...(note.report ? reportHow(note, node) : refinement ? refinementHow(note, key) : ['What to do:',
    'Reply in the thread. If it asks for a change, or points at something wrong, make the change; if it needs code, propose a child task for it in the strict shape.',
    '',
    `How: change the item, the spec or the map through a refinement, so everyone sees it at once. Open one with refine(place: "${key}"), then propose(refinement, item: "${key}", markdown: the whole new text in the strict shape, annotations: ["${note.id}"]); changes to other items go into the same refinement. Then reply(annotation: "${note.id}", item: "${key}", text: what you changed, refinement: its id) in the thread. A person adopts the refinement. If nothing needs changing, just reply. Don't dismiss the comment because you replied: the person who wrote it decides. If something can't be decided from here, say so in your reply rather than guessing.`]),
  ].join('\n');
}

/** What the refinement proposes for the behaviour the comment is on, against the spec. */
function proposedWords(refinement, node, behaviour) {
  const item = refinement.items.find((it) => it.key === itemKeyOf(node));
  if (!item?.after) return ['', 'That change is no longer in the refinement: it has been adopted or declined.'];
  const change = compareItems(editableOf(node), item.after, item.base).behaviours.find((b) => b.key === behaviour);
  if (!change) return behaviour === OTHER_CHANGES ? [] : ['', `Your refinement no longer changes ${behaviour}.`];
  return ['', `Your refinement ${change.change === 'added' ? 'adds' : change.change === 'removed' ? 'removes' : 'changes'} it:`, ...(change.before ? ['The spec says:', quote(change.before)] : []), ...(change.after ? ['You propose:', quote(change.after)] : [])];
}

/** How to triage a bug report (REPORT-05): ask in its thread until it is exact, then propose it, in place, in the report's refinement. */
function reportHow(note, node) {
  const key = itemKeyOf(node);
  const cs = node.refinement;
  return [
    'What to do:',
    `It is a bug report, sent from the Bugs lens: the item above is its draft, new in its own refinement${cs ? ` ("${cs}")` : ''}, placed where the reporter confirmed. Triage it before any other work. Nothing in Overworld asks the reporter anything: you do, in this thread.`,
    `1. Make it exact. Read the reporter's words, its screenshots (photo(item: "${key}")) and the behaviours it names (context() on their items). If the steps to reproduce, what was expected or what happened instead is missing or vague, ask: reply(annotation: "${note.id}", item: "${key}", text: your questions, one short list). The reporter's answer comes back to you here, with this prompt. Ask again until you could reproduce it.`,
    `2. Place it. Find the item that owns the behaviour it breaks (zoom(), context()). The draft sits under the place the reporter chose; if that is wrong, propose a new bug under the right item in the same refinement and say so in the thread, so a person declines the draft.`,
    `3. Propose it: propose(refinement: "${cs ?? 'the draft\'s refinement'}", item: "${key}", title: a short statement of what is wrong, markdown: the strict shape with Kind: Bug, Part of its owner, Why saying who it hurts, Behaviours naming the broken behaviour by its ID as Given … when … then …, with what happens now, Acceptance a check that proves it fixed, annotations: ["${note.id}"]), and mark it ready_for_adoption. Then reply in the thread saying where it went and that a person adopts it; once adopted it is ready work for any builder through next_work().`,
    "Don't adopt it, and don't dismiss the thread: the reporter decides when it is done. If it isn't a bug (it works as the spec says), say so in the thread, with the behaviour that says so.",
  ];
}

/** How to answer a comment on your refinement: in its thread, and with a revision when it asks for one. */
function refinementHow(note, key) {
  const id = note.anchor.refinement;
  return [
    'What to do:',
    `It is a comment on your proposal, before anyone adopts it: pushback or a question. Answer it in the thread with reply(annotation: "${note.id}", item: "${key}", text, refinement: "${id}"). If it asks for a change, or is right, revise the proposal: propose(refinement: "${id}", item: "${key}", markdown: the whole new text in the strict shape, annotations: ["${note.id}"]), then reply saying what you changed. The thread stays with the behaviour through the revision, and a person adopts or declines it. Don't dismiss the comment: the person who wrote it decides. If something can't be decided from here, say so in your reply rather than guessing.`,
  ];
}
