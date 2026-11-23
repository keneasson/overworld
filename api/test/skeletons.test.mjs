// Test skeletons from adopted behaviours (SKETCH-01 to SKETCH-04, #23), tested the way an agent gets them: through the
// MCP server and the build prompt, on a repository mapped from a fake GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../app.mjs';
import { modelFor } from '../model/index.mjs';
import { fileTable } from '../model/table.mjs';
import { fakeShop } from './fake-github.mjs';

const ready = { labels: [{ name: 'status:ready' }] };
const body = (behaviours) => `Part of #1\n\n## Why\n\nBecause.\n\n## Behaviours\n\n${behaviours.map((b) => `- ${b}`).join('\n')}\n\n## Acceptance\n\nIt works.\n\n## Out of scope\n\nNothing.\n\n## Open questions\n\nNone\n`;
const CART = ['CART-01 Given a product, when added, then the cart holds it.', 'CART-02 Given a cart, when emptied, then it shows "nothing here", and the total is zero.', 'CART-03 Not worked out yet: saved carts.'];

/** A repository on a fake GitHub, mapped; `shape` changes it first. An agent signed in to it, and a person's REST calls. */
async function mapped(shape) {
  const dir = await mkdtemp(join(tmpdir(), 'overworld-sketch-'));
  const shop = fakeShop();
  shop.issues.push(shop.issue(40, 'Cart', body(CART), ready), shop.issue(41, 'Wishlist', body(['WISH-01 Given a product, when wished for, then it is kept.']), { labels: [{ name: 'status:needs-decision' }] }));
  shape?.(shop);
  const api = createApi({ model: modelFor(fileTable(join(dir, 'table.json'))), accessKey: 'k', fetchImpl: shop.fetch, log: { error() {} } });
  const rest = async (method, path, b) => (await api({ method, path, body: b, headers: { 'x-projectmap-key': 'k' } })).body;
  const pid = (await rest('POST', '/api/import/github', { repo: 'octo/shop' })).project.id;
  const { token } = await rest('POST', `/api/projects/${pid}/agents`, { name: 'Builder' });
  const tool = async (name, args) => (await api({ method: 'POST', path: '/api/mcp', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers: { authorization: `Bearer ${token}` } })).body.result;
  return { rest, pid, tool, dir };
}

/** Run one skeleton with Node's test runner, as a builder would before filling it in. */
const run = (file) => {
  const { NODE_TEST_CONTEXT, ...env } = process.env; // run on its own, not as a child of this run
  return new Promise((done) => execFile(process.execPath, ['--test', file], { env }, (err, stdout) => done({ failed: Boolean(err), out: stdout })));
};

// A project whose tests are written its own way: Mocha-style it(), double quotes, no semicolons, four spaces, function ().
const OWN_STYLE = 'import { it } from "vitest"\n\nit("CART-01 the cart holds a product", function () {\n    expect(cart.add(p)).toBe(true)\n})\n';
const withOwnTests = (shop) => {
  shop.tree.push({ path: 'apps/web/test/cart.test.ts', type: 'blob' });
  shop.docs['apps/web/test/cart.test.ts'] = OWN_STYLE;
};

test('SKETCH-01 SKETCH-03 an adopted behaviour gets a failing skeleton in the style of the project\'s tests; one already tested points to its test', async () => {
  const { tool } = await mapped(withOwnTests);
  const r = (await tool('skeletons', { issue: '40' })).structuredContent;
  assert.match(r.style, /existing tests \(1 file: apps\/web\/test\/cart\.test\.ts\)/);
  assert.deepEqual(r.skeletons.map((s) => [s.id, s.file, s.new_file]), [['CART-02', 'apps/web/test/cart.test.ts', false]], 'beside its family, and nothing for the Fog');
  const [s] = r.skeletons;
  assert.equal(s.name, 'CART-02 it shows "nothing here"');
  assert.equal(s.code, 'it("CART-02 it shows \\"nothing here\\"", function () {\n    // Given a cart,\n    // when emptied,\n    // then it shows "nothing here", and the total is zero.\n    throw new Error("CART-02 is not proven yet: write this test")\n})\n');
  const ran = [];
  assert.throws(() => new Function('it', s.code)((name, fn) => (ran.push(name), fn())), /CART-02 is not proven yet/, 'failing until filled in');
  assert.deepEqual(ran, [s.name]);

  assert.deepEqual(r.already_tested, [{ id: 'CART-01', tests: [{ file: 'apps/web/test/cart.test.ts', name: 'CART-01 the cart holds a product' }] }], 'no duplicate: the existing test instead');
  const one = (await tool('skeletons', { issue: '40', behaviours: ['CART-01'] })).structuredContent;
  assert.deepEqual([one.skeletons, one.already_tested.map((e) => e.id)], [[], ['CART-01']]);

  const notAdopted = await tool('skeletons', { issue: '41' });
  assert.ok(notAdopted.isError);
  assert.match(notAdopted.content[0].text, /aren't adopted yet/);
});

test('SKETCH-04 a project with no tests gets best practice for its language: one test per behaviour, named by its ID, with its Given / When / Then', async () => {
  const js = (shop) => shop.tree.splice(0, shop.tree.length, { path: 'package.json', type: 'blob' }, { path: 'src/cart.js', type: 'blob' });
  const { tool, dir } = await mapped(js);
  const r = (await tool('skeletons', { issue: '40' })).structuredContent;
  assert.match(r.style, /no tests yet: best practice for requirement-driven tests in javascript/);
  const [s] = r.skeletons;
  assert.deepEqual([s.id, s.file, s.new_file], ['CART-01', 'test/cart.test.mjs', true]);
  assert.deepEqual(r.skeletons.map((k) => k.id), ['CART-01', 'CART-02'], 'one per behaviour');
  assert.match(s.code, /^import \{ test \} from 'node:test';\nimport assert from 'node:assert\/strict';\n\ntest\('CART-01 the cart holds it', \(\) => \{\n {2}\/\/ Given a product,\n {2}\/\/ when added,\n {2}\/\/ then the cart holds it\.\n/);
  const file = join(dir, 'cart.test.mjs');
  await writeFile(file, s.code);
  const ran = await run(file);
  assert.ok(ran.failed, 'it fails until filled in');
  assert.match(ran.out, /CART-01 is not proven yet/);

  const py = (shop) => shop.tree.splice(0, shop.tree.length, { path: 'app/cart.py', type: 'blob' }, { path: 'app/main.py', type: 'blob' });
  const p = (await (await mapped(py)).tool('skeletons', { issue: '40', behaviours: ['CART-01'] })).structuredContent;
  assert.match(p.style, /in python/);
  assert.deepEqual([p.skeletons[0].file, p.skeletons[0].code.split('\n').slice(3, 6)], ['tests/test_cart.py', ['def test_cart_01_the_cart_holds_it():', '    """CART-01 the cart holds it"""', '    # Given a product,']]);
  assert.match(p.skeletons[0].code, /pytest\.fail\("CART-01 is not proven yet: write this test"\)/);
});

test('SKETCH-02 an issue handed to an agent carries its untested behaviours\' skeletons and says they must pass', async () => {
  const elsewhere = (shop) => {
    shop.tree.push({ path: 'apps/web/test/pay.test.ts', type: 'blob' });
    shop.docs['apps/web/test/pay.test.ts'] = OWN_STYLE.replace('CART-01 the cart holds a product', 'PAY-01 a saved card pays');
  };
  const { rest, pid, tool } = await mapped(elsewhere);
  await rest('POST', `/api/projects/${pid}/builds`, { item: 'issue-40', by: 'Ken' });
  const { build_requests: [request] } = (await tool('next_work', {})).structuredContent;
  assert.deepEqual(request.behaviours, ['CART-01', 'CART-02']);
  for (const part of ['In apps/web/test/cart.test.ts (a new file):', 'import { it } from "vitest"\n\nit("CART-01 the cart holds it", function () {', 'it("CART-02 it shows \\"nothing here\\"", function () {', '    throw new Error("CART-02 is not proven yet: write this test")']) {
    assert.ok(request.prompt.includes(part), `the prompt has ${part}`);
  }
  assert.match(request.prompt, /they must all pass before the pull request opens/);
  assert.ok(request.prompt.indexOf('test skeletons') < request.prompt.indexOf('How:'), 'before how to build it');
});
