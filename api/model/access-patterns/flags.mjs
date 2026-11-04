// Flags: one-off facts about the app, like "the demo project was created once".

import { keys } from '../keys.mjs';

export function flags(table) {
  return {
    /** GetItem. */
    async has(name) {
      return Boolean(await table.get(keys.flag(name)));
    },

    /** PutItem. */
    async set(name) {
      await table.put({ ...keys.flag(name), entity: 'flag', at: new Date().toISOString() });
    },
  };
}
