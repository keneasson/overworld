// A store kept in memory, behind the store API (api/stores/index.mjs), for tests. Its refs (M-3) and
// mentions ([M-3]) look nothing like GitHub's, so a sync that assumed GitHub would trip here (SYNC-14).
// `failNext` queues failures; `crashAfter` dies right after a write lands.

import { PermanentError } from '../stores/errors.mjs';
import { editableOf } from '../../shared/issue-shape.js';
import { openQuestions } from '../engine/lifecycle.mjs';

export function memoryStore(seed, { clock }) {
  const items = new Map(seed.map((it) => [it.ref, { hidden: null, epic: false, ...it }]));
  const calls = [];
  const writeTimes = [];
  const failNext = [];
  let crashAfter = null;
  let made = 100;
  const numberOf = (ref) => ref.replace(/^M-/, '');
  const step = (kind, ref) => {
    const e = failNext.shift();
    if (e) throw e;
    calls.push(`${kind} ${ref ? numberOf(ref) : ''}`.trim());
    if (kind === 'update' || kind === 'create') writeTimes.push(clock());
  };
  const crash = (kind) => {
    if (crashAfter === kind) {
      crashAfter = null;
      throw new Error('worker killed');
    }
  };
  // Like any tracker, an open question reads as needing a decision.
  const statusOf = (it) => (openQuestions(it.markdown) ? 'needs_decision' : it.status);
  const nodeOf = (it) => ({ id: `mem-${it.ref}`, parentId: 'root', kind: 'task', title: it.title, body: it.markdown, status: statusOf(it), definition: statusOf(it) === 'needs_decision' ? 'vague' : 'auto', tags: [], links: [], memRef: it.ref });

  return {
    items,
    calls,
    writeTimes,
    failNext,
    crashAfter: (kind) => (crashAfter = kind),
    writes: () => calls.filter((c) => /^(update|create)/.test(c)),

    key: 'memory:test',
    refOf: (node) => node.memRef ?? null,
    nodeIdOf: (ref) => `mem-${ref}`,
    mention: (ref) => `[${ref}]`,
    wanted: (node) => ({ ...editableOf(node), state: node.status }),
    asRead: (node) => ({ ...editableOf(node), state: node.status }),
    same: (a, b) => a.title === b.title && a.markdown === b.markdown && a.state === b.state,
    async read(ref) {
      step('get', ref);
      if (!items.has(ref)) throw new PermanentError(`no ${ref}`);
      return structuredClone(items.get(ref));
    },
    version: (it) => ({ title: it.title, markdown: it.markdown, state: statusOf(it) }),
    async create(version, { guard, epic }) {
      step('create');
      const ref = `M-${++made}`;
      items.set(ref, { ref, title: version.title, markdown: version.markdown, status: version.state, hidden: guard, epic });
      crash('create');
      return { ref };
    },
    async findCreated(guard) {
      step('find');
      const it = [...items.values()].find((x) => x.hidden === guard);
      return it ? { ref: it.ref } : null;
    },
    carriesGuard: (it, guard) => it.hidden === guard,
    async update(ref, it, version) {
      step('update', ref);
      Object.assign(items.get(ref), { title: version.title, markdown: version.markdown, status: version.state, hidden: null });
      crash('update');
    },
    placed: (node, ref) => ({ ...node, memRef: ref }),
    onMap: (node, it) => ({ ...node, title: it.title, body: it.markdown, status: statusOf(it), definition: statusOf(it) === 'needs_decision' ? 'vague' : 'auto' }),
    async mapAgain() {
      const root = { id: 'root', parentId: null, kind: 'project', title: 'A project in memory', body: '', status: 'planned', definition: 'auto', tags: [], links: [] };
      return { nodes: [root, ...[...items.values()].map(nodeOf)], project: {} };
    },
  };
}
