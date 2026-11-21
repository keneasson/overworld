import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { editableOf, itemKeyOf } from '@shared/issue-shape.js';
import { isUnread } from '@shared/annotations.js';
import { api, storage } from '../api.js';
import { toSave } from '../model/sync.js';
import { authorOf, readyToSave, refinementGone, yourChangeset } from '../model/changesets.js';

const NAME = 'projectmap.name';
const READ = 'projectmap.read'; // threads read without a name, remembered in this browser only (NOTE-03)
const readHereAtFirst = () => {
  try {
    return new Set(JSON.parse(storage.get(READ) ?? '[]'));
  } catch {
    return new Set();
  }
};
const SAVE_AFTER_MS = 700;
const SYNC_POLL_MS = 2000; // while a save is on its way to GitHub
const SYNC_POLL_TRIES = 20;
const same = (a, b) => a.title === b.title && a.markdown === b.markdown;

/**
 * Editing the project's items in the panel, one at a time (#41 EDIT-09, EDIT-13). Every edit goes into the
 * project's open changeset as you type, so picking another item loses nothing; Accept applies them to the map
 * together (EDIT-03), and only Save sends anything to GitHub (SYNC-07), deciding nothing (SYNC-08).
 */
export function useItemEditing({ projectId, tree, setComments, onAccepted, onRemoved, reloadNodes, toast, fail }) {
  const [changeset, setChangeset] = useState(null);
  const [others, setOthers] = useState([]); // open refinements by someone else: an agent or another person (ADOPT-02)
  const [drafts, setDrafts] = useState(() => new Map());
  const [generation, setGeneration] = useState(0); // remounts the documents after an accept or a discard
  const [conflicts, setConflicts] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(0);
  const [name, setNameState] = useState(() => storage.get(NAME) ?? '');
  const [readHere, setReadHere] = useState(readHereAtFirst);
  const timers = useRef(new Map());
  const pending = useRef(new Map());
  const csPromise = useRef(null);
  const polls = useRef(null);
  const mine = useRef(null);
  mine.current = changeset?.id ?? null;

  // Pick up where the project was left: its open changeset.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    csPromise.current = null;
    setChangeset(null);
    setOthers([]);
    setDrafts(new Map());
    setConflicts(new Set());
    api
      .listChangesets(projectId)
      .then(({ changesets }) => {
        if (cancelled) return;
        // Yours is the open one you wrote; anyone else's is a refinement to look at and adopt or decline.
        const all = changesets.filter((c) => c.status === 'open');
        const open = yourChangeset(all, storage.get(NAME));
        setChangeset(open);
        setOthers(all.filter((c) => c !== open && !(c.author === authorOf(storage.get(NAME)) && !c.items.length))); // an empty one of yours is nobody's to adopt
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

  // Pick up refinements made since: an agent proposes through MCP while the map is open.
  const reloadRefinements = useCallback(async () => {
    if (!projectId) return;
    try {
      const { changesets } = await api.listChangesets(projectId);
      setOthers(changesets.filter((c) => c.status === 'open' && c.id !== mine.current));
    } catch (err) {
      fail(err);
    }
  }, [projectId, fail]);

  // Adopt or decline one item of someone else's refinement (ADOPT-05). Adopting changes the map and waits for a save.
  // `behaviours` is what was ticked (ADOPT-05); without it, the whole item.
  async function decide(cs, key, action, reason = '', behaviours) {
    setBusy(true);
    try {
      const res = await api.decideChangesetItem(projectId, cs.id, key, action, { by: name, reason, ...(behaviours ? { behaviours } : {}) });
      setOthers((os) => os.map((o) => (o.id === res.changeset.id ? res.changeset : o)).filter((o) => o.status === 'open'));
      if (res.nodes.length) {
        onAccepted(res.nodes);
        setGeneration((g) => g + 1);
        toast('Adopted. Save to send it to GitHub.');
      } else toast('Declined');
      return true;
    } catch (err) {
      fail(err);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const adopt = (cs, key, behaviours) => decide(cs, key, 'adopt', '', behaviours);
  const decline = (cs, key, reason, behaviours) => decide(cs, key, 'decline', reason, behaviours);

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
      if (!after || !readyToSave(after)) return; // a title being retyped waits until it has one again (EDIT-24)
      pending.current.delete(key);
      setSaving((n) => n + 1);
      try {
        const cs = await ensureChangeset();
        const res = await api.putChangesetItem(projectId, cs.id, { key, ...after });
        setChangeset(res.changeset);
        if (res.node) onAccepted([res.node]); // a new item changes on the map as it is written (NEW-03)
      } catch (err) {
        // Only a refinement that is gone is replaced: a new item belongs to its own, and leaving it would block it (EDIT-24).
        if (refinementGone(err)) csPromise.current = null;
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

  // A new item in an area (NEW-01): it joins the open changeset, the refinement it belongs to (NEW-02), and is on the map at once.
  async function addItem(parentId, kind) {
    setBusy(true);
    try {
      await flush();
      const cs = await ensureChangeset();
      const res = await api.newChangesetItem(projectId, cs.id, { parentId, kind });
      setChangeset(res.changeset);
      return res.node;
    } catch (err) {
      fail(err);
      return null;
    } finally {
      setBusy(false);
    }
  }

  // Split an item that needs it (#32 STATE-14): what it still has to build moves into a new child task, and the item keeps
  // what's built. Both are in this changeset, to accept or discard like any edit.
  const splitOf = (node) =>
    api
      .splitOf(projectId, itemKeyOf(node))
      .then((r) => r.split)
      .catch(() => null);
  async function split(node) {
    setBusy(true);
    try {
      await flush();
      const cs = await ensureChangeset();
      const key = itemKeyOf(node);
      const res = await api.splitItem(projectId, key, { changeset: cs.id, by: name });
      setChangeset(res.changeset);
      const after = res.changeset.items.find((it) => it.key === key)?.after;
      if (after) setDrafts((d) => new Map(d).set(key, after));
      onAccepted([res.node]);
      setGeneration((g) => g + 1); // the open document shows the item without what moved
      toast(`Split: ${res.moved.join(', ')} moved to "${res.node.title}". Accept it to keep it.`);
      return res.node;
    } catch (err) {
      fail(err);
      return null;
    } finally {
      setBusy(false);
    }
  }

  // Take a new item out of the refinement: it is gone, and never reaches GitHub (NEW-06).
  async function drop(node) {
    setBusy(true);
    try {
      const key = itemKeyOf(node);
      clearTimeout(timers.current.get(key));
      timers.current.delete(key);
      pending.current.delete(key);
      const cs = await csPromise.current;
      const res = await api.dropChangesetItem(projectId, cs.id, key);
      setChangeset(res.changeset);
      setDrafts((d) => {
        const next = new Map(d);
        next.delete(key);
        return next;
      });
      onRemoved(res.deleted, res.updated);
      return res.deleted;
    } catch (err) {
      fail(err);
      return null;
    } finally {
      setBusy(false);
    }
  }

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
      // Adopting applies the answers it carries (ANSWER-04); the comments it acted on stay where they are (NOTE-19).
      if (res.applied?.length) setComments((cs) => cs.map((x) => res.applied.find((r) => r.id === x.id && r.itemKey === x.itemKey) ?? x));
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
      if (cs) {
        const res = await api.discardChangeset(projectId, cs.id);
        if (res.deleted?.length) onRemoved(res.deleted, res.nodes);
      }
      reset();
      toast('Changes discarded');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  // What Accept would adopt: edited items, and every new item made in this changeset.
  const edited = useMemo(
    () => (tree ? tree.list.filter((n) => (changeset && n.refinement === changeset.id) || (!n.refinement && drafts.has(itemKeyOf(n)) && !same(drafts.get(itemKeyOf(n)), editableOf(n)))).map(itemKeyOf) : []),
    [tree, drafts, changeset],
  );
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

  // A comment (#15), or a reply in a thread (NOTE-11). A person's reply to a question is its answer, with the prompt they
  // changed, if they did (ANSWER-01, ANSWER-05). True once it is posted.
  async function comment(key, anchor, text, { replyTo, prompt } = {}) {
    try {
      const { comment: c, thread, prompt: sent } = await api.addComment(projectId, { itemKey: key, anchor, text, author: name, replyTo, prompt });
      if (sent) toast('Answered. An agent applies it through a refinement for you to adopt.');
      // A reply to @Claude also changes its thread: it is addressed to an agent again (NOTE-14).
      setComments((cs) => [...cs.map((x) => (thread && x.id === thread.id && x.itemKey === thread.itemKey ? thread : x)), c]);
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }
  const replace = (next) => setComments((cs) => cs.map((x) => (x.id === next.id && x.itemKey === next.itemKey ? next : x)));
  // Any comment becomes a child task, new in this changeset like any item added here; its thread says so, and it is dismissed (NOTE-06).
  async function promote(c) {
    setBusy(true);
    try {
      await flush();
      const cs = await ensureChangeset();
      const res = await api.promoteComment(projectId, c, { changeset: cs.id, by: name });
      setChangeset(res.changeset);
      onAccepted([res.node]);
      setComments((cs) => [...cs.map((x) => (x.id === res.comment.id && x.itemKey === res.comment.itemKey ? res.comment : x)), res.reply]);
      toast(`Made it a task: “${res.node.title}”. Accept to adopt it.`);
      return res.node;
    } catch (err) {
      fail(err);
      return null;
    } finally {
      setBusy(false);
    }
  }

  // Dismiss a thread into the conversation log, or bring it back (NOTE-05). Nothing else moves a comment.
  async function dismiss(c) {
    try {
      replace((await api.dismissComment(projectId, c, { by: name })).comment);
      toast('Dismissed to the conversation log');
    } catch (err) {
      fail(err);
    }
  }
  async function restore(c) {
    try {
      replace((await api.restoreComment(projectId, c)).comment);
    } catch (err) {
      fail(err);
    }
  }

  // Read or unread, for this person (NOTE-03): kept on the server under their name, or, with no name, in this browser,
  // by the thread's last word, so a new reply makes it unread again. Reading moves nothing.
  const lastWord = (t) => `${t.root.id}/${(t.replies.at(-1) ?? t.root).id}`;
  const hasRead = useCallback((t) => (name ? !isUnread(t.root, name) : readHere.has(lastWord(t))), [name, readHere]);
  async function markRead(t) {
    if (hasRead(t)) return;
    if (!name) {
      const next = new Set([...readHere, lastWord(t)]);
      setReadHere(next);
      storage.set(READ, JSON.stringify([...next].slice(-2000)));
      return;
    }
    try {
      replace((await api.readComment(projectId, t.root, { by: name })).comment);
    } catch {
      // Not read yet: it is marked again the next time it is opened.
    }
  }

  // The prompt a reply to a question goes out with, to read and change first (ANSWER-05).
  const answerPrompt = async (c, text) => (await api.answerPrompt(projectId, c, { text, author: name })).prompt;

  const setName = (v) => {
    setNameState(v);
    storage.set(NAME, v || null);
  };

  return { changeset, others, reloadRefinements, adopt, decline, drafts, generation, conflicts, busy, saving, edited, unsaved, onItsWay, name, setName, change, addItem, split, splitOf, drop, accept, discard, saveToGithub, comment, promote, dismiss, restore, answerPrompt, hasRead, markRead, flush };
}
