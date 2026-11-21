// Search the project: items by title, tag, summary or assignee, and behaviours by their ID or their words (#53 FIND-04).
// An ID match comes first, since an ID is someone looking for exactly that behaviour; matches in a behaviour's words come
// after the items whose own title or summary matched.

const BEHAVIOUR_ID = /^[a-z][a-z0-9]*-[0-9]*$/i;

function score(n, q) {
  const t = n.title.toLowerCase();
  if (t.startsWith(q)) return 0;
  if (t.includes(` ${q}`)) return 1;
  if (t.includes(q)) return 2;
  if (n.tags?.some((tag) => tag.includes(q))) return 3;
  if ((n.summary ?? '').toLowerCase().includes(q) || n.assignee?.toLowerCase() === q.replace(/^@/, '')) return 4;
  return -1;
}

/** The matches for a query, best first: { node, behaviour? }, where behaviour is { id, words } when a behaviour matched. */
export function search(tree, query, limit = 8) {
  const q = query.trim().toLowerCase();
  if (!q || !tree) return [];
  const byId = BEHAVIOUR_ID.test(q);
  const rows = tree.list.flatMap((node) => (node.behaviourRows ?? []).map((behaviour) => ({ node, behaviour })));
  const ids = byId ? rows.filter((r) => r.behaviour.id.toLowerCase().startsWith(q)).sort((a, b) => a.behaviour.id.localeCompare(b.behaviour.id, undefined, { numeric: true })) : [];
  const words = byId ? [] : rows.filter((r) => (r.behaviour.said ?? r.behaviour.words).toLowerCase().includes(q));
  const items = tree.list
    .map((node) => [node, score(node, q)])
    .filter(([, s]) => s >= 0)
    .sort((a, b) => a[1] - b[1] || a[0].depth - b[0].depth)
    .map(([node]) => ({ node }));
  return [...ids, ...items, ...words].slice(0, limit);
}
