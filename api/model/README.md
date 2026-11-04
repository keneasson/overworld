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
| Node    | `PROJECT#<id>` | `NODE#<nodeId>` |          |             |
| Flag    | `APP`          | `FLAG#<name>` |          |             |

A project and its nodes share a partition, so one query reads a whole map. GSI1 is sparse:
only projects carry its keys, which makes it the project list.

## Access patterns

| Access pattern | Method | How |
| -------------- | ------ | --- |
| List projects, most recently updated first | `projects.list()` | Query GSI1, `GSI1PK = PROJECTS`, descending |
| Open a project's map | `projects.getWithNodes(id)` | Query `PK = PROJECT#<id>` |
| Save a project's summary | `projects.put(project)` | PutItem |
| Delete a project and its map | `projects.delete(id)` | Query the partition, batched deletes |
| Add or change nodes | `nodes.put(projectId, nodes)` | Batched puts |
| Delete nodes | `nodes.delete(projectId, ids)` | Batched deletes |
| Replace a whole map (GitHub refresh) | `nodes.replace(projectId, nodes)` | Query `begins_with(SK, NODE#)`, puts first, then deletes |
| Has a one-off thing happened? | `flags.has(name)`, `flags.set(name)` | GetItem, PutItem |

## Adding a feature

1. Write the access pattern in the table above first: what is asked for, and by whom.
2. Choose keys so that it's a GetItem or a Query on one partition. The app never scans.
   `scan()` exists for migrations and backups only.
3. Add the keys to `keys.mjs`, the method to `access-patterns/`, and a test in
   `api/test/model.test.mjs`.
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
