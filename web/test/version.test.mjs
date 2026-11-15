import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../src/model/version.js';

const page = (entry) => `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head><body><div id="root"></div></body></html>`;

test('SHIP-12 an open app knows when a newer version has been deployed', () => {
  assert.equal(isNewer('/assets/index-aaa111.js', page('/assets/index-bbb222.js')), true, 'a new deploy');
  assert.equal(isNewer('/assets/index-aaa111.js', page('/assets/index-aaa111.js')), false, 'the same build');
  assert.equal(isNewer(null, page('/assets/index-bbb222.js')), false, 'in development nothing is hashed');
  assert.equal(isNewer('/assets/index-aaa111.js', '<html>Service unavailable</html>'), false, 'an error page is not a version');
});
