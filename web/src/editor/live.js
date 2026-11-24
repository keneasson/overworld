// The live document (prototype): one shared document per item, edited at once by everyone who has it open, agents and
// the store included. On in local development (`npm run dev`, which runs the collaboration server); `?live=0` turns it off.

import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { storage } from '../api.js';

const PALETTE = ['#2f80ed', '#27ae60', '#eb5757', '#f2994a', '#9b51e0', '#00a3a3', '#c2185b', '#5d6d7e'];

export function liveOn() {
  if (typeof window === 'undefined') return false;
  const asked = new URLSearchParams(window.location.search).get('live');
  if (asked === '0') return false;
  return asked === '1' || Boolean(import.meta.env?.DEV);
}

const url = () => import.meta.env?.VITE_LIVE_URL ?? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:1234`;

/** Who you are in a live document: your name, or "Someone" with a short tag per tab, and a steady colour for it. */
export function liveUser() {
  let tab = sessionStorage.getItem('projectmap.live.tab');
  if (!tab) sessionStorage.setItem('projectmap.live.tab', (tab = Math.random().toString(36).slice(2, 6)));
  const name = (storage.get('projectmap.name') ?? '').trim() || `Someone ${tab}`;
  let h = 0;
  for (const c of `${name}:${tab}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { name, color: PALETTE[h % PALETTE.length] };
}

/** Joins an item's live document. `onSaid(message)` hears what collaborators say beside the text (a comment posted). */
export function joinLive({ projectId, itemKey, onSaid }) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: url(),
    name: `${projectId}/${itemKey}`,
    document: doc,
    onStateless: ({ payload }) => {
      try {
        onSaid?.(JSON.parse(payload));
      } catch {
        // Not something this prototype says.
      }
    },
  });
  return { doc, provider, destroy: () => provider.destroy() };
}
