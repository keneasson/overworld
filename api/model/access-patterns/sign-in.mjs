// Sign-in's records (#52): the free-tier-auth package's store adapter on the app's table. The package names its records
// '<kind>#<rest>' (session#<hash>, person#<id>, identity#github#<id>, personsession#<person>#<hash>, state#<nonce>), so each
// kind gets its own partition and the package's list(prefix) is a Query on one partition. Sessions are stored by a hash of their
// id, and nothing here holds a provider's token. Records with an expiry carry the table's TTL, and a read checks it too,
// because TTL deletes late.

import { keys } from '../keys.mjs';

const split = (key) => {
  const i = String(key).indexOf('#');
  return i < 0 ? [String(key), ''] : [key.slice(0, i), key.slice(i + 1)];
};

export function signIn(table, { clock = Date.now } = {}) {
  const live = (row) => row && (!row.until || row.until > clock());
  return {
    /** GetItem. */
    async get(key) {
      const row = await table.get(keys.signIn(...split(key)));
      return live(row) ? row.value : undefined;
    },
    /** PutItem, with TTL when it expires. */
    async put(key, value, { expiresAt } = {}) {
      await table.put({ ...keys.signIn(...split(key)), entity: 'signIn', value, ...(expiresAt ? { until: expiresAt, expiresAt: Math.ceil(expiresAt / 1000) } : {}) });
    },
    /** DeleteItem. */
    async delete(key) {
      await table.delete(keys.signIn(...split(key)));
    },
    /** Query one kind's partition, begins_with(SK, the rest of the prefix). */
    async list(prefix) {
      const [kind, rest] = split(prefix);
      if (!kind) return [];
      return (await table.query(keys.signInsOf(kind, rest))).filter(live).map((row) => ({ key: `${kind}#${row.SK}`, value: row.value }));
    },
  };
}
