import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, quoteOf } from '@shared/annotations.js';

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
