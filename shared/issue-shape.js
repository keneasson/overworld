// The strict issue shape (see CONTRIBUTING.md), read and written without losing a character.
//
//   Part of #1                      the head: everything before the first "## "
//   Kind: Feature · Place: …
//   ## Why
//   ## Behaviours                   - AREA-01 Given …, when …, then …
//   ## Acceptance
//   ## Out of scope
//   ## Open questions
//
// Parsing keeps each section's raw text, and writing puts back the raw text of anything that was
// not edited, so GitHub markdown -> editor -> markdown is unchanged unless someone changed it.
// Used by the web editor and by the API when it applies a changeset.

export const SECTIONS = ['Why', 'Behaviours', 'Acceptance', 'Out of scope', 'Open questions'];
export const RICH_SECTIONS = SECTIONS.filter((s) => s !== 'Behaviours');

const HEADING = /^##[ \t]+(.+?)[ \t]*$/gm;
const canonical = (name) => SECTIONS.find((s) => s.toLowerCase() === name.trim().toLowerCase().replace(/^behaviors$/, 'behaviours')) ?? null;

// Template hints ("<!-- One per line … -->") are guidance for the writer, not content.
const COMMENT = /<!--[\s\S]*?-->/g;
export const hintOf = (raw) => [...raw.matchAll(COMMENT)].map((m) => m[0].slice(4, -3).trim()).join(' ');
export const contentOf = (raw) => raw.replace(COMMENT, '').trim();

/**
 * @returns {{ eol: string, head: string, sections: { name: string, heading: string, raw: string }[] }}
 *   name is the canonical section name (or the heading as written, for sections outside the shape)
 */
export function parseIssue(markdown = '') {
  const eol = /\r\n/.test(markdown) ? '\r\n' : '\n';
  const text = markdown.replace(/\r\n/g, '\n');
  const marks = [...text.matchAll(HEADING)];
  const head = marks.length ? text.slice(0, marks[0].index) : text;
  const sections = marks.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    return { name: canonical(m[1]) ?? m[1].trim(), heading: m[0], raw: text.slice(start, end) };
  });
  return { eol, head, sections };
}

/** Every section of the shape, once, in order, and nothing else. */
export function isWellFormed(shape) {
  const names = shape.sections.map((s) => s.name);
  return names.length === SECTIONS.length && names.every((n, i) => n === SECTIONS[i]);
}

export const sectionText = (shape, name) => contentOf(shape.sections.find((s) => s.name === name)?.raw ?? '');

/**
 * Write the issue back. `edits` maps a section name to its new content (markdown, without the heading).
 * Sections not in `edits` keep their raw text exactly. A missing shape section that gains content is
 * inserted where the shape says it belongs.
 */
export function writeIssue(shape, edits = {}) {
  const sections = shape.sections.map((s) => ({ ...s }));
  for (const [name, content] of Object.entries(edits)) {
    const at = sections.findIndex((s) => s.name === name);
    if (at >= 0) {
      if (contentOf(sections[at].raw) !== content.trim()) sections[at].raw = rewrap(sections[at].raw, content, at === sections.length - 1);
      continue;
    }
    if (!content.trim()) continue;
    const rank = SECTIONS.indexOf(name);
    let after = -1;
    sections.forEach((s, i) => {
      const r = SECTIONS.indexOf(s.name);
      if (r >= 0 && r < rank) after = i;
    });
    const last = after === sections.length - 1;
    if (last && sections.length) sections[after].raw = sections[after].raw.replace(/\n*$/, '\n\n');
    sections.splice(after + 1, 0, { name, heading: `## ${name}`, raw: rewrap('', content, last) });
  }
  let head = shape.head;
  if (sections.length && head && !/\n\n$/.test(head)) head = head.replace(/\n*$/, '\n\n');
  const text = head + sections.map((s) => s.heading + s.raw).join('');
  return shape.eol === '\n' ? text : text.replace(/\n/g, shape.eol);
}

// Keep the blank lines around a section as they were; a new or empty one gets the template's spacing.
function rewrap(raw, content, last) {
  const body = content.trim();
  if (!body) return last ? '\n' : '\n\n';
  const filled = /\S/.test(raw);
  return (filled ? raw.match(/^\s*/)[0] : '\n\n') + body + (filled ? raw.match(/\s*$/)[0] : last ? '\n' : '\n\n');
}

// ---- Behaviours ----------------------------------------------------------------------------

const ITEM = /^\s*[-*]\s+(.*)$/;
const ID = /^(?:\*\*)?`?([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)-(\d+)`?(?:\*\*)?:?\s+([\s\S]*)$/;
const GWT = /^given\s+([\s\S]+?),?\s+when\s+([\s\S]+?),?\s+then\s+([\s\S]+)$/i;

let rowSeq = 0;
const rowKey = () => `b${++rowSeq}`;

/**
 * One row per list item: { key, id, given, when, then, text, raw }.
 * `raw` is the item exactly as written; a row that is not edited is written back as `raw`.
 * Lines before the first item (rare) become a row of their own so nothing is dropped.
 */
export function parseBehaviours(content = '') {
  const rows = [];
  for (const line of contentOf(content).split('\n')) {
    const item = line.match(ITEM);
    if (item) rows.push({ raw: line, said: item[1] });
    else if (rows.length && line.trim()) {
      rows.at(-1).raw += `\n${line}`;
      rows.at(-1).said += ` ${line.trim()}`;
    } else if (line.trim()) rows.push({ raw: line, said: line.trim(), loose: true });
  }
  return rows.map(({ said, loose, ...r }) => ({ key: rowKey(), ...r, ...(loose ? { id: '', given: '', when: '', then: '', text: said } : readItem(said)) }));
}

function readItem(text) {
  const m = text.match(ID);
  const id = m ? `${m[1]}-${m[2]}` : '';
  const rest = (m ? m[3] : text).trim();
  const g = rest.match(GWT);
  return g ? { id, given: g[1].trim(), when: g[2].trim(), then: g[3].trim(), text: '' } : { id, given: '', when: '', then: '', text: rest };
}

export const isGwt = (row) => Boolean(row.given || row.when || row.then) || !row.text;

/** The markdown for one row: as it was written if untouched, otherwise in the shape's own words. */
export function writeBehaviour(row) {
  if (row.raw != null && !row.dirty) return row.raw;
  const id = row.id ? `${row.id} ` : '';
  if (!isGwt(row)) return `- ${id}${row.text.trim()}`;
  const clause = (s) => s.trim().replace(/[,.]$/, '');
  return `- ${id}Given ${clause(row.given)}, when ${clause(row.when)}, then ${row.then.trim()}`;
}

export const writeBehaviours = (rows) =>
  rows
    .filter((r) => r.raw != null || r.text.trim() || r.given.trim() || r.when.trim() || r.then.trim())
    .map(writeBehaviour)
    .join('\n');

export const blankBehaviour = (id) => ({ key: rowKey(), id, given: '', when: '', then: '', text: '', raw: null, dirty: true });

// ---- Behaviour IDs ---------------------------------------------------------------------------

const ANY_ID = /\b([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)-(\d{1,4})\b/g;

/** The prefix an issue's behaviours already use, or one made from its title ("Area editor" -> AREA). */
export function behaviourPrefix(rows, title = '') {
  const counts = new Map();
  for (const r of rows) {
    const p = r.id.replace(/-\d+$/, '');
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  if (counts.size) return [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const words = title
    .replace(/^#\d+\s*/, '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^(the|and|for|with|from|into|epic|feature|story|task|bug)$/i.test(w));
  return (words[0] ?? 'ITEM').toUpperCase().slice(0, 6);
}

/** The next free ID for a prefix, counting every behaviour already written in the area. */
export function nextBehaviourId(prefix, texts) {
  let max = 0;
  for (const t of texts) for (const m of String(t ?? '').matchAll(ANY_ID)) if (m[1] === prefix) max = Math.max(max, Number(m[2]));
  return `${prefix}-${String(max + 1).padStart(2, '0')}`;
}

// ---- The note the mapper adds to an issue's body on the map ----------------------------------

const TRAILER = /\n\n---\n📍 [^\n]*$/;

/** A mapped issue's body is the issue's markdown plus a "📍 why it's here" note. Split them. */
export function splitNote(body = '') {
  const m = body.match(TRAILER);
  return m ? { markdown: body.slice(0, m.index), note: m[0] } : { markdown: body, note: '' };
}

/** The GitHub issue a node stands for, from its link: { repo, number } or null. */
export function issueOf(node) {
  const m = String(node?.url ?? '').match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** The key an item keeps across refreshes: its issue number, or its node id for items made here. */
export const itemKeyOf = (node) => {
  const issue = issueOf(node);
  return issue ? `issue-${issue.number}` : `node-${node.id}`;
};

/** What the editor edits: the title without "#12 ", and the issue's markdown without the map's 📍 note. */
export function editableOf(node) {
  const issue = issueOf(node);
  const title = issue ? node.title.replace(new RegExp(`^#${issue.number}\\s+`), '') : node.title;
  return { title, markdown: splitNote(node.body ?? '').markdown };
}

/** "None", "n/a" or nothing: no open questions. Mirrors the mapper's reading (api/engine/lifecycle.mjs). */
export const hasOpenQuestions = (content) => Boolean(contentOf(content)) && !/^(none|n\/a|no open questions)\b/i.test(contentOf(content));
