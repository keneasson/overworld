// A fake GitHub for tests: one small repository, a Next.js shop with issues, a pull request and a behaviour spec.

export function fakeShop() {
  const issue = (number, title, body = '', extra = {}) => ({ number, title, body, state: 'open', html_url: `https://github.com/octo/shop/issues/${number}`, labels: [], milestone: null, assignees: [], ...extra });
  const issues = [
    issue(1, 'Epic: checkout', '- [ ] #2\n- [ ] #3'),
    issue(2, 'Pay with saved card', 'depends on #4', { state: 'closed', labels: [{ name: 'enhancement' }] }),
    issue(3, 'Coupon field broken', 'The field on /checkout rejects valid codes.', { labels: [{ name: 'bug' }, { name: 'P1' }], assignees: [{ login: 'ken' }] }),
    issue(4, 'Card tokens', 'Part of #1. See `apps/web/app/api/payments/route.ts`.', { milestone: { title: 'v1', due_on: '2027-01-31T00:00:00Z' } }),
    issue(5, 'Think about the vibe', 'Hmm.'),
    issue(6, 'A PR', '', { pull_request: {} }),
    issue(8, 'Dark mode toggle', 'Maybe later.', { state: 'closed', state_reason: 'not_planned' }),
  ];
  const pulls = [{ number: 9, title: 'Vibes', body: 'Closes #5' }];
  const files = { 'package.json': { name: 'shop', workspaces: ['apps/*'] }, 'apps/web/package.json': { name: 'web', dependencies: { next: '16.0.0', stripe: '19.0.0' } } };
  const spec =
    '# Behaviour spec: Checkout\n\n> What paying must do.\n\n## 1. Paying — `PAY`\n\n| ID | Scenario | Status |\n|---|---|---|\n| PAY-01 | A saved card pays in one tap. | ✅ |\n| PAY-02 | A coupon applies before paying. | ❌ #3 |\n| PAY-03 | Who refunds? | 🔷 |\n';
  const tree = [
    'package.json',
    'apps/web/package.json',
    'apps/web/app/(shop)/page.tsx',
    'apps/web/app/(shop)/checkout/page.tsx',
    'apps/web/app/(shop)/cart/page.tsx',
    'apps/web/app/(shop)/products/page.tsx',
    'apps/web/app/auth/signin/page.tsx',
    'apps/web/app/api/payments/route.ts',
    'apps/web/components/site-header.tsx',
    'docs/behavior/checkout.md',
  ].map((path) => ({ path, type: 'blob' }));
  const docs = {}; // more files' text, by path: a test adds them, with their paths in `tree`
  return {
    issues,
    issue,
    tree,
    docs,
    fetch: async (url) => {
      const raw = url.match(/^https:\/\/raw\.githubusercontent\.com\/octo\/shop\/main\/(.*)$/);
      const body = raw
        ? (docs[decodeURIComponent(raw[1])] ?? (files[decodeURIComponent(raw[1])] && JSON.stringify(files[decodeURIComponent(raw[1])])) ?? (raw[1].endsWith('checkout.md') ? spec : null))
        : url.includes('/issues?')
          ? issues
          : url.includes('/pulls?')
            ? pulls
          : url.includes('/git/trees/')
            ? { tree }
            : { full_name: 'octo/shop', description: '', html_url: 'https://github.com/octo/shop', default_branch: 'main' };
      return { ok: body != null, status: body == null ? 404 : 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    },
  };
}
