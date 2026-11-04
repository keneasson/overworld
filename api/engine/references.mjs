// Nesting from what issues say about each other. Deterministic: the same issues
// always give the same tree, and every decision carries the sentence it came from.
//
// Strongest evidence wins:
//   4  GitHub's own sub-issue parent
//   3  "Part of #55", "Parent epic: #11", "Sub-issue of #9", "under Epic #55"
//   3  the parent lists it in a task list ("- [ ] #56", "- [x] Phase 1 … (#23)")
//   2  "Epic #131" / "(Epic #55)" in a sentence that isn't just a cross-reference
//   2  "(#270 Phase 2 step 0)" or "(#58, #270)" at the end of a title
//   1  "Follow-up to #124", "Design: … (#202)"

import { words } from './text.mjs';

const REF = '#(\\d+)';
// Lines that only point elsewhere ("Related: #20", "See #27") never nest anything.
const CROSS_REF_LINE =
  /^\s*(?:[-*>]\s*|\d+\.\s*)?(?:\*\*)?(?:related|relates|ties? (?:in )?to|see(?: also)?|overlaps?|builds on|refs?|references|coordinate|pairs?|similar|duplicates?|context|background|unifies)\b/i;
const CROSS_REF_HEADING =
  /\b(related|see also|refs?|references|context|background|prior art|history|links|overlaps?|known (?:issues|bugs)|depends|dependencies|blocked by|follow-?ups?)\b/i;

const PATTERNS = [
  { strength: 3, re: new RegExp(`\\bpart of\\b[^.\\n#]{0,60}?${REF}`, 'gi'), why: 'says it is part of' },
  { strength: 3, re: new RegExp(`\\bparent(?:\\s+(?:epic|issue))?\\s*:?\\s*${REF}`, 'gi'), why: 'names its parent' },
  { strength: 3, re: new RegExp(`\\b(?:sub-?issue|child|subtask|sub-task) of\\s+(?:epic\\s+|issue\\s+)?${REF}`, 'gi'), why: 'says it is a sub-issue of' },
  { strength: 3, re: new RegExp(`\\bunder\\s+(?:the\\s+)?epic\\s+${REF}`, 'gi'), why: 'says it sits under' },
  { strength: 3, re: new RegExp(`\\b(?:tracked|belongs) (?:in|by|to)\\s+(?:epic\\s+|issue\\s+)?${REF}`, 'gi'), why: 'says it is tracked in' },
  { strength: 2, re: new RegExp(`(?<!\\bsee\\s)\\bepic\\s*${REF}`, 'gi'), why: 'names its epic' },
  { strength: 1, re: new RegExp(`\\bfollow-?up (?:to|of|on)\\s+(?:issue\\s+)?${REF}`, 'gi'), why: 'is a follow-up to' },
  { strength: 1, re: new RegExp(`${REF}\\s+follow-?up\\b`, 'gi'), why: 'is a follow-up to' },
  { strength: 1, re: new RegExp(`\\bdesign(?: issue)?\\s*:?[^#\\n]{0,60}?\\(${REF}\\)`, 'gi'), why: 'implements the design in' },
];

/** Lines of an issue body that can carry nesting evidence (no quotes, code or cross-reference sections). */
function meaningfulLines(body) {
  const out = [];
  let section = '';
  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*>/.test(line)) continue;
    const heading = line.match(/^\s*(?:#{1,6}\s+(.*)|\*\*([^*]+)\*\*:?\s*$|([A-Z][\w /&-]{2,40}):\s*$)/);
    if (heading) section = heading[1] ?? heading[2] ?? heading[3] ?? '';
    out.push({ line, section });
  }
  return out;
}

/** Candidate parents an issue claims for itself. */
function claims(issue, known) {
  const found = [];
  const add = (number, strength, why, text) => {
    if (number === issue.number || !known.has(number)) return;
    found.push({ number, strength, why, quote: text.trim().slice(0, 160), at: found.length });
  };
  if (issue.parent && known.has(issue.parent)) found.push({ number: issue.parent, strength: 4, why: 'is a GitHub sub-issue of', quote: '', at: -1 });

  // "(#270 Phase 2 step 0)" / "(#58, #270)" / "(Epic #55)" at the end of a title.
  const tail = issue.title.match(/\(([^()]*#\d+[^()]*)\)\s*$/);
  if (tail && !/\bfollow-?up\b/i.test(tail[1])) {
    const first = tail[1].match(/#(\d+)/);
    if (first) add(Number(first[1]), 2, 'names its parent in the title', issue.title);
  }

  const lines = [{ line: issue.title, section: '' }, ...meaningfulLines(issue.body ?? '')];
  for (const { line, section } of lines) {
    if (CROSS_REF_LINE.test(line)) continue;
    const crossSection = CROSS_REF_HEADING.test(section);
    for (const p of PATTERNS) {
      if (crossSection && p.strength < 3) continue;
      p.re.lastIndex = 0;
      for (const m of line.matchAll(p.re)) add(Number(m[1]), p.strength, p.why, line);
    }
  }
  return found;
}

/**
 * Children a parent issue lists in its own task lists. An item is about an issue
 * when it starts with it ("- [ ] #56 …") or ends with it ("- [x] Phase 1 … (#23)");
 * "Connect with the email system (issue #15)" is a to-do that mentions one, not a child.
 * An item without a number names an issue when it reads like that issue's title
 * ("- [ ] B — reusable Verify step-up" → "Verify: reusable step-up flow").
 */
function listed(issue, known, titleWords) {
  const out = [];
  for (const { line, section } of meaningfulLines(issue.body ?? '')) {
    if (CROSS_REF_HEADING.test(section)) continue;
    const task = line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+#(\d+)\b/);
    if (task) {
      const item = task[1].trim();
      const lead = item.match(/^#(\d+)\b/);
      const tail = item.match(/\(#(\d+)\)\W*$/);
      const number = Number(lead?.[1] ?? tail?.[1]);
      if (number && known.has(number) && number !== issue.number) out.push({ number, strength: 3, quote: line.trim().slice(0, 160) });
      else if (!/#\d+/.test(item) && SLICE_LABEL.test(item)) {
        const match = titleMatch(item.replace(SLICE_LABEL, ''), issue.number, titleWords);
        if (match) out.push({ number: match, strength: 2, quote: line.trim().slice(0, 160) });
      }
    } else if (bullet && !CROSS_REF_LINE.test(line)) {
      const number = Number(bullet[1]);
      if (known.has(number) && number !== issue.number) out.push({ number, strength: 3, quote: line.trim().slice(0, 160) });
    }
  }
  return out;
}

// "B — …", "2. …", "Phase 3: …", "R2 — …": an item naming a planned slice of the work.
const SLICE_LABEL = /^(?:\*\*)?(?:[A-Z]|\d+|[A-Z]\d+|(?:phase|slice|step|part|stage)\s+\w+)(?:\*\*)?\s*[—–:.)-]\s+/i;

/** The one issue whose title shares most of this task item's words (and clearly more than any other). */
function titleMatch(item, self, titleWords) {
  const want = new Set(words(item, { code: true }));
  if (want.size < 2) return null;
  let best = null,
    bestScore = 0,
    second = 0;
  for (const [number, have] of titleWords) {
    if (number === self) continue;
    let shared = 0;
    for (const w of want) if (have.has(w)) shared++;
    const score = shared / want.size;
    if (shared < 3 || score < 0.6) continue;
    if (score > bestScore) [second, bestScore, best] = [bestScore, score, number];
    else if (score > second) second = score;
  }
  return best && bestScore - second >= 0.2 ? best : null;
}

/**
 * Decide each issue's parent issue. Returns Map<number, { parent, strength, reason }>
 * for the issues that nest; the rest are top level. Never creates a cycle.
 */
export function nestByReferences(issues) {
  const known = new Map(issues.map((i) => [i.number, i]));
  const candidates = new Map(issues.map((i) => [i.number, claims(i, known)]));
  const titleWords = new Map(issues.map((i) => [i.number, new Set(words(i.title, { code: true }))]));
  for (const parent of issues) {
    for (const { number, strength, quote } of listed(parent, known, titleWords)) {
      candidates.get(number).push({ number: parent.number, strength, why: 'is listed in the task list of', quote, at: -0.5 });
    }
  }

  const parentOf = new Map();
  const wouldCycle = (child, parent) => {
    for (let p = parent; p != null; p = parentOf.get(p)?.parent) if (p === child) return true;
    return false;
  };
  // Strongest claims first, so a weak "follow-up" never blocks a real "part of".
  const order = issues.map((i) => ({ i, best: Math.max(0, ...candidates.get(i.number).map((c) => c.strength)) })).sort((a, b) => b.best - a.best || a.i.number - b.i.number);
  for (const { i } of order) {
    const ranked = candidates.get(i.number).sort((a, b) => b.strength - a.strength || epicness(known.get(b.number)) - epicness(known.get(a.number)) || a.at - b.at);
    for (const c of ranked) {
      if (wouldCycle(i.number, c.number)) continue;
      parentOf.set(i.number, {
        parent: c.number,
        strength: c.strength,
        reason: `#${i.number} ${c.why} #${c.number}${c.quote ? `: “${c.quote}”` : ''}`,
      });
      break;
    }
  }
  return parentOf;
}

/** Epics win ties ("Epic #131, design issue #202" nests under the epic). */
export function epicness(issue) {
  if (!issue) return 0;
  if (/^epic\b|\bepic\s*:|\(epic\)|\bnew epic\b/i.test(issue.title) || issue.labels?.some((l) => /^epic$/i.test(l)) || /^epic$/i.test(issue.type ?? '')) return 2;
  if (/^(phase|slice|milestone)\b/i.test(issue.title)) return 0.5;
  return 0;
}

/** "depends on #12" / "blocked by #12" are dependencies; other mentions are relations. */
export function referencesIn(issue) {
  const out = [];
  const seen = new Set();
  for (const m of `${issue.title}\n${issue.body ?? ''}`.matchAll(/(depends on|blocked by|requires|after)?[^\S\n]*(?:issue[^\S\n]+)?(?<![\w/])#(\d+)\b/gi)) {
    const number = Number(m[2]);
    const type = m[1] ? 'depends' : 'relates';
    if (seen.has(number) && type === 'relates') continue;
    seen.add(number);
    out.push({ number, type });
  }
  return out;
}
