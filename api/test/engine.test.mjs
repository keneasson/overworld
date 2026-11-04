import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nestByReferences } from '../engine/references.mjs';
import { mapArchitecture } from '../engine/architecture.mjs';
import { makeLocator } from '../engine/placement.mjs';
import { parseSpec } from '../engine/behaviours.mjs';

const issue = (number, title, body = '') => ({ number, title, body, labels: [], parent: null });
const parents = (issues) => Object.fromEntries([...nestByReferences(issues)].map(([c, { parent }]) => [c, parent]));

test('nests issues by what they say about each other', () => {
  const nest = parents([
    issue(1, 'Epic: Unify sending', '- [ ] #2 Personalise\n- [x] **Phase 1**: Foundation (#3)\n- [ ] Connect with the email system (issue #9)'),
    issue(2, 'Personalise every email'),
    issue(3, 'Phase 1: Foundation'),
    issue(4, 'Office model', 'Part of #1 · Slice 3'),
    issue(5, 'Mailing-list registry (Epic #1)'),
    issue(6, 'Reminder email follow-up', 'Follow-up to #4.'),
    issue(7, 'Shared sender', 'Related: #1, #4'),
    issue(8, 'Retire legacy stores (#4 Phase 2 step 1)'),
    issue(9, 'Email system'),
    issue(10, 'Epic: Verify', 'Slices:\n- [x] A — recognized view gate\n- [ ] B — reusable Verify step-up\n- [ ] C — server-side PII redaction primitive'),
    issue(11, 'Verify: reusable step-up flow (password / OTP)'),
    issue(12, 'Server-side PII redaction primitive (first-name floor)'),
  ]);
  assert.equal(nest[2], 1, 'task list item that starts with the issue');
  assert.equal(nest[3], 1, 'task list item that ends with the issue');
  assert.equal(nest[9], undefined, 'a to-do that mentions an issue is not a child');
  assert.equal(nest[4], 1, '"Part of #1"');
  assert.equal(nest[5], 1, '"(Epic #1)" in the title');
  assert.equal(nest[6], 4, '"Follow-up to #4"');
  assert.equal(nest[7], undefined, '"Related:" lines never nest');
  assert.equal(nest[8], 4, '"(#4 Phase 2 …)" at the end of a title');
  assert.equal(nest[11], 10, 'a lettered slice that reads like the title');
  assert.equal(nest[12], 10);
});

test('never nests in a circle', () => {
  const nest = parents([issue(1, 'A', 'Part of #2'), issue(2, 'B', 'Part of #3'), issue(3, 'C', 'Part of #1')]);
  const chain = (n, seen = new Set()) => (n == null ? false : seen.has(n) ? true : (seen.add(n), chain(nest[n], seen)));
  for (const n of [1, 2, 3]) assert.equal(chain(n), false);
  assert.equal(Object.keys(nest).length, 2, 'the weakest-ordered claim is dropped');
});

const repo = () => {
  const paths = [
    'package.json',
    'apps/next/package.json',
    'apps/next/app/(public)/page.tsx',
    ...['events', 'news', 'directory', 'profile', 'schedule', 'subscribe', 'welfare'].map((p) => `apps/next/app/(public)/${p}/page.tsx`),
    'apps/next/app/(public)/directory/people/page.tsx',
    'apps/next/app/(public)/directory/people/add/page.tsx',
    'apps/next/app/(public)/directory/people/[id]/page.tsx',
    'apps/next/app/(public)/directory/ecclesias/page.tsx',
    'apps/next/app/(public)/directory/guests/page.tsx',
    'apps/next/app/(public)/directory/groups/page.tsx',
    'apps/next/app/(public)/directory/orgs/page.tsx',
    'apps/next/app/admin/(admin-plus)/posts/page.tsx',
    'apps/next/app/admin/(admin-plus)/posts/[id]/page.tsx',
    'apps/next/app/admin/(admin-plus)/email/lists/page.tsx',
    'apps/next/app/admin/(owner)/data-sync/page.tsx',
    'apps/next/app/auth/signin/page.tsx',
    'apps/next/app/api/admin/email/search/route.ts',
    'apps/next/app/api/admin/email/send/route.ts',
    'apps/next/app/api/admin/posts/route.ts',
    'apps/next/app/api/user/emails/route.ts',
    'apps/next/utils/email/email-send.tsx',
    'apps/next/utils/email/resolve.ts',
    'apps/next/utils/email/brand.ts',
    'apps/next/tests/email.test.ts',
    'apps/expo/package.json',
    'apps/expo/app/index.tsx',
    'apps/expo/app/schedule/index.tsx',
    'apps/email-builder/package.json',
    'apps/email-builder/emails/Wedding.tsx',
    'apps/email-builder/emails/Newsletter.tsx',
    'packages/app/package.json',
    'packages/app/features/email-lists/screen.tsx',
    'packages/app/features/post-editor/editor.tsx',
    'packages/app/features/site-navigation.tsx',
    'docs/behavior/contacts.md',
  ];
  const manifests = new Map([
    ['package.json', { workspaces: ['apps/*', 'packages/*'] }],
    ['apps/next/package.json', { dependencies: { next: '16', '@aws-sdk/client-sesv2': '3' } }],
    ['apps/expo/package.json', { dependencies: { expo: '54', 'react-native': '0.81' } }],
    ['apps/email-builder/package.json', { dependencies: { '@react-email/components': '1' } }],
    ['packages/app/package.json', { name: '@my/app' }],
  ]);
  return mapArchitecture({ paths, manifests });
};

test('reads the product’s shape from its code', () => {
  const arch = repo();
  const r = (title, parentTitle) => [...arch.regions.values()].find((x) => x.title === title && (!parentTitle || arch.regions.get(x.parent)?.title === parentTitle));
  assert.equal(r('Web app').surface, 'web');
  assert.equal(r('Mobile app').surface, 'mobile');
  assert.equal(r('Emails').surface, 'email');
  assert.equal(r('API').surface, 'api');
  assert.equal(r('Amazon SES').surface, 'external');
  assert.equal(r('Public site', 'Web app').place, 'center', 'many top-level pages in one route group read as one part of the site');
  assert.equal(r('Sign-in', 'Web app').place, 'top-right');
  assert.equal(r('Navigation', 'Web app').place, 'top');
  assert.deepEqual(r('People', 'Directory').urls, ['/directory/people', '/directory/people/add'], 'a page and its small sub-pages are one place');
  assert.ok(r('Posts', 'Admin'), 'route groups like (admin-plus) are not places');
  assert.ok(r('Wedding', 'Emails').tags.includes('template'));
  assert.ok(r('Schedule', 'Mobile app'));
  assert.ok(r('Email lists API', 'Admin API') || r('Admin API', 'API'), 'endpoints group by path');
  // Shared screens go where they are used; code folders go behind the screen.
  assert.deepEqual(r('Lists', 'Admin').urls, ['/admin/email/lists'], 'a folder with one route is one step, not two');
  assert.ok(r('Lists', 'Admin').files.includes('packages/app/features/email-lists/screen.tsx'));
  assert.ok(r('Navigation', 'Web app').files.includes('packages/app/features/site-navigation.tsx'));
  assert.equal(r('Next app code').place, 'offscreen');
  assert.equal(r('Tests & CI').place, 'offscreen');
});

test('places an issue where its evidence points, and says why', () => {
  const arch = repo();
  const loc = makeLocator(arch);
  const where = (input) => {
    const e = loc.evidence(input);
    const key = loc.choose(e.weights, e.hints);
    return key && arch.regions.get(key).title;
  };
  assert.equal(where({ title: 'Wedding announcement email 500' }), 'Wedding', 'the title names a place');
  assert.equal(
    where({ title: 'Lists page slow', body: 'See `/admin/email/lists` and `apps/next/app/api/admin/email/search/route.ts`.' }),
    'Lists',
    'a page beats the API behind it',
  );
  assert.equal(where({ title: 'Editor crash', prs: [{ number: 9, files: ['apps/next/app/admin/(admin-plus)/posts/[id]/page.tsx'] }] }), 'Posts');
  assert.equal(where({ title: 'Think about the vibe' }), null, 'nothing to go by');
  assert.equal(where({ title: 'Bounce handling', body: 'SES suppression list keeps growing' }), 'Amazon SES', 'a guess from shared words');
  assert.equal(where({ title: 'Typo in the contacts spec', body: 'In docs/behavior/contacts.md' }), null, 'design docs are not places in the product');
});

test('reads behaviour specs: status, decisions and the issues they cite', () => {
  const spec = parseSpec(
    'docs/behavior/contacts.md',
    '# Behaviour spec: Contacts\n\n> **What this is.** How contact details behave.\n\n## 1. Seeing — `C-SEE`\n\n| ID | Scenario | Status |\n|---|---|---|\n| SEE-01 | Owners see all. | ✅ `privacy.test` |\n| SEE-02 | Ask for a hidden detail. | ⚠️ #259: half-built |\n| SEE-03 | Region rung. | ⏸ Deferred |\n| SEE-04 | Visiting speakers. | 🔷 #259 |\n| SEE-05 | Verified members. | ❌ #12 |\n',
  );
  assert.equal(spec.title, 'Contacts');
  assert.equal(spec.summary, 'How contact details behave.');
  const s = spec.sections[0];
  assert.equal(s.prefix, 'C-SEE');
  assert.deepEqual(
    s.scenarios.map((x) => [x.id, x.status, x.definition]),
    [
      ['SEE-01', 'done', 'auto'],
      ['SEE-02', 'in_progress', 'auto'],
      ['SEE-03', 'idea', 'auto'],
      ['SEE-04', 'idea', 'vague'],
      ['SEE-05', 'planned', 'auto'],
    ],
  );
  assert.deepEqual(s.scenarios[1].issues, [259]);
  const gherkin = parseSpec('features/cart.feature', 'Feature: Cart\n  Keeps what you pick\n\n  Scenario: Add an item\n    Given …\n\n  @wip\n  Scenario: Save for later\n');
  assert.deepEqual(
    gherkin.sections[0].scenarios.map((x) => [x.text, x.status]),
    [
      ['Add an item', 'done'],
      ['Save for later', 'planned'],
    ],
  );
});
