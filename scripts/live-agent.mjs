#!/usr/bin/env node
// An agent as a collaborator in an item's live document (prototype). It joins as "Claude" with its own caret, and streams a
// suggested rewording of one behaviour into the text as it is written: the new words marked as a suggested insertion,
// the old ones as a suggested deletion, both by Claude, for a person to accept or reject in place. Then it says why in a
// comment on that behaviour.
//
//   node scripts/live-agent.mjs --item issue-13 --behaviour ADOPT-11 [--project <id>] [--ask "make it shorter"]
//
// With ANTHROPIC_API_KEY set, the wording comes from Claude, streamed; without it, a scripted revision is streamed instead.

import Anthropic from '@anthropic-ai/sdk';
import * as Y from 'yjs';
import { editableOf, parseIssue, sectionText } from '../shared/issue-shape.js';
import { isDismissed, threadsOf } from '../shared/annotations.js';
import { findItem, http, join, options } from './live/client.mjs';
import { behaviourParagraph, cursorAt, pieces, sleep } from './live/ydoc.mjs';

const MODEL = 'claude-opus-5-5';
const args = options({ behaviour: { type: 'string' }, ask: { type: 'string' }, name: { type: 'string', default: 'Claude' }, color: { type: 'string', default: '#d97757' } });
if (!args.behaviour) throw new Error('--behaviour <ID> is required, for example --behaviour ADOPT-11');
const user = { name: args.name, color: args.color };
const call = http(args.app);

const { pid, node } = await findItem(call, args.item, args.project);
const { markdown } = editableOf(node);
const shape = parseIssue(markdown);
const { comments } = await call('GET', `/api/projects/${pid}/comments/${args.item}`);
const thread = threadsOf(comments).find((t) => t.root.anchor?.behaviour === args.behaviour && !isDismissed(t.root));

const live = await join({ live: args.live, pid, item: args.item, user });
const para = behaviourParagraph(live.doc, args.behaviour);
if (!para) {
  await live.leave();
  throw new Error(`${args.behaviour} is not in the Behaviours of ${args.item}`);
}
const id = args.behaviour;
const was = para.words.slice(id.length); // " Given …", with its leading space
const said = { id: `s${Date.now().toString(36)}`, author: user.name, color: user.color };
console.log(`${user.name} is in ${args.item} (${pid}), suggesting a new wording for ${id}`);

// The old words are marked for removal, and the new ones arrive just before them, a piece at a time. Where they go is held
// relative to the old words, so someone typing elsewhere in the behaviour meanwhile moves nothing.
const before = Y.createRelativePositionFromTypeIndex(para.text, id.length);
const here = () => Y.createAbsolutePositionFromRelativePosition(before, live.doc).index;
let written = 0;
live.doc.transact(() => para.text.format(id.length, was.length, { suggestionDelete: said }), user.name);
live.setCursor(cursorAt(para.text, here()));
await sleep(500);
const write = (piece) => {
  live.doc.transact(() => para.text.insert(here(), piece, { suggestionInsert: said }), user.name);
  written += piece.length;
  live.setCursor(cursorAt(para.text, here()));
  process.stdout.write(piece);
};
write(' ');

let note = '';
try {
  note = process.env.ANTHROPIC_API_KEY ? await fromClaude(write) : await scripted(write);
} catch (err) {
  // Nothing half-written stays behind: the suggestion is taken back, and the old words are as they were.
  live.doc.transact(() => {
    const end = here();
    para.text.delete(end - written, written);
    para.text.format(end - written, was.length, { suggestionDelete: null });
  }, user.name);
  await live.leave();
  throw err;
}
process.stdout.write('\n');
live.setCursor(null);

// Why, in a thread on the behaviour: a reply in the one already there, or a new one.
if (note) {
  const { comment } = await call('POST', `/api/projects/${pid}/comments`, { itemKey: args.item, anchor: { on: 'behaviour', behaviour: id }, text: note, author: user.name, ...(thread ? { replyTo: thread.root.id } : {}) });
  live.provider.sendStateless(JSON.stringify({ type: 'comments', itemKey: args.item, by: user.name, id: comment.id }));
  console.log(`${thread ? 'Replied in the thread' : 'Started a thread'} on ${id}: ${note}`);
}
await sleep(1500);
await live.leave();

async function fromClaude(emit) {
  const client = new Anthropic();
  const questions = sectionText(shape, 'Open questions');
  const prompt = [
    `You are revising one behaviour in a product spec, as a collaborator suggesting an edit in a shared document.`,
    `Item: ${node.title}`,
    `Why this item exists:\n${sectionText(shape, 'Why') || '(not written)'}`,
    `The behaviour, ${id}:\n${was.trim()}`,
    questions ? `Open questions in the item:\n${questions}` : '',
    thread ? `Comments on ${id} so far:\n${[thread.root, ...thread.replies].map((c) => `${c.author}: ${c.text}`).join('\n')}` : '',
    args.ask ? `The person asked: ${args.ask}` : '',
    `Write a clearer version of ${id} in the form "Given …, when …, then …", keeping its meaning and anything a test would check.`,
    `Reply with exactly two lines and nothing else. Line 1: the revised behaviour text, without the ID. Line 2: "NOTE: " and one short sentence, to the person, saying what you changed and why.`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const stream = client.messages.stream({ model: MODEL, max_tokens: 8000, output_config: { effort: 'low' }, messages: [{ role: 'user', content: prompt }] });
  let line = '';
  let rest = '';
  let first = true;
  for await (const event of stream) {
    if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') continue;
    let text = event.delta.text;
    if (!first) {
      rest += text;
      continue;
    }
    const nl = text.indexOf('\n');
    if (nl >= 0) {
      rest += text.slice(nl + 1);
      text = text.slice(0, nl);
      first = false;
    }
    if (!line) text = text.replace(/^\s+/, '');
    line += text;
    if (text) emit(text);
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') throw new Error(`Claude declined to revise ${id}`);
  if (!line.trim()) throw new Error('Claude sent no wording');
  return rest.replace(/^\s*NOTE:\s*/i, '').trim();
}

async function scripted(emit) {
  const revisions = {
    'ADOPT-11':
      "Given people and agents adding behaviours to the same area at the same time, when a new behaviour is first saved in Overworld, then the server gives it the area's next free number (AREA-NN), and that number is never given again, even if the behaviour is dropped; a behaviour arriving from GitHub without an ID is numbered the same way, and one arriving with a number already taken shows in the editor as a conflict to resolve.",
  };
  const text = revisions[id] ?? `${was.trim().replace(/\.$/, '')}, and the person can see that it happened.`;
  for (const piece of pieces(text)) {
    emit(piece);
    await sleep(60 + Math.random() * 90);
  }
  return revisions[id]
    ? 'Split it into one outcome per clause and said "next free number" so it is clear a number is never reused. Accept or reject it in the text. (Scripted: no ANTHROPIC_API_KEY was set.)'
    : 'Added what the person sees when it happens. (Scripted: no ANTHROPIC_API_KEY was set.)';
}
