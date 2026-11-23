// What changed between two texts, word by word, so a change reads as one text with its edits marked in it,
// never as the old block struck through above the new one (#13 ADOPT-18).

// Words and the spaces between them, so the proposed text can be put back together exactly.
const tokensOf = (text) => String(text ?? '').match(/\s+|[^\s]+/g) ?? [];
const space = (t) => /^\s/.test(t);
const LIMIT = 4e6; // cells in the table: beyond this, the change is shown as removed and added whole

/**
 * The two texts as one run of pieces: unchanged, removed or added. Joining the unchanged and added pieces gives `after`
 * exactly, and the unchanged and removed ones `before`. Spacing alone never counts as a change.
 * @returns {{ kind: 'same' | 'del' | 'ins', text: string }[]}
 */
export function wordDiff(before, after) {
  const a = tokensOf(before), b = tokensOf(after);
  const eq = (x, y) => x === y || (space(x) && space(y));
  let lo = 0;
  while (lo < a.length && lo < b.length && eq(a[lo], b[lo])) lo++;
  let ea = a.length, eb = b.length;
  while (ea > lo && eb > lo && eq(a[ea - 1], b[eb - 1])) ea--, eb--;
  const out = [];
  const push = (kind, text) => {
    if (!text) return;
    if (out.at(-1)?.kind === kind) out.at(-1).text += text;
    else out.push({ kind, text });
  };
  b.slice(0, lo).forEach((t) => push('same', t));
  const x = a.slice(lo, ea), y = b.slice(lo, eb);
  if (x.length * y.length > LIMIT) {
    push('del', x.join(''));
    push('ins', y.join(''));
  } else {
    // Longest common subsequence over the middle, then walked from the start.
    const n = x.length, m = y.length, w = m + 1;
    const len = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) len[i * w + j] = eq(x[i], y[j]) ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && eq(x[i], y[j])) push('same', y[j++]), i++;
      else if (j < m && (i === n || len[i * w + j + 1] >= len[(i + 1) * w + j])) push('ins', y[j++]);
      else push('del', x[i++]);
    }
  }
  b.slice(eb).forEach((t) => push('same', t));
  return tidy(out);
}

// One edit reads as one: the removed words, then the added ones, with a lone space between two edits taken into both.
function tidy(parts) {
  const out = [];
  let del = '', ins = '';
  const flush = () => {
    if (del) out.push({ kind: 'del', text: del });
    if (ins) out.push({ kind: 'ins', text: ins });
    del = ins = '';
  };
  parts.forEach((p, k) => {
    if (p.kind === 'del') del += p.text;
    else if (p.kind === 'ins') ins += p.text;
    else if ((del || ins) && /^\s+$/.test(p.text) && parts[k + 1] && parts[k + 1].kind !== 'same') (del += p.text), (ins += p.text);
    else {
      flush();
      if (out.at(-1)?.kind === 'same') out.at(-1).text += p.text;
      else out.push({ kind: 'same', text: p.text });
    }
  });
  flush();
  return out;
}

/**
 * The pieces with long unchanged runs folded to their ends, so a long section shows only what changed and a few words
 * around it. A folded run is { kind: 'fold', text, head, tail }: `head` and `tail` stay visible around the "…".
 */
export function foldUnchanged(parts, keep = 6) {
  return parts.map((p, k) => {
    if (p.kind !== 'same') return p;
    const words = tokensOf(p.text);
    const lead = k > 0 ? keep * 2 : 0, trail = k < parts.length - 1 ? keep * 2 : 0; // a word and its space
    if (words.length <= lead + trail + keep * 2) return p;
    return { kind: 'fold', text: p.text, head: words.slice(0, lead).join(''), tail: words.slice(words.length - trail).join('') };
  });
}

// ---- A one-line summary of a change -----------------------------------------------------------

const sentencesOf = (text) =>
  String(text ?? '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A section written as a list (Open questions, Acceptance, Out of scope) changes by its items: each bullet with the lines
// under it, as said. "None" and the like are no item. Null when the text isn't a list.
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const NOTHING = /^(none|n\/a|nothing( yet)?|no open questions)\.?$/i;
function itemsOf(text) {
  const lines = String(text ?? '').split('\n').filter((l) => l.trim());
  if (!lines.some((l) => BULLET.test(l))) return null;
  const items = [];
  for (const l of lines) {
    if (BULLET.test(l) && !/^\s{2,}/.test(l)) items.push(l.replace(BULLET, ''));
    else if (items.length) items[items.length - 1] += ` ${l}`;
    else if (!NOTHING.test(l.trim())) items.push(l);
  }
  return items.map((i) => i.replace(/\s+/g, ' ').trim());
}
const asList = (text) => itemsOf(text) ?? (NOTHING.test(String(text ?? '').trim()) ? [] : null);

/**
 * What a change to a section did, in a few words: "1 sentence reworded", "2 sentences added, 1 removed", "emptied". A list
 * counts its items, as questions in Open questions: "3 questions removed".
 */
export function changeSummary({ name = '', change, before = '', after = '' }) {
  if (change === 'added') return 'added';
  if (change === 'removed' || !String(after).trim()) return 'emptied';
  const lists = [asList(before), asList(after)];
  const listed = lists.every(Boolean) && (itemsOf(before) || itemsOf(after));
  if (listed && !lists[1].length) return 'emptied';
  const [was, now] = listed ? lists : [sentencesOf(before), sentencesOf(after)];
  const unit = !listed ? 'sentence' : name === 'Open questions' ? 'question' : 'item';
  const gone = was.filter((s) => !now.includes(s)).length, fresh = now.filter((s) => !was.includes(s)).length;
  const reworded = Math.min(gone, fresh);
  const parts = [reworded && 'reworded', fresh - reworded && 'added', gone - reworded && 'removed'].filter(Boolean);
  if (!parts.length) return 'reordered';
  const counts = { reworded, added: fresh - reworded, removed: gone - reworded };
  return parts.map((p, i) => (i === 0 ? `${plural(counts[p], unit)} ${p}` : `${counts[p]} ${p}`)).join(', ');
}
