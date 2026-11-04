// The single table, and the only file that talks to DynamoDB. A JSON-file copy of the
// same table runs local dev and the tests, so they exercise the same keys and access
// patterns as AWS.
//
// Both adapters offer the same operations:
//   get(key)                                         -> item | null
//   put(item)                                        replaces the whole item
//   delete(key)
//   query({ pk, skBeginsWith, index, newestFirst })  -> every matching item, all pages
//   write({ puts, deletes })                         batched, retried while throttled
//   scan()                                           every item; for migrations and backups only

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export const INDEXES = { GSI1: { pk: 'GSI1PK', sk: 'GSI1SK' } };
const BASE = { pk: 'PK', sk: 'SK' };

export function createTable(env = process.env) {
  return env.TABLE_NAME ? dynamoTable(env.TABLE_NAME) : fileTable(env.DATA_FILE ?? '.data/table.json');
}

export async function dynamoTable(tableName, { region } = {}) {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand, BatchWriteCommand, ScanCommand } = await import('@aws-sdk/lib-dynamodb');
  const db = DynamoDBDocumentClient.from(new DynamoDBClient(region ? { region } : {}), {
    marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
  });

  async function all(command, input) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const res = await db.send(new command({ ...input, TableName: tableName, ExclusiveStartKey }));
      items.push(...res.Items);
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  return {
    async get(key) {
      return (await db.send(new GetCommand({ TableName: tableName, Key: key }))).Item ?? null;
    },
    async put(item) {
      await db.send(new PutCommand({ TableName: tableName, Item: item }));
    },
    async delete(key) {
      await db.send(new DeleteCommand({ TableName: tableName, Key: key }));
    },
    async query({ pk, skBeginsWith, index, newestFirst = false }) {
      const names = index ? INDEXES[index] : BASE;
      const prefix = skBeginsWith != null;
      return all(QueryCommand, {
        IndexName: index,
        KeyConditionExpression: prefix ? '#pk = :pk AND begins_with(#sk, :sk)' : '#pk = :pk',
        ExpressionAttributeNames: prefix ? { '#pk': names.pk, '#sk': names.sk } : { '#pk': names.pk },
        ExpressionAttributeValues: prefix ? { ':pk': pk, ':sk': skBeginsWith } : { ':pk': pk },
        ScanIndexForward: !newestFirst,
      });
    },
    async write({ puts = [], deletes = [] }) {
      // Puts go first, so a write that fails part-way leaves extra items rather than holes.
      const requests = [...puts.map((Item) => ({ PutRequest: { Item } })), ...deletes.map((Key) => ({ DeleteRequest: { Key } }))];
      for (let i = 0; i < requests.length; i += 25) {
        let pending = { [tableName]: requests.slice(i, i + 25) };
        for (let attempt = 0; pending && Object.keys(pending).length; attempt++) {
          if (attempt > 8) throw new Error('DynamoDB batch write kept throttling');
          if (attempt) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
          pending = (await db.send(new BatchWriteCommand({ RequestItems: pending }))).UnprocessedItems;
        }
      }
    },
    async scan() {
      return all(ScanCommand, {});
    },
  };
}

export function fileTable(path) {
  let items = null;
  let writing = Promise.resolve();
  const at = (key) => `${key.PK}\u0000${key.SK}`;
  const clone = (v) => structuredClone(v);

  async function load() {
    if (items) return items;
    try {
      items = new Map(JSON.parse(await readFile(path, 'utf8')).items.map((it) => [at(it), it]));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      items = new Map();
    }
    return items;
  }
  async function save() {
    const snapshot = JSON.stringify({ items: [...items.values()] }, null, 1);
    writing = writing.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, snapshot);
      await rename(`${path}.tmp`, path);
    });
    await writing;
  }

  return {
    async get(key) {
      const it = (await load()).get(at(key));
      return it ? clone(it) : null;
    },
    async put(item) {
      (await load()).set(at(item), clone(item));
      await save();
    },
    async delete(key) {
      (await load()).delete(at(key));
      await save();
    },
    async query({ pk, skBeginsWith, index, newestFirst = false }) {
      // Like DynamoDB: an index only holds items that carry its keys, sorted by its sort key.
      const names = index ? INDEXES[index] : BASE;
      const out = [...(await load()).values()].filter((it) => it[names.pk] === pk && it[names.sk] != null && (skBeginsWith == null || it[names.sk].startsWith(skBeginsWith)));
      out.sort((a, b) => (a[names.sk] < b[names.sk] ? -1 : a[names.sk] > b[names.sk] ? 1 : 0));
      if (newestFirst) out.reverse();
      return out.map(clone);
    },
    async write({ puts = [], deletes = [] }) {
      const all = await load();
      for (const it of puts) all.set(at(it), clone(it));
      for (const key of deletes) all.delete(at(key));
      await save();
    },
    async scan() {
      return [...(await load()).values()].map(clone);
    },
  };
}
