import { Suspense, lazy, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { CHILD_KIND, KIND_LABEL, LINK_LABEL, STATUS_LABEL } from '@shared/schema.js';
import { HEALTH_COLOR, HEALTH_LABEL, isInside, pathOf } from '../model/tree.js';
import { Icon } from './Icon.jsx';
import { compareItems, editableOf, hasOpenQuestions, issueOf, itemKeyOf, parseIssue, sectionText } from '@shared/issue-shape.js';
import { isEditable, isMapped } from '../editor/items.js';
import { AddLink, Properties } from './Properties.jsx';
import { syncBadge } from '../model/sync.js';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function Markdown({ text }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text ?? '', { gfm: true, breaks: true })), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function HealthPill({ health, large }) {
  return (
    <span className={`pill${large ? ' pill-lg' : ''}`} style={{ background: HEALTH_COLOR[health] }}>
      {HEALTH_LABEL[health]}
    </span>
  );
}

/** Where an item stands with GitHub (SYNC-11): nothing when it is in line. */
export function SyncBadge({ node, compact = false }) {
  const b = syncBadge(node);
  if (b && compact) return <span className={`sync-dot sync-${b.state}`} title={`${b.label}: ${b.hint}`} role="img" aria-label={b.label} />;
  return b ? (
    <span className={`tag sync-${b.state}`} title={b.hint}>
      {b.label}
    </span>
  ) : null;
}

export function KindBadge({ kind }) {
  return <span className={`kind kind-${kind}`}>{KIND_LABEL[kind]}</span>;
}

const STATUS_DOT = { idea: '#a142f4', planned: '#9aa0a6', ready: '#2da44e', needs_decision: '#8b5cf6', in_progress: '#1a73e8', review: '#12b5cb', blocked: '#d93025', done: '#1e8e3e', rejected: '#bdc1c6' };

export function StatusDot({ status }) {
  return <span className="status-dot" style={{ background: STATUS_DOT[status] }} title={STATUS_LABEL[status]} />;
}

function NodeRow({ node, onPick, sub }) {
  return (
    <li>
      <button className="row" onClick={() => onPick(node.id)}>
        <StatusDot status={node.status} />
        <span className="row-main">
          <span className="row-title">{node.title}</span>
          {sub && <span className="row-sub">{sub}</span>}
        </span>
        <KindBadge kind={node.kind} />
      </button>
    </li>
  );
}

const pct = (v) => `${Math.round(v * 100)}%`;

// The document editor is big: it loads the first time an item with text opens.
const IssueForm = lazy(() => import('../editor/IssueForm.jsx').then((m) => ({ default: m.IssueForm })));

/** What the open changeset holds, and the three things to do with it: discard, accept, save to GitHub. */
function EditBar({ editing }) {
  const { edited, unsaved, saving, busy, onItsWay, changeset, name, setName, accept, discard, saveToGithub } = editing;
  if (!edited.length && !unsaved.length && !saving && !onItsWay) return null;
  const status = saving ? 'Saving…' : edited.length ? `${edited.length} edited, kept in this changeset` : `${unsaved.length} accepted, not on GitHub yet`;
  return (
    <div className="edit-bar" aria-live="polite">
      <span className="edit-status">
        {status}
        {onItsWay > 0 && ` · ${onItsWay} on its way to GitHub`}
      </span>
      <input aria-label="Your name" className="edit-name" value={name} placeholder="Your name" maxLength={80} onChange={(e) => setName(e.target.value)} />
      <div className="edit-actions">
        <button type="button" onClick={discard} disabled={busy || (!changeset && !edited.length)}>
          Discard
        </button>
        <button type="button" className="primary" onClick={accept} disabled={busy || !edited.length}>
          <Icon name="check" size={16} /> Accept {edited.length || ''}
        </button>
        <button type="button" onClick={saveToGithub} disabled={busy || edited.length > 0 || !unsaved.length} title={edited.length ? 'Accept or discard your edits first' : 'Send accepted changes to GitHub'}>
          Save {unsaved.length || ''} to GitHub
        </button>
      </div>
    </div>
  );
}

const CHANGE_LABEL = { added: 'Added', changed: 'Changed', removed: 'Removed' };
const when = (iso) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
};

/** One change in a refinement: what the spec says now, struck through, and what is proposed. */
function Change({ label, change, before, after, ready }) {
  return (
    <li className={`change change-${change}`}>
      <div className="change-head">
        <span className="change-label">{label}</span>
        <span className={`change-kind change-kind-${change}`}>{CHANGE_LABEL[change]}</span>
        {ready && (
          <span className="pill pill-ready" title="The conversation has converged: marked ready for adoption">
            Ready for adoption
          </span>
        )}
      </div>
      {before && <del className="change-before">{before}</del>}
      {after && <ins className="change-after">{after}</ins>}
    </li>
  );
}

/**
 * Someone else's refinement of this item (ADOPT-02): who proposed it and when, what it changes against the spec,
 * which behaviours are ready for adoption (ADOPT-04), and the person's yes or no (ADOPT-05). Open questions keep it
 * from adoption (ADOPT-08).
 */
function Refinement({ cs, item, node, editing }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const diff = useMemo(() => compareItems(editableOf(node), item.after), [node, item.after]);
  const ready = new Set(item.readyForAdoption ?? []);
  const questions = hasOpenQuestions(sectionText(parseIssue(item.after.markdown), 'Open questions'));
  const nothing = !diff.title && !diff.behaviours.length && !diff.sections.length;
  const key = item.key;
  return (
    <section className="refinement" aria-label={`Refinement by ${cs.author}`}>
      <div className="refinement-head">
        <Icon name="edit" size={16} />
        <span>
          Refinement by <strong>{cs.author}</strong> · {when(cs.updatedAt)}
        </span>
      </div>
      <p className="refinement-note">The spec is unchanged until it is adopted. This is what it proposes:</p>
      {nothing ? (
        <p className="empty-note">It proposes the item as it already is.</p>
      ) : (
        <ul className="changes">
          {diff.title && <Change label="Title" change="changed" before={diff.title.before} after={diff.title.after} />}
          {diff.behaviours.map((b, i) => (
            <Change key={`b${b.id || i}`} label={b.id || 'Behaviour'} change={b.change} before={b.before} after={b.after} ready={ready.has(b.id)} />
          ))}
          {diff.sections.map((c) => (
            <Change key={`s${c.name}`} label={c.name === 'Head' ? 'Part of · Kind · Place' : c.name} change={c.change} before={c.before} after={c.after} />
          ))}
        </ul>
      )}
      {ready.size > 0 && (
        <p className="refinement-ready">
          Ready for adoption: {[...ready].join(', ')}
        </p>
      )}
      {questions && <p className="refinement-blocked">It still has open questions. Answer them before adopting it.</p>}
      {declining ? (
        <div className="refinement-decline">
          <textarea aria-label="Why decline (optional)" placeholder="Why not? (optional: its author sees this)" value={reason} maxLength={2000} rows={2} onChange={(e) => setReason(e.target.value)} />
          <div className="edit-actions">
            <button type="button" onClick={() => setDeclining(false)} disabled={editing.busy}>
              Keep it
            </button>
            <button type="button" className="armed" onClick={() => editing.decline(cs, key, reason)} disabled={editing.busy}>
              Decline
            </button>
          </div>
        </div>
      ) : (
        <div className="edit-actions">
          <button type="button" onClick={() => setDeclining(true)} disabled={editing.busy}>
            Decline…
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => editing.adopt(cs, key)}
            disabled={editing.busy || questions}
            title={questions ? 'Answer its open questions first' : 'Adopt it: the item takes this text, and waits for a save to reach GitHub'}
          >
            <Icon name="check" size={16} /> Adopt
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * One item, open beside the map, and edited where it is (#41 EDIT-09): its text is the document editor, its
 * properties change in place (EDIT-11), and comments sit on what they are about. The panel only ever holds this
 * one item (EDIT-13); its edits wait in the project's changeset when another is picked.
 */
export function Details({ node, tree, lens, comments = [], editing, commenting = false, commentControl = null, onPick, onFly, onAdd, onPatch, onDelete, onClose, onCopyLink, onDocFocus }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const s = node.stats;
  const key = itemKeyOf(node);
  const issue = issueOf(node);
  // A new item changes only in the refinement it was made in (NEW-02).
  const theirs = Boolean(node.refinement) && node.refinement !== editing.changeset?.id;
  const editable = isEditable(tree, node) && !theirs;
  const path = pathOf(node).slice(0, -1);
  const incoming = tree.incoming.get(node.id) ?? [];
  // On a map read from GitHub everything added is an issue: under the project or an area, that starts with an epic.
  const childKind = isMapped(tree) && ['project', 'area'].includes(node.kind) ? 'epic' : (CHILD_KIND[node.kind] ?? 'task');
  const isRoot = node.depth === 0;
  // Other people's and agents' proposed edits to this item (ADOPT-02); their new items show as new, below.
  const proposals = editing.others.flatMap((cs) => cs.items.filter((it) => it.key === key && !it.new && it.after).map((it) => ({ cs, item: it })));
  // Every behaviour already written, drafts included, so a new behaviour's ID never collides.
  const texts = useMemo(() => (editable ? tree.list.map((n) => editing.drafts.get(itemKeyOf(n))?.markdown ?? n.body ?? '') : []), [editable, tree, editing.drafts]);
  const readOnly = (
    <>
      <h2 className="node-title">{node.title}</h2>
      {node.body && <Markdown text={node.body} />}
    </>
  );

  return (
    <div className="details">
      <header className="panel-head">
        <div className="crumbs-small">
          {path.map((p) => (
            <button key={p.id} onClick={() => onPick(p.id)}>
              {p.title}
            </button>
          ))}
        </div>
        <span className="panel-head-actions">
          {commentControl}
          <button className="icon-btn" onClick={onClose} aria-label="Close panel">
            <Icon name="close" />
          </button>
        </span>
      </header>
      <div className="title-row">
        <KindBadge kind={node.kind} />
        {node.priority && <span className="tag tag-strong">{node.priority}</span>}
        <span className="status-text">
          <StatusDot status={node.status} /> {STATUS_LABEL[node.status]}
        </span>
        <HealthPill health={s.health} />
        {s.overdue && <span className="pill pill-outline">Overdue</span>}
        {s.vague && <span className="pill pill-fog">Poorly defined</span>}
        {node.refinement && (
          <span className="pill pill-new" title={theirs ? 'New in someone else’s refinement: it changes there until it is adopted.' : 'New in your refinement: Accept adopts it, Discard drops it.'}>
            New · needs improvement
          </span>
        )}
        {proposals.length > 0 && (
          <span className="pill pill-refine" title="Someone else has proposed a change to this item: see it below">
            Refinement proposed
          </span>
        )}
        <SyncBadge node={node} />
      </div>

      <div className="actions">
        <button onClick={() => onFly(node.id)}>
          <span className="action-icon">
            <Icon name="target" />
          </span>
          Zoom to
        </button>
        <button onClick={() => onAdd(node.id, childKind)}>
          <span className="action-icon">
            <Icon name="plus" />
          </span>
          Add {KIND_LABEL[childKind].toLowerCase()}
        </button>
        <button onClick={onCopyLink}>
          <span className="action-icon">
            <Icon name="link" />
          </span>
          Share
        </button>
        {node.url && (
          <a href={node.url} target="_blank" rel="noopener noreferrer">
            <span className="action-icon">
              <Icon name="external" />
            </span>
            Source
          </a>
        )}
        {!isRoot && !theirs && (
          <button className={confirmDelete ? 'armed' : ''} onClick={() => (confirmDelete ? onDelete(node) : setConfirmDelete(true))} onBlur={() => setConfirmDelete(false)}>
            <span className="action-icon danger">
              <Icon name="trash" />
            </span>
            {node.refinement ? (confirmDelete ? 'Drop it?' : 'Drop') : confirmDelete ? `Delete${node.children.length ? ` ${node.stats.items}` : ''}?` : 'Delete'}
          </button>
        )}
      </div>

      <EditBar editing={editing} />
      {proposals.map(({ cs, item }) => (
        <Refinement key={cs.id} cs={cs} item={item} node={node} editing={editing} />
      ))}
      <div className="doc" onFocusCapture={onDocFocus}>
        {editable ? (
          <Suspense fallback={readOnly}>
            <IssueForm
              key={`${key}:${editing.generation}`}
              value={editing.drafts.get(key) ?? editableOf(node)}
              issueNumber={issue?.number}
              areaTexts={texts}
              comments={comments.filter((c) => c.itemKey === key)}
              commenting={commenting}
              conflict={editing.conflicts.has(key)}
              onChange={(after) => editing.change(key, after)}
              onComment={(anchor, text, extra) => editing.comment(key, anchor, text, extra)}
              onResolve={editing.resolve}
              onAnswer={editing.answer}
              onAnswerPrompt={editing.answerPrompt}
            />
          </Suspense>
        ) : (
          readOnly
        )}
      </div>

      <section>
        <h3>Properties</h3>
        <Properties node={node} tree={tree} onPatch={onPatch} />
      </section>

      {node.summary && <p className="summary">{node.summary}</p>}

      <div className="progress" aria-label={`Progress ${pct(s.progress)}`}>
        <div className="progress-bar">
          <span style={{ width: pct(s.progress) }} />
        </div>
        <span>{pct(s.progress)} done</span>
      </div>

      <dl className="stats">
        <div>
          <dt>Items</dt>
          <dd>{s.items - 1 || '—'}</dd>
        </div>
        <div className={s.openBugs ? 'warn' : ''}>
          <dt>Open bugs</dt>
          <dd>{s.openBugs}</dd>
        </div>
        <div>
          <dt>New features</dt>
          <dd>{s.newFeatures}</dd>
        </div>
        <div className={s.poorlyDefined ? 'fog' : ''}>
          <dt>Vague</dt>
          <dd>{s.poorlyDefined}</dd>
        </div>
        <div className={s.blocked ? 'warn' : ''}>
          <dt>Blocked</dt>
          <dd>{s.blocked}</dd>
        </div>
        <div>
          <dt>Defined</dt>
          <dd>{pct(s.def)}</dd>
        </div>
      </dl>

      {node.children.length > 0 && (
        <section>
          <h3>
            Inside this {KIND_LABEL[node.kind].toLowerCase()} <span className="count">{node.children.length}</span>
          </h3>
          <ul className="rows">
            {node.children.map((c) => (
              <NodeRow key={c.id} node={c} onPick={onPick} sub={lens.stat(c)} />
            ))}
          </ul>
        </section>
      )}

      {!isRoot && (
        <section>
          <h3>Connections</h3>
          <ul className="rows">
            {node.links.map((l, i) => {
              const t = tree.byId.get(l.to);
              return (
                t && (
                  <li key={`o${l.type}${l.to}`} className="row-with-action">
                    <button className="row" onClick={() => onPick(t.id)}>
                      <StatusDot status={t.status} />
                      <span className="row-main">
                        <span className="row-title">{t.title}</span>
                        <span className="row-sub">This {LINK_LABEL[l.type]} it</span>
                      </span>
                    </button>
                    <button className="icon-btn small" aria-label={`Remove the connection to ${t.title}`} onClick={() => onPatch({ links: node.links.filter((_, j) => j !== i) })}>
                      <Icon name="close" size={16} />
                    </button>
                  </li>
                )
              );
            })}
            {incoming.map((l) => {
              const f = tree.byId.get(l.from);
              return f && <NodeRow key={`i${l.type}${l.from}`} node={f} onPick={onPick} sub={`It ${LINK_LABEL[l.type]} this`} />;
            })}
          </ul>
          <AddLink node={node} tree={tree} onPatch={onPatch} />
        </section>
      )}
    </div>
  );
}

export function Results({ lens, tree, focusId, onPick, onClose }) {
  const [everywhere, setEverywhere] = useState(false);
  const scope = !everywhere && focusId ? tree.byId.get(focusId) : tree.root;
  const items = useMemo(() => {
    const list = tree.list.filter((n) => lens.matches(n) && isInside(n, scope));
    return lens.sort ? list.sort(lens.sort) : list;
  }, [tree, lens, scope]);
  return (
    <div className="details">
      <header className="panel-head">
        <div>
          <div className="eyebrow">
            {lens.icon} {lens.name}
          </div>
          <h2 className="node-title">
            {items.length} {lens.chip.toLowerCase()} {scope === tree.root ? 'in the project' : `in ${scope.title}`}
          </h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close results">
          <Icon name="close" />
        </button>
      </header>
      <p className="summary">{lens.blurb}</p>
      {scope !== tree.root && (
        <button className="link-btn" onClick={() => setEverywhere(true)}>
          Search the whole project
        </button>
      )}
      {everywhere && focusId && focusId !== tree.root.id && (
        <button className="link-btn" onClick={() => setEverywhere(false)}>
          Only {tree.byId.get(focusId)?.title}
        </button>
      )}
      <ul className="rows">
        {items.map((n) => (
          <NodeRow
            key={n.id}
            node={n}
            onPick={onPick}
            sub={[lens.stat(n), pathOf(n).slice(1, -1).map((p) => p.title).join(' › ')].filter(Boolean).join(' — ')}
          />
        ))}
      </ul>
      {!items.length && <p className="empty-note">Nothing here. Zoom out or search the whole project.</p>}
    </div>
  );
}
