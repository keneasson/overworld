// The demo project created on first run. It mirrors a real web-app rebuild so
// every lens (bugs, fog of definition, new-feature lights, routes) has something to show.
// `place` and `surface` shape the Site projection: the storefront is a web screen
// (navigation on top, footer at the bottom, cart on the right), with a mostly
// uncharted mobile app beside it, the API below, then services and third parties.

import { ROOT_ID, newId } from '../shared/schema.js';

const day = 86_400_000;
const inDays = (n) => new Date(Date.now() + n * day).toISOString().slice(0, 10);

const ac = (...items) => `**Acceptance criteria**\n\n${items.map((i) => `- [ ] ${i}`).join('\n')}`;
const repro = (steps, expected, actual) =>
  `**Steps to reproduce**\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n**Expected:** ${expected}\n\n**Actual:** ${actual}`;

// node(kind, title, props?, ...children) — props may be a status string for brevity.
const node =
  (kind) =>
  (title, props = {}, ...children) => ({
    kind,
    title,
    ...(typeof props === 'string' ? { status: props } : props),
    children,
  });
const area = node('area');
const epic = node('epic');
const feature = node('feature');
const story = (title, props) => node('story')(title, { tags: ['new-feature'], ...(typeof props === 'string' ? { status: props } : props) });
const task = node('task');
const bug = node('bug');
const page = (title, key, status, to, props = {}) =>
  task(title, { key, status, tags: ['page'], links: to.map((t) => ['navigates', t]), ...props });

const tree = {
  kind: 'project',
  title: 'Northwind Storefront v2',
  summary: 'Rebuild the customer storefront so shoppers can find, compare and buy on any device. Launch target: end of Q1.',
  body: `## Why\n\nThe current storefront is desktop-only and converts at half the industry rate on phones.\n\n## Goals\n\n- Mobile conversion **+40%**\n- Search-to-product in under **3 taps**\n- Lighthouse performance **90+** on product pages\n\n## How to read this map\n\nZoom out to see the whole project. Zoom in to trade breadth for depth. Use the chips at the top (Bugs, Fog, New features…) to change what the map shows.`,
  status: 'in_progress',
  due: inDays(150),
  children: [
    area(
      'Navigation & Wayfinding',
      {
        status: 'in_progress',
        place: 'top',
        summary: 'How shoppers move around the store — on phones and desktops.',
        body: 'Today there is **no navigation** at all: every page is a dead end reached from search engines.',
      },
      epic(
        'Global navigation',
        { status: 'in_progress', summary: 'Add a header and menu that work on every screen size, mobile and desktop.', due: inDays(40) },
        feature(
          'Header & buttons',
          { status: 'in_progress', summary: 'The always-visible bar: logo, search, cart and account.', estimate: 8, assignee: 'maya' },
          story('As a shopper I can reach Shop, Deals and Account from any page', {
            status: 'in_progress',
            estimate: 3,
            assignee: 'maya',
            summary: 'Primary destinations are one tap away everywhere.',
            body: ac('Header renders on every route', 'Shop, Deals and Account are reachable in one tap', 'Works with keyboard only'),
          }),
          task('Header shell component', { status: 'done', estimate: 2, assignee: 'maya', summary: 'Layout grid, logo slot, action slots.' }),
          task('Primary & icon button variants', {
            status: 'done',
            estimate: 1,
            assignee: 'maya',
            summary: 'Uses design-system buttons.',
            links: [['depends', 'ds-buttons']],
          }),
          task('Sticky header on scroll', { status: 'in_progress', estimate: 2, assignee: 'maya', summary: 'Hide on scroll down, reveal on scroll up.' }),
          bug('Header overlaps page content on iOS Safari', {
            status: 'planned',
            priority: 'P1',
            summary: 'Safe-area inset not applied.',
            body: repro(['Open any page on iPhone 15', 'Scroll to top'], 'Content starts below the header', 'First 40px of content are hidden'),
          }),
        ),
        feature(
          'Menu groups & line breaks',
          { status: 'planned', summary: 'Organize categories into scannable groups with headings and dividers.', estimate: 5 },
          story('As a shopper I can scan categories grouped by department', {
            status: 'planned',
            estimate: 3,
            summary: 'Departments as group headings, max 8 items per group.',
            body: ac('Groups have visible headings', 'Dividers between groups', 'Screen readers announce group names'),
          }),
          task('Group heading & divider tokens', { status: 'planned', estimate: 1, links: [['depends', 'ds-tokens']], summary: 'Spacing and rule tokens.' }),
          task('Responsive collapse into hamburger', { status: 'planned', estimate: 2, summary: 'Below 768px the menu folds into a drawer.' }),
          task('"More" overflow menu', { status: 'idea' }),
        ),
        feature(
          'Mobile drawer',
          { key: 'nav-drawer', status: 'in_progress', summary: 'Thumb-friendly slide-in menu for phones.', estimate: 5, assignee: 'devon' },
          story('As a mobile shopper I can open the menu with one thumb', {
            status: 'in_progress',
            estimate: 3,
            assignee: 'devon',
            summary: 'Menu trigger sits in the bottom thumb zone.',
            body: ac('Trigger reachable one-handed', 'Drawer opens in under 150ms', 'Tapping outside closes it'),
          }),
          task('Swipe-to-close gesture', { status: 'planned', estimate: 1, summary: 'Swipe left closes the drawer.' }),
          bug('Drawer does not close on Android back gesture', {
            status: 'in_progress',
            priority: 'P1',
            assignee: 'devon',
            body: repro(['Open drawer on Pixel 8', 'Use system back gesture'], 'Drawer closes', 'Browser navigates back, drawer stays open'),
          }),
          bug('Focus escapes the open drawer', { status: 'planned', priority: 'P2', summary: 'Tab moves to page content behind the drawer.' }),
        ),
      ),
      epic(
        'Microinteractions',
        { status: 'planned', summary: 'The polish layer: words, hints and motion.' },
        feature(
          'Localized labels',
          { status: 'planned', summary: 'Navigation in English, French, German and Arabic.', estimate: 8 },
          task('Extract nav strings into i18n catalog', { status: 'planned', estimate: 3, summary: 'All visible strings come from the catalog.' }),
          task('Right-to-left layout for Arabic', { status: 'planned', estimate: 3, summary: 'Mirror header and drawer for RTL locales.' }),
          bug('German labels truncate in header', { status: 'planned', priority: 'P2', summary: '"Sonderangebote" is cut off at 1280px.' }),
          story('As a French shopper I see the menu in French', {
            status: 'planned',
            estimate: 2,
            summary: 'Locale picked from browser, overridable.',
            body: ac('Browser locale respected', 'Manual switch persists', 'No English fallbacks visible'),
          }),
        ),
        feature('Tooltips', { status: 'idea' }, task('Tooltips for icon-only buttons', { status: 'idea' }), task('Touch behaviour for tooltips', { status: 'idea' })),
        feature(
          'Animations',
          { status: 'planned', summary: 'Menu open/close and hover motion.' },
          task('Menu open/close transition', { status: 'planned', estimate: 1, summary: '200ms ease-out slide.' }),
          task('Respect prefers-reduced-motion', {
            status: 'planned',
            estimate: 1,
            summary: 'No motion for users who ask for less.',
            body: ac('All transitions disabled when reduced motion is set'),
          }),
          story('As a shopper I get feedback when I add to cart', { status: 'idea' }),
        ),
      ),
      epic(
        'Site map & page connections',
        { status: 'in_progress', summary: 'Every page a shopper can land on, and where each one leads. Turn on Routes to see the site map.' },
        feature(
          'Page inventory',
          { status: 'in_progress', summary: 'The pages of the storefront and their links.', assignee: 'lee' },
          page('Home', 'pg-home', 'done', ['pg-category', 'pg-search', 'pg-account', 'pg-cart'], { summary: 'Hero, featured categories, deals.' }),
          page('Category listing', 'pg-category', 'done', ['pg-product'], { summary: 'Grid of products in a department.' }),
          page('Search results', 'pg-search', 'in_progress', ['pg-product'], { summary: 'Ranked results with facets.' }),
          page('Product detail', 'pg-product', 'in_progress', ['pg-cart'], { summary: 'Gallery, price, reviews, add to cart.' }),
          page('Cart', 'pg-cart', 'in_progress', ['pg-checkout', 'pg-product'], { summary: 'Line items, totals, promo codes.' }),
          page('Checkout', 'pg-checkout', 'planned', ['pg-confirm'], { summary: 'Address, delivery, payment.' }),
          page('Order confirmation', 'pg-confirm', 'planned', ['pg-orders']),
          page('Account', 'pg-account', 'planned', ['pg-orders']),
          page('Order history', 'pg-orders', 'idea', ['pg-product']),
          page('Help centre', 'pg-help', 'idea', [], { summary: 'Nothing links here yet.' }),
        ),
        feature(
          'Breadcrumbs',
          { status: 'planned', summary: 'Show shoppers where they are and let them step back up.' },
          story('As a shopper I can step back up a level', {
            status: 'planned',
            estimate: 2,
            summary: 'Breadcrumb trail on category and product pages.',
            body: ac('Trail reflects category path', 'Each crumb is a link', 'Collapses on mobile'),
          }),
          task('Breadcrumb structured data', { status: 'planned', estimate: 1, summary: 'schema.org BreadcrumbList.' }),
        ),
        feature('404 & redirects', { status: 'idea' }, task('Redirect map from old URLs', { status: 'idea' })),
      ),
    ),
    area(
      'Catalog & Search',
      { status: 'in_progress', summary: 'Help shoppers find the right product fast.' },
      epic(
        'Search',
        { status: 'in_progress', place: 'top', summary: 'Type a few letters, land on the right product.' },
        feature(
          'Autocomplete',
          { status: 'in_progress', summary: 'Suggestions while typing.', estimate: 8, assignee: 'priya' },
          story('As a shopper I see suggestions as I type', {
            status: 'in_progress',
            estimate: 5,
            assignee: 'priya',
            summary: 'Top 6 products and 3 categories.',
            body: ac('Suggestions after 2 characters', 'Arrow keys move through results', 'Under 100ms p95'),
            links: [['depends', 'api-search']],
          }),
          task('Debounced query & keyboard navigation', { status: 'done', estimate: 2, assignee: 'priya', summary: '120ms debounce.' }),
          bug('Suggestions flicker on slow connections', { status: 'planned', priority: 'P2', summary: 'Stale responses overwrite newer ones.' }),
        ),
        feature(
          'Results relevance',
          { status: 'in_progress', summary: 'The right products at the top.', assignee: 'priya' },
          task('Tune synonym dictionary', { status: 'in_progress', estimate: 3, summary: 'tee → t-shirt, sneaker → trainer…' }),
          bug('Searching "tshirt" returns no results', {
            status: 'in_progress',
            priority: 'P0',
            assignee: 'priya',
            due: inDays(-4),
            body: repro(['Search for "tshirt"'], 'T-shirts are listed', 'Empty results page'),
          }),
          bug('Out-of-stock items ranked first', { status: 'planned', priority: 'P1', summary: 'Availability ignored by ranking.' }),
          bug('Plural queries miss matches', { status: 'planned', priority: 'P2' }),
        ),
        feature(
          'Filters & facets',
          { status: 'planned', summary: 'Narrow results by size, colour and price.', estimate: 8 },
          story('As a shopper I can filter by size, colour and price', {
            status: 'planned',
            estimate: 5,
            summary: 'Facets update counts live.',
            body: ac('Multiple facets combine', 'Counts update without reload', 'Filters survive back navigation'),
            links: [['depends', 'api-facets']],
          }),
          task('Facet counts API', { key: 'api-facets', status: 'planned', estimate: 3, assignee: 'sam', summary: 'Aggregations endpoint.' }),
        ),
      ),
      epic(
        'Product detail page',
        { status: 'in_progress', summary: 'Everything needed to decide.' },
        feature(
          'Image gallery',
          { status: 'done', summary: 'Swipeable, zoomable product images.' },
          task('Pinch-zoom gallery', { status: 'done', estimate: 2, summary: 'Touch and trackpad zoom.' }),
          task('Lazy-load thumbnails', { status: 'done', estimate: 1, summary: 'Native lazy loading.' }),
        ),
        feature(
          'Reviews & ratings',
          { status: 'planned', summary: 'Social proof on every product.' },
          story('As a shopper I can read reviews before buying', {
            status: 'planned',
            estimate: 3,
            summary: 'Average rating plus most helpful reviews.',
            body: ac('Average rating visible above the fold', 'Sort by most helpful', 'Paginates after 10'),
          }),
          story('As a buyer I can leave a review after delivery', { status: 'idea' }),
        ),
        feature('Size guide', { status: 'idea' }),
      ),
    ),
    area(
      'Cart & Checkout',
      { status: 'in_progress', place: 'right', summary: 'From "add to cart" to "order placed" with as little friction as possible.' },
      epic(
        'Cart',
        { status: 'in_progress', summary: 'Hold, review and adjust what you want to buy.' },
        feature(
          'Mini-cart',
          { status: 'in_progress', summary: 'Peek at the cart without leaving the page.' },
          story('As a shopper I can see my cart without leaving the page', {
            status: 'in_progress',
            estimate: 3,
            summary: 'Slide-over from the header cart button.',
            body: ac('Opens from header cart button', 'Shows items and subtotal', 'Checkout button inside'),
          }),
          task('Cart badge count', { status: 'done', estimate: 1, summary: 'Live item count in the header.' }),
        ),
        feature('Save for later', { status: 'idea' }, story('As a shopper I can move items to a wishlist', { status: 'idea' })),
      ),
      epic(
        'Checkout',
        { status: 'in_progress', summary: 'Address, delivery and payment in three steps.', due: inDays(45) },
        feature(
          'Guest checkout',
          { status: 'in_progress', summary: 'Buy without creating an account.', assignee: 'ana' },
          story('As a first-time shopper I can check out without an account', {
            status: 'in_progress',
            estimate: 5,
            assignee: 'ana',
            summary: 'Email only; offer account creation after purchase.',
            body: ac('Only email required', 'Account offered on confirmation page', 'Order lookup by email + number'),
          }),
          task('Email capture & order lookup', { status: 'planned', estimate: 2, assignee: 'ana', summary: 'Lookup page for guest orders.' }),
        ),
        feature(
          'Express pay',
          { status: 'planned', summary: 'Apple Pay and Google Pay. Waiting on the payment provider contract.' },
          task('Payment provider contract signed', {
            key: 'pay-contract',
            status: 'blocked',
            due: inDays(-10),
            summary: 'Legal review stalled.',
            links: [['depends', 'pay-sandbox']],
          }),
          story('As a mobile shopper I can pay with one tap', {
            status: 'planned',
            estimate: 5,
            summary: 'Wallet buttons on cart and checkout.',
            body: ac('Apple Pay on Safari', 'Google Pay on Chrome', 'Falls back to card form'),
            links: [['depends', 'pay-contract']],
          }),
        ),
        feature(
          'Address validation',
          { status: 'blocked', summary: 'Vendor API keys still pending.' },
          task('Integrate address lookup API', {
            status: 'blocked',
            estimate: 3,
            summary: 'Autocomplete addresses as you type.',
            links: [['depends', 'addr-vendor']],
          }),
          bug('Postal codes with spaces rejected', { status: 'planned', priority: 'P1', body: repro(['Enter "K1A 0B1"'], 'Accepted', 'Validation error') }),
          bug('Apartment numbers dropped from shipping label', { status: 'planned', priority: 'P2' }),
        ),
        feature(
          'Order confirmation emails',
          { status: 'planned', summary: 'Receipt and shipping updates.' },
          task('Transactional email templates', { status: 'planned', estimate: 3, links: [['depends', 'ds-tokens']], summary: 'MJML templates using brand tokens.' }),
        ),
      ),
    ),
    area(
      'Accounts & Identity',
      { status: 'planned', place: 'top-right', summary: 'Who the shopper is, and what they have bought.' },
      epic(
        'Sign in',
        { status: 'in_progress', summary: 'Fast, safe ways to get back into an account.' },
        feature(
          'Passkeys',
          { status: 'planned', summary: 'Passwordless sign-in.' },
          story('As a returning shopper I can sign in with a passkey', {
            status: 'planned',
            estimate: 5,
            summary: 'WebAuthn with password fallback.',
            body: ac('Register passkey from account page', 'Sign in without password', 'Fallback to password'),
          }),
        ),
        feature('Social login', { status: 'idea' }, story('Sign in with Google or Apple', { status: 'idea' })),
        feature(
          'Password reset',
          { status: 'in_progress', summary: 'Recover access by email.', assignee: 'devon' },
          task('Reset email flow', { status: 'done', estimate: 2, assignee: 'devon', summary: 'Signed, single-use links.' }),
          bug('Reset link expires immediately', {
            status: 'in_progress',
            priority: 'P0',
            assignee: 'devon',
            body: repro(['Request reset', 'Open the email link'], 'Reset form', '"Link expired"'),
          }),
        ),
      ),
      epic(
        'Order history',
        { status: 'idea' },
        story('As a customer I can see past orders and re-order', { status: 'idea' }),
        story('As a customer I can track a shipment', { status: 'idea' }),
      ),
    ),
    area(
      'Footer & help',
      { status: 'planned', place: 'bottom', summary: 'The bottom of every page: help, legal and the newsletter.' },
      feature(
        'Footer links',
        { status: 'planned', estimate: 3, summary: 'Help, returns, contact and legal. Columns on desktop, an accordion on phones.' },
        task('Footer columns & accordion', { status: 'planned', estimate: 2, summary: 'Columns from 768px up, accordion below.', links: [['navigates', 'pg-help']] }),
        task('Legal & cookie links', { status: 'planned', estimate: 1 }),
      ),
      story('As a shopper I can sign up for the newsletter from any page', { status: 'idea' }),
      task('Cookie consent banner', { status: 'planned', estimate: 2, summary: '"Reject all" as prominent as "Accept all".' }),
    ),
    area(
      'Mobile app',
      {
        status: 'idea',
        surface: 'mobile',
        summary: 'Native iOS and Android apps for repeat shoppers. Mostly uncharted.',
      },
      feature(
        'Tab bar',
        { status: 'idea', place: 'bottom' },
        story('As a shopper I can jump between Home, Search, Cart and Account with my thumb', { status: 'idea' }),
      ),
      feature('Home feed', { status: 'idea' }, story('As a returning shopper I see picks based on what I bought', { status: 'idea' })),
      feature('Push notifications', { status: 'idea', summary: 'Price drops and delivery updates.' }),
      story('As a shopper I can scan a barcode in store to see reviews', { status: 'idea' }),
      task('App store listing', { status: 'idea' }),
    ),
    area(
      'Storefront API',
      { status: 'in_progress', surface: 'api', summary: 'The one API the web and mobile apps talk to.' },
      epic(
        'Catalog API',
        { status: 'in_progress', summary: 'Search, products and prices.', assignee: 'sam' },
        task('Search endpoint v2', { key: 'api-search', status: 'in_progress', estimate: 5, assignee: 'sam', summary: 'Typo tolerance and synonyms.' }),
        task('Inventory sync job', { status: 'done', estimate: 3, assignee: 'sam', summary: 'Every 5 minutes from the ERP.' }),
        bug('Prices cached for 24h after a change', { status: 'planned', priority: 'P1', summary: 'CDN TTL too long for price fields.' }),
      ),
      epic(
        'Cart & order endpoints',
        { status: 'in_progress', summary: 'Everything the cart and checkout pages call.' },
        task('Cart endpoints', { status: 'done', estimate: 3, assignee: 'sam', summary: 'Add, update, remove, merge on sign-in.' }),
        task('Create order endpoint', {
          status: 'planned',
          estimate: 3,
          summary: 'Idempotent, so a double-click never places two orders.',
          body: ac('Idempotency key required', 'Returns the order number', 'Rejects stale cart versions'),
          links: [['depends', 'orders-sm']],
        }),
        task('Rate limiting', { status: 'idea' }),
      ),
    ),
    area(
      'Order service',
      { status: 'in_progress', surface: 'service', summary: 'Owns orders from "placed" to "delivered". Talks to payments and email.' },
      task('Orders REST handlers', { status: 'in_progress', estimate: 3, assignee: 'sam', summary: 'Create, read and cancel orders.' }),
      task('Order state machine', {
        key: 'orders-sm',
        status: 'planned',
        estimate: 5,
        summary: 'Placed → paid → packed → shipped → delivered, plus cancel and refund.',
        body: ac('Every transition is logged', 'Refunds only from paid or later', 'Shipped orders cannot be cancelled'),
        links: [['depends', 'pay-sandbox']],
      }),
      task('Orders database schema', { status: 'done', estimate: 2, summary: 'Orders, lines and events tables.' }),
      task('Outbox events to email & analytics', { status: 'planned', estimate: 3, summary: 'Reliable events after each state change.' }),
      bug('Duplicate orders on double-click', {
        status: 'planned',
        priority: 'P1',
        body: repro(['Add an item', 'Double-click "Place order"'], 'One order', 'Two orders, card charged twice'),
      }),
    ),
    area(
      'Design System',
      { status: 'in_progress', place: 'offscreen', summary: 'Shared tokens and components so every page looks and behaves the same.' },
      epic(
        'Foundations',
        { status: 'done', summary: 'Colour, spacing and type.' },
        task('Colour & spacing tokens', { key: 'ds-tokens', status: 'done', estimate: 3, summary: 'CSS custom properties.' }),
        task('Type scale', { status: 'done', estimate: 1, summary: 'Fluid scale, 6 steps.' }),
        task('Dark mode palette', { status: 'done', estimate: 2, summary: 'Automatic via prefers-color-scheme.' }),
      ),
      epic(
        'Components',
        { status: 'in_progress', summary: 'The building blocks.' },
        feature(
          'Buttons',
          { key: 'ds-buttons', status: 'done', summary: 'Primary, secondary, icon and link buttons.' },
          task('Button states', { status: 'done', estimate: 1, summary: 'Hover, focus, pressed, disabled.' }),
          task('Icon button', { status: 'done', estimate: 1, summary: 'Square hit target, tooltip slot.' }),
        ),
        feature(
          'Form controls',
          { status: 'in_progress', summary: 'Inputs, selects, checkboxes.' },
          task('Text field', { status: 'done', estimate: 1, summary: 'Label, hint and error slots.' }),
          task('Select', { status: 'in_progress', estimate: 2, summary: 'Native on mobile, custom on desktop.' }),
          bug('Select menu clipped inside modals', { status: 'planned', priority: 'P2' }),
        ),
        feature(
          'Dialogs & sheets',
          { status: 'planned', summary: 'Modal dialog and mobile bottom sheet.' },
          task('Modal dialog', { status: 'planned', estimate: 2, summary: 'Focus-trapped, escape to close.' }),
          task('Bottom sheet', { status: 'planned', estimate: 3, summary: 'Draggable sheet for mobile.', links: [['relates', 'nav-drawer']] }),
        ),
      ),
    ),
    area(
      'Platform & Performance',
      { status: 'in_progress', place: 'offscreen', summary: 'Fast, observable, and safe to release.' },
      epic(
        'Core Web Vitals',
        { status: 'in_progress', summary: 'Green vitals on every template.', due: inDays(20) },
        task('LCP under 2.5s on product page', {
          status: 'in_progress',
          estimate: 5,
          assignee: 'lee',
          health: 'at_risk',
          summary: 'Currently 3.4s on mid-range Android.',
          body: ac('p75 LCP < 2.5s in RUM', 'Hero image preloaded', 'No render-blocking fonts'),
        }),
        task('Image CDN with AVIF', { status: 'planned', estimate: 3, summary: 'Responsive images at the edge.' }),
        bug('Layout shift when fonts load', { status: 'planned', priority: 'P2', summary: 'CLS 0.18 on home.' }),
      ),
      epic('Observability', { status: 'idea' }, task('Real user monitoring', { status: 'idea' }), task('Error tracking', { status: 'idea' })),
      epic(
        'Release pipeline',
        { status: 'done', summary: 'Ship small, ship often.' },
        task('CI on every pull request', { status: 'done', estimate: 2, summary: 'Lint, test, build.' }),
        task('Feature flags', { status: 'done', estimate: 2, summary: 'Percentage rollouts.' }),
        task('Preview environments', { status: 'done', estimate: 3, summary: 'One per pull request.' }),
      ),
    ),
    area(
      'Payment provider',
      { status: 'blocked', surface: 'external', summary: 'Cards, Apple Pay and Google Pay. The contract is still with legal.' },
      task('Sandbox keys & webhooks', { key: 'pay-sandbox', status: 'blocked', estimate: 2, summary: 'Test keys arrive once the contract is signed.' }),
      task('PCI self-assessment', { status: 'idea' }),
    ),
    area(
      'Address lookup provider',
      { status: 'planned', surface: 'external' },
      task('Pick a vendor', { key: 'addr-vendor', status: 'planned' }),
    ),
  ],
};

/** Flatten the demo tree into stored nodes with fresh ids and resolved links. */
export function demoProject() {
  const nodes = [];
  const keys = new Map();
  const pendingLinks = [];
  const now = new Date().toISOString();

  (function walk(n, parentId, order) {
    const { children = [], key, links = [], ...fields } = n;
    const id = parentId ? newId() : ROOT_ID;
    if (key) keys.set(key, id);
    const stored = {
      tags: [],
      health: 'auto',
      definition: 'auto',
      priority: '',
      place: 'auto',
      surface: 'auto',
      summary: '',
      body: '',
      assignee: '',
      due: '',
      estimate: null,
      weight: null,
      url: '',
      status: 'planned',
      ...fields,
      id,
      parentId,
      order,
      links: [],
      createdAt: now,
      updatedAt: now,
    };
    nodes.push(stored);
    for (const [type, to] of links) pendingLinks.push([stored, type, to]);
    children.forEach((c, i) => walk(c, id, i));
  })(tree, null, 0);

  for (const [stored, type, to] of pendingLinks) {
    const target = keys.get(to);
    if (target) stored.links.push({ to: target, type, label: '' });
  }
  return { title: tree.title, summary: tree.summary, nodes };
}
