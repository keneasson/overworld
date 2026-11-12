// The store adapter every backend implements: a key-value store with expiry and listing by key prefix.
//   get(key) -> value | undefined     put(key, value, { expiresAt }?)     delete(key)     list(prefix) -> [{ key, value }]
// Keys are strings like 'member#<account>#<person>'; values are plain JSON. This one keeps everything in memory, for tests and local use.
export function memoryStore({ clock = Date.now } = {}) {
  const rows = new Map();
  const live = (row) => row && (!row.expiresAt || row.expiresAt > clock());
  return {
    async get(key) { const row = rows.get(key); return live(row) ? structuredClone(row.value) : undefined; },
    async put(key, value, { expiresAt } = {}) { rows.set(key, { value: structuredClone(value), expiresAt }); },
    async delete(key) { rows.delete(key); },
    async list(prefix) { return [...rows].filter(([k, row]) => k.startsWith(prefix) && live(row)).sort(([a], [b]) => a.localeCompare(b)).map(([key, row]) => ({ key, value: structuredClone(row.value) })); },
  };
}
