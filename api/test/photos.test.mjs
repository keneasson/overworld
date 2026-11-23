// Annotations pinned on screenshots of the running app (SHOT-01 to SHOT-04, #16), tested the way people and agents use
// them: through the API, the one-time upload link, and the MCP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../app.mjs';
import { modelFor } from '../model/index.mjs';
import { fileTable } from '../model/table.mjs';

const body = `Part of #1\n\n## Why\n\nBecause.\n\n## Behaviours\n\n- CL-01 Given work, when claimed, then it is held.\n\n## Acceptance\n\nIt works.\n\n## Out of scope\n\nNothing.\n\n## Open questions\n\nNone\n`;
const PROJECT = { nodes: [{ id: 'root', title: 'App', kind: 'project' }, { id: 'i11', url: 'https://github.com/octo/app/issues/11', title: '#11 Claims', kind: 'story', status: 'ready', parentId: 'root', body }] };

/** A PNG's signature and header, saying its size, then `extra` bytes of picture. */
function png(width, height, extra = 16, fill = 7) {
  const head = Buffer.alloc(24);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(head);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(extra, fill)]);
}

async function setup() {
  const table = fileTable(join(await mkdtemp(join(tmpdir(), 'overworld-photos-')), 'table.json'));
  const api = createApi({ model: modelFor(table), accessKey: 'k', log: { error() {} } });
  const call = (method, path, b, headers = { 'x-projectmap-key': 'k' }) => api({ method, path, body: b, headers });
  const rest = async (method, path, b) => {
    const res = await call(method, path, b);
    assert.ok(res.status < 400, `${method} ${path}: ${res.body?.error}`);
    return res.body;
  };
  const pid = (await rest('POST', '/api/import/json', PROJECT)).project.id;
  const add = (bytes, extra = {}) => rest('POST', `/api/projects/${pid}/photos`, { itemKey: 'issue-11', data: bytes.toString('base64'), by: 'Ken', ...extra });
  const pin = (photo, spot, text = 'Missing label', author = 'Ken') => call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-11', anchor: { on: 'image', photo, ...spot }, text, author });
  async function agent(name) {
    const { token } = await rest('POST', `/api/projects/${pid}/agents`, { name });
    let id = 0;
    return async (tool, args = {}) => {
      const res = await api({ method: 'POST', path: '/api/mcp', body: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } }, headers: { authorization: `Bearer ${token}`, host: 'map.example' } });
      assert.ok(!res.body.result.isError, `${tool}: ${res.body.result.content[0].text}`);
      return res.body.result;
    };
  }
  return { api, call, rest, pid, add, pin, agent };
}

test('SHOT-04 a screenshot from any source lands in Photos and is pinned the same way: uploaded by a person, given to an agent, sent to an upload link, captured in a browser', async () => {
  const { api, call, rest, pid, add, pin, agent } = await setup();
  const mcp = await agent('Builder');
  const big = png(2560, 1600, 900_000, 3); // bigger than one table item can hold
  const byPerson = (await add(big, { caption: 'The map at dusk' })).photo;
  const given = (await mcp('screenshot', { item: '11', data: `data:image/png;base64,${png(800, 600).toString('base64')}`, caption: 'Given to me' })).structuredContent;
  const linked = (await mcp('screenshot', { item: 'issue-11', source: 'browser' })).structuredContent;
  assert.match(linked.upload_url, /^https:\/\/map\.example\/api\/uploads\/[\w-]+$/);
  assert.match(linked.how, /curl -sS -H 'content-type: application\/octet-stream' --data-binary @<file>/);
  const path = new URL(linked.upload_url).pathname;
  const sent = await api({ method: 'POST', path, rawBytes: png(1280, 800) });
  assert.equal(sent.status, 201, 'the link needs no key: it is the permission');
  assert.equal((await api({ method: 'POST', path, rawBytes: png(1280, 800) })).status, 404, 'and works once');

  const { photos } = await rest('GET', `/api/projects/${pid}/photos/issue-11`);
  assert.deepEqual(photos.map((p) => [p.source, p.width, p.height, p.mime]).sort(), [['agent', 800, 600, 'image/png'], ['browser', 1280, 800, 'image/png'], ['upload', 2560, 1600, 'image/png']]);
  assert.equal(given.caption, 'Given to me');
  const { data } = await rest('GET', `/api/projects/${pid}/photos/issue-11/${byPerson.id}`);
  assert.ok(Buffer.from(data, 'base64').equals(big), 'kept byte for byte');
  for (const p of photos) assert.equal((await pin(p.id, { x: 0.5, y: 0.5 })).status, 201, `a ${p.source} screenshot takes a pin`);
  const res = await call('POST', `/api/projects/${pid}/photos`, { itemKey: 'issue-11', data: Buffer.from('<html>not an image</html>').toString('base64'), by: 'Ken' });
  assert.equal(res.status, 400, 'whatever claims to be a screenshot is read from its bytes');
});

test('SHOT-01 a click on a spot of a screenshot pins a comment there, or on a region', async () => {
  const { rest, call, pid, add, pin } = await setup();
  const { photo } = await add(png(1000, 500), { caption: 'Place card' });
  const { comment } = (await pin(photo.id, { x: 0.25, y: 0.4 }, 'Missing label')).body;
  assert.deepEqual(comment.anchor, { on: 'image', section: 'Photos', photo: photo.id, version: 1, x: 0.25, y: 0.4, quote: 'Place card' });
  const region = (await pin(photo.id, { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, 'make this blue')).body.comment;
  assert.deepEqual([region.anchor.w, region.anchor.h], [0.3, 0.2]);
  const thread = (await rest('GET', `/api/projects/${pid}/comments/issue-11`)).comments.filter((c) => c.anchor.photo === photo.id);
  assert.equal(thread.length, 2, 'pins are comments on the item, like any other');
  assert.equal((await pin(photo.id, { x: 1.5, y: 0.2 })).status, 400);
  assert.equal((await pin(photo.id, { x: 0.8, y: 0.2, w: 0.5, h: 0.1 })).status, 400, 'a region stays on the screenshot');
  assert.equal((await pin('nothere', { x: 0.5, y: 0.5 })).status, 404);
  assert.equal((await call('POST', `/api/projects/${pid}/comments`, { itemKey: 'issue-11', replyTo: comment.id, text: 'Agreed', author: 'Ana' })).status, 201, 'and threads take replies');
});

test('SHOT-02 a newer screenshot keeps its pins, marked possibly out of date until someone confirms or moves them', async () => {
  const { rest, call, pid, add, pin } = await setup();
  const { photo } = await add(png(1000, 500));
  const kept = (await pin(photo.id, { x: 0.2, y: 0.3 })).body.comment;
  const moved = (await pin(photo.id, { x: 0.6, y: 0.6, w: 0.2, h: 0.2 })).body.comment;
  const newer = png(1200, 600, 64, 9);
  const replaced = (await add(newer, { replaces: photo.id, by: 'Ana' })).photo;
  assert.deepEqual([replaced.id, replaced.version, replaced.width], [photo.id, 2, 1200], 'the same screenshot, one version on');
  assert.ok(Buffer.from((await rest('GET', `/api/projects/${pid}/photos/issue-11/${photo.id}`)).data, 'base64').equals(newer));
  const pins = () => rest('GET', `/api/projects/${pid}/comments/issue-11`).then((r) => r.comments);
  assert.deepEqual((await pins()).map((c) => c.anchor.version), [1, 1], 'the pins stay, pinned on the version before');
  const { isStale } = await import('../../shared/photos.js');
  assert.ok((await pins()).every((c) => isStale(c.anchor, replaced)), 'so they read as possibly out of date');

  const confirmed = (await rest('POST', `/api/projects/${pid}/comments/issue-11/${kept.id}/pin`, { by: 'Ken' })).comment;
  assert.deepEqual([confirmed.anchor.version, confirmed.anchor.x, confirmed.anchor.y, isStale(confirmed.anchor, replaced)], [2, 0.2, 0.3, false], 'confirmed where it was');
  const there = (await rest('POST', `/api/projects/${pid}/comments/issue-11/${moved.id}/pin`, { x: 0.5, y: 0.1, by: 'Ken' })).comment;
  assert.deepEqual([there.anchor.version, there.anchor.x, there.anchor.y, there.anchor.w], [2, 0.5, 0.1, undefined], 'or moved');
  assert.equal((await call('DELETE', `/api/projects/${pid}/photos/issue-11/${photo.id}`)).status, 409, 'a screenshot with open pins stays');
});

test('SHOT-03 a change pinned on a screenshot reaches an agent with the image, the spot and what it says', async () => {
  const { rest, pid, add, pin, agent } = await setup();
  const mcp = await agent('Builder');
  const shot = png(1280, 800, 32, 5);
  const { photo } = await add(shot, { caption: 'Legend panel' });
  const { comment } = (await pin(photo.id, { x: 0.25, y: 0.5 }, '@Claude make this blue')).body;
  const got = await mcp('zoom');
  const [now] = got.structuredContent.addressed_to_you_now;
  assert.equal(now.annotation, comment.id);
  assert.equal(now.photo, photo.id);
  for (const part of [/pinned on a screenshot in its Photos, "Legend panel" \(photo \w+, uploaded, version 1\)/, /25% from the left and 50% from the top \(about 320, 400 of 1280×800 pixels\)/, /> @Claude make this blue/, /comes with this prompt as an image/]) assert.match(now.prompt, part);
  const image = got.content.find((c) => c.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.ok(Buffer.from(image.data, 'base64').equals(shot), 'the screenshot itself comes with it');

  await add(png(1280, 800, 32, 6), { replaces: photo.id });
  const look = await mcp('photo', { item: 'issue-11', photo: photo.id });
  assert.deepEqual(look.structuredContent.pins.map((p) => [p.annotation, p.said, p.possibly_out_of_date]), [[comment.id, '@Claude make this blue', true]]);
  assert.ok(look.content.some((c) => c.type === 'image'));
  const theirs = (await mcp('pin', { item: '11', photo: photo.id, x: 0.9, y: 0.1, text: 'This is where it was.' })).structuredContent;
  const said = (await rest('GET', `/api/projects/${pid}/comments/issue-11`)).comments.find((c) => c.id === theirs.pinned);
  assert.match(said.author, /^Builder \(/, 'and an agent pins the way a person does');
});
