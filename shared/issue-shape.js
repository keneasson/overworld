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

/** A "## " heading the shape doesn't have, or a section written twice: words saved as headings (#78, #81). */
export const hasStrayHeadings = (shape) => {
  const names = shape.sections.map((s) => s.name);
  return names.some((n, i) => !SECTIONS.includes(n) || names.indexOf(n) !== i);
};

// Words typed into a heading read like a sentence; a short label is a sub-heading.
const isProse = (words) => words.split(/\s+/).length > 5 || /[.!?;:,]/.test(words);

/**
 * The issue in the strict shape, keeping every word (EDIT-18): a stray heading is text of the section it sits in.
 * One that starts with a section's name ("Acceptance: as a user …") opens that section with the rest of its words,
 * prose becomes a paragraph, a short label a "### " sub-heading, and an empty one goes; a section written twice is one.
 * Markdown already in the shape comes back exactly as it was.
 */
export function reshapeIssue(markdown = '') {
  const shape = parseIssue(markdown);
  if (!hasStrayHeadings(shape)) return markdown;
  const bodies = new Map(SECTIONS.map((s) => [s, []]));
  let at = 'Why';
  for (const s of shape.sections) {
    const words = s.heading.replace(/^##[ \t]*/, '').trim();
    const named = SECTIONS.includes(s.name)
      ? { name: s.name, rest: '' }
      : SECTIONS.map((name) => ({ name, m: words.match(new RegExp(`^${name.replace('Behaviours', 'Behaviou?rs')}\\b\\s*(:?)\\s*(.*)$`, 'i')) }))
          .filter(({ m }) => m && m[2] && (m[1] || isProse(m[2])))
          .map(({ name, m }) => ({ name, rest: m[2] }))[0];
    if (named) at = named.name;
    const lead = named ? named.rest : !words ? '' : isProse(words) ? words : `### ${words}`;
    bodies.get(at).push(...[lead, contentOf(s.raw)].filter(Boolean));
  }
  const head = shape.head.trim();
  const text = [head, ...SECTIONS.map((name) => [`## ${name}`, ...bodies.get(name)].join('\n\n'))].filter(Boolean).join('\n\n');
  return `${text}\n`;
}

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

// ---- A new item ------------------------------------------------------------------------------

const TEMPLATE_HINTS = {
  Why: '<!-- The problem, for whom, and why now. -->',
  Behaviours: '<!-- One per line, each with an ID: AREA-01 Given … when … then … -->',
  'Open questions': '<!-- While anything is listed here, the issue needs a decision before work starts. -->',
};
const KIND_WORD = { epic: 'Epic', feature: 'Feature', story: 'Story', task: 'Task', bug: 'Bug' };

/** The place written in an item's head ("Kind: … · Place: checkout"), or ''. */
export const placeOf = (markdown = '') => parseIssue(markdown).head.match(/^Kind:.*?·\s*Place:[ \t]*(.*)$/im)?.[1].trim() ?? '';

/** The first of the places a parent lists ("the editor (`web/src/editor`), the API and sync" -> "the editor (`web/src/editor`)"). */
export function firstPlace(place = '') {
  let depth = 0;
  let code = false;
  for (let i = 0; i < place.length; i++) {
    const c = place[i];
    if (c === '`') code = !code;
    else if (!code && '([{'.includes(c)) depth++;
    else if (!code && ')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (!code && !depth && (c === ',' || c === ';' || place.startsWith(' and ', i))) return place.slice(0, i).trim();
  }
  return place.trim();
}

/**
 * A new item's markdown: the issue template (.github/ISSUE_TEMPLATE/work.md) in the strict shape (NEW-01).
 * Its place is the first of its parent's (EDIT-22): a child is in one place, its parent may span several.
 * @param {{ kind: string, partOf?: string, place?: string }} o partOf: how the item refers to its parent ("#12"), if it has one
 */
export function newItemMarkdown({ kind, partOf = '', place = '' }) {
  const head = [partOf ? `Part of ${partOf}` : '', `Kind: ${KIND_WORD[kind] ?? 'Task'} · Place: ${firstPlace(place)}`.trimEnd()].filter(Boolean).join('\n');
  return `${head}\n\n${SECTIONS.map((s) => (TEMPLATE_HINTS[s] ? `## ${s}\n\n${TEMPLATE_HINTS[s]}` : `## ${s}`)).join('\n\n')}\n`;
}

// ---- Behaviours ----------------------------------------------------------------------------

const ITEM = /^\s*[-*]\s+(.*)$/;
// An ID is AREA-NN, or a draft's placeholder AREA-?N until its first save numbers it (#13 ADOPT-11).
const ID = /^(?:\*\*)?`?([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)-(\d+|\?\d*)`?(?:\*\*)?:?\s+([\s\S]*)$/;
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

/** A behaviour still in the Fog: written as `AREA-NN Not worked out yet: …` (#32 STATE-04). */
export const notWorkedOut = (row) => /^not worked out yet\b/i.test(row.text || row.given || '');

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
const PLACEHOLDER = /^([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)-\?(\d*)$/;

/** A draft behaviour's ID before its first save: AREA-?N, which the server swaps for the area's next number (#13 ADOPT-11). */
export const isPlaceholder = (id) => PLACEHOLDER.test(String(id ?? ''));

/** The prefix an issue's behaviours already use, or one made from its title ("Area editor" -> AREA). */
export function behaviourPrefix(rows, title = '') {
  const counts = new Map();
  for (const r of rows) {
    const p = r.id.replace(/-(\d+|\?\d*)$/, '');
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

/** The ID a new behaviour is drafted with: a placeholder, never a number, so an abandoned draft uses none (#13 ADOPT-11). */
export function placeholderId(prefix, markdown = '', after = 0) {
  let n = after;
  for (const m of String(markdown).matchAll(/\b([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)-\?(\d+)/g)) if (m[1] === prefix) n = Math.max(n, Number(m[2]));
  return `${prefix}-?${n + 1}`;
}

/** The highest number given for each prefix in these texts: what an area's counter must stay above. */
export function highestIds(texts) {
  const max = new Map();
  for (const t of texts) for (const m of String(t ?? '').matchAll(ANY_ID)) max.set(m[1], Math.max(max.get(m[1]) ?? 0, Number(m[2])));
  return max;
}

const BULLET = /^(\s*[-*]\s+(?:\*\*)?`?)([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-(?:\d+|\?\d*))?/;

/**
 * The behaviours in an item's text still to be numbered, each with its prefix: every placeholder, and with `bare`, every
 * behaviour written without an ID that `previous` (the item before) didn't have, as one arriving from the store may be.
 * @returns {{ line: number, prefix: string, placeholder: string|null }[]}
 */
export function unnumbered(markdown = '', { title = '', bare = false, previous = null } = {}) {
  const shape = parseIssue(markdown);
  const rows = parseBehaviours(sectionText(shape, 'Behaviours'));
  const had = new Set(previous == null ? [] : parseBehaviours(sectionText(parseIssue(previous), 'Behaviours')).map((r) => said({ ...r, raw: null })));
  const prefix = behaviourPrefix(rows.filter((r) => r.id && !isPlaceholder(r.id)), title);
  const out = [];
  let section = null;
  String(markdown).split('\n').forEach((line, i) => {
    const h = line.match(/^##\s+(.*?)\s*$/);
    if (h) section = h[1].replace(/^behaviors$/i, 'Behaviours');
    if (section !== 'Behaviours' || !ITEM.test(line)) return;
    const row = readItem(line.match(ITEM)[1]);
    if (isPlaceholder(row.id)) out.push({ line: i, prefix: row.id.replace(/-\?\d*$/, ''), placeholder: row.id });
    else if (bare && !row.id && (row.text || row.given) && !had.has(said({ ...row, raw: null }))) out.push({ line: i, prefix, placeholder: null });
  });
  return out;
}

/** The text with each of `unnumbered`'s lines given its ID (`ids`, line -> ID), everything else exactly as it was. */
export function withIds(markdown, ids) {
  return String(markdown)
    .split('\n')
    .map((line, i) => (ids.has(i) ? line.replace(BULLET, (_, lead, old) => (old ? `${lead}${ids.get(i)}` : `${lead}${ids.get(i)} `)) : line))
    .join('\n');
}

/**
 * The text with placeholders swapped for the numbers a save gave them, as the editor then shows them. `given` lists them in
 * the order they were written ({ placeholder, id }), so the same placeholder written twice still gets two numbers.
 */
export function renumbered(markdown, given = []) {
  if (!given.length) return markdown;
  const queue = new Map();
  for (const g of given) queue.set(g.placeholder, [...(queue.get(g.placeholder) ?? []), g.id]);
  const ids = new Map(unnumbered(markdown).flatMap((u) => (queue.get(u.placeholder)?.length ? [[u.line, queue.get(u.placeholder).shift()]] : [])));
  return withIds(markdown, ids);
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

// ---- A refinement against the spec (#13 ADOPT-02) ----------------------------------------------

/**
 * What a refinement changes in an item, readably: its title, each behaviour (matched by ID) and each other
 * section, as added, changed or removed. Unchanged parts are left out, and so is a difference in spacing or blank lines.
 * With `base` (the item as the refinement found it), its changes are what it changed from that (#13 ADOPT-17): a part it
 * didn't touch is left out even where the item has changed since, by someone else or by the editor; a part it did touch
 * that has changed since is marked `conflict`. Without one (a new item), it is read against `adopted`.
 * @param {{ title: string, markdown: string }} adopted  the item as the spec holds it
 * @param {{ title: string, markdown: string }} proposed the refinement's version
 * @param {{ title: string, markdown: string } | null} [base] the item as the refinement started from it
 * @returns {{ title: { before: string, after: string, conflict?: true } | null, behaviours: { key: string, id: string, change: string, before: string, after: string, conflict?: true }[], sections: { name: string, change: string, before: string, after: string, conflict?: true }[] }}
 */
export function compareItems(adopted, proposed, base = null) {
  const now = partsOf(adopted), to = partsOf(proposed), from = base ? partsOf(base) : now;
  const changes = (kind) => [...new Set([...now[kind].keys(), ...from[kind].keys(), ...to[kind].keys()])].flatMap((k) => {
    const x = from[kind].get(k) ?? '', y = to[kind].get(k) ?? '', here = now[kind].get(k) ?? '';
    if (flat(x) === flat(y) || flat(here) === flat(y)) return []; // not changed by it, or already so
    const conflict = flat(here) !== flat(x);
    return [{ key: k, change: !x ? 'added' : !y ? 'removed' : 'changed', before: conflict ? x : here, after: y, ...(conflict ? { conflict: true } : {}) }];
  });
  const [title] = changes('title');
  return {
    title: title ? { before: title.before, after: title.after, ...(title.conflict ? { conflict: true } : {}) } : null,
    behaviours: changes('behaviours').map(({ key, ...c }) => ({ key, id: key.startsWith('text:') ? '' : key, ...c })),
    sections: changes('sections').map(({ key, ...c }) => ({ name: key, ...c })),
  };
}

// An item as the parts a refinement changes: its title, each behaviour by its key, and each other section ('Head' for the lines before the first).
function partsOf(item) {
  const shape = parseIssue(item.markdown);
  return {
    title: new Map([['title', item.title.trim()]]),
    behaviours: new Map(parseBehaviours(sectionText(shape, 'Behaviours')).map((r) => [changeKeyOf(r), said(r)])),
    sections: new Map([['Head', contentOf(shape.head)], ...shape.sections.filter((s) => s.name !== 'Behaviours').map((s) => [s.name, contentOf(s.raw)])].filter(([, t]) => t)),
  };
}

// Text as compared: spacing and blank lines aside.
const flat = (text) => text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

// A behaviour row as said, whitespace aside, and the key a refinement's change to it goes by: its ID, or its words.
const said = (r) => writeBehaviour(r).replace(/^\s*[-*]\s+/, '').replace(/\s+/g, ' ').trim();
const changeKeyOf = (r) => r.id || `text:${said(r)}`;

/** Every change of a refinement that isn't a behaviour (its title and other sections) at once: what older clients tick (#13 ADOPT-05). */
export const OTHER_CHANGES = 'other';
/** A refinement's change to its title, and to one section ('Head' for the lines before the first), each decided on its own (#13 ADOPT-05). */
export const TITLE_CHANGE = 'title';
export const sectionKey = (name) => `section:${name}`;

/** What can be decided in a refinement of an item, one at a time: each changed behaviour by its key, then its title, then each changed section. */
export const changeKeys = (diff) => [...diff.behaviours.map((b) => b.key), ...(diff.title ? [TITLE_CHANGE] : []), ...diff.sections.map((s) => sectionKey(s.name))];

/** The keys (as changeKeys gives them) of the changes whose part has changed since the refinement was proposed. */
export const conflictKeys = (diff) => [...diff.behaviours.filter((b) => b.conflict).map((b) => b.key), ...(diff.title?.conflict ? [TITLE_CHANGE] : []), ...diff.sections.filter((s) => s.conflict).map((s) => sectionKey(s.name))];

/** Picks as changeKeys names them: OTHER_CHANGES, from an older client or a decision already recorded, stands for every title and section change in `all`. */
export const expandPicks = (picks, all) => [...new Set(picks.flatMap((p) => (p === OTHER_CHANGES ? all.filter((k) => k === TITLE_CHANGE || k.startsWith('section:')) : [p])))];

/**
 * `into` with the ticked changes of `from` (keys from changeKeys): each ticked behaviour as `from` has it (changed,
 * added where `from` puts it, or removed), its title with TITLE_CHANGE, and each section with its sectionKey (OTHER_CHANGES:
 * the title and every section). Nothing else moves, so adopting some of a refinement leaves the rest of the item as it
 * was, and declining some takes those back out of it. A section comes across only where `from` changed it from `base`
 * (without one, from `into`): what it didn't touch stays as `into` has it, whoever changed it there (#13 ADOPT-17).
 */
export function mergeChanges(into, from, picks, base = null) {
  const pick = new Set(picks);
  const every = pick.has(OTHER_CHANGES);
  const takes = (name) => every || pick.has(sectionKey(name));
  const rows = parseBehaviours(sectionText(parseIssue(into.markdown), 'Behaviours'));
  const theirs = parseBehaviours(sectionText(parseIssue(from.markdown), 'Behaviours'));
  const byKey = new Map(theirs.map((r) => [changeKeyOf(r), r]));
  let moved = false;
  for (const key of pick) {
    if (key === OTHER_CHANGES || key === TITLE_CHANGE || key.startsWith('section:')) continue;
    const at = rows.findIndex((r) => changeKeyOf(r) === key), row = byKey.get(key);
    if (at >= 0 && row) rows[at] = row;
    else if (at >= 0) rows.splice(at, 1);
    else if (row) {
      // After the last behaviour before it in `from` that is here too; first if there is none.
      const before = theirs.slice(0, theirs.indexOf(row)).map(changeKeyOf).reverse();
      const after = before.map((k) => rows.findIndex((r) => changeKeyOf(r) === k)).find((i) => i >= 0) ?? -1;
      rows.splice(after + 1, 0, row);
    } else continue;
    moved = true;
  }
  const title = (every || pick.has(TITLE_CHANGE)) && flat((base ?? into).title) !== flat(from.title) ? from.title : into.title;
  const sections = every || [...pick].some((k) => k.startsWith('section:'));
  if (!moved && !sections) return { title, markdown: into.markdown };
  const Behaviours = rows.map((r) => r.raw).join('\n');
  const shape = parseIssue(into.markdown);
  if (!sections) return { title, markdown: writeIssue(shape, { Behaviours }) };
  // Only the picked sections `from` changed from `base` come across, as `from` wrote them.
  const was = parseIssue((base ?? into).markdown), to = parseIssue(from.markdown);
  const raw = (sh, name) => (name === 'Head' ? sh.head : sh.sections.find((s) => s.name === name)?.raw ?? '');
  const names = [...new Set([...to.sections, ...was.sections].map((s) => s.name).filter((n) => n !== 'Behaviours'))];
  const edits = moved ? { Behaviours } : {};
  if (takes('Head') && flat(contentOf(was.head)) !== flat(contentOf(to.head))) shape.head = to.head;
  for (const name of names) {
    if (!takes(name) || flat(contentOf(raw(was, name))) === flat(contentOf(raw(to, name)))) continue;
    const at = shape.sections.findIndex((s) => s.name === name);
    if (!to.sections.some((s) => s.name === name)) {
      if (at >= 0) shape.sections.splice(at, 1);
    } else if (at >= 0) shape.sections[at].raw = rewrap(shape.sections[at].raw, raw(to, name), at === shape.sections.length - 1);
    else edits[name] = raw(to, name);
  }
  return { title, markdown: writeIssue(shape, edits) };
}

// `list` with the entries of `was` that aren't in it and are `gone` put back, each after the last entry before it that is there (first if none).
function keepGone(list, was, keyOf, gone) {
  const out = [...list];
  const here = new Set(list.map(keyOf));
  was.forEach((x, i) => {
    if (here.has(keyOf(x)) || !gone(x)) return;
    const prev = was.slice(0, i).map(keyOf).reverse().map((k) => out.findIndex((y) => keyOf(y) === k)).find((j) => j >= 0) ?? -1;
    out.splice(prev + 1, 0, x);
  });
  return out;
}

/**
 * An item with a refinement's changes in their places, for reading it once with its edits marked in it (#13 ADOPT-18):
 * the item as it would be with every change adopted, in reading order, removed parts kept where they were. Each part
 * carries the key (as changeKeys gives it) of the change it is, or null where the refinement left it alone.
 * @returns {{ diff: object, title: string | null, parts: ({ section: string, key: string | null, text: string } | { section: 'Behaviours', key: null, rows: { key: string | null, text: string }[] })[] }}
 */
export function reviewOf(adopted, proposed, base = null) {
  const diff = compareItems(adopted, proposed, base);
  const keys = changeKeys(diff);
  const now = parseIssue(adopted.markdown), to = parseIssue(mergeChanges(adopted, proposed, keys, base).markdown);
  const touched = new Set(diff.sections.map((s) => s.name)), moved = new Set(diff.behaviours.map((b) => b.key));
  const part = (name, text) => ({ section: name, key: touched.has(name) ? sectionKey(name) : null, text });
  const rowsOf = (shape) => parseBehaviours(sectionText(shape, 'Behaviours'));
  const rows = keepGone(rowsOf(to), rowsOf(now), changeKeyOf, (r) => moved.has(changeKeyOf(r))).map((r) => ({ key: moved.has(changeKeyOf(r)) ? changeKeyOf(r) : null, text: r.raw.replace(/^\s*[-*]\s+/, '') }));
  const names = keepGone(to.sections.map((s) => s.name), now.sections.map((s) => s.name), (n) => n, (n) => touched.has(n) || (n === 'Behaviours' && rows.length));
  const parts = [
    ...(contentOf(to.head) || touched.has('Head') ? [part('Head', contentOf(to.head))] : []),
    ...names.map((n) => (n === 'Behaviours' ? { section: n, key: null, rows } : part(n, sectionText(to, n)))),
  ];
  return { diff, title: diff.title ? TITLE_CHANGE : null, parts };
}

// ---- Carrying a refinement onto the item as it now is ---------------------------------------------

// Lines a and b say the same, spacing aside.
const sameLine = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

// Pairs [i, j] of lines a[i] and b[j] that stay the same from a to b (a longest common subsequence).
function common(a, b) {
  const n = a.length, m = b.length;
  const len = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) len[i][j] = sameLine(a[i], b[j]) ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
  const out = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (sameLine(a[i], b[j])) out.push([i++, j++]);
    else if (len[i + 1][j] >= len[i][j + 1]) i++;
    else j++;
  }
  return out;
}

const sameLines = (a, b) => a.length === b.length && a.every((l, i) => sameLine(l, b[i]));
const endsWith = (a, b) => a.length >= b.length && sameLines(a.slice(a.length - b.length), b);
const startsWith = (a, b) => a.length >= b.length && sameLines(a.slice(0, b.length), b);

/**
 * Two edits of one text, line by line: what `ours` changed from `base` and what `theirs` changed from it, both kept, or null
 * where both changed the same lines. Lines one side only added next to lines the other changed are kept beside them.
 */
export function mergeLines(base, ours, theirs) {
  const o = base.split('\n'), a = ours.split('\n'), b = theirs.split('\n');
  const ma = new Map(common(o, a)), mb = new Map(common(o, b));
  // Lines of the base that both sides kept, in order: the text between them is merged a chunk at a time.
  const stable = o.map((_, i) => i).filter((i) => ma.has(i) && mb.has(i));
  const out = [];
  let oi = 0, ai = 0, bi = 0;
  for (const i of [...stable, o.length]) {
    const end = i === o.length;
    const oc = o.slice(oi, i), ac = a.slice(ai, end ? a.length : ma.get(i)), bc = b.slice(bi, end ? b.length : mb.get(i));
    if (sameLines(ac, oc)) out.push(...bc);
    else if (sameLines(bc, oc) || sameLines(ac, bc)) out.push(...ac);
    // One side only added lines before or after the base's; the other changed them. Both adding in one place is a clash.
    else if (!oc.length) return null;
    else if (endsWith(ac, oc)) out.push(...ac.slice(0, ac.length - oc.length), ...bc);
    else if (startsWith(ac, oc)) out.push(...bc, ...ac.slice(oc.length));
    else if (endsWith(bc, oc)) out.push(...bc.slice(0, bc.length - oc.length), ...ac);
    else if (startsWith(bc, oc)) out.push(...ac, ...bc.slice(oc.length));
    else return null;
    if (end) break;
    out.push(o[i]);
    oi = i + 1; ai = ma.get(i) + 1; bi = mb.get(i) + 1;
  }
  return out.join('\n');
}

/**
 * A refinement's edit carried onto the item as it now is (#13 ADOPT-17): where the item changed since the edit began and
 * the edit changed other lines of the same section, both are kept, so what it proposes is proposed against now and nothing
 * the server has is hidden from it. Null where a part both changed can't be merged: that is a conflict, and a person decides.
 * @returns {{ base: { title: string, markdown: string }, after: { title: string, markdown: string } } | null}
 */
export function rebaseEdit(now, after, base) {
  const diff = compareItems(now, after, base);
  if (diff.title?.conflict || diff.behaviours.some((b) => b.conflict)) return null;
  const clashing = diff.sections.filter((s) => s.conflict).map((s) => s.name);
  const shapes = [now, after, base].map((x) => parseIssue(x.markdown));
  const text = (shape, name) => (name === 'Head' ? contentOf(shape.head) : sectionText(shape, name));
  const merged = {};
  for (const name of clashing) {
    const m = mergeLines(text(shapes[2], name), text(shapes[0], name), text(shapes[1], name));
    if (m == null) return null;
    merged[name] = m;
  }
  // The base with the clashing sections as they are now, and the edit with them merged: then nothing clashes.
  const put = (shape, edits) => {
    const { Head, ...rest } = edits;
    const s = { ...shape, sections: shape.sections.map((x) => ({ ...x })) };
    if (Head != null) s.head = Head ? `${Head}\n\n` : '';
    return writeIssue(s, rest);
  };
  const base2 = { title: base.title, markdown: put(shapes[2], Object.fromEntries(clashing.map((n) => [n, text(shapes[0], n)]))) };
  const after2 = { title: after.title, markdown: put(shapes[1], merged) };
  return { base: now, after: mergeChanges(now, after2, changeKeys(compareItems(now, after2, base2)), base2) };
}
