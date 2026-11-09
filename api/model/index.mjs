// The model: every read and write of the app's data goes through an access pattern here.
// api/app.mjs (the controller) calls them by name and never sees keys or DynamoDB.
// See README.md in this folder for the table design.

import { createTable } from './table.mjs';
import { projects } from './access-patterns/projects.mjs';
import { nodes } from './access-patterns/nodes.mjs';
import { flags } from './access-patterns/flags.mjs';
import { changesets } from './access-patterns/changesets.mjs';
import { comments } from './access-patterns/comments.mjs';

export async function createModel(env = process.env) {
  return modelFor(await createTable(env));
}

export function modelFor(table) {
  return { projects: projects(table), nodes: nodes(table), flags: flags(table), changesets: changesets(table), comments: comments(table) };
}
