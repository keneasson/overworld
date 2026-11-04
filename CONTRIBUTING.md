# Contributing

Contributions are welcome, from people and from people working with coding agents. The bar is
the same either way: craft, not slop. Read [VISION.md](VISION.md) first.

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

## Lifecycle

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
- `npm test` must pass.
- Follow the conventions in [CLAUDE.md](CLAUDE.md). It's written for agents, but it applies to
  everyone.

## Contributor License Agreement

Overworld is licensed under the [GNU AGPL-3.0](LICENSE). The first time you open a pull
request, a bot asks you to sign the [CLA](CLA.md) by posting a comment. You keep the copyright
in your work. The CLA lets the maintainer also offer Overworld under other terms, which keeps
the project sustainable.
