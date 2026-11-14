# Data model

One DynamoDB table, single-table design. Nothing outside `api/model/` talks to DynamoDB:
the API routes in `api/app.mjs` call access patterns by name, like a controller calling a
model.

- **`table.mjs`** is the table itself: DynamoDB in AWS, and a JSON file with the same
  semantics for local dev and tests. It's the only file that imports the AWS SDK.
- **`keys.mjs`** defines every entity's keys.
- **`access-patterns/`** has one file per entity. Each exported method is one access pattern.

## Entities

| Entity  | PK             | SK            | GSI1PK   | GSI1SK      |
| ------- | -------------- | ------------- | -------- | ----------- |
| Project | `PROJECT#<id>` | `PROJECT`     | `PROJECTS` | `<updatedAt>` |
| Node    | `PROJECT#<id>` | `NODE#<nodeId>` | `PENDING#<id>`, only while it has a sync state | `<itemKey>` |
| Flag    | `APP`          | `FLAG#<name>` |          |             |
| Changeset | `PROJECT#<id>` | `CHANGESET#<changesetId>` | | |
| Comment | `PROJECT#<id>` | `COMMENT#<itemKey>#<commentId>` | | |
| Sync job | `PROJECT#<id>` | `JOB#<savedAt>#<itemKey>` | | |
| Sync lease | `PROJECT#<id>` | `LEASE#sync` | | |
| Write budget | `PROJECT#<id>` | `LEASE#budget` | | |
| Reconciliation report | `PROJECT#<id>` | `AUDIT#<at>` | | |
| Store link | `STORE#<store key>` | `PROJECT#<id>` | | |
| Agent | `PROJECT#<id>` | `AGENT#<agentId>` | | |
| Agent token | `TOKEN#<sha256 of the token>` | `TOKEN` | | |
| Claim | `PROJECT#<id>` | `CLAIM#<behaviourId>` | | |
| Handoff note | `PROJECT#<id>` | `HANDOFF#<itemKey>#<at>#<id>` | | |
| Remembered fact | `PROJECT#<id>` | `FACT#<at>#<id>` | | |
| Agent action | `PROJECT#<id>` | `ACTION#<at>#<id>` | `ACTIONS#<id>#<agentId>` | `<at>` |
| Request key | `PROJECT#<id>` | `KEY#<agentId>#<requestKey>` | | |
| Call count | `PROJECT#<id>` | `LIMIT#<agentId>#<minute>` | | |

A project and its nodes share a partition, and sort last in it (`NODE#…`, then `PROJECT`), so one
query reads a whole map and nothing else. A new entity in the partition must sort before `NODE#`. Changesets and
comments share it too, so deleting a project removes them with it. They are keyed by the item
they concern (`issue-<number>` for a GitHub issue, `node-<id>` otherwise). Comment ids start with the time, so a thread reads in order, because a refresh from
GitHub gives every node a new id. GSI1 is sparse. Projects carry its keys, which makes it the project list.
So does a node while it has a sync state (unsaved, saving, conflict or failed): that makes it the list of
items not yet in line with their store, so a save or a refresh finds them without reading the map.

Sync with each project's store (#3) keeps its state in the project's partition too: the outbox of saved items (one
job per item and save; an item saved again before it was written replaces its job), the lease that lets
one worker at a time sync a project, its recent writes (the write budget), and the last 30 reconciliation reports. All of them
sort before `NODE#`, so opening a map never reads them. An issue's node id is `issue-<number>`, so a
webhook about one issue reads and writes one item. Store links are the one thing outside a project's
partition: they let an event from a store (a GitHub webhook, say) find the projects that live there
without a scan. A store's key names it, e.g. `github:owner/name`. A link left behind by a deleted
project is removed the next time an event finds it.

Agents that use a project through MCP (#4) keep their records in its partition too, all sorting before `NODE#`:
who they are, their claims (one per behaviour, so a claim is one conditional write), handoff notes (by item, so
`context()` reads one item's notes), remembered facts, and what each changed. Actions carry GSI1 keys, so one agent's
work lists without reading anyone else's. Request keys, call counts and actions carry `expiresAt`, the table's TTL
(a day, two minutes and 90 days), so DynamoDB removes them for free; a read still checks `expiresAt`, because TTL
deletes late. A token is found by its hash in one GetItem, outside any partition, so deleting a project deletes its
agents' tokens first. The token itself is never stored.

## Access patterns

| Access pattern | Method | How |
| -------------- | ------ | --- |
| List projects, most recently updated first | `projects.list()` | Query GSI1, `GSI1PK = PROJECTS`, descending |
| Open a project's map | `projects.getWithNodes(id)` | Query `PK = PROJECT#<id>`, `SK >= NODE#`: the project and its nodes, never its changesets or comments |
| Save a project's summary | `projects.put(project)` | PutItem |
| Delete a project and its map | `projects.delete(id)` | Query the partition, batched deletes |
| Add or change nodes | `nodes.put(projectId, nodes)` | Batched puts |
| Delete nodes | `nodes.delete(projectId, ids)` | Batched deletes |
| Replace a whole map (read from its store again) | `nodes.replace(projectId, nodes)` | Query `begins_with(SK, NODE#)`, puts first, then deletes |
| An area's changesets: open, accepted, discarded | `changesets.list(projectId)` | Query `begins_with(SK, CHANGESET#)` |
| Open one changeset | `changesets.get(projectId, id)` | GetItem |
| Save a changeset (edits, accept, discard) | `changesets.put(projectId, changeset)` | PutItem |
| Every comment in a project, by item then time | `comments.list(projectId)` | Query `begins_with(SK, COMMENT#)` |
| One item's comment thread | `comments.list(projectId, itemKey)` | Query `begins_with(SK, COMMENT#<itemKey>#)` |
| Add, resolve or delete a comment | `comments.get` / `put` / `delete` | GetItem, PutItem, DeleteItem |
| Has a one-off thing happened? | `flags.has(name)`, `flags.set(name)` | GetItem, PutItem |
| A project's summary, without its map | `projects.get(id)` | GetItem |
| One node (an issue's is `issue-<number>`) | `nodes.get(projectId, id)` | GetItem |
| Items not yet in line with their store (to save, or to keep through a refresh) | `nodes.pending(projectId)` | Query GSI1, `GSI1PK = PENDING#<id>` |
| Save: queue items for the store (the outbox) | `jobs.save(projectId, saves)` | TransactWriteItems: each item's node, its job and the job it replaces, or none of them |
| What is still on its way to the store, in the order saved | `jobs.list(projectId)` | Query `begins_with(SK, JOB#)` |
| A job's attempts, next try, or the new item's ref | `jobs.put(projectId, job)` | PutItem |
| An item synced: its node's outcome, and its job gone | `jobs.finish(projectId, job, { node, rebased })` | TransactWriteItems |
| A project's recent writes to its store | `budgets.get(projectId)`, `budgets.put(projectId, writes)` | GetItem, PutItem |
| Hold or let go of a project's sync | `leases.claim(projectId, owner, until, now)`, `leases.release(projectId, owner)` | Conditional PutItem; GetItem, DeleteItem |
| The last reconciliations, newest first | `audits.list(projectId)` | Query `begins_with(SK, AUDIT#)`, descending |
| Keep a report, and drop those past the last 30 | `audits.put(projectId, report)` | Query, then batched put and deletes |
| Projects that live in a store (its events) | `links.projectsOf(key)` | Query `PK = STORE#<key>` |
| Link or unlink a project and its store | `links.link(key, projectId)`, `links.unlink(key, projectId)` | PutItem, DeleteItem |
| A project's agents | `agents.list(projectId)` | Query `begins_with(SK, AGENT#)` |
| One agent | `agents.get(projectId, id)` | GetItem |
| Make an agent and its token | `agents.create(projectId, agent, tokenHash)` | Conditional PutItem (the id is free), then PutItem |
| Save an agent (its last handoff, its last standup, its revocation) | `agents.put(projectId, agent)` | PutItem |
| Who a token belongs to | `agents.byToken(tokenHash)` | GetItem `TOKEN#<hash>` |
| Revoke a token, or every token of a project | `agents.revokeToken(hash)`, `agents.revokeAll(projectId)` | DeleteItem; Query `AGENT#`, then batched deletes |
| A project's claims | `claims.list(projectId)` | Query `begins_with(SK, CLAIM#)` |
| Claim behaviours, all or none | `claims.take(projectId, claims, { owner, now })` | TransactWriteItems, each put conditional on nobody else holding it |
| Release a claim (a handoff, or an expiry) | `claims.release(projectId, behaviour, { owner, until })` | Conditional DeleteItem |
| One item's handoff notes | `handoffs.list(projectId, itemKey)`, `handoffs.put` | Query `begins_with(SK, HANDOFF#<itemKey>#)`; PutItem |
| What a project remembers | `facts.list(projectId)`, `facts.put`, `facts.delete` | Query `begins_with(SK, FACT#)`; PutItem; DeleteItem |
| Record a change by an agent; one agent's changes | `actions.put(projectId, action)`, `actions.list(projectId, agentId)` | PutItem; Query GSI1 `ACTIONS#<id>#<agentId>`, descending |
| Every agent's changes since a time (a standup) | `actions.since(projectId, at)` | Query `SK BETWEEN ACTION#<at> AND ACTION#~` |
| A change's request key: start, read, finish, forget | `requests.start` / `get` / `finish` / `forget` | Conditional PutItem; GetItem; PutItem; DeleteItem |
| Count an agent's call this minute | `limits.count(projectId, agentId, minute, limit)` | UpdateItem `ADD`, conditional on the limit |

## Adding a feature

1. Write the access pattern in the table above first: what is asked for, and by whom.
2. Choose keys so that it's a GetItem or a Query on one partition. The app never scans.
   `scan()` exists for migrations and backups only.
3. Add the keys to `keys.mjs` and the method to `access-patterns/`. Which keys a pattern uses
   is mechanics, so it gets no test of its own: `api/test/model.test.mjs` tests the design's
   promises once, through the API (DATA-01 no scans, DATA-02 a map opens in one query that reads only the map, DATA-03 a
   project's partition goes with it). The feature's own tests prove its behaviours.
4. If existing keys change, add a migration in `scripts/migrations/` that backs the table up
   first.
5. A new index ships in its own deploy, before any code that reads it. CloudFormation reports
   the table as updated while DynamoDB is still filling the index, and reads fail until it's
   done. Adding GSI1 caused about 8 minutes of errors on the project list.

## Planned for accounts and billing (not built)

- **Users:** stored at `USER#<id>` / `PROFILE`.
- **Projects:** move from `GSI1PK = PROJECTS` to `GSI1PK = OWNER#<userId>`, so the list
  becomes "my projects".
- **Subscriptions:** stored at `USER#<id>` / `SUBSCRIPTION`, with the Stripe customer and
  subscription ids.
- **Metered AI use:** `USER#<id>` / `USAGE#<yyyy-mm>`, as counters.
