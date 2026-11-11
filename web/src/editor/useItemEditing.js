import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { editableOf, itemKeyOf } from '@shared/issue-shape.js';
import { api, storage } from '../api.js';
import { toSave } from '../model/sync.js';

const NAME = 'projectmap.name';
const SAVE_AFTER_MS = 700;
const SYNC_POLL_MS = 2000; // while a save is on its way to GitHub
const SYNC_POLL_TRIES = 20;
const same = (a, b) => a.title === b.title && a.markdown === b.markdown;

/**
 * Editing the project's items in the panel, one at a time (#41 EDIT-09, EDIT-13). Every edit goes into the
 * project's open changeset as you type, so picking another item loses nothing; Accept applies them to the map
 * together (EDIT-03), and only Save sends anything to GitHub (SYNC-07), deciding nothing (SYNC-08).
 */
export function useItemEditing({ projectId, tree, setComments, onAccepted, reloadNodes, toast, fail }) {
  const [changeset, setChangeset] = useState(null);
  const [drafts, setDrafts] = useState(() => new Map());
  const [generation, setGeneration] = useState(0); // remounts the documents after an accept or a discard
  const [conflicts, setConflicts] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(0);
  const [name, setNameState] = useState(() => storage.get(NAME) ?? '');
  const timers = useRef(new Map());
  const pending = useRef(new Map());
  const csPromise = useRef(null);
  const polls = useRef(null);

  // Pick up where the project was left: its open changeset.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    csPromise.current = null;
    setChangeset(null);
    setDrafts(new Map());
    setConflicts(new Set());
    api
      .listChangesets(projectId)
      .then(({ changesets }) => {
        if (cancelled) return;
        const open = changesets.filter((c) => c.status === 'open').at(-1) ?? null;
        setChangeset(open);
        if (open) {
          csPromise.current = Promise.resolve(open);
          setDrafts(new Map(open.items.map((it) => [it.key, it.after])));
        }
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      [...timers.current.values()].forEach(clearTimeout);
      clearTimeout(polls.current);
    },
    [],
  );

  const ensureChangeset = useCallback(() => {
    csPromise.current ??= api.createChangeset(projectId, { author: name }).then(({ changeset: cs }) => {
      setChangeset(cs);
      return cs;
    });
    return csPromise.current;
  }, [projectId, name]);

  const save = useCallback(
    async (key) => {
      const after = pending.current.get(key);
      if (!after) return;
      pending.current.delete(key);
      setSaving((n) => n + 1);
      try {
        const cs = await ensureChangeset();
        const res = await api.putChangesetItem(projectId, cs.id, { key, ...after });
        setChangeset(res.changeset);
      } catch (err) {
        csPromise.current = null;
        fail(err);
      } finally {
        setSaving((n) => n - 1);
      }
    },
    [ensureChangeset, projectId, fail],
  );
  const flush = () => Promise.all([...timers.current.keys()].map((key) => (clearTimeout(timers.current.get(key)), timers.current.delete(key), save(key))));

  const change = (key, after) => {
    setDrafts((d) => new Map(d).set(key, after));
    pending.current.set(key, after);
    clearTimeout(timers.current.get(key));
    timers.current.set(
      key,
      setTimeout(() => {
        timers.current.delete(key);
        save(key);
      }, SAVE_AFTER_MS),
    );
  };

  function reset() {
    csPromise.current = null;
    setChangeset(null);
    setDrafts(new Map());
    setConflicts(new Set());
    setGeneration((g) => g + 1);
  }

  async function accept() {
    setBusy(true);
    try {
      await flush();
      const cs = await csPromise.current;
      const res = await api.acceptChangeset(projectId, cs.id);
      onAccepted(res.nodes);
      const n = res.changeset.items.length;
      toast(`Accepted ${n} edit${n === 1 ? '' : 's'}. Save to send ${n === 1 ? 'it' : 'them'} to GitHub.`);
      reset();
    } catch (err) {
      if (err.status === 409 && err.conflicts) setConflicts(new Set(err.conflicts));
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    setBusy(true);
    try {
      [...timers.current.values()].forEach(clearTimeout);
      timers.current.clear();
      pending.current.clear();
      const cs = await csPromise.current;
      if (cs) await api.discardChangeset(projectId, cs.id);
      reset();
      toast('Changes discarded');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const edited = useMemo(() => (tree ? tree.list.filter((n) => drafts.has(itemKeyOf(n)) && !same(drafts.get(itemKeyOf(n)), editableOf(n))).map(itemKeyOf) : []), [tree, drafts]);
  const unsaved = useMemo(() => (tree ? toSave(tree.list) : []), [tree]);
  const onItsWay = tree ? tree.list.filter((n) => n.sync === 'saving').length : 0;

  // Save (SYNC-08): every unsaved item goes to GitHub as it is now. Then watch until it has arrived.
  async function saveToGithub() {
    setBusy(true);
    try {
      const { saved } = await api.save(projectId, unsaved);
      toast(saved.length ? `Saving ${saved.length} to GitHub` : 'Nothing to save');
      let tries = 0;
      const poll = async () => {
        const nodes = await reloadNodes();
        const still = nodes?.some((n) => saved.includes(itemKeyOf(n)) && n.sync === 'saving');
        if (still && ++tries < SYNC_POLL_TRIES) polls.current = setTimeout(poll, SYNC_POLL_MS);
      };
      if (saved.length) await poll();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function comment(key, anchor, text) {
    try {
      const { comment: c } = await api.addComment(projectId, { itemKey: key, anchor, text, author: name });
      setComments((cs) => [...cs, c]);
    } catch (err) {
      fail(err);
    }
  }
  async function resolve(c, resolved) {
    try {
      const { comment: next } = await api.resolveComment(projectId, c, resolved);
      setComments((cs) => cs.map((x) => (x.id === next.id ? next : x)));
    } catch (err) {
      fail(err);
    }
  }

  const setName = (v) => {
    setNameState(v);
    storage.set(NAME, v || null);
  };

  return { changeset, drafts, generation, conflicts, busy, saving, edited, unsaved, onItsWay, name, setName, change, accept, discard, saveToGithub, comment, resolve, flush };
}
