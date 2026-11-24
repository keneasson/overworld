import { keys } from '../keys.mjs';

// Behaviour IDs (#13 ADOPT-11): one counter per area prefix in a project, so each new behaviour gets the area's next
// number when it is first saved, and no number is given twice or used again, even once its behaviour is dropped.
export function ids(table) {
  return {
    /**
     * Take `n` numbers for a prefix, all above `floor` (the highest ever seen for it) and above any given before.
     * UpdateItem ADD, conditional; the first time, a conditional write starts the counter at the floor.
     * @returns {Promise<number[]>} the numbers, in order
     */
    async take(projectId, prefix, n, floor = 0) {
      const last = await table.reserve(keys.counter(projectId, prefix), { n, floor });
      return Array.from({ length: n }, (_, i) => last - n + 1 + i);
    },
  };
}
