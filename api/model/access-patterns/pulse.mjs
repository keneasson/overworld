// The pulse: one small record per project that every change people see moves on (#13 ADOPT-23). An open page reads it
// every second or two (one GetItem) and reloads what it shows when it has moved, so a change made anywhere, by a person,
// an agent or the store, reaches every open page without a refresh.

import { PROJECT_SK, keys } from '../keys.mjs';

// What people see changing, by where it sits in a project's partition. Sync's own records, agents' call counts and the
// like never move the pulse.
const SEEN = [
  ['NODE#', 'node'],
  ['CHANGESET#', 'changeset'],
  ['COMMENT#', 'comment'],
  ['ASK#', 'comment'],
  ['INBOX#', 'comment'],
  ['CLAIM#', 'claim'],
  ['BUILD#', 'claim'],
  ['HANDOFF#', 'claim'],
  ['IMAGE#', 'node'],
];

const kindOf = (item) => (typeof item?.PK === 'string' && item.PK.startsWith('PROJECT#') ? SEEN.find(([p]) => item.SK?.startsWith(p))?.[1] ?? null : null);

export function pulse(table) {
  return {
    /** Where a project's pulse is: a value that changes with every change people see, or null if none yet. GetItem. */
    async get(projectId) {
      const it = await table.get(keys.pulse(projectId));
      return it ? { v: it.v, at: it.at, kind: it.kind } : null;
    },
  };
}

/** The table, with every write people would see moving its project's pulse once. */
export function pulsing(table) {
  const beat = async (items, deletes = []) => {
    const moved = new Map();
    // A project deleted with this write has nothing left to pulse.
    const gone = new Set(deletes.filter((k) => k.SK === PROJECT_SK).map((k) => k.PK));
    for (const it of items.filter((x) => !gone.has(x.PK))) {
      const kind = kindOf(it);
      if (kind) moved.set(it.PK.slice('PROJECT#'.length), kind);
    }
    const at = new Date().toISOString();
    await Promise.all([...moved].map(([pid, kind]) => table.put({ ...keys.pulse(pid), entity: 'pulse', at, kind, v: `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}` })));
  };
  const after = (fn, itemsOf) =>
    async function (...args) {
      const out = await fn.apply(table, args);
      if (out !== false) await beat(...itemsOf(...args));
      return out;
    };
  return {
    ...table,
    put: after(table.put, (item) => [[item]]),
    delete: after(table.delete, (key) => [[key], [key]]),
    write: after(table.write, ({ puts = [], deletes = [] }) => [[...puts, ...deletes], deletes]),
    transact: after(table.transact, ({ puts = [], deletes = [] }) => [[...puts, ...deletes], deletes]),
    create: after(table.create, (item) => [[item]]),
    claim: after(table.claim, (key) => [[key]]),
    claimAll: after(table.claimAll, (items) => [items]),
    release: after(table.release, (key) => [[key]]),
  };
}
