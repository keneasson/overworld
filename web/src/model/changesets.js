// Which refinement a person's edits go into, and when a refused save leaves it alone (#41 EDIT-24).
// One refused edit must never cost the refinement: a new item belongs to the refinement it was made in, so moving
// to a fresh one would leave every later edit of it refused, and editing blocked even after a reload.

/** Who a changeset is by, as the API writes it: a person's name, or "Name (id)" for an agent. */
export const authorOf = (name) => String(name ?? '').trim().slice(0, 80) || 'Someone';

/** Your open refinement: the latest one of yours with edits in it, else the latest of yours, else none. */
export function yourChangeset(changesets, name) {
  const yours = changesets.filter((c) => c.status === 'open' && c.author === authorOf(name));
  return yours.filter((c) => c.items?.length).at(-1) ?? yours.at(-1) ?? null;
}

/** Whether a refused save means the refinement itself is gone (deleted, or already adopted or declined), so a new one is needed. */
export const refinementGone = (err) => err?.status === 404 || (err?.status === 409 && /already/.test(err.message ?? ''));

/** Whether an edit can be sent yet: an item always has a title, so one being retyped waits until it has one again. */
export const readyToSave = (after) => Boolean(after?.title?.trim());
