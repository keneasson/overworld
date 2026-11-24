#!/usr/bin/env node
// The store as a collaborator in an item's live document (prototype): stands in for an edit made to the issue on GitHub
// arriving as a store event. Instead of a "changed on GitHub since you started" banner, the edit arrives in the open
// document under GitHub's own caret and colour, while people keep typing.
//
//   node scripts/live-github.mjs --item issue-13 [--section Why | --behaviour ADOPT-11] [--text "…"] [--suggest]
//
// By default the edit goes straight in, as the store's text is the record; --suggest makes it a suggestion to accept or reject.

import { findItem, http, join, options } from './live/client.mjs';
import { behaviourParagraph, cursorAt, pieces, sectionParagraph, sleep } from './live/ydoc.mjs';

const args = options({ section: { type: 'string', default: 'Why' }, behaviour: { type: 'string' }, text: { type: 'string' }, suggest: { type: 'boolean', default: false } });
const user = { name: 'GitHub', color: '#8250df' };
const call = http(args.app);
const { pid } = await findItem(call, args.item, args.project);
const live = await join({ live: args.live, pid, item: args.item, user });

const para = args.behaviour ? behaviourParagraph(live.doc, args.behaviour) : sectionParagraph(live.doc, args.section);
if (!para) {
  await live.leave();
  throw new Error(`Nothing to edit: ${args.behaviour ?? args.section} is not in ${args.item}`);
}
const text = args.text ?? ' (Edited on GitHub: a store event arriving in the live document, not as a conflict.)';
const marks = args.suggest ? { suggestionInsert: { id: `g${Date.now().toString(36)}`, author: user.name, color: user.color } } : {};
console.log(`GitHub is in ${args.item} (${pid}), editing ${args.behaviour ?? args.section}${args.suggest ? ' as a suggestion' : ''}`);

// A store event arrives whole, but it is laid in quickly enough to see where it lands.
let at = para.text.length;
live.setCursor(cursorAt(para.text, at));
await sleep(600);
for (const piece of pieces(text.startsWith(' ') || !para.words ? text : ` ${text}`)) {
  live.doc.transact(() => para.text.insert(at, piece, marks), 'store');
  at += piece.length;
  live.setCursor(cursorAt(para.text, at));
  await sleep(25);
}
console.log('Applied. GitHub stays in the document for a few seconds so its caret can be seen.');
await sleep(4000);
await live.leave();
