// Where an item stands with its store (SYNC-11). Nodes carry `sync` only while they differ from the store:
// unsaved (changed here, not saved), saving (saved, not yet in the store), conflict, or failed.

import { itemKeyOf } from '@shared/issue-shape.js';

export const SYNC_BADGE = {
  unsaved: { label: 'Not saved', hint: 'Changed here. Nothing reaches GitHub until you save.' },
  saving: { label: 'Saving', hint: 'Saved. On its way to GitHub.' },
  conflict: { label: 'Changed on GitHub', hint: 'GitHub changed since this was edited. Nothing was overwritten.' },
  failed: { label: 'Save failed', hint: 'GitHub refused it. Saving again retries.' },
};

/** The badge an item shows, or null when it is in line with its store. */
export const syncBadge = (node) => (node?.sync && SYNC_BADGE[node.sync] ? { state: node.sync, ...SYNC_BADGE[node.sync] } : null);

/** The items a save would send: changed here and not yet saved, or a save that failed. */
export const toSave = (nodes) => nodes.filter((n) => n.sync === 'unsaved' || n.sync === 'failed').map(itemKeyOf);
