# Overworld

In a game, the overworld is the map that joins every level: you see the whole world, walk to a
place and step into it. Overworld does that for a project.

See a project the way you read a map. Zoom all the way out and you see the project's
name, purpose and whether it is on target, with its areas laid out like countries. Zoom in
and the map shows areas, then epics, features, stories, and finally a single task's
acceptance criteria. You never get more text on screen, only a closer view.

## Projections

Like a globe flattened onto paper, the same project can be drawn more than one way
(Layers → Projection).

**Site layout** (default) is shaped like the product, so you can find things by where
you would expect them:

- **Continents are surfaces.** A web app is a wide screen, a mobile app is a tall phone,
  an API is a thin strip between the front ends and the back end, each back-end service
  is its own landmass, and third-party integrations are small islands. They are stacked
  the way data flows: clients on top, then APIs, then services. Work you have not given a
  continent shares an **On screen** landmass, or **Behind the screen** if it has no spot
  on screen (APIs, pipelines, the design system).
- **Inside a region, things sit where they live.** On a screen the header is on top, the
  footer at the bottom, filters on the left and the cart on the right. In a service,
  endpoints are on top and storage is at the bottom. Items in the same spot keep their
  order, so pages read left to right in journey order.
- **Area is still work.** Like a cartogram, positions follow the product and sizes follow
  the amount of work, so a big header means a lot of header work.

Placement is guessed from titles and tags ("Footer links", "Orders database", "Stripe
integration"). You can override it in the editor: *Where it sits* is a nine-spot screen
plus *Behind the screen*, and top-level items have *Its own continent?*.

**Organic** is one island of free-form territories, sized by work.

## Reading the map

| Map idea | Project idea |
| --- | --- |
| Continents (Site layout) | Web app, mobile app, emails, API, services, third parties |
| Island (Organic) | The project |
| Countries → provinces → cities → blocks | Areas → epics → features → stories/tasks |
| Land area | Size of the work (estimates, or item count) |
| Faded capitals over a region | The parent you are inside (like a country name at street level) |
| Roads (Routes toggle) | `depends on` / `navigates to` / `relates to` links, merged into whatever level you are viewing |
| Pin | The selected item |

**Lenses** (the chips across the top, or the Layers button) re-colour the same geography:

- **Map**: one colour per area.
- **On target**: rolled-up health (blocked or overdue work turns its region red). The list shows root causes.
- **Progress**: terrain from sand (untouched) to deep green (done).
- **Bugs**: heat by open bugs, with each bug as an incident dot.
- **Poorly defined (Fog)**: hatches items missing a summary, details, acceptance criteria or an estimate.
- **Behaviours**: the laws of each place. Regions are coloured by how many of their spec'd behaviours
  are kept (green), partly kept (amber) or missing (red); undecided ones are violet; land with no spec is hatched.
- **New features**: a night view where every `new-feature` user story is a light, so clusters glow.
- **Owners**: who owns each region; hatched regions have no owner.

A typical workflow: pick a lens (e.g. *Bugs*), see where it is hot, zoom into that area,
and the results list narrows to what is under you.

Keys: `/` search · `+`/`-` zoom · arrows pan · `Esc` close. Every view is a shareable URL
(project, selection, lens, position).

## Architecture

```
web/      React 19 + Vite. Canvas renderer with semantic-zoom labels. Two layouts:
          Site (anchored power diagrams: each child starts where it sits on screen and
          its weight grows until its area matches its share of the work) and Organic
          (nested Voronoi treemap, d3-voronoi-map). A smooth domain warp turns straight
          cuts into borders and coastlines.
api/      Framework-free Node API (also serves the built web app). Runs in one Lambda.
          app.mjs holds the routes; it reads and writes only through the model.
api/model/  The only code that talks to DynamoDB: one table (single-table design), with
          an access-patterns/ file per entity. Keys and patterns: api/model/README.md.
api/engine/  The deterministic repository mapper (no AI): architecture.mjs reads the code's
          shape, references.mjs nests issues, placement.mjs puts work where its code lives,
          behaviours.mjs reads specs, project.mjs assembles the map.
shared/   Schema and validation used by both sides.
template.yaml  SAM: DynamoDB (on-demand, retained on delete) + Lambda (Node 24, arm64)
               with a public Function URL. Reserved concurrency 10 caps runaway cost.
```

Data lives in one DynamoDB table. A project and its nodes share a partition
(`PROJECT#<id>`), so opening a map is a single query, and a sparse index (GSI1) lists the
projects. The keys, every access pattern, and how to add one are in
[`api/model/README.md`](api/model/README.md). Every node has a title, a summary, a Markdown body,
kind, status, a health override, a definition override, priority, owner, estimate, due date,
tags, links, `place` (where it sits inside its parent) and `surface` (whether a top-level
item is its own continent: web, mobile, email, api, service, external or uncharted).

The rollups (progress, health, bug counts, definition score) are computed in the browser
(`web/src/model/tree.js`), so a change shows up across every level immediately.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173. The API runs in-process on a JSON file in .data/
npm test           # API, import engine and layout tests
npm run deploy     # builds, bundles, and runs sam deploy (default AWS profile/region)
npm run destroy    # removes the stack (the table is kept; the command to drop it is printed)
```

`deploy` uses `AWS_PROFILE`, `AWS_REGION` and `STACK_NAME` when set. On the first deploy it
generates an access key and writes it, with the URL, to `.projectmap.local.json` (git-ignored,
mode 600). Set `PROJECTMAP_ACCESS_KEY` to choose your own key.

Changes to the keys of data that is already deployed go in `scripts/migrations/`, numbered and
run by hand. Each migration backs the table up to `.data/backups/` before it writes anything.

The name lives in `shared/brand.js` (plus this README and the descriptions in `template.yaml`).
The stack, the access-key header, browser storage and `.projectmap.local.json` keep the original
`projectmap` name on purpose, so renaming never strands a deployed map.

## Mapping a GitHub repository

Menu → *Map a GitHub repository*, then enter `owner/repo`. The map is built from the repository
itself, deterministically: no AI, so the same repository always draws the same map.

- **The land is the code.** The file tree and every `package.json` decide the continents: a
  Next.js / SvelteKit / Remix / Vite app is a wide screen whose route tree is the site map
  (route groups like `(public)` become sections, `auth` is sign-in at the top right, navigation
  components run across the top); API routes form the API strip; an Expo / React Native app is a
  phone; React Email templates are a letter; servers and SAM/serverless folders are services;
  shared packages, server code, tests and docs sit behind the screen; and services the code
  depends on (SES, DynamoDB, S3, Stripe, Google Sheets, …) are islands.
- **The work is the issues, nested by what they say.** GitHub sub-issues, task lists
  (`- [ ] #12`, `- [x] Phase 1 … (#23)`, or a lettered slice that reads like another issue's
  title), "Part of #55", "Epic #131", "(#270 Phase 2)" in a title, and "Follow-up to #124".
  Lines that only cross-reference ("Related: #20", "See #27") never nest anything.
- **Each issue sits where its code lives**: the files its closing pull requests changed (with a
  token), the files and URLs it mentions, the place its title names ("Exhorter heads-up email"),
  and only then shared words, which are marked as a guess. Where you would *see* a behaviour
  beats where the code sits, so a page wins over the API route behind it. A parent issue sits
  where most of its family is. Anything with nothing to go by lands on the *Uncharted* island.
  Every issue ends with a 📍 line saying why it is where it is.
- **The laws are the behaviour specs.** Markdown tables (`| ID | Scenario | Status |` with
  ✅ ⚠️ ❌ ⏸ 🔷) in `docs/behavior/`, `specs/` or `requirements/`, and Gherkin `.feature` files,
  become behaviours under the place they describe, linked to the issues they cite.
  "🔷 Decision needed" is fog.

Milestones become due dates and tags (they say when, not where). Labels and issue types set the
kind; `depends on #123` becomes a dependency. The ↻ button next to an imported project maps the
repository again in place (same link). A token is optional: it unlocks private repositories and
pull-request files, is used for that one request and is never stored.

## Cost

At personal-use volumes this costs essentially nothing:

- Lambda stays inside the free tier.
- DynamoDB on-demand costs fractions of a cent.
- Logs are kept for 14 days.
- SAM's artifact bucket holds a few MB.
