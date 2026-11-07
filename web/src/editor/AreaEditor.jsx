import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { editableOf, issueOf, itemKeyOf } from '@shared/issue-shape.js';
import { api, storage } from '../api.js';
import { isInside } from '../model/tree.js';
import { StatusDot } from '../components/Panel.jsx';
import { Icon } from '../components/Icon.jsx';
import { IssueForm } from './IssueForm.jsx';
import { editableItems } from './items.js';

const NAME = 'projectmap.name';
const SAVE_AFTER_MS = 700;
const same = (a, b) => a.title === b.title && a.markdown === b.markdown;

/**
 * Edit several items of one area side by side. Every edit goes into the area's open changeset,
 * which is saved as you type and accepted or discarded as one.
 */
export function AreaEditor({ projectId, tree, scopeId, startKey, comments, setComments, onAccepted, onClose, toast, fail, mobile }) {
  const scope = tree.byId.get(scopeId) ?? tree.root;
  const items = useMemo(() => editableItems(tree, scope), [tree, scope]);
  const byKey = useMemo(() => new Map(items.map((n) => [itemKeyOf(n), n])), [items]);
  const [openKeys, setOpenKeys] = useState(() => {
    const keys = items.map(itemKeyOf);
    if (startKey && keys.includes(startKey)) return [startKey];
    return keys.slice(0, mobile ? 1 : 3);
  });
  const [changeset, setChangeset] = useState(null);
  const [waiting, setWaiting] = useState([]);
  const [drafts, setDrafts] = useState(() => new Map());
  const [generation, setGeneration] = useState(0); // remounts the forms after a discard
  const [conflicts, setConflicts] = useState(() => new Set());
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(0);
  const [name, setName] = useState(() => storage.get(NAME) ?? '');
  const timers = useRef(new Map());
  const pending = useRef(new Map());
  const csPromise = useRef(null);

  // Pick up where the area was left: its open changeset, and what is waiting to reach GitHub.
  useEffect(() => {
    let cancelled = false;
    api
      .listChangesets(projectId)
      .then(({ changesets }) => {
        if (cancelled) return;
        const open = changesets.filter((c) => c.status === 'open' && c.scopeId === scope.id).at(-1) ?? null;
        setChangeset(open);
        if (open) {
          csPromise.current = Promise.resolve(open);
          setDrafts(new Map(open.items.map((it) => [it.key, it.after])));
          setOpenKeys((ks) => [...new Set([...ks, ...open.items.map((it) => it.key).filter((k) => byKey.has(k))])]);
        }
        setWaiting(changesets.filter((c) => c.status === 'accepted' && c.sync === 'waiting'));
        setLoaded(true);
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [projectId, scope.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const ensureChangeset = useCallback(() => {
    csPromise.current ??= api.createChangeset(projectId, { scopeId: scope.id, author: name }).then(({ changeset: cs }) => {
      setChangeset(cs);
      return cs;
    });
    return csPromise.current;
  }, [projectId, scope.id, name]);

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
  useEffect(() => () => [...timers.current.values()].forEach(clearTimeout), []);

  const change = (key) => (after) => {
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

  async function accept() {
    setBusy(true);
    try {
      await flush();
      const cs = await csPromise.current;
      const res = await api.acceptChangeset(projectId, cs.id);
      onAccepted(res.nodes);
      toast(`Accepted ${res.changeset.items.length} edit${res.changeset.items.length === 1 ? '' : 's'}${res.changeset.sync === 'waiting' ? '. They wait here until GitHub sync is set up.' : ''}`);
      reset();
      setWaiting((w) => (res.changeset.sync === 'waiting' ? [...w, res.changeset] : w));
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

  function reset() {
    csPromise.current = null;
    setChangeset(null);
    setDrafts(new Map());
    setConflicts(new Set());
    setGeneration((g) => g + 1);
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

  const close = async () => {
    await flush();
    onClose();
  };
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !e.target.closest?.('.ProseMirror, textarea, input') && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const edited = items.filter((n) => {
    const d = drafts.get(itemKeyOf(n));
    return d && !same(d, editableOf(n));
  });
  const editedKeys = new Set(edited.map(itemKeyOf));
  const toggle = (key) => setOpenKeys((ks) => (mobile ? [key] : ks.includes(key) ? ks.filter((k) => k !== key) : [...ks, key]));
  // Every behaviour already written in the area, drafts included, so new IDs never collide.
  const areaTexts = useMemo(() => tree.list.filter((n) => isInside(n, scope)).map((n) => drafts.get(itemKeyOf(n))?.markdown ?? n.body ?? ''), [tree, scope, drafts]);
  const status = !loaded ? 'Loading…' : saving ? 'Saving…' : edited.length ? `${edited.length} edited · saved in this changeset` : 'No changes yet';

  return (
    <div className={`area-editor${mobile ? ' mobile' : ''}`} role="dialog" aria-modal="true" aria-label={`Edit ${scope.title}`}>
      <header className="area-head">
        <button type="button" className="icon-btn" onClick={close} aria-label="Close the editor">
          <Icon name="close" />
        </button>
        <div className="area-title">
          <div className="eyebrow">Editing together</div>
          <h2>{scope.title}</h2>
        </div>
        <span className="area-status" aria-live="polite">
          {status}
          {waiting.length > 0 && ` · ${waiting.length} accepted, waiting for GitHub`}
        </span>
        <label className="area-name">
          <span>You</span>
          <input
            value={name}
            placeholder="Your name"
            maxLength={80}
            onChange={(e) => {
              setName(e.target.value);
              storage.set(NAME, e.target.value || null);
            }}
          />
        </label>
        <button type="button" onClick={discard} disabled={busy || (!changeset && !edited.length)}>
          Discard
        </button>
        <button type="button" className="primary" onClick={accept} disabled={busy || !edited.length}>
          <Icon name="check" size={18} /> Accept {edited.length || ''}
        </button>
      </header>

      <div className="area-body">
        {mobile ? (
          <div className="area-switch">
            <label htmlFor="area-item">Item</label>
            <select id="area-item" value={openKeys[0] ?? ''} onChange={(e) => toggle(e.target.value)}>
              {items.map((n) => (
                <option key={n.id} value={itemKeyOf(n)}>
                  {editedKeys.has(itemKeyOf(n)) ? '● ' : ''}
                  {n.title}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <nav className="area-rail" aria-label="Items in this area">
            <div className="eyebrow">
              <Icon name="columns" size={16} /> {items.length} items
            </div>
            <ul>
              {items.map((n) => {
                const key = itemKeyOf(n);
                return (
                  <li key={n.id} style={{ paddingLeft: Math.max(0, n.depth - scope.depth - (items.includes(scope) ? 0 : 1)) * 12 }}>
                    <label className={editedKeys.has(key) ? 'edited' : ''}>
                      <input type="checkbox" checked={openKeys.includes(key)} onChange={() => toggle(key)} />
                      <StatusDot status={n.status} />
                      <span>{n.title}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        <div className="area-columns">
          {!items.length && <p className="empty-note">Nothing here has text to edit.</p>}
          {loaded &&
            openKeys
              .filter((k) => byKey.has(k))
              .map((key) => {
                const node = byKey.get(key);
                const issue = issueOf(node);
                return (
                  <article key={`${key}:${generation}`} className={`area-column${editedKeys.has(key) ? ' edited' : ''}`}>
                    <div className="column-head">
                      <StatusDot status={node.status} />
                      <span className="column-title">{issue ? `#${issue.number}` : node.title}</span>
                      {editedKeys.has(key) && <span className="tag tag-strong">Edited</span>}
                      <span className="spacer" />
                      {node.url && (
                        <a className="icon-btn small" href={node.url} target="_blank" rel="noopener noreferrer" aria-label="Open the source">
                          <Icon name="external" size={16} />
                        </a>
                      )}
                      {!mobile && (
                        <button type="button" className="icon-btn small" aria-label="Close this column" onClick={() => toggle(key)}>
                          <Icon name="close" size={16} />
                        </button>
                      )}
                    </div>
                    <IssueForm
                      value={drafts.get(key) ?? editableOf(node)}
                      issueNumber={issue?.number}
                      areaTexts={areaTexts}
                      comments={comments.filter((c) => c.itemKey === key)}
                      conflict={conflicts.has(key)}
                      onChange={change(key)}
                      onComment={(anchor, text) => comment(key, anchor, text)}
                      onResolve={resolve}
                    />
                  </article>
                );
              })}
          {loaded && !mobile && openKeys.length === 0 && items.length > 0 && <p className="empty-note">Tick items on the left to edit them side by side.</p>}
        </div>
      </div>
    </div>
  );
}
