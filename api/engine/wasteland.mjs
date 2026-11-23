// Wasteland (#24): code that is in use but damaged, read from the code itself. Deterministic, no AI: the same files always
// give the same marks. What marks it was decided by the maintainer (WASTE-05): a fix-me comment, unreachable code, the
// leftover side of an A/B test whose winner is chosen, a resolved feature flag whose code is still there, and a comment
// that calls the code debt. A to-do comment never does (WASTE-06): it is ready work, not damage.

/** Why ground is waste, in the words the place card uses. */
export const WASTE_MARKS = {
  fixme: 'A FIXME comment',
  unreachable: 'Unreachable code',
  'ab-leftover': 'The leftover side of a decided A/B test',
  'resolved-flag': 'A resolved feature flag still in the code',
  'debt-comment': 'A comment calling it technical debt',
};

// The files read for marks: code, not prose (a doc that mentions a fix-me isn't damaged code).
const C_LIKE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|go|rs|java|kt|swift|cs|php|scss|css|prisma)$/i;
const JS_LIKE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro)$/i;
const HASH = /\.(py|rb|sh|ya?ml|graphql)$/i;
export const SCANNED = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|go|rs|java|kt|swift|cs|php|scss|css|prisma|py|rb|sh|ya?ml|graphql|sql|html)$/i;
const MAX_TEXT = 160;
const MAX_PER_FILE = 20;

const FIXME = /\bFIXME\b/i;
// The usual upper-case debt markers count only in upper case; in lower case they are ordinary words.
const DEBT = /\btech(nical)?[ -]debt\b|\bdebt:|\bklu(d)?ge\b/i;
const DEBT_CASED = /\bHACK\b|\bXXX\b/;
const FLAG_NAME = /flag|feature|enabled?\b|enabled?[A-Z_]|^enable|disabled?|toggle|rollout|kill_?switch/i;
const AB_NAME = /variant|experiment|cohort|bucket|ab_?test|split_?test|treatment/i;

const clip = (s) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

/**
 * Split source into its comments and its code. In the code, comments and the insides of template strings are blanked
 * (newlines kept, so lines still line up); short quoted strings are kept, since an A/B test is told apart by its values.
 */
function lexC(src, { hash = false, js = false } = {}) {
  const comments = [];
  let out = '';
  let line = 1;
  let i = 0;
  const n = src.length;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const lines = (s) => (s.match(/\n/g) ?? []).length;
  const modes = [{ code: true, depth: 0 }];
  let prev = ''; // the last token in the code, to tell a regex from a division
  while (i < n) {
    const mode = modes.at(-1);
    const c = src[i];
    const d = src[i + 1];
    if (!mode.code) {
      // Inside a template string: its text is blanked, its ${…} is code again.
      if (c === '\\') {
        out += blank(src.slice(i, i + 2));
        line += lines(src.slice(i, i + 2));
        i += 2;
      } else if (c === '`') {
        modes.pop();
        out += c;
        prev = 'x';
        i++;
      } else if (c === '$' && d === '{') {
        modes.push({ code: true, depth: 0 });
        out += '  ';
        i += 2;
      } else {
        out += c === '\n' ? c : ' ';
        if (c === '\n') line++;
        i++;
      }
      continue;
    }
    if (c === '\n') {
      out += c;
      line++;
      i++;
      continue;
    }
    if ((c === '/' && d === '/') || (hash && c === '#')) {
      const end = src.indexOf('\n', i);
      const j = end < 0 ? n : end;
      comments.push({ line, text: src.slice(i + (c === '#' ? 1 : 2), j) });
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end < 0 ? n : end + 2;
      src
        .slice(i + 2, end < 0 ? n : end)
        .split('\n')
        .forEach((text, k) => comments.push({ line: line + k, text }));
      const chunk = src.slice(i, j);
      out += blank(chunk);
      line += lines(chunk);
      i = j;
      continue;
    }
    if (c === '<' && src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const j = end < 0 ? n : end + 3;
      src
        .slice(i + 4, end < 0 ? n : end)
        .split('\n')
        .forEach((text, k) => comments.push({ line: line + k, text }));
      const chunk = src.slice(i, j);
      out += blank(chunk);
      line += lines(chunk);
      i = j;
      continue;
    }
    if (c === '`' && js) {
      modes.push({ code: false });
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, Math.min(j + 1, n));
      i = j + 1;
      prev = 'x';
      continue;
    }
    if (c === '/' && js && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /^(return|typeof|case|do|else|in|of|new|delete|void|throw)$/.test(prev))) {
      // A regex literal: its text could hold quotes or slashes, so it is blanked.
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== '\n' && (cls || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        j++;
      }
      if (src[j] === '/') {
        out += `/${' '.repeat(j - i - 1)}/`;
        i = j + 1;
        prev = 'x';
        continue;
      }
    }
    if (c === '{') mode.depth++;
    if (c === '}') {
      if (mode.depth === 0 && modes.length > 1) {
        modes.pop();
        out += ' ';
        i++;
        continue;
      }
      mode.depth--;
    }
    out += c;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[\w$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      out += src.slice(i + 1, j);
      prev = src.slice(i, j);
      i = j;
      continue;
    }
    prev = c;
    i++;
  }
  return { comments, code: out.split('\n') };
}

/** Python and the other #-comment languages: comments, and code with triple-quoted text blanked. */
function lexHash(src) {
  const comments = [];
  let out = '';
  let line = 1;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      out += c;
      line++;
      i++;
    } else if (c === '#') {
      const end = src.indexOf('\n', i);
      const j = end < 0 ? n : end;
      comments.push({ line, text: src.slice(i + 1, j) });
      out += ' '.repeat(j - i);
      i = j;
    } else if ((c === '"' || c === "'") && src.startsWith(c.repeat(3), i)) {
      const end = src.indexOf(c.repeat(3), i + 3);
      const j = end < 0 ? n : end + 3;
      const chunk = src.slice(i, j);
      out += chunk.replace(/[^\n]/g, ' ');
      line += (chunk.match(/\n/g) ?? []).length;
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, Math.min(j + 1, n));
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return { comments, code: out.split('\n') };
}

function lexSql(src) {
  // SQL: -- line comments and /* */ blocks. The code itself isn't read for marks.
  const comments = [];
  src.split('\n').forEach((l, k) => {
    const at = l.indexOf('--');
    if (at >= 0) comments.push({ line: k + 1, text: l.slice(at + 2) });
  });
  return { comments: [...comments, ...lexC(src.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))).comments], code: [] };
}

const balanced = (s) => {
  let p = 0;
  for (const ch of s) p += '([{'.includes(ch) ? 1 : ')]}'.includes(ch) ? -1 : 0;
  return p === 0;
};

/** Statements after a return, throw, break or continue in the same block, in C-like code. */
function unreachableC(code, push) {
  const depthAt = [];
  let depth = 0;
  for (const l of code) {
    depthAt.push(depth);
    for (const ch of l) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
  }
  const next = (from) => {
    for (let k = from; k < code.length; k++) if (code[k].trim()) return k;
    return -1;
  };
  const before = (from) => {
    for (let k = from; k >= 0; k--) if (code[k].trim()) return code[k].trim();
    return '';
  };
  code.forEach((l, k) => {
    const t = l.trim();
    if (!/^(return|throw|break|continue)\b/.test(t)) return;
    if (!((t.endsWith(';') && balanced(t)) || /^(return|break|continue)$/.test(t))) return;
    // A brace-less `if (x)` or `else` above makes the jump that statement's body, not the end of the block.
    if (!/[;{}:]$/.test(before(k - 1)) && k > 0 && before(k - 1)) return;
    const m = next(k + 1);
    if (m < 0 || depthAt[m] !== depthAt[k]) return;
    const after = code[m].trim();
    if (/^(}|\)|]|case\b|default\b|(export\s+)?(async\s+)?function\b|<\/)/.test(after)) return;
    push('unreachable', m + 1, `after "${clip(t)}": ${after}`);
  });
  code.forEach((l, k) => {
    if (/\b(if|while)\s*\(\s*(false|0)\s*\)/.test(l)) push('unreachable', k + 1, l);
  });
}

function unreachableHash(code, push) {
  const indent = (l) => l.match(/^\s*/)[0].length;
  code.forEach((l, k) => {
    const t = l.trim();
    if (/^(if|while|elif)\s+(False|0)\s*:/.test(t)) push('unreachable', k + 1, l);
    if (!/^(return|raise|break|continue)\b/.test(t) || !balanced(t) || /[\\,(]$/.test(t)) return;
    let m = k + 1;
    while (m < code.length && !code[m].trim()) m++;
    if (m >= code.length || indent(code[m]) !== indent(l)) return;
    if (/^(elif|else|except|finally|case|def|class|@)\b/.test(code[m].trim())) return;
    push('unreachable', m + 1, `after "${clip(t)}": ${code[m].trim()}`);
  });
}

/** Feature flags fixed in the code, and A/B tests whose variant is fixed, still branched on in the same file. */
function decided(code, push, { python = false } = {}) {
  const text = code.join('\n');
  const decl = python ? /^([A-Za-z_]\w*)\s*=\s*(True|False|'[^']*'|"[^"]*")\s*$/gm : /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(true|false|'[^'\n]*'|"[^"\n]*")\s*;?\s*$/gm;
  for (const [, name, value] of text.matchAll(decl)) {
    const bool = /^(true|false)$/i.test(value);
    if (bool ? !FLAG_NAME.test(name) : !AB_NAME.test(name)) continue;
    const esc = name.replace(/\$/g, '\\$');
    const use = bool
      ? python
        ? new RegExp(`\\b(if|elif|while)\\s+(not\\s+)?${esc}\\b|\\b${esc}\\s+(and|or)\\b|\\bif\\s+${esc}\\s+else\\b`)
        : new RegExp(`(\\bif\\s*\\(\\s*!?\\s*${esc}\\s*\\)|(^|[^\\w$.])!?${esc}\\s*(\\?[^?.]|&&|\\|\\|))`)
      : new RegExp(`(^|[^\\w$.])${esc}\\s*[!=]==?\\s*(['"])([^'"]*)\\2|(['"])([^'"]*)\\4\\s*[!=]==?\\s*${esc}(?![\\w$])`);
    code.forEach((l, k) => {
      const m = l.match(use);
      if (!m) return;
      if (bool) push('resolved-flag', k + 1, `${name} is always ${value.toLowerCase()}, so one side never runs: ${l}`);
      else {
        const other = m[3] ?? m[5];
        const fixed = value.slice(1, -1);
        push('ab-leftover', k + 1, other === fixed ? `${name} is fixed to "${fixed}": the other side is left over: ${l}` : `${name} is fixed to "${fixed}", so the "${other}" side is left over: ${l}`);
      }
    });
  }
}

/**
 * The marks that make a file's code wasteland, in line order.
 * @returns {{ mark: keyof WASTE_MARKS, line: number, text: string }[]}
 */
export function debtIn(path, text) {
  if (!SCANNED.test(path) || typeof text !== 'string') return [];
  const marks = [];
  const seen = new Set();
  const push = (mark, line, said) => {
    if (seen.has(`${mark}:${line}`)) return;
    seen.add(`${mark}:${line}`);
    marks.push({ mark, line, text: clip(said) });
  };
  const python = /\.py$/i.test(path);
  const lexed = /\.sql$/i.test(path) ? lexSql(text) : HASH.test(path) ? lexHash(text) : lexC(text, { js: JS_LIKE.test(path), hash: /\.php$/i.test(path) });
  for (const c of lexed.comments) {
    if (FIXME.test(c.text)) push('fixme', c.line, c.text);
    else if (DEBT.test(c.text) || DEBT_CASED.test(c.text)) push('debt-comment', c.line, c.text);
  }
  if (JS_LIKE.test(path) || (C_LIKE.test(path) && !/\.(s?css|prisma)$/i.test(path))) {
    unreachableC(lexed.code, push);
    if (JS_LIKE.test(path)) decided(lexed.code, push);
  } else if (python) {
    unreachableHash(lexed.code, push);
    decided(lexed.code, push, { python: true });
  }
  return marks.sort((a, b) => a.line - b.line).slice(0, MAX_PER_FILE);
}

/** Every marked file's marks: Map path -> marks. */
export function wastelandOf(sources) {
  const waste = new Map();
  for (const [path, text] of sources) {
    const marks = debtIn(path, text);
    if (marks.length) waste.set(path, marks);
  }
  return waste;
}

/**
 * The wasteland fields of a code region's node: its marks with links to their lines, the issues whose pull requests
 * changed those files (their behaviours cross it, WASTE-03), and the marks cleared from its files (WASTE-04).
 */
export function wasteFields(files, { waste, issues = [], cleared = [], blob }) {
  const mine = new Set(files);
  const marks = files.flatMap((f) => (waste.get(f) ?? []).map((m) => ({ ...m, path: f, url: `${blob(f)}#L${m.line}` }))).slice(0, 40);
  const marked = new Set(marks.map((m) => m.path));
  const crossing = issues.filter((i) => (i.prs ?? []).some((p) => (p.files ?? []).some((f) => marked.has(f)))).map((i) => i.number);
  const gone = cleared.filter((c) => mine.has(c.path));
  return {
    ...(marks.length ? { waste: marks, wasteIssues: [...new Set(crossing)].sort((a, b) => a - b) } : {}),
    ...(gone.length ? { wasteCleared: gone } : {}),
  };
}

/** A project's marks in the compact form kept on the project, to tell next time what was repaired. */
export const wasteIndex = (waste) => [...waste].flatMap(([path, marks]) => marks.map((m) => ({ path, mark: m.mark, text: m.text }))).slice(0, 400);

/**
 * What was repaired since the last mapping (WASTE-04): each mark that was there and is gone, with when it was seen gone,
 * on top of what was cleared before. The pull request that cleared it is filled in by whoever can ask the store.
 * @param {{ marks?: object[], cleared?: object[] }} previous  the project's `waste` from the last mapping
 */
export function clearedSince(previous, waste, at) {
  const still = new Set(wasteIndex(waste).map((m) => `${m.path}\n${m.mark}\n${m.text}`));
  const fresh = (previous?.marks ?? []).filter((m) => !still.has(`${m.path}\n${m.mark}\n${m.text}`)).map((m) => ({ ...m, at }));
  return { fresh, all: [...fresh, ...(previous?.cleared ?? [])].slice(0, 50) };
}
