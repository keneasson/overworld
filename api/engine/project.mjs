// Assemble a mapped project from a repository: the code is the land,
// issues are the work on it, behaviour specs are the laws of each place.
// Pure and deterministic given the same inputs (ids come from `makeId`).

import { ROOT_ID, newId } from '../../shared/schema.js';
import { mapArchitecture } from './architecture.mjs';
import { explain, makeLocator } from './placement.mjs';
import { epicness, nestByReferences, referencesIn } from './references.mjs';
import { closedByOpenPrs, lifecycleOf, usesLifecycle } from './lifecycle.mjs';

const BUG_TITLE =
  /\b(bug|crash(es|ed)?|broken|breaks|fails?|failing|error|500|leak|regression|cut off|unusable|dead end|wrong|rotted|not (invalidated|enforced|sendable|working)|never (enforced|applied)|silently)\b/i;

const has = (labels, re) => labels.some((l) => re.test(l));

function kindFor(issue, hasChildren, parentIsRegion) {
  const type = (issue.type ?? '').toLowerCase();
  if (type === 'bug' || has(issue.labels, /^(bug|defect|regression)$/i)) return 'bug';
  if (epicness(issue) === 2 || (hasChildren && parentIsRegion)) return 'epic';
  if (hasChildren) return 'feature';
  if (BUG_TITLE.test(issue.title) && !/^(epic|design|decide)\b/i.test(issue.title)) return 'bug';
  if (type === 'feature' || has(issue.labels, /^(enhancement|feature|user story|story)$/i) || /^\(?feat\b/i.test(issue.title)) return 'story';
  return 'task';
}

export function firstLine(body) {
  const line = body
    .split('\n')
    .map((l) => l.replace(/[#>*_`]/g, '').trim())
    .find((l) => l && !l.startsWith('- [') && !l.startsWith('<!--') && !/^\|/.test(l) && !/^(part of|epic|design|see|refs?)\b/i.test(l));
  return (line ?? '').slice(0, 240);
}

const md = (s) => s.replace(/[[\]*_`]/g, '\\$&');

/**
 * @param {object} input
 * @param {{ full_name: string, description?: string, html_url: string, default_branch?: string }} input.repo
 * @param {string[]} input.paths
 * @param {Map<string, object>} input.manifests
 * @param {object[]} input.specs     parsed behaviour specs (see behaviours.mjs)
 * @param {object[]} input.issues    { number, title, body, state, stateReason, url, labels, milestone, assignees, type, parent, prs: [{ number, files }] }
 * @param {object[]} input.pulls     open pull requests { number, title, body }
 */
/** The id of an issue's node on the map. */
export const issueNodeId = (number) => `issue-${number}`;

/**
 * What an issue says about itself, as a node's fields: everything but where it sits, its kind and its links.
 * A full mapping and a webhook about one issue both use it, so they agree.
 * @param {string} opts.note the 📍 note on why it sits where it does, kept as the map last wrote it
 * @param {string[]} opts.placement tags the placement gave it ('placed-by-words', 'unplaced')
 */
export function issueFields(i, { lifecycle, note, placement = [], kind }) {
  const priority = i.labels.map((l) => l.match(/^p([0-3])\b/i)?.[1]).find(Boolean);
  // Milestones are about when, not where: they become the due date and a tag.
  const tags = [...new Set([...i.labels, ...(i.milestone ? [i.milestone.title] : [])].map((l) => l.toLowerCase().slice(0, 40)))];
  tags.push(...placement);
  const state = lifecycleOf(i, lifecycle);
  if (state.unclear) tags.push('status-unclear');
  if (kind === 'story') tags.push('new-feature');
  return {
    title: `#${i.number} ${i.title.replace(/\s+/g, ' ').trim()}`.slice(0, 200),
    summary: firstLine(i.body),
    body: `${i.body.slice(0, 19400)}\n\n---\n📍 ${note}${state.unclear ? ` Status unclear: ${state.unclear}.` : ''}`,
    status: state.status,
    definition: state.definition,
    tags: tags.slice(0, 20),
    assignee: i.assignees[0] ?? '',
    due: i.milestone?.dueOn ? i.milestone.dueOn.slice(0, 10) : '',
    priority: priority ? `P${priority}` : '',
    url: i.url,
  };
}

export function buildProject({ repo, paths = [], manifests = new Map(), specs = [], issues = [], pulls = [], now = new Date().toISOString(), makeId = newId }) {
  const branch = repo.default_branch ?? 'main';
  const arch = mapArchitecture({ paths, manifests, mentions: issues.map((i) => `${i.title}\n${i.body}`) });
  const locate = makeLocator(arch);
  const nesting = nestByReferences(issues);
  const lifecycle = { strict: usesLifecycle(issues), inProgress: closedByOpenPrs(pulls) };
  const kids = new Map();
  for (const [child, { parent }] of nesting) kids.set(parent, [...(kids.get(parent) ?? []), child]);

  // Where each issue would sit on its own evidence.
  const evidence = new Map(issues.map((i) => [i.number, locate.evidence({ title: i.title, body: i.body, prs: i.prs ?? [] })]));
  const ownHome = new Map(issues.map((i) => [i.number, locate.choose(evidence.get(i.number).weights, evidence.get(i.number).hints)]));

  // A parent issue sits where most of its family is: each sub-issue votes for
  // its own place (nearer generations count more), and the parent's own place
  // counts for about a third (more in a small family). The map's tree then nests the family inside it.
  const home = new Map();
  const stats = { pr: 0, path: 0, name: 0, words: 0, uncharted: 0, nested: nesting.size };
  for (const i of issues) {
    if (nesting.has(i.number)) continue;
    const votes = new Map();
    const hints = new Map(evidence.get(i.number).hints);
    let family = 0,
      total = 0;
    const visit = (n, scale) => {
      for (const c of kids.get(n) ?? []) {
        family++;
        const k = ownHome.get(c);
        if (k) {
          votes.set(k, (votes.get(k) ?? 0) + scale);
          total += scale;
        }
        for (const [h, w] of evidence.get(c).hints) hints.set(h, (hints.get(h) ?? 0) + w * scale * 0.5);
        visit(c, scale * 0.7);
      }
    };
    visit(i.number, 1);
    const mine = ownHome.get(i.number);
    if (mine) votes.set(mine, (votes.get(mine) ?? 0) + Math.max(1.5, total * 0.5));
    const key = locate.choose(votes, hints);
    if (!key) {
      home.set(i.number, { key: null });
      stats.uncharted++;
      continue;
    }
    const why = explain(evidence.get(i.number).reasons, key, arch.regions);
    if (family) {
      const inside = (k) => {
        for (let r = arch.regions.get(k); r; r = arch.regions.get(r.parent)) if (r.key === key) return true;
        return false;
      };
      let here = 0;
      const count = (n) => (kids.get(n) ?? []).forEach((c) => ((here += inside(ownHome.get(c)) ? 1 : 0), count(c)));
      count(i.number);
      if (here) why.whys.unshift(`${here} of its ${family} sub-issues are here`);
      if (here && why.source === 'words') why.guess = false;
    }
    home.set(i.number, { key, ...why });
    stats[why.source]++;
  }

  // Behaviour specs sit where the issues they cite and the places they name are.
  const specHome = specs.map((spec) => {
    const text = [spec.title, spec.intro, ...spec.sections.flatMap((s) => [s.title, ...s.scenarios.map((x) => x.text)])].join('\n');
    const e = locate.evidence({ title: spec.title, body: text });
    for (const n of new Set(spec.sections.flatMap((s) => s.scenarios.flatMap((x) => x.issues)))) {
      if (!evidence.has(n)) continue;
      for (const [k, w] of evidence.get(n).weights) e.weights.set(k, (e.weights.get(k) ?? 0) + w * 0.5);
    }
    return locate.choose(e.weights, e.hints);
  });

  // ---- Nodes ------------------------------------------------------------
  const base = {
    health: 'auto',
    definition: 'auto',
    priority: '',
    estimate: null,
    weight: null,
    due: '',
    assignee: '',
    links: [],
    place: 'auto',
    surface: 'auto',
    createdAt: now,
    updatedAt: now,
  };
  const nodes = [];
  const regionId = new Map([...arch.regions.keys()].map((k) => [k, makeId()]));
  // An issue's node is named by its number, so it keeps its place and id through every refresh, and a webhook can find it in one read.
  const issueId = new Map(issues.map((i) => [i.number, issueNodeId(i.number)]));
  let unchartedId = null;
  const uncharted = () => {
    if (!unchartedId) {
      unchartedId = makeId();
      nodes.push({
        ...base,
        id: unchartedId,
        parentId: ROOT_ID,
        order: 1e6,
        kind: 'area',
        title: 'Uncharted',
        summary: 'Work the map could not place: no files, pages or names to go by.',
        body: 'Nothing in these issues points at a file, a page or a part of the product. Open one and set where it belongs, or give it a parent issue ("Part of #12").',
        status: 'planned',
        tags: [],
        url: '',
        surface: 'uncharted',
      });
    }
    return unchartedId;
  };

  const blob = (f) => `${repo.html_url}/blob/${branch}/${f.split('/').map(encodeURIComponent).join('/')}`;
  for (const r of arch.regions.values()) {
    const files = r.files;
    const list = files
      .slice(0, 25)
      .map((f) => `- [${md(f)}](${blob(f)})`)
      .join('\n');
    nodes.push({
      ...base,
      id: regionId.get(r.key),
      parentId: r.parent ? regionId.get(r.parent) : ROOT_ID,
      order: r.order,
      kind: r.kind,
      title: r.title,
      summary: r.summary,
      body: files.length ? `**Code here** (${files.length} file${files.length === 1 ? '' : 's'}):\n\n${list}${files.length > 25 ? `\n- … and ${files.length - 25} more` : ''}` : (r.details ?? ''),
      status: 'done',
      tags: ['code', ...r.tags],
      url: files.length === 1 ? blob(files[0]) : '',
      place: r.place,
      surface: r.parent ? 'auto' : r.surface,
      region: r.key,
    });
  }

  const childCount = (n) => (kids.get(n) ?? []).length;
  for (const i of issues) {
    const nest = nesting.get(i.number);
    const placed = home.get(i.number);
    const parentId = nest ? issueId.get(nest.parent) : placed?.key ? regionId.get(placed.key) : uncharted();
    const note = nest
      ? `Nested here because ${nest.reason.replace(/^#\d+ /, 'it ')}`
      : placed?.key
        ? `On the map in **${placed.path}** because ${placed.guess ? 'its words match (a guess)' : placed.whys.slice(0, 2).join('; ')}.`
        : 'Not placed: nothing in it points at a file, page or part of the product.';
    const links = [];
    for (const ref of referencesIn(i)) {
      const target = issueId.get(ref.number);
      if (!target || ref.number === i.number || ref.number === nest?.parent || nesting.get(ref.number)?.parent === i.number) continue;
      if (!links.some((l) => l.to === target)) links.push({ to: target, type: ref.type, label: '' });
    }
    const placement = [...(placed?.guess ? ['placed-by-words'] : []), ...(!nest && !placed?.key ? ['unplaced'] : [])];
    const kind = kindFor(i, childCount(i.number) > 0, !nest);
    nodes.push({
      ...base,
      id: issueId.get(i.number),
      parentId,
      order: i.number,
      kind,
      ...issueFields(i, { lifecycle, note: note.replace(/\n/g, ' ').slice(0, 500), placement, kind }),
      links: links.slice(0, 50),
    });
  }

  specs.forEach((spec, s) => {
    const key = specHome[s];
    const specId = makeId();
    nodes.push({
      ...base,
      id: specId,
      parentId: key ? regionId.get(key) : ROOT_ID,
      order: -1000 + s,
      kind: 'feature',
      title: `${spec.title} (behaviour spec)`.slice(0, 200),
      summary: spec.summary,
      body: `${spec.intro}\n\n[Read the full spec](${blob(spec.path)})`.slice(0, 20000),
      status: 'in_progress',
      tags: ['behaviour-spec'],
      url: blob(spec.path),
    });
    spec.sections.forEach((section, j) => {
      const sectionId = makeId();
      nodes.push({
        ...base,
        id: sectionId,
        parentId: specId,
        order: j,
        kind: 'feature',
        title: section.title,
        summary: `${section.scenarios.length} behaviours${section.prefix ? ` · ${section.prefix}` : ''}`,
        body: '',
        status: 'in_progress',
        tags: ['behaviour-spec'],
        url: '',
      });
      section.scenarios.forEach((x, k) => {
        nodes.push({
          ...base,
          id: makeId(),
          parentId: sectionId,
          order: k,
          kind: 'behavior',
          title: `${x.id ? `${x.id} ` : ''}${x.text}`.slice(0, 200),
          summary: x.text.slice(0, 1000),
          body: `**Status in the spec:** ${x.statusText || 'not stated'}\n\nFrom [${spec.path}](${blob(spec.path)}).`,
          status: x.status,
          definition: x.definition === 'vague' ? 'vague' : 'clear',
          tags: ['behaviour'],
          url: blob(spec.path),
          links: [...new Set(x.issues)].filter((n) => issueId.has(n)).map((n) => ({ to: issueId.get(n), type: x.status === 'done' ? 'relates' : 'depends', label: '' })),
        });
      });
    });
  });

  // Land with nothing on it is small but there; land with open work is in progress.
  const childrenOf = new Map();
  for (const n of nodes) childrenOf.set(n.parentId, [...(childrenOf.get(n.parentId) ?? []), n]);
  const openInside = (n) => (childrenOf.get(n.id) ?? []).some((c) => (c.status !== 'done' && c.status !== 'rejected') || openInside(c));
  for (const n of nodes) {
    if (!n.region) continue;
    const hasKids = childrenOf.has(n.id);
    if (!hasKids) n.weight = Math.round((0.4 + 0.05 * Math.min(arch.regions.get(n.region).files.length, 20)) * 100) / 100;
    n.status = openInside(n) ? 'in_progress' : 'done';
    delete n.region;
  }

  const count = (pred) => [...arch.regions.values()].filter(pred).length;
  const pages = count((r) => r.tags.includes('page') && r.key.startsWith('page:'));
  const screens = count((r) => r.key.startsWith('screen:'));
  const emails = count((r) => r.tags.includes('template'));
  const endpoints = arch.paths.filter((p) => /(^|\/)api\/.*(route|\+server)\.(ts|js|mjs)$|(^|\/)pages\/api\//.test(p)).length;
  const behaviours = specs.reduce((t, s) => t + s.sections.reduce((u, x) => u + x.scenarios.length, 0), 0);
  const shape = [pages && `${pages} pages`, endpoints && `${endpoints} endpoints`, screens && `${screens} mobile screens`, emails && `${emails} emails`].filter(Boolean).join(', ');
  const placedBy = [
    stats.nested && `${stats.nested} nested under a parent issue they name`,
    stats.pr && `${stats.pr} placed by the files their pull requests changed`,
    stats.path && `${stats.path} by the files and pages they mention`,
    stats.name && `${stats.name} by the part of the product their title names`,
    stats.words && `${stats.words} by shared words (a guess)`,
    stats.uncharted && `${stats.uncharted} uncharted`,
  ].filter(Boolean);

  nodes.unshift({
    ...base,
    id: ROOT_ID,
    parentId: null,
    order: 0,
    kind: 'project',
    title: repo.full_name,
    summary: repo.description || (shape ? `${shape}.` : ''),
    body: [
      `Mapped from [${repo.full_name}](${repo.html_url}) on ${now.slice(0, 10)}.`,
      shape && `**The land** is the code: ${shape}, shared packages behind the screen, and the services it talks to as islands.`,
      issues.length && `**The work** is ${issues.length} issues: ${placedBy.join('; ')}. Each issue says why it is where it is.`,
      behaviours && `**The laws** are ${behaviours} behaviours from ${specs.length} spec file${specs.length === 1 ? '' : 's'}.`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    status: 'in_progress',
    tags: ['github'],
    url: repo.html_url,
  });

  return { title: repo.full_name, summary: nodes[0].summary, nodes, strictLifecycle: lifecycle.strict, stats: { ...stats, regions: arch.regions.size, behaviours } };
}
