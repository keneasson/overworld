import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importGitHub } from '../github.mjs';
import { fakeShop } from './fake-github.mjs';

// The shop with damaged code in its payments route and its header, read the way a mapping reads it.
function damagedShop(route, header = 'export const Header = () => null;\n') {
  const shop = fakeShop();
  shop.docs['apps/web/app/api/payments/route.ts'] = route;
  shop.docs['apps/web/components/site-header.tsx'] = header;
  const fetch = shop.fetch;
  // The commits API, for which pull request repaired a file (WASTE-04).
  shop.fetch = async (url) => {
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (/\/commits\?path=/.test(url)) return ok([{ sha: 'abc123' }]);
    if (/\/commits\/abc123\/pulls$/.test(url)) return ok([{ number: 42, title: 'Repair the payments route', html_url: 'https://github.com/octo/shop/pull/42', merged_at: '2026-11-20T00:00:00Z' }]);
    return fetch(url);
  };
  return shop;
}
const DAMAGED = `// FIXME: rounding is off by a cent
const NEW_PAY_ENABLED = true;
const payVariant = 'b';
export async function POST(req) {
  if (NEW_PAY_ENABLED) return newPay(req);
  if (payVariant === 'a') return oldPay(req);
  return pay(req);
  audit(req);
}
/* tech debt: duplicated in the cart */
`;
const regionOf = (nodes, file) => nodes.find((n) => n.tags.includes('code') && n.body.includes(file));

test('WASTE-05 a FIXME, unreachable code, a decided A/B test, a resolved flag and a debt comment each make their code wasteland, and say which', async () => {
  const { nodes, waste } = await importGitHub({ repo: 'octo/shop' }, damagedShop(DAMAGED).fetch);
  const route = regionOf(nodes, 'payments/route.ts');
  const kinds = Object.fromEntries(route.waste.map((m) => [m.mark, m.line]));
  assert.deepEqual(kinds, { fixme: 1, 'resolved-flag': 5, 'ab-leftover': 6, unreachable: 8, 'debt-comment': 10 });
  assert.ok(route.waste.every((m) => m.path === 'apps/web/app/api/payments/route.ts' && m.url.endsWith(`#L${m.line}`) && m.text));
  assert.ok(!regionOf(nodes, 'site-header.tsx').waste, 'sound code is not wasteland');
  assert.equal(waste.marks.length, 5);
});

test('WASTE-06 a TODO does not make its code wasteland', async () => {
  const { nodes } = await importGitHub({ repo: 'octo/shop' }, damagedShop('// TODO: retry on a timeout\nexport const POST = (req) => pay(req); // todo: log it\n').fetch);
  assert.ok(!regionOf(nodes, 'payments/route.ts').waste);
});

test('WASTE-04 repaired code is no longer wasteland, and its history names the pull request that repaired it', async () => {
  const first = await importGitHub({ repo: 'octo/shop' }, damagedShop(DAMAGED).fetch);
  const again = await importGitHub({ repo: 'octo/shop', previous: { waste: first.waste } }, damagedShop('export async function POST(req) {\n  return pay(req);\n}\n').fetch);
  const route = regionOf(again.nodes, 'payments/route.ts');
  assert.ok(!route.waste, 'the terrain clears');
  assert.equal(route.wasteCleared.length, 5);
  assert.ok(route.wasteCleared.every((c) => c.pr?.number === 42 && c.at && c.path.endsWith('route.ts')));
  // The history carries on through the next mapping.
  const later = await importGitHub({ repo: 'octo/shop', previous: { waste: again.waste } }, damagedShop('export const POST = (req) => pay(req);\n').fetch);
  assert.equal(regionOf(later.nodes, 'payments/route.ts').wasteCleared.length, 5);
});
