// Behaviour specs: what the product must do, read from the repository.
//
//   Markdown specs  "| ID | Scenario | Status |" tables, status by ✅ ⚠️ ❌ ⏸ 🔷 (or the words)
//   Gherkin files   "Feature:" / "Scenario:" (tagged @wip / @todo when not built yet)

export const SPEC_PATH = /(^|\/)(behaviou?rs?|specs?|requirements|acceptance|features)\/(?!readme)[^/]+\.(md|feature)$/i;

const STATUS = [
  [/✅|\bimplemented\b|\bdone\b|\bpass(es|ing)?\b/i, 'done', 'auto'],
  [/⚠️|⚠|\bpartial\b/i, 'in_progress', 'auto'],
  [/❌|\bgap\b|\bmissing\b|\bnot (yet )?(built|implemented)\b/i, 'planned', 'auto'],
  [/⏸|\bdeferred\b|\blater\b/i, 'idea', 'auto'],
  [/🔷|\bdecision needed\b|\bdecide\b|\bopen question\b/i, 'idea', 'vague'],
];

const plain = (s) =>
  s
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();

function statusOf(text) {
  for (const [re, status, definition] of STATUS) if (re.test(text)) return { status, definition };
  return { status: 'planned', definition: 'auto' };
}

/** Parse one spec file into { title, summary, intro, sections: [{ title, scenarios: [{ id, text, status, definition, issues }] }] }. */
export function parseSpec(path, text) {
  return /\.feature$/i.test(path) ? parseGherkin(path, text) : parseMarkdown(path, text);
}

function parseMarkdown(path, text) {
  const lines = text.split('\n');
  const h1 = lines.find((l) => /^#\s+/.test(l));
  const title = plain((h1 ?? path.replace(/^.*\//, '').replace(/\.md$/, '')).replace(/^#\s+/, '').replace(/^(behaviou?r )?spec(ification)?s?:\s*/i, ''));
  const introLines = [];
  for (const l of lines.slice(h1 ? lines.indexOf(h1) + 1 : 0)) {
    if (/^##\s/.test(l)) break;
    introLines.push(l);
  }
  const intro = introLines.join('\n').trim();
  const summary = plain(
    intro
      .split('\n')
      .map((l) => l.replace(/^>\s?/, ''))
      .join(' ')
      .replace(/^\s*\*\*What this is\.?\*\*\s*/i, '')
      .split(/(?<=\.)\s/)[0] ?? '',
  ).slice(0, 300);

  const sections = [];
  let section = null;
  let columns = null;
  for (const l of lines) {
    const h = l.match(/^##+\s+(.*)$/);
    if (h) {
      // "## 2. Asking for a hidden detail — `CONTACT-ASK`": the code goes in the summary, not the name.
      section = { title: plain(h[1].replace(/\s*[—–-]\s*`[A-Z][\w-]+`/, '')).replace(/^\d+\.\s*/, ''), prefix: (h[1].match(/`([A-Z][\w-]+)`/) ?? [])[1] ?? '', scenarios: [] };
      sections.push(section);
      columns = null;
      continue;
    }
    if (!/^\s*\|/.test(l)) {
      columns = null;
      continue;
    }
    const cells = l
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!columns) {
      const lower = cells.map((c) => plain(c).toLowerCase());
      const id = lower.findIndex((c) => c === 'id');
      const what = lower.findIndex((c) => /scenario|behaviou?r|rule|requirement/.test(c));
      const status = lower.findIndex((c) => /status|state/.test(c));
      columns = what >= 0 && status >= 0 ? { id, what, status } : { skip: true };
      continue;
    }
    if (columns.skip || !section) continue;
    const statusText = cells[columns.status] ?? '';
    const scenario = {
      id: columns.id >= 0 ? plain(cells[columns.id] ?? '') : '',
      text: plain(cells[columns.what] ?? ''),
      statusText: plain(statusText),
      issues: [...statusText.matchAll(/#(\d+)/g), ...(cells[columns.what] ?? '').matchAll(/#(\d+)/g)].map((m) => Number(m[1])),
      ...statusOf(statusText),
    };
    if (scenario.text) section.scenarios.push(scenario);
  }
  return { path, title, summary, intro, sections: sections.filter((s) => s.scenarios.length) };
}

function parseGherkin(path, text) {
  const lines = text.split('\n');
  let title = path.replace(/^.*\//, '').replace(/\.feature$/, '');
  let summary = '';
  const sections = [{ title: 'Scenarios', prefix: '', scenarios: [] }];
  let tags = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('@')) tags = l.split(/\s+/);
    const feature = l.match(/^Feature:\s*(.*)$/);
    if (feature) {
      title = feature[1];
      summary = (lines[i + 1] ?? '').trim();
    }
    const rule = l.match(/^Rule:\s*(.*)$/);
    if (rule) sections.push({ title: rule[1], prefix: '', scenarios: [] });
    const sc = l.match(/^Scenario(?: Outline)?:\s*(.*)$/);
    if (sc) {
      const todo = tags.some((t) => /^@(wip|todo|pending|skip|ignore|manual)$/i.test(t));
      sections
        .at(-1)
        .scenarios.push({ id: '', text: sc[1], statusText: todo ? 'Not built yet' : 'Executable scenario', issues: [], status: todo ? 'planned' : 'done', definition: 'auto' });
      tags = [];
    } else if (!l.startsWith('@')) tags = l ? tags : [];
  }
  return { path, title, summary, intro: summary, sections: sections.filter((s) => s.scenarios.length) };
}
