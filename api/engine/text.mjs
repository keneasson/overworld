// Small, deterministic text helpers shared by the import engine.

const STOP = new Set(
  `a an and are as at be been but by can do does for from has have how if in into is it its no not of on or our so that the their them then there these this to too was we were what when where which who why will with without you your
  all any each every just more most new old one only other same some than very via vs per also get gets use used uses using make makes made add adds added fix fixes fixed
  should must may might would could need needs today now still yet already instead about after before over under up out off`.split(/\s+/),
);
// Words that name code, not product (they would match everything).
const CODE = new Set(
  'src app apps lib libs util utils index page pages route routes component components tsx ts js jsx mjs json md test tests spec file files code api next'.split(' '),
);

export function stem(word) {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) return w.slice(0, -1);
  return w;
}

/** Content words: lower case, split on non-letters and camelCase, stemmed, no stop words. */
export function words(text, { code = false } = {}) {
  return String(text ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !STOP.has(w) && (code || !CODE.has(w)))
    .map(stem);
}

const SMALL = new Set(['ui', 'ux', 'api', 'id', 'rb', 'faq', 'pii', 'otp', 'sms', 'cms', 'ses', 'pdf', 'aws', 'sam', 'gcp', 'ci', 'cdn', 'sql', 'db', 'css', 'seo', 'sso']);
/** "email-preferences" -> "Email preferences", "ui-ux" -> "UI/UX". */
export function humanize(segment) {
  const special = {
    'ui-ux': 'UI/UX',
    auth: 'Sign-in',
    api: 'API',
    dynamodb: 'DynamoDB',
    graphql: 'GraphQL',
    oauth: 'OAuth',
    ios: 'iOS',
    youtube: 'YouTube',
    adr: 'Decisions (ADRs)',
    e2e: 'End-to-end',
  };
  if (special[segment]) return special[segment];
  const text = segment
    .replace(/\.(tsx?|jsx?|mjs|vue|svelte|mdx?)$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (SMALL.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()))
    .join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
