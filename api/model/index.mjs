// The model: every read and write of the app's data goes through an access pattern here.
// api/app.mjs (the controller) calls them by name and never sees keys or DynamoDB.
// See README.md in this folder for the table design.

import { createTable } from './table.mjs';
import { projects } from './access-patterns/projects.mjs';
import { nodes } from './access-patterns/nodes.mjs';
import { flags } from './access-patterns/flags.mjs';
import { changesets } from './access-patterns/changesets.mjs';
import { comments, inbox, questions } from './access-patterns/comments.mjs';
import { errors } from './access-patterns/errors.mjs';
import { coverage } from './access-patterns/coverage.mjs';
import { audits, budgets, jobs, leases, links } from './access-patterns/sync.mjs';
import { findings } from './access-patterns/coherence.mjs';
import { actions, agents, builds, claims, facts, handoffs, limits, requests } from './access-patterns/agents.mjs';

export async function createModel(env = process.env) {
  return modelFor(await createTable(env));
}

export function modelFor(table) {
  return {
    projects: projects(table), nodes: nodes(table), flags: flags(table), errors: errors(table), changesets: changesets(table), comments: comments(table), inbox: inbox(table), questions: questions(table),
    jobs: jobs(table), leases: leases(table), budgets: budgets(table), audits: audits(table), links: links(table),
    agents: agents(table), builds: builds(table), claims: claims(table), handoffs: handoffs(table), facts: facts(table), actions: actions(table), requests: requests(table), limits: limits(table),
    findings: findings(table),
    coverage: coverage(table),
  };
}
