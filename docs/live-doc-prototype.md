# Live document prototype

One shared, live document per item, edited at once by people, agents and GitHub, instead of a parallel copy (a refinement)
per writer merged later with Adopt and Accept. Local only: it is not deployed and the production build leaves it off.

## Try it

```sh
npm install
npm run dev     # the app on :5173, and the collaboration server (Hocuspocus) on ws://localhost:1234
```

1. Map `keneasson/overworld` locally (Menu → *Map a GitHub repository*) so `issue-13` exists in `.data/table.json`.
2. Open #13 Adopt behaviours through refinement in two tabs. Each shows a **Live** bar with who is in the document; typing in
   one shows a named, coloured caret in the other.
3. `node scripts/live-agent.mjs --item issue-13 --behaviour ADOPT-11`: "Claude" joins with its own caret and streams a new
   wording into ADOPT-11 as a suggestion (new words highlighted in its colour, old words struck), with ✓ Accept and ✕ Reject
   at its end, then replies in a comment thread on ADOPT-11. With `ANTHROPIC_API_KEY` set it streams from `claude-opus-5-5`
   (low effort); otherwise a scripted revision. `--ask "…"` passes a request along.
4. `node scripts/live-github.mjs --item issue-13 [--behaviour ADOPT-11 | --section Why] [--text "…"] [--suggest]`: "GitHub"
   joins and lays in an edit, as a store event would, where a conflict banner would have been.

`?live=0` opens the old editor; `LIVE=0 npm run dev` runs without the server. Saves go through `PATCH /api/projects/:id/nodes/:id`
(debounced 1.2 s) into `.data/table.json`, marking the item unsaved for an ordinary Save to GitHub. Open suggestions are never saved.

**Works:** two-tab editing with carets; the strict shape (sections, hints, IDs, Given/when/then, Enter for the next behaviour,
whose placeholder is numbered by the server's save and swapped in every tab); suggestions with authors and inline Accept/Reject;
the agent's comment shows up in the open tabs at once; GitHub edits arrive live.
**Not yet:** the title isn't live (read-only while live); Accept/Reject aren't recorded anywhere; suggestions live in server
memory, so a restart drops unaccepted ones; no auth on the WebSocket; refinements, Adopt and the changeset bar still run beside it.

## What production would need

- **Hosting.** Hocuspocus is a long-lived WebSocket server, which Lambda isn't. A small always-on container (App Runner, or a
  Lightsail container at ~$7/month) runs it. Each Yjs update is appended to DynamoDB under the item's partition
  (`PROJECT#<id>`, `LIVE#<itemKey>#<seq>`), compacted into a snapshot every N updates, so a restart loses nothing and a
  document loads with one query. The markdown save stays as here: debounced, through the API, so the map, rollups and the
  store keep reading `body`. One container is fine at our scale; more need Hocuspocus's Redis extension to share documents.
- **Auth on the WebSocket.** `onAuthenticate` gets the provider's token: for people, the signed-in session (#52) or the
  project access key, checked by the same code as the API, giving read or write per project (#56, the store decides); for
  agents, their own agent token (#4), which also names the agent shown on its caret. The document name's project must match
  the token's project. Agents that may only suggest get a connection that rejects updates outside suggestion marks.
- **Refinements, Adopt and the changeset record.** A refinement becomes a set of suggestions by one author in the live
  document; Adopt becomes Accept on each (or all of one author's at once, by behaviour as ADOPT-05 ticks them today). The
  changeset record becomes a log appended at each Accept and Reject: who suggested, who decided, the behaviour, before and
  after, and the Yjs version, which is also the document history to step back through. False "changed since you started"
  conflicts go away because nobody edits a stale copy: concurrent edits merge character by character, and only a real
  disagreement (two suggestions on the same words) is left for a person, shown in place.
- **The backend agent (#13 ADOPT-23).** It joins as a collaborator exactly as `scripts/live-agent.mjs` does, server-side
  with its agent token: a Yjs client in the worker that handles a comment addressed to it, reading the document and the
  thread, streaming its revision as suggestion marks and replying in the thread. The MCP server's `refine`/`propose` tools
  become "write suggestions into the live document", so an agent in Claude Code and the backend agent look the same to people.
- **GitHub.** The store event handler in `api/sync.mjs` applies the issue's new body to the live document as a diff by
  "GitHub" (direct text: the store is the record), so people see it arrive instead of a conflict banner.
