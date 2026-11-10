# Contributing

Contributions are welcome, from people and from people working with coding agents. The bar is
the same either way: craft, not slop. Read [VISION.md](VISION.md) first.

## Standing decisions

The maintainer's standing decisions, for people and agents alike. Each is a directive; the reasons
are in the linked issue. Dated 2026-11-08 unless marked otherwise. Until Overworld can hold them
itself (`remember` and `prime`, #4 MCP-08 and MCP-10), they live here ([AGENT-07](https://github.com/keneasson/overworld/issues/34)).

**Product**

1. **Prime Mandate.** Overworld is the interface between people and agents for defining behaviour, refining requirements and giving agents clear prompts. Judge every feature by whether it moves that conversation forward. (2026-11-07, [VISION.md](VISION.md#prime-mandate))
2. The map uses symbols, badges and roads. Long text goes in the place card, not on the canvas. ([#9](https://github.com/keneasson/overworld/issues/9), [#10](https://github.com/keneasson/overworld/issues/10))
3. Zoom is the vehicle for refinement: select part of the map and say "let's refine this". ([#13](https://github.com/keneasson/overworld/issues/13) ADOPT-01)
4. Behaviours are a human-readable version of the code: nothing less, nothing more. ([#18](https://github.com/keneasson/overworld/issues/18))
5. Behaviours have no lifecycle states. The spec works like code: the spec is main, a refinement is a pull request, and adoption is the merge. State has two axes, derived from the facts: agreement (needs improvement, ready for adoption, adopted) and building (new, being coded, coded). ([#32](https://github.com/keneasson/overworld/issues/32), [#13](https://github.com/keneasson/overworld/issues/13))
6. A person's yes, after working a behaviour through with an agent, adopts it. No second person is needed. Agents propose and revise; they never adopt alone. (2026-11-07, [#13](https://github.com/keneasson/overworld/issues/13))
7. Terrain:
   - Fog is behaviour nobody knows yet, written in *Behaviours* as `AREA-NN Not worked out yet: …`. ([#32](https://github.com/keneasson/overworld/issues/32) STATE-04)
   - An open question is a "?" badge, never Fog. ([#10](https://github.com/keneasson/overworld/issues/10) SYM-03)
   - Dead code is desert ([#22](https://github.com/keneasson/overworld/issues/22)); technical debt is wasteland ([#24](https://github.com/keneasson/overworld/issues/24)).
   - "Out of scope" that still needs working out is Fog in disguise: move it into *Behaviours*.
8. Overworld is where people and agents collaborate. GitHub is the permanent store, and it must still read as an ordinary tracker. A save is just a save: clicked or triggered, it decides nothing, and it writes each item's state in the store's own terms. ([#3](https://github.com/keneasson/overworld/issues/3) SYNC-07 to SYNC-11)
9. Everything that saves goes through the store API: GitHub first, Jira later. ([#3](https://github.com/keneasson/overworld/issues/3) SYNC-14)
10. Overworld is multi-tenant, sold per GitHub account and priced by the size of its projects in GB. (Maintainer, 2026-11-08; no issue yet.) Auth is tokens now, OAuth later. ([#4](https://github.com/keneasson/overworld/issues/4) MCP-07) AI is optional, and Overworld runs fully deterministic without it. Agents that build a project use the customer's own Claude (or other agent) and reach Overworld through MCP. Overworld Intelligence runs only on the customer's own provider credentials: an Anthropic API key, Bedrock or Foundry. Results vary by model, and Overworld doesn't tune for each one. Never route requests through a customer's Claude subscription. (2026-11-09, [#36](https://github.com/keneasson/overworld/issues/36))
11. The deterministic mapper uses no AI. AI reading is a separate feature. ([CLAUDE.md](CLAUDE.md))
12. The Fog lens is a favourite. Keep it working. ([CLAUDE.md](CLAUDE.md))

**Working rules**

13. Test behaviour, never mechanics. No behaviour, no test. Keep the suite small and fast. ([#19](https://github.com/keneasson/overworld/issues/19))
14. Name each test by its behaviour ID plus a short statement. A behaviour and its tests move together in one pull request. IDs never change and are never reused. ([#19](https://github.com/keneasson/overworld/issues/19), [#13](https://github.com/keneasson/overworld/issues/13) ADOPT-11)
15. Handoffs between agents go in comments on the issue, not in chat between sessions, so the next agent finds them. ([#34](https://github.com/keneasson/overworld/issues/34) AGENT-03)
16. A question from a peer is not a work order. Only the maintainer's own words approve. ([#34](https://github.com/keneasson/overworld/issues/34) AGENT-10)

## Issues have a strict shape

Every issue uses this structure. It comes from the issue template, and agents rely on it:

```
Part of #<parent>              ← where it nests on the map (leave out for top-level work)
Kind: Epic | Feature | Story | Task | Bug · Place: <page, path or area>

## Why
## Behaviours                  ← Given / When / Then, each with an ID (AREA-01)
## Acceptance
## Out of scope
## Open questions              ← while this has anything in it, the issue needs a decision
```

Leave *Open questions* empty, or write "None", when nothing is undecided. The map reads all of
this deterministically; see `api/engine/lifecycle.mjs`.

## Lifecycle

Being replaced by [#32](https://github.com/keneasson/overworld/issues/32); until it's decided, the status labels below still apply.

Every open issue carries exactly one `status:` label.

| State | On GitHub | Who moves it |
|---|---|---|
| Draft | open, `status:draft` | Whoever is writing the issue |
| Needs decision | open, `status:needs-decision` | Anyone who adds an open question |
| Ready | open, `status:ready` | The maintainer, once the open questions are answered |
| In progress | open, `status:in-progress` | A pull request that says `Closes #N` |
| Done | closed as *completed* | Merging that pull request |
| Rejected | closed as *not planned* | The maintainer, with a comment saying why |

Only pick up issues marked **Ready**. If you find a question while working, add it to the
issue's open questions and move the issue to `status:needs-decision`. Don't guess.

## Pull requests

- Link the issue with `Closes #N`. One issue per pull request where you can.
- Name the behaviour IDs the change satisfies, and the tests that prove them.
- Every test proves a behaviour, and is named by its ID plus a short, clear statement:
  `test('EDIT-01 each section opens as its own field')`. The issue holds the full behaviour.
  A test that names no behaviour is given one (proposed in its issue, then adopted) or deleted.
- Test what the product does, never how it does it, so a refactor that keeps the behaviour keeps
  the test passing. If there's no behaviour to prove, there's no test.
- A behaviour and its tests change in the same pull request, and the ID never changes, even if the
  behaviour moves to another issue.
- `npm test` must pass.
- Follow the conventions in [CLAUDE.md](CLAUDE.md). It's written for agents, but it applies to
  everyone.

## Contributor License Agreement

Overworld is licensed under the [GNU AGPL-3.0](LICENSE). The first time you open a pull
request, a bot asks you to sign the [CLA](CLA.md) by posting a comment. You keep the copyright
in your work. The CLA lets the maintainer also offer Overworld under other terms, which keeps
the project sustainable.
