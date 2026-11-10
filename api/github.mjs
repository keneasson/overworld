// Map a GitHub repository: its code becomes the land, its issues the work on
// it, its behaviour specs the laws of each place. See api/engine/ for how.
//
// Reads (all deterministic, no AI):
//   the file tree, every package.json, behaviour specs (docs/behavior/*.md, *.feature)
//   issues, with GitHub sub-issues and (with a token) the files each closing PR changed
//
// A token is optional (public repos work without one, at 60 requests/hour).
// It is used for this request only and never stored or logged.

import { ValidationError } from '../shared/schema.js';
import { parseSpec, SPEC_PATH } from './engine/behaviours.mjs';
import { buildProject } from './engine/project.mjs';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const MAX_ISSUES = 600;
const MAX_MANIFESTS = 40;
const MAX_SPECS = 30;

export function parseRepo(input) {
  const m = String(input ?? '')
    .trim()
    .match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) throw new ValidationError('repo must look like "owner/name" or a github.com URL');
  return { owner: m[1], name: m[2] };
}

export async function importGitHub({ repo, token }, fetchImpl = fetch) {
  const { owner, name } = parseRepo(repo);
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'projectmap',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  async function rest(path) {
    const res = await fetchImpl(`${API}${path}`, { headers });
    if (res.status === 404) throw Object.assign(new Error(`GitHub: ${owner}/${name} not found (private repos need a token)`), { status: 404 });
    if (res.status === 401) throw Object.assign(new Error('GitHub rejected the token'), { status: 400 });
    if (res.status === 403 || res.status === 429) throw Object.assign(new Error('GitHub rate limit reached — add a token or try later'), { status: 429 });
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}`);
    return res.json();
  }

  const info = await rest(`/repos/${owner}/${name}`);
  const branch = info.default_branch ?? 'main';
  const [paths, issues] = await Promise.all([
    rest(`/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`)
      .then((t) => (t.tree ?? []).filter((e) => e.type === 'blob').map((e) => e.path))
      .catch(() => []),
    (token ? viaGraphQL(owner, name, headers, fetchImpl).catch(() => null) : Promise.resolve(null)).then((r) => r ?? viaRest(owner, name, rest)),
  ]);

  // File contents come from raw.githubusercontent.com, outside the API rate limit.
  async function raw(path) {
    const res = await fetchImpl(`${RAW}/${owner}/${name}/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`, {
      headers: token ? { authorization: `token ${token}` } : {},
    });
    return res.ok ? res.text() : null;
  }
  const manifestPaths = paths.filter((p) => /(^|\/)package\.json$/.test(p) && !/node_modules\//.test(p)).slice(0, MAX_MANIFESTS);
  const specPaths = paths.filter((p) => SPEC_PATH.test(p) && !/node_modules\//.test(p)).slice(0, MAX_SPECS);
  const texts = await inBatches([...manifestPaths, ...specPaths], 8, (p) => raw(p).catch(() => null));
  const manifests = new Map();
  manifestPaths.forEach((p, i) => {
    try {
      if (texts[i]) manifests.set(p, JSON.parse(texts[i]));
    } catch {
      // Not every package.json parses (templates, fixtures); skip those.
    }
  });
  const specs = specPaths.map((p, i) => texts[manifestPaths.length + i] && parseSpec(p, texts[manifestPaths.length + i])).filter((s) => s && s.sections.length);

  // Open pull requests saying "Closes #N" put issue N in progress. One page is plenty for most repositories.
  const pulls = await rest(`/repos/${owner}/${name}/pulls?state=open&per_page=100`).catch(() => []);
  const built = buildProject({ repo: info, paths, manifests, specs, issues, pulls: (Array.isArray(pulls) ? pulls : []).map((p) => ({ number: p.number, title: p.title, body: p.body ?? '' })) });
  return { ...built, guide: await guideFor(paths, raw) };
}

const GUIDES = ['CONTRIBUTING.md', 'CLAUDE.md', 'AGENTS.md'];

/** What an agent should read first (MCP-08): the guides the repository has, and CONTRIBUTING.md's "Standing decisions". */
async function guideFor(paths, raw) {
  const conventions = GUIDES.filter((g) => paths.includes(g));
  const contributing = conventions.includes('CONTRIBUTING.md') ? await raw('CONTRIBUTING.md').catch(() => null) : null;
  const m = (contributing ?? '').match(/^##[ \t]+Standing decisions[ \t]*\n([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/im);
  return { conventions, standingDecisions: m ? m[1].trim().slice(0, 12000) : '' };
}

/** An issue as GitHub's REST API (and its webhooks) send it, in the shape the mapper reads. */
export function fromRest(i) {
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? '',
    state: i.state,
    stateReason: i.state_reason ?? null,
    url: i.html_url,
    labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    milestone: i.milestone && { title: i.milestone.title, dueOn: i.milestone.due_on },
    assignees: (i.assignees ?? []).map((a) => a.login),
    type: i.type?.name ?? null,
    parent: null,
    prs: [],
    subIssueCount: i.sub_issues_summary?.total ?? 0,
  };
}

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

async function viaRest(owner, name, rest) {
  const raw = [];
  for (let page = 1; raw.length < MAX_ISSUES; page++) {
    const batch = await rest(`/repos/${owner}/${name}/issues?state=all&per_page=100&page=${page}&sort=created&direction=asc`);
    raw.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) break;
  }
  const issues = raw.map(fromRest);
  // Sub-issue relationships need one request per parent; cap it to stay inside unauthenticated rate limits.
  const parents = issues.filter((i) => i.subIssueCount > 0).slice(0, 25);
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  for (const p of parents) {
    try {
      const subs = await rest(`/repos/${owner}/${name}/issues/${p.number}/sub_issues?per_page=100`);
      for (const s of subs) {
        const child = byNumber.get(s.number);
        if (child) child.parent = p.number;
      }
    } catch {
      break;
    }
  }
  return issues;
}

async function viaGraphQL(owner, name, headers, fetchImpl) {
  const query = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){issues(first:50,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){pageInfo{hasNextPage endCursor}nodes{number title body state stateReason url labels(first:20){nodes{name}} milestone{title dueOn} assignees(first:3){nodes{login}} parent{number} issueType{name} closedByPullRequestsReferences(first:5){nodes{number files(first:100){nodes{path}}}}}}}}`;
  const issues = [];
  let after = null;
  do {
    const res = await fetchImpl(`${API}/graphql`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { owner, name, after } }),
    });
    const json = await res.json();
    if (!res.ok || json.errors) throw new Error(json.errors?.[0]?.message ?? `GraphQL ${res.status}`);
    const conn = json.data.repository.issues;
    for (const i of conn.nodes) {
      issues.push({
        number: i.number,
        title: i.title,
        body: i.body ?? '',
        state: i.state.toLowerCase(),
        stateReason: i.stateReason,
        url: i.url,
        labels: i.labels.nodes.map((l) => l.name),
        milestone: i.milestone,
        assignees: i.assignees.nodes.map((a) => a.login),
        type: i.issueType?.name ?? null,
        parent: i.parent?.number ?? null,
        prs: (i.closedByPullRequestsReferences?.nodes ?? []).map((p) => ({ number: p.number, files: (p.files?.nodes ?? []).map((f) => f.path) })),
      });
    }
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after && issues.length < MAX_ISSUES);
  return issues;
}
