#!/usr/bin/env node
// A Claude Code channel (#15 NOTE-17): what people address to an agent with @Claude reaches a running Claude Code
// session within seconds, as a new turn, without waiting for the agent's next call.
//
// Claude Code takes pushed events only from a local stdio MCP server that declares the `claude/channel` capability;
// a remote HTTP server can't push to it. So this small bridge runs beside the session: it asks the project's MCP
// server's `inbox` tool every few seconds, with the agent's own token, and turns each annotation handed over into a
// `notifications/claude/channel` event carrying its prompt. Without it, the agent still gets the same annotation in the
// result of its next call to any tool, and at its standup.
//
// Set up, once, beside the HTTP server (`claude mcp add --transport http …`) and with the same token:
//   claude mcp add --scope local project-channel -e PROJECT_MCP_URL=https://…/api/mcp -e PROJECT_MCP_TOKEN=owk_… -- node scripts/channel.mjs
// then start Claude Code with the channel on (a research preview, so for now it is a development channel):
//   claude --dangerously-load-development-channels server:project-channel

import { createInterface } from 'node:readline';
import { APP_NAME } from '../shared/brand.js';

const url = process.env.PROJECT_MCP_URL;
const token = process.env.PROJECT_MCP_TOKEN;
const every = Math.max(2, Number(process.env.POLL_SECONDS) || 5) * 1000;

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const log = (...a) => console.error('[channel]', ...a);

let id = 0;
async function inbox() {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'inbox', arguments: {} } }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const reply = await res.json();
  return reply.result?.structuredContent?.addressed_to_you_now ?? [];
}

let polling = null;
function start() {
  if (polling || !url || !token) return;
  const tick = async () => {
    try {
      for (const n of await inbox()) {
        const meta = { item: String(n.item), annotation: String(n.annotation), kind: String(n.kind), from: String(n.from) };
        send({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: n.prompt, meta } });
      }
    } catch (err) {
      log('could not reach the server:', err.message);
    }
  };
  polling = setInterval(tick, every);
  tick();
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      if (!url || !token) log('PROJECT_MCP_URL and PROJECT_MCP_TOKEN are needed; nothing will arrive');
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
        serverInfo: { name: `${APP_NAME} channel`, version: '0.1.0' },
        instructions: `Events from this channel are annotations people addressed to you with @Claude in ${APP_NAME}. Each carries the prompt to act on it: act on it at once with the project's MCP tools (refine, propose with annotations, then reply in its thread).`,
      });
    case 'notifications/initialized':
      return start();
    case 'tools/list':
      return reply({ tools: [] });
    case 'ping':
      return reply({});
    default:
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } });
  }
});
lines.on('close', () => process.exit(0));
