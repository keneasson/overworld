# Vision

**Craft, not slop.** Overworld exists to show what careful software development with AI looks
like. It starts with behaviours and requirements that are clearly expressed, and with a
constant dialogue between the people and the agents building the product.

## A product is chaos, defined

A product is never finished. It evolves, throws out the old and builds the new. Facebook
today looks nothing like Facebook in 2010, and that's good: apps that fail to evolve fail.
But all that change is hard to manage. Issue lists, Kanban boards and wiki pages are flat and
top-down. They show the work as a queue, not the product as a place.

Overworld shows the product as a map, and maps are made to evolve. Borders move, cities grow
and old roads close, and the map is redrawn. You can still find your way.

## Read it like a map

- **Zoom.** Zoom out for scope, zoom in for detail. You never scroll down a list and follow
  a link to an issue that doesn't show where it fits in the whole project.
- **What belongs together is drawn together.** An epic is a country, its features are
  regions, and its tasks are towns. The web app, the mobile app, the API and third-party
  services are continents shaped roughly like the product itself.
- **Layers.** Show bugs, completion, status, age, poorly defined work (the Fog), any
  combination of them, or none.
- **A legend.** Symbols you learn once and then read at a glance.
- **Roads.** Connections between things: dependencies, navigation and shared code.

## Collaboration happens on the map

On GitHub, one person edits an issue at a time. Comments are hard to follow, and the plan
stays flat. In Overworld a team reviews an *area* together: a developer, an agent and QA
looking at the same country. As decisions land, they change many of its issues at once.
When everyone is confident, the changes sync to GitHub Issues.

GitHub Issues is the free, durable store. Overworld owns what connects issues intelligently:
where each sits on the map, the links between them, behaviours, decisions and history. Sync is
eventually consistent, and it is guaranteed.

## As easy for agents as for people

A coding agent should never have to guess. Overworld gives agents:

- the same zoom levels people have;
- issues in a strict format;
- a clear lifecycle, so it's always obvious what is ready, in progress, waiting on a decision,
  done or rejected;
- a place to put questions and decisions that doesn't scroll away.

In a fast agent session, too much goes past in the terminal and gets missed, then repeated.
On the map, a question stays pinned to the place it concerns until someone answers it.

## Built with itself

Overworld is built from issues written in Overworld. Progress is shown by the pull requests
that close them. Its own roadmap is the first map it draws.
