import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clausesOf, locate, piecesOf, quoteOf } from '@shared/annotations.js';

const at = (text, words, from = 0) => {
  const start = text.indexOf(words, from);
  return quoteOf(text, start, start + words.length);
};
const found = (text, anchor) => {
  const r = locate(text, anchor);
  return r && { words: text.slice(r.start, r.end), start: r.start };
};

test('NOTE-01 an annotation stays on its words as the text around them is edited, and says so when they are gone', () => {
  const text = 'The map shows the work. The map is shaped like the product.\nEach region names the map it is on.';
  const second = at(text, 'map', text.indexOf('The map is'));
  const phrase = at(text, 'shaped like the product');
  const edited = `A first line, added.\n${text.replace('shows the work', 'shows every piece of work').replace('Each region', 'Every region')}`;
  assert.deepEqual(found(edited, second), { words: 'map', start: edited.indexOf('The map is') + 4 }, 'the same "map", not another one');
  assert.equal(found(edited, phrase).words, 'shaped like the product');
  const moved = 'Each region names the map it is on. The map is shaped like the product. The map shows the work.';
  assert.equal(found(moved, second).start, moved.indexOf('The map is') + 4, 'moved with its sentence');
  assert.equal(locate(text.replace('shaped like the product', 'drawn freely'), phrase), null, 'its words were rewritten');
  assert.equal(found('mapping the map', at('the map', 'map')).start, 12, 'a word is found as a word');
});

test('ADOPT-03 a comment can be on one clause of a proposed behaviour, its Given, When or Then, and its words stay marked through a revision', () => {
  const proposed = 'CL-05 Given work, when step 5 happens, then it expires in five minutes.';
  const clauses = clausesOf(proposed);
  assert.deepEqual(clauses.map((c) => [c.part, proposed.slice(c.start, c.end)]), [['Given', 'Given work'], ['When', 'when step 5 happens'], ['Then', 'then it expires in five minutes.']]);
  assert.deepEqual(clausesOf('CL-06 Not worked out yet.'), [], 'a behaviour not in that shape has none to tap');
  // On the Then alone; then on two words of it, selected.
  const then = clauses[2];
  const onThen = { root: { anchor: quoteOf(proposed, then.start, then.end) } };
  const onWords = { root: { anchor: at(proposed, 'five minutes') } };
  const marked = (text, threads) => piecesOf(text, clausesOf(text), threads).filter((p) => p.threads.length).map((p) => [text.slice(p.start, p.end), p.threads.length]);
  assert.deepEqual(marked(proposed, [onWords]), [['five minutes', 1]]);
  assert.deepEqual(marked(proposed, [onThen, onWords]), [['then it expires in ', 1], ['five minutes', 2], ['.', 1]]);
  // A revision that keeps the words keeps the mark; one that rewrites them says the words have gone.
  assert.deepEqual(marked('CL-05 Given work, when step 5 happens, then it expires in five minutes, or when its build ends.', [onWords]), [['five minutes', 1]]);
  assert.equal(found('CL-05 Given work, when step 5 happens, then it expires when its build does.', onWords.root.anchor), null);
});
