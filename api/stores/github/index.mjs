// GitHub as a store (SYNC-14): a repository's issues behind Overworld's store API (../index.mjs).
// An item's ref is its issue number, as a string. Writes go through the Overworld GitHub App (app.mjs);
// how a state becomes labels and open or closed is state.mjs.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { editableOf, issueOf, splitNote } from '../../../shared/issue-shape.js';
import { fromRest, importGitHub } from '../../github.mjs';
import { closedByOpenPrs } from '../../engine/lifecycle.mjs';
import { issueFields, issueNodeId } from '../../engine/project.mjs';
import { TransientError } from '../errors.mjs';
import { labelsForNew, patchFor, sameVersion, stateAsRead, stateOf, versionOnGitHub } from './state.mjs';

const PLACEMENT_TAGS = new Set(['placed-by-words', 'unplaced']);
export const githubKey = (repo) => `github:${repo.toLowerCase()}`;
const hidden = (guard) => `<!-- ${guard} -->`;

/** A node with what GitHub now says about its issue, keeping where it sits on the map and why. */
function mapIssueOnto(node, ghIssue, { strict }) {
  const issue = fromRest(ghIssue);
  const note = splitNote(node.body ?? '').note.replace(/^\s*---\s*📍\s*/, '').replace(/ Status unclear: [^.]*\.$/, '');
  const placement = (node.tags ?? []).filter((t) => PLACEMENT_TAGS.has(t));
  // A pull request that closes the issue keeps it in progress; events about the issue don't say so, so keep what the map knew.
  const inProgress = node.status === 'in_progress' && issue.state === 'open' ? new Set([issue.number]) : new Set();
  return { ...node, ...issueFields(issue, { lifecycle: { strict, inProgress }, note, placement, kind: node.kind }) };
}

/**
 * @param {object} o
 * @param {string} o.repo owner/name
 * @param {boolean} [o.strict] the repository uses status labels, so states are written as labels
 * @param {object} [o.app] the GitHub App client; without it, nothing can be read or written as the App
 */
export function githubStore({ repo, strict = true, app = null, fetchImpl = fetch }) {
  const client = () => {
    if (!app) throw new TransientError('The GitHub App is not set up here');
    return app;
  };
  return {
    key: githubKey(repo),
    // GitHub allows 80 content-creating requests a minute and 500 an hour; sync keeps well under (SYNC-10).
    writeBudget: { perMinute: 20, perHour: 150 },
    refOf: (node) => {
      const issue = issueOf(node);
      return issue ? String(issue.number) : null;
    },
    nodeIdOf: (ref) => issueNodeId(Number(ref)),
    mention: (ref) => `#${ref}`,
    wanted: (node) => ({ ...editableOf(node), state: stateOf(node, { strict }) }),
    asRead: (node) => ({ ...editableOf(node), state: stateAsRead(node, { strict }) }),
    same: sameVersion,
    read: (ref) => client().getIssue(repo, Number(ref)),
    version: (item) => versionOnGitHub(item, { strict }),
    async create(version, { guard, epic }) {
      const { number } = await client().createIssue(repo, { title: version.title, body: `${version.markdown}\n\n${hidden(guard)}`, labels: labelsForNew(version, { epic }) });
      return { ref: String(number) };
    },
    async findCreated(guard, since) {
      const found = await client().findCreated(repo, hidden(guard), since);
      return found ? { ref: String(found.number) } : null;
    },
    carriesGuard: (item, guard) => (item.body ?? '').includes(hidden(guard)),
    update: (ref, item, version) => client().updateIssue(repo, Number(ref), patchFor(item, version, { strict })),
    placed: (node, ref) => ({ ...node, url: `https://github.com/${repo}/issues/${ref}`, title: `#${ref} ${node.title}`.slice(0, 200) }),
    onMap: (node, item) => mapIssueOnto(node, item, { strict }),
    async mapAgain({ token } = {}) {
      if (!token && app) token = await app.token().catch(() => undefined); // private repositories need the App; public ones read without it
      const data = await importGitHub({ repo, token }, fetchImpl);
      return { nodes: data.nodes, project: { strictLifecycle: data.strictLifecycle } };
    },
  };
}

/** Is this webhook delivery signed with the App's webhook secret? */
export function signedByGitHub(rawBody, signature, secret) {
  const want = `sha256=${createHmac('sha256', secret).update(rawBody ?? '').digest('hex')}`;
  const got = String(signature ?? '');
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** A GitHub webhook as store events: { key, events }, or null for a delivery sync doesn't use. */
export function eventsFromWebhook(event, payload) {
  const repo = payload?.repository?.full_name;
  if (!repo) return null;
  if (event === 'issues' && payload.issue && !payload.issue.pull_request) return { key: githubKey(repo), events: [{ type: 'changed', ref: String(payload.issue.number), item: payload.issue }] };
  if (event === 'pull_request' && ['opened', 'reopened', 'edited'].includes(payload.action) && payload.pull_request?.state === 'open') {
    return { key: githubKey(repo), events: [...closedByOpenPrs([payload.pull_request])].map((n) => ({ type: 'started', ref: String(n) })) };
  }
  return null;
}
