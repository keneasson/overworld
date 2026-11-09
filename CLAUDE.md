# Overworld

A project shown as a map. The code is the land, issues are the work on it, and behaviour specs
are its laws. Zoom out to see the whole product and zoom in to see one task. `README.md`
explains the product. This file covers how to work on it.

## Commands

```sh
npm run dev      # web app + API in-process on .data/table.json, http://localhost:5173
npm test         # must pass before every deploy
npm run deploy   # builds, bundles, sam deploy; prints the URL and runs a health check
```

## Where things go

- `api/app.mjs`: the API routes, acting as the controller. It never builds keys and never imports the AWS SDK.
- `api/model/`: the only code that talks to DynamoDB, using a single-table design.
  - A new data need gets an access pattern in `api/model/access-patterns/`, its keys in `keys.mjs`, a row in `api/model/README.md` and a test in `api/test/model.test.mjs`.
  - The app never scans the table.
- `api/sync.mjs`: sync with each project's store (#3): saving (`saveNow`, the one path every save trigger calls), the outbox worker, store events and the nightly reconciliation. It reaches a store only through the store API in `api/stores/index.mjs` (SYNC-14), and never imports anything store-specific.
- `api/stores/github/`: GitHub as a store. `state.mjs` is the one place that says how an item's state is written on GitHub (labels, open or closed); `app.mjs` writes as the GitHub App; `index.mjs` is the store and turns webhooks into store events. `api/aws.mjs` holds what sync needs from AWS (SSM, Scheduler), and `api/handler.mjs` routes the stream and schedules to it.
- `api/engine/`: the deterministic repository mapper. It uses no AI, so the same repository always gives the same map. AI reading will be a separate, metered feature.
- `shared/`: the schema and validation used by both sides. `shared/brand.js` holds the product name.
- `web/`: React plus a Canvas 2D renderer. Rollups are computed in `web/src/model/tree.js`.
- `scripts/migrations/`: changes to deployed data, numbered and run by hand. Each one backs up the table first.
- `.github/workflows/`: CI and delivery. Pull requests are tested, main deploys to production, and a pull request labelled `preview` gets a temporary stack. The limits and setup are in `.github/workflows/README.md`; the rules are in `scripts/ci/rules.mjs`.
- `infra/`: AWS resources outside the app's stack, deployed once by hand, such as CI's role (`infra/ci-bootstrap.yaml`).

## Conventions

- **Naming.** The product name may change, so keep it in `shared/brand.js` and keep code comments name-neutral. Deployed identifiers stay `projectmap`: the stack, the `x-projectmap-key` header and browser storage keys.
- **Secrets live in `.conf/`, which git ignores as a whole.** Never print or commit them. That covers the access key in `.conf/deploy.json` and GitHub tokens, which are used per request and never stored. A new secret or machine-local setting goes in `.conf/`, read through `scripts/local-config.mjs`.
- **Code style.**
  - Match the surrounding code: single quotes, long lines (about 180 columns), and short comments that say why.
  - No formatter is installed, so don't run `npx prettier`.
- **The Fog lens** (poorly defined work) is a favourite. Keep it working.
