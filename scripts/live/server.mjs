// The live document's collaboration server (prototype, local development only): one shared Yjs document per item, named
// `<projectId>/<itemKey>`. The first to open an item seeds it from the item's stored markdown; every change is saved back
// to the item, debounced, through the API's own route for an item's text, so the map and a later save to GitHub see it.
// An open suggestion is never saved: what is written is the document as it would be with every suggestion rejected.

import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { editableOf, splitNote } from '../../shared/issue-shape.js';
import { FIELD, swapStarts } from './ydoc.mjs';

const PLACEHOLDER = /(?<![\w-])[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\?\d*/g;
const IDS = /(?<![\w-])[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+\b/g;

/**
 * `api` is the in-process API handler, `model` the data model, `load(path)` loads one of the web app's modules (the editor's
 * own schema and markdown pipeline, so the server reads and writes an item exactly as the editor does).
 */
export async function startLiveServer({ api, model, load, port = 1234, accessKey = '', debounce = 1200 }) {
  const { parseMarkdown, serializeMarkdown, EXTENSIONS } = await load('/src/editor/rich-text.js');
  const { toDocument, fromDocument } = await load('/src/editor/document.js');
  const { openWithBodies } = await load('/src/editor/shape-extension.js');
  const { withoutSuggestions } = await load('/src/editor/suggestions.js');
  const schema = getSchema(EXTENSIONS);
  const meta = new Map(); // documentName -> what its saves are written relative to
  const kept = new Map(); // documentName -> the document as last saved, so open suggestions outlive every tab closing (until a restart)
  const headers = accessKey ? { 'x-projectmap-key': accessKey } : {};

  const nameOf = (documentName) => {
    const m = String(documentName).match(/^([\w-]+)\/(issue-\d+|node-[\w-]+)$/);
    if (!m) throw new Error(`Not an item document: ${documentName}`);
    return { pid: m[1], itemKey: m[2], nid: m[2].startsWith('issue-') ? m[2] : m[2].slice(5) };
  };

  const server = new Server({
    port,
    quiet: true,
    name: 'live-doc',
    debounce,
    maxDebounce: debounce * 5,

    async onLoadDocument({ documentName, document }) {
      const { pid, nid, itemKey } = nameOf(documentName);
      const node = await model.nodes.get(pid, nid);
      if (!node) throw new Error(`No item ${itemKey} in ${pid}`);
      const { markdown } = editableOf(node);
      const { note } = splitNote(node.body ?? '');
      const was = kept.get(documentName);
      if (was && was.body === (node.body ?? '')) {
        Y.applyUpdate(document, was.update);
        meta.set(documentName, { pid, nid, original: markdown, opened: was.saved, saved: was.saved, note });
        return;
      }
      // Changed outside the live document since (an accepted refinement, a refresh): it opens on the item as it is now.
      const json = openWithBodies(parseMarkdown(toDocument(markdown)), schema);
      prosemirrorJSONToYXmlFragment(schema, json, document.getXmlFragment(FIELD));
      const opened = serializeMarkdown(json);
      meta.set(documentName, { pid, nid, original: markdown, opened, saved: opened, note });
      console.log(`live: ${documentName} opened from its stored text`);
    },

    async onStoreDocument({ documentName, document }) {
      const m = meta.get(documentName);
      if (!m) return;
      const edited = serializeMarkdown(withoutSuggestions(yXmlFragmentToProsemirrorJSON(document.getXmlFragment(FIELD))));
      const keep = (body) => kept.set(documentName, { update: Y.encodeStateAsUpdate(document), body, saved: m.saved });
      if (edited === m.saved) {
        const node = await model.nodes.get(m.pid, m.nid);
        return keep(node?.body ?? '');
      }
      const markdown = fromDocument(m.original, m.opened, edited);
      const out = await api({ method: 'PATCH', path: `/api/projects/${m.pid}/nodes/${m.nid}`, headers, body: { body: `${markdown}${m.note}` } });
      if (out.status !== 200) return console.error(`live: saving ${documentName} failed (${out.status}): ${out.body?.error ?? ''}`);
      const stored = out.body.node.body ?? '';
      // The save numbered new behaviours (#13 ADOPT-11): their placeholders take those numbers in the document too.
      const sent = markdown.match(PLACEHOLDER) ?? [];
      const had = new Set(markdown.match(IDS) ?? []);
      const given = (splitNote(stored).markdown.match(IDS) ?? []).filter((id) => !had.has(id));
      const swaps = sent.map((from, i) => ({ from, to: given[i] })).filter((s) => s.to);
      let saved = edited;
      for (const s of swaps) saved = saved.replace(s.from, s.to);
      swapStarts(document, swaps, 'numbering');
      Object.assign(m, { original: splitNote(stored).markdown, opened: saved, saved });
      keep(stored);
      console.log(`live: saved ${documentName}${swaps.length ? ` (numbered ${swaps.map((s) => s.to).join(', ')})` : ''}`);
    },

    // A collaborator says something changed beside the text (a comment posted): every tab on the item hears it.
    async onStateless({ document, payload }) {
      document.broadcastStateless(payload);
    },
  });
  await server.listen();
  console.log(`  ➜  Live documents: ws://localhost:${port}`);
  return server;
}
