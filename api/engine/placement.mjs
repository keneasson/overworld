// Where an issue lives on the map. Deterministic and explainable: each piece
// of evidence names what it saw, and the strongest, most specific region wins.
//
//   files a closing pull request changed   strongest
//   file paths and URLs the issue mentions  strong
//   words shared with a region's name       weak (a hint, flagged as a guess)

import { words } from './text.mjs';

const W_PR = 3; // shared among the files of one pull request
const W_PATH = 2;
const W_URL = 2;
const W_NAME = 2.5; // the issue's title names the region ("Exhorter heads-up email")
const W_WORDS = 1;
const DESCEND = 0.6; // go one level deeper while it holds this share of the evidence

// The map is about behaviour: where you would see it beats where the code sits.
const SURFACE_FACTOR = { web: 1, mobile: 1, email: 1, api: 0.6, service: 0.8, external: 0.8, none: 0.5 };

export function makeLocator({ regions, fileOwners, urlIndex, paths }) {
  const children = new Map();
  for (const r of regions.values()) {
    if (!children.has(r.parent)) children.set(r.parent, []);
    children.get(r.parent).push(r);
  }
  const byBase = new Map();
  for (const p of paths) {
    const b = p.slice(p.lastIndexOf('/') + 1);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(p);
  }
  // How telling a word is: rare across regions -> strong.
  const df = new Map();
  for (const r of regions.values()) for (const w of r.words.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w) => Math.log(1 + regions.size / (df.get(w) ?? regions.size));
  const topSegments = new Set(urlIndex.map((u) => u.url.split('/')[1]).filter(Boolean));
  const topOf = (key) => {
    let r = regions.get(key);
    while (r && r.parent) r = regions.get(r.parent);
    return r;
  };
  const factor = (key, title) => {
    if (key === 'tests') return /\b(tests?|lint|ci|specs?|e2e|regression)\b/i.test(title) ? 1 : 0.25;
    if (/^code:docs\//.test(key)) return /\b(docs|documentation|adrs?|readme|guide|checklist)\b/i.test(title) ? 1 : 0;
    if (regions.get(key)?.tags.includes('showcase')) return 0.3;
    return SURFACE_FACTOR[topOf(key)?.surface] ?? 0.5;
  };
  // Places in the product an issue title can name ("Exhorter heads up", "Recording brothers"):
  // not code folders ("Utils") or design showcases, and one place per name (the first, usually public).
  const named = new Set();
  const names = [...regions.values()]
    .filter((r) => topOf(r.key)?.surface !== 'none' && !r.tags.includes('showcase'))
    .filter((r) => !named.has(r.title) && named.add(r.title))
    .map((r) => ({ r, want: words(r.title.replace(/\s*\bAPI$/, ''), { code: true }) }))
    .filter(({ want }) => want.length)
    .map((x) => ({ ...x, idf: x.want.reduce((t, w) => t + idf(w), 0) }))
    .filter((x) => x.idf >= 2.5);
  const contains = (seq, part) => seq.some((_, i) => part.every((w, j) => seq[i + j] === w));

  function ownersOfPath(raw) {
    const p = raw
      .replace(/^\.?\//, '')
      .replace(/:\d+(-\d+)?$/, '')
      .replace(/\/$/, '');
    if (fileOwners.has(p)) return { files: [p] };
    const hits = paths.filter((f) => f.endsWith(`/${p}`) || f.startsWith(`${p}/`) || f.includes(`/${p}/`));
    return hits.length && hits.length <= 80 ? { files: hits } : null;
  }

  function regionOfUrl(raw) {
    const segs = raw
      .replace(/[).,;:'"`]+$/, '')
      .split(/[?#]/)[0]
      .split('/')
      .filter((s) => s && !/^\(.*\)$/.test(s) && !/^\[.*\]$/.test(s) && !/^\{.*\}$/.test(s) && !/^:/.test(s));
    if (!segs.length || !topSegments.has(segs[0])) return null;
    for (let n = segs.length; n > 0; n--) {
      const url = `/${segs.slice(0, n).join('/')}`;
      const hit = urlIndex.find((u) => u.url === url && (segs[0] === 'api') === (u.kind === 'api'));
      if (hit) return hit.key;
    }
    return null;
  }

  /** Evidence for one text (+ the files its pull requests changed). */
  function evidence({ title = '', body = '', prs = [] }) {
    const weights = new Map();
    const reasons = [];
    const hints = new Map();
    const give = (key, w, why) => {
      if (!key || !regions.has(key)) return;
      const f = factor(key, title);
      if (!f) return;
      weights.set(key, (weights.get(key) ?? 0) + w * f);
      reasons.push({ key, w: w * f, why });
    };
    for (const pr of prs) {
      const owned = pr.files.filter((f) => fileOwners.has(f));
      for (const f of owned) {
        const owners = fileOwners.get(f);
        for (const k of owners) give(k, W_PR / owned.length / owners.length, `PR #${pr.number} changed ${f}`);
      }
    }
    const text = `${title}\n${body}`.replace(/https?:\/\/\S+/g, ' ').replace(/^.*generated with .*$/gim, '');
    const seen = new Set();
    for (const m of text.matchAll(/(?:^|[\s`'"(\[])((?:[\w@.()[\]-]+\/)+[\w@.()[\]-]*\w(?::\d+(?:-\d+)?)?)/g)) {
      const raw = m[1];
      if (seen.has(raw) || raw.startsWith('/') || !raw.includes('/')) continue;
      seen.add(raw);
      const hit = ownersOfPath(raw);
      if (!hit) continue;
      const owners = hit.files.flatMap((f) => fileOwners.get(f) ?? []);
      for (const k of owners) give(k, W_PATH / owners.length, `mentions ${raw}`);
    }
    for (const m of text.matchAll(/(?:^|[\s`'"(])([\w-]+\.(?:tsx|jsx|ts|js|mjs|vue|svelte))\b/g)) {
      const list = byBase.get(m[1]);
      if (!list || list.length > 3 || seen.has(m[1])) continue;
      seen.add(m[1]);
      const owners = list.flatMap((f) => fileOwners.get(f) ?? []);
      for (const k of owners) give(k, W_PATH / owners.length, `mentions ${m[1]}`);
    }
    for (const m of text.matchAll(/(?:^|[\s`'"(])(\/[a-z][\w-]*(?:\/[\w[\]().:{}-]+)*)/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      give(regionOfUrl(m[1]), W_URL, `mentions ${m[1]}`);
    }

    // The title names a place, words in order ("Email preferences: link shows…").
    const seq = words(title, { code: true });
    for (const { r, want, idf: strength } of names) {
      if (contains(seq, want)) give(r.key, W_NAME * Math.min(1, strength / 5) * (want.length === 1 ? 0.5 : 1), `its title names ${r.title}`);
    }

    // Shared words: a hint that breaks ties, and the only evidence when nothing above said anything.
    {
      const want = new Map();
      for (const w of words(title)) want.set(w, 2);
      for (const w of words(text.slice(0, 4000))) if (!want.has(w)) want.set(w, 0.5);
      const scores = [];
      for (const r of regions.values()) {
        let s = 0;
        const hits = [];
        for (const [w, rw] of r.words) {
          const iw = want.get(w);
          if (!iw) continue;
          s += iw * rw * idf(w);
          hits.push(w);
        }
        if (r.mentionRe?.test(text)) {
          s += 3;
          hits.push(r.title);
        }
        if (s > 0) scores.push({ r, s, hits });
      }
      scores.sort((a, b) => b.s - a.s);
      for (const x of scores) hints.set(x.r.key, x.s);
      const best = scores[0];
      if (!weights.size && best && best.s >= 3) {
        const close = scores.filter((x) => x.s >= best.s * 0.75).slice(0, 4);
        const sum = close.reduce((t, x) => t + x.s, 0);
        for (const x of close) give(x.r.key, (W_WORDS * x.s) / sum, `its words match ${x.hits.slice(0, 4).join(', ')}`);
      }
    }
    return { weights, reasons, hints };
  }

  /**
   * The deepest region that holds most of the evidence. When the evidence
   * splits between two places (a screen shared by /posts and /admin/posts),
   * the issue's own words break the tie.
   */
  function choose(weights, hints = new Map()) {
    const sum = (m) => {
      const sub = new Map();
      for (const [key, w] of m) for (let r = regions.get(key); r; r = regions.get(r.parent)) sub.set(r.key, (sub.get(r.key) ?? 0) + w);
      return sub;
    };
    const sub = sum(weights);
    const hint = sum(hints);
    if (![...weights.values()].some((w) => w > 0)) return null;
    const ranked = (list) =>
      list.filter((r) => sub.has(r.key)).sort((a, b) => sub.get(b.key) - sub.get(a.key) || (hint.get(b.key) ?? 0) - (hint.get(a.key) ?? 0) || a.order - b.order);
    let cur = ranked(children.get(null) ?? [])[0];
    while (cur) {
      const kids = ranked(children.get(cur.key) ?? []);
      if (!kids.length) break;
      if (sub.get(kids[0].key) >= DESCEND * sub.get(cur.key)) {
        cur = kids[0];
        continue;
      }
      const contenders = kids.filter((k) => sub.get(k.key) >= 0.3 * sub.get(cur.key)).sort((a, b) => (hint.get(b.key) ?? 0) - (hint.get(a.key) ?? 0));
      const [a, b] = contenders;
      const share = contenders.reduce((t, k) => t + sub.get(k.key), 0) / sub.get(cur.key);
      if (a && share >= DESCEND && (hint.get(a.key) ?? 0) > 0 && (hint.get(a.key) ?? 0) >= 2 * (hint.get(b?.key) ?? 0)) cur = a;
      else break;
    }
    return cur?.key ?? null;
  }

  return { evidence, choose };
}

/** A one-line, human explanation of why something sits where it does. */
export function explain(reasons, key, regions) {
  const path = [];
  for (let r = regions.get(key); r; r = regions.get(r.parent)) path.unshift(r.title);
  const within = (k) => {
    for (let r = regions.get(k); r; r = regions.get(r.parent)) if (r.key === key) return true;
    return false;
  };
  const relevant = reasons.filter((x) => within(x.key)).sort((a, b) => b.w - a.w);
  const whys = [...new Set(relevant.map((x) => x.why))].slice(0, 3);
  const guess = relevant.every((x) => x.why.startsWith('its words'));
  const kinds = new Set(relevant.map((x) => (x.why.startsWith('PR ') ? 'pr' : x.why.startsWith('mentions') ? 'path' : x.why.startsWith('its title') ? 'name' : 'words')));
  const source = ['pr', 'path', 'name', 'words'].find((k) => kinds.has(k)) ?? 'words';
  return { path: path.join(' › '), whys, guess, source };
}
