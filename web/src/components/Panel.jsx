import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { CHILD_KIND, KIND_LABEL, LINK_LABEL, STATUS_LABEL } from '@shared/schema.js';
import { HEALTH_COLOR, HEALTH_LABEL, isInside, pathOf } from '../model/tree.js';
import { Icon } from './Icon.jsx';
import { OTHER_CHANGES, changeKeys, compareItems, editableOf, issueOf, itemKeyOf, reshapeIssue, splitNote } from '@shared/issue-shape.js';
import { isEditable, isMapped } from '../editor/items.js';
import { Composer, Thread } from '../editor/Annotate.jsx';
import { clausesOf, isDismissed, locate, piecesOf, quoteOf, refinementThreads } from '@shared/annotations.js';
import { AddLink, Properties } from './Properties.jsx';
import { syncBadge } from '../model/sync.js';
import { issueRefExtension } from '../model/links.js';
import { useLinks } from './links-context.js';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// "#12" in the text links to the item it is (EDIT-14), so a parser per repository.
const parsers = new Map();
const markedFor = (repo) => {
  if (!parsers.has(repo)) parsers.set(repo, new Marked({ gfm: true, breaks: true }).use({ extensions: [issueRefExtension(repo)] }));
  return parsers.get(repo);
};

export function Markdown({ text }) {
  const { repo } = useLinks();
  const html = useMemo(() => DOMPurify.sanitize(markedFor(repo).parse(text ?? '')), [text, repo]);
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

// An item's health, shown only when it says more than its status (EDIT-21): "Done · Done" or "Idea · Not started" says it twice.
const NOT_STARTED = ['idea', 'planned', 'ready', 'needs_decision'];
const saysMore = (node, health) =>
  !(health === 'done' && ['done', 'rejected'].includes(node.status)) && !(health === 'not_started' && NOT_STARTED.includes(node.status)) && (node.children.length > 0 || ['off_track', 'at_risk'].includes(health));

// Words saved as headings read as the text of their section here too (EDIT-18), the map's 📍 note kept after them.
const shaped = (body) => {
  const { markdown, note } = splitNote(body);
  return reshapeIssue(markdown).trimEnd() + note;
};

const pct = (v) => `${Math.round(v * 100)}%`;

// The document editor is big: it loads the first time an item with text opens.
const IssueForm = lazy(() => import('../editor/IssueForm.jsx').then((m) => ({ default: m.IssueForm })));

/** What the open changeset holds, and the three things to do with it, in one quiet line below the text (EDIT-21). */
function EditBar({ editing }) {
  const { edited, unsaved, saving, busy, onItsWay, changeset, name, setName, accept, discard, saveToGithub } = editing;
  const [naming, setNaming] = useState(false);
  if (!edited.length && !unsaved.length && !saving && !onItsWay) return null;
  const status = saving ? 'Saving…' : edited.length ? `${edited.length} edited` : `${unsaved.length} not on GitHub yet`;
  return (
    <div className="edit-bar" aria-live="polite">
      <span className="edit-status" title={edited.length ? 'Kept in this changeset until you accept or discard it' : 'Accepted, waiting to be saved'}>
        {status}
        {onItsWay > 0 && ` · ${onItsWay} on its way`}
        {name && !naming ? (
          <button type="button" className="edit-by" onClick={() => setNaming(true)} title="Change your name">
            · as {name}
          </button>
        ) : (
          <input
            aria-label="Your name"
            className="edit-name"
            value={name}
            placeholder="Your name"
            maxLength={80}
            autoFocus={naming}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setNaming(false)}
          />
        )}
      </span>
      <span className="edit-actions">
        <button type="button" className="link-btn" onClick={discard} disabled={busy || (!changeset && !edited.length)}>
          Discard
        </button>
        {edited.length > 0 ? (
          <button type="button" className="primary" onClick={accept} disabled={busy}>
            <Icon name="check" size={14} /> Accept
          </button>
        ) : (
          <button type="button" className="primary" onClick={saveToGithub} disabled={busy || !unsaved.length} title="Send accepted changes to GitHub">
            Save to GitHub
          </button>
        )}
      </span>
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

/** One change in a refinement: what the spec says now, struck through, and what is proposed, and its conversation. */
function Change({ label, change, before, after, ready, tick = null, talk = null }) {
  return (
    <li className={`change change-${change}`}>
      <div className="change-head">
        {tick}
        <span className="change-label">{label}</span>
        <span className={`change-kind change-kind-${change}`}>{CHANGE_LABEL[change]}</span>
        {ready && (
          <span className="pill pill-ready" title="The conversation has converged: marked ready for adoption">
            Ready for adoption
          </span>
        )}
        {talk?.head}
      </div>
      {before && <del className="change-before">{before}</del>}
      {after && (talk?.proposed ?? <ins className="change-after">{after}</ins>)}
      {talk?.body}
    </li>
  );
}

/**
 * The conversation on one behaviour of a refinement (#13 ADOPT-03, ADOPT-14): pushback or a question for its author,
 * anchored to the refinement and the behaviour, so it stays with the behaviour through every revision. A thread waiting
 * for the author's word shows a badge. `text` is the behaviour as proposed: select some of its words, or tap its Given,
 * When or Then, to comment on just those, and the words a thread quotes are marked in it, as in the document.
 */
function useTalk({ cs, item, on, label, text = '', threads, editing }) {
  const [writing, setWriting] = useState(null); // the anchor a new comment goes on
  const [picked, setPicked] = useState(null); // words selected in the proposed text: { start, end }
  const [shut, setShut] = useState(() => new Set());
  const words = useRef(null);
  const here = threads.get(on) ?? { threads: [], unanswered: 0 };
  const open = here.threads.filter((t) => !isDismissed(t.root));
  const about = (start, end) => {
    setPicked(null);
    window.getSelection()?.removeAllRanges();
    setWriting({ on: 'phrase', behaviour: on, refinement: cs.id, ...quoteOf(text, start, end) });
  };
  // Where a selection is in the proposed text, as offsets into it, trimmed of the spaces either side.
  const offsetOf = (node, offset) => {
    const r = document.createRange();
    r.selectNodeContents(words.current);
    r.setEnd(node, offset);
    return r.toString().length;
  };
  const select = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !words.current?.contains(sel.anchorNode) || !words.current.contains(sel.focusNode)) return setPicked(null);
    let [a, b] = [offsetOf(sel.anchorNode, sel.anchorOffset), offsetOf(sel.focusNode, sel.focusOffset)].sort((x, y) => x - y);
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    setPicked(b > a ? { start: a, end: b } : null);
  };
  const clauses = useMemo(() => clausesOf(text), [text]);
  const pieces = text ? piecesOf(text, clauses, open) : [];
  const tap = (part) => {
    if (!window.getSelection()?.isCollapsed) return; // a drag that selected words, not a tap
    const c = clauses.find((x) => x.part === part);
    if (c) about(c.start, c.end);
  };
  const show = (ts) => setShut((s) => new Set([...s].filter((id) => !ts.some((t) => t.root.id === id))));
  return {
    head: (
      <span className="change-talk">
        {here.unanswered > 0 && (
          <span className="talk-badge" title={`Waiting for ${cs.author}`} aria-label={`${here.unanswered} waiting for ${cs.author}`}>
            <Icon name="comment" size={12} /> {here.unanswered}
          </span>
        )}
        <button type="button" className="link-btn" onClick={() => setWriting({ on: 'behaviour', behaviour: on, refinement: cs.id })} disabled={Boolean(writing)}>
          Comment
        </button>
      </span>
    ),
    proposed: text ? (
      <>
        <ins className="change-after talkable" ref={words} onMouseUp={select} onKeyUp={select}>
          {pieces.map((p) => {
            const said = text.slice(p.start, p.end);
            if (p.threads.length)
              return (
                <mark key={p.start} className="noted" title="Open its comment" onClick={() => window.getSelection()?.isCollapsed && show(p.threads)}>
                  {said}
                </mark>
              );
            if (!p.clause) return said;
            return (
              <span
                key={p.start}
                className="clause"
                role="button"
                tabIndex={0}
                title={`Comment on the ${p.clause}`}
                onClick={() => tap(p.clause)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), tap(p.clause))}
              >
                {said}
              </span>
            );
          })}
        </ins>
        {picked && (
          <button type="button" className="link-btn pick-comment" onMouseDown={(e) => e.preventDefault()} onClick={() => about(picked.start, picked.end)}>
            <Icon name="comment" size={12} /> Comment on these words
          </button>
        )}
      </>
    ) : null,
    body: (writing || open.length > 0) && (
      <div className="change-threads">
        {open
          .filter((t) => !shut.has(t.root.id))
          .map((t) => (
            <Thread
              key={t.root.id}
              heading={label}
              quote={t.root.anchor?.quote}
              moved={Boolean(t.root.anchor?.quote && text && !locate(text, t.root.anchor))}
              thread={t}
              you={editing.name}
              onReply={(said) => editing.comment(item.key, t.root.anchor, said, { replyTo: t.root.id })}
              onDismiss={editing.dismiss}
              onClose={() => setShut((s) => new Set([...s, t.root.id]))}
            />
          ))}
        {open.some((t) => shut.has(t.root.id)) && (
          <button type="button" className="link-btn" onClick={() => setShut(new Set())}>
            Show {open.filter((t) => shut.has(t.root.id)).length} hidden
          </button>
        )}
        {writing && (
          <Composer
            heading={label}
            quote={writing.quote}
            what={`as ${cs.author} proposes it`}
            onPost={(said) => editing.comment(item.key, writing, said)}
            onCancel={() => setWriting(null)}
          />
        )}
      </div>
    ),
  };
}

/** A behaviour row of a refinement, with its tick and its conversation. */
function BehaviourChange({ b, cs, item, threads, editing, ready, tick }) {
  const talk = useTalk({ cs, item, on: b.id, label: b.id, text: b.after, threads, editing });
  return <Change label={b.id || 'Behaviour'} change={b.change} before={b.before} after={b.after} ready={ready} tick={tick} talk={b.id ? talk : null} />;
}

/** A tick on one change of a refinement (ADOPT-05). */
function Tick({ on, label, onChange, disabled }) {
  return <input type="checkbox" className="change-tick" checked={on} aria-label={label} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />;
}

/**
 * Someone else's refinement of this item (ADOPT-02): who proposed it and when, what it changes against the spec,
 * which behaviours are ready for adoption (ADOPT-04), and the person's yes or no, one behaviour at a time (ADOPT-05):
 * each changed behaviour has a tick, its other changes one more, and those marked ready start ticked. Adopt or Decline
 * acts on the ticked ones only, and the rest stay to decide (ADOPT-06). Open questions show as badges, and never hold it
 * back (ADOPT-08).
 */
function Refinement({ cs, item, node, editing, comments }) {
  const threads = useMemo(() => refinementThreads(comments, cs), [comments, cs]);
  const otherTalk = useTalk({ cs, item, on: OTHER_CHANGES, label: 'Other changes', threads, editing });
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const diff = useMemo(() => compareItems(editableOf(node), item.after), [node, item.after]);
  const keys = useMemo(() => changeKeys(diff), [diff]);
  const ready = new Set(item.readyForAdoption ?? []);
  const [ticks, setTicks] = useState(() => new Set(keys.filter((k) => ready.has(k))));
  const ticked = keys.filter((k) => ticks.has(k));
  const tick = (k, on) => setTicks((t) => (on ? new Set([...t, k]) : new Set([...t].filter((x) => x !== k))));
  const all = keys.length > 0 && ticked.length === keys.length;
  const nothing = !keys.length;
  const key = item.key;
  // With nothing to tick (it proposes the item as it is), the whole item is decided.
  const picks = nothing ? undefined : ticked;
  const done = () => {
    setTicks(new Set());
    setDeclining(false);
    setReason('');
  };
  const count = nothing ? '' : ` ${ticked.length}`;
  const other = diff.title || diff.sections.length;
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
        <>
          <label className="refinement-all">
            <input
              type="checkbox"
              checked={all}
              ref={(el) => el && (el.indeterminate = ticked.length > 0 && !all)}
              onChange={(e) => setTicks(new Set(e.target.checked ? keys : []))}
              disabled={editing.busy}
            />
            Select all
          </label>
          <ul className="changes">
            {diff.behaviours.map((b, i) => (
              <BehaviourChange
                key={`b${b.key || i}`}
                b={b}
                cs={cs}
                item={item}
                threads={threads}
                editing={editing}
                ready={ready.has(b.id)}
                tick={<Tick on={ticks.has(b.key)} label={`Tick ${b.id || 'this behaviour'}`} onChange={(on) => tick(b.key, on)} disabled={editing.busy} />}
              />
            ))}
            {other && (
              <li className="change change-other">
                <div className="change-head">
                  <Tick on={ticks.has(OTHER_CHANGES)} label="Tick the other changes" onChange={(on) => tick(OTHER_CHANGES, on)} disabled={editing.busy} />
                  <span className="change-label">Other changes</span>
                  {otherTalk.head}
                </div>
                {otherTalk.body}
                <ul className="changes">
                  {diff.title && <Change label="Title" change="changed" before={diff.title.before} after={diff.title.after} />}
                  {diff.sections.map((c) => (
                    <Change key={`s${c.name}`} label={c.name === 'Head' ? 'Part of · Kind · Place' : c.name} change={c.change} before={c.before} after={c.after} />
                  ))}
                </ul>
              </li>
            )}
          </ul>
        </>
      )}
      {ready.size > 0 && <p className="refinement-ready">Ready for adoption: {[...ready].join(', ')}</p>}
      {declining ? (
        <div className="refinement-decline">
          <textarea aria-label="Why decline (optional)" placeholder="Why not? (optional: its author sees this)" value={reason} maxLength={2000} rows={2} onChange={(e) => setReason(e.target.value)} />
          <div className="edit-actions">
            <button type="button" onClick={() => setDeclining(false)} disabled={editing.busy}>
              Keep it
            </button>
            <button type="button" className="armed" onClick={async () => (await editing.decline(cs, key, reason, picks)) && done()} disabled={editing.busy || (!nothing && !ticked.length)}>
              Decline{count}
            </button>
          </div>
        </div>
      ) : (
        <div className="edit-actions">
          <button type="button" onClick={() => setDeclining(true)} disabled={editing.busy || (!nothing && !ticked.length)}>
            Decline{count}…
          </button>
          <button
            type="button"
            className="primary"
            onClick={async () => (await editing.adopt(cs, key, picks)) && done()}
            disabled={editing.busy || (!nothing && !ticked.length)}
            title="Adopt the ticked changes: the item takes them, and waits for a save to reach GitHub"
          >
            <Icon name="check" size={16} /> Adopt{count}
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
const ago = (iso) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};

/**
 * Build (#14 HANDOFF-05): offered for the behaviours that are new and unclaimed, all of them or the one whose house opened
 * the card; once asked for, the card says they wait for a builder, and says so plainly after an hour (HANDOFF-06). The
 * server decides what can be built, and only a person can ask.
 */
function BuildBar({ node, atBehaviour, builds, onBuild }) {
  const [busy, setBusy] = useState(false);
  const key = itemKeyOf(node);
  const offer = builds?.buildable?.[key] ?? [];
  const asked = (builds?.requests ?? []).filter((r) => r.itemKey === key);
  if (!onBuild || (!offer.length && !asked.length)) return null;
  const go = async (behaviours) => {
    setBusy(true);
    await onBuild(node, behaviours);
    setBusy(false);
  };
  const one = atBehaviour && offer.includes(atBehaviour) && offer.length > 1;
  return (
    <section className="build-bar" aria-label="Build">
      {offer.length > 0 && (
        <div className="build-actions">
          {one && (
            <button type="button" className="primary" disabled={busy} onClick={() => go([atBehaviour])} title={`Ask for a builder for ${atBehaviour}`}>
              <Icon name="build" size={16} /> Build {atBehaviour}
            </button>
          )}
          <button type="button" className={one ? '' : 'primary'} disabled={busy} onClick={() => go(null)} title={`Ask for a builder for ${offer.join(', ')}`}>
            <Icon name="build" size={16} /> Build {offer.length === 1 ? offer[0] : `all ${offer.length}`}
          </button>
        </div>
      )}
      {asked.map((r) => (
        <p key={r.id} className={`build-waiting${r.stale ? ' stale' : ''}`} role="status">
          Waiting for a builder: {r.waiting.join(', ')}. Asked by {r.by}, {ago(r.at)}.
          {r.stale && ' Nobody has picked it up in over an hour: an agent session takes it at its standup, or with next_work.'}
        </p>
      ))}
    </section>
  );
}

export function Details({ node, atBehaviour = null, tree, lens, comments = [], editing, builds = null, onBuild = null, commenting = false, commentControl = null, back = null, onPick, onFly, onAdd, onPatch, onDelete, onClose, onCopyLink, onDocFocus }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const docRef = useRef(null);
  // Opened from a behaviour's house on the map (#46 MARK-16): show that behaviour, once the document has rendered it.
  useEffect(() => {
    if (!atBehaviour) return undefined;
    let tries = 0, frame = 0, timer = 0;
    const look = () => {
      const row = [...(docRef.current?.querySelectorAll('li, p') ?? [])].find((el) => el.textContent.trim().startsWith(atBehaviour));
      if (!row) {
        if (++tries < 60) frame = requestAnimationFrame(look);
        return;
      }
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('at-behaviour');
      timer = setTimeout(() => row.classList.remove('at-behaviour'), 2400);
    };
    look();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [atBehaviour, node.id]);
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
  // A comment on a refinement's behaviour sits under that behaviour in the refinement while it is open (#13 ADOPT-14),
  // and on the behaviour in the text once the refinement has closed.
  const reviewing = new Set([...editing.others.map((cs) => cs.id), ...(editing.changeset ? [editing.changeset.id] : [])]);
  const proposals = editing.others.flatMap((cs) => cs.items.filter((it) => it.key === key && !it.new && it.after).map((it) => ({ cs, item: it })));
  // Every behaviour already written, drafts included, so a new behaviour's ID never collides.
  const texts = useMemo(() => (editable ? tree.list.map((n) => editing.drafts.get(itemKeyOf(n))?.markdown ?? n.body ?? '') : []), [editable, tree, editing.drafts]);
  const readOnly = (
    <>
      <h2 className="node-title">{node.title}</h2>
      {node.body && <Markdown text={shaped(node.body)} />}
    </>
  );

  return (
    <div className="details">
      <header className="panel-head">
        {back && (
          <button type="button" className="icon-btn back-btn" onClick={back.go} aria-label={back.label} title={back.label}>
            <Icon name="left" />
          </button>
        )}
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
        {/* Each fact once (EDIT-21): a new item is just new; a leaf's health only says more than its status when it is off track or at risk. */}
        {!node.refinement && (
          <span className="status-text">
            <StatusDot status={node.status} /> {STATUS_LABEL[node.status]}
          </span>
        )}
        {!node.refinement && saysMore(node, s.health) && <HealthPill health={s.health} />}
        {s.overdue && <span className="pill pill-outline">Overdue</span>}
        {s.vague && <span className="pill pill-fog">Poorly defined</span>}
        {node.refinement && (
          <span className="pill pill-new" title={theirs ? 'New in someone else’s refinement: it changes there until it is adopted.' : 'New in your refinement: Accept adopts it, Discard drops it.'}>
            New
          </span>
        )}
        {proposals.length > 0 && (
          <span className="pill pill-refine" title="Someone else has proposed a change to this item: see it below">
            Refinement proposed
          </span>
        )}
        <SyncBadge node={node} />
      </div>

      <BuildBar node={node} atBehaviour={atBehaviour} builds={builds} onBuild={onBuild} />

      <div className="actions quiet">
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
          <button className={confirmDelete ? 'armed' : ''} title={node.refinement ? undefined : 'Delete'} onClick={() => (confirmDelete ? onDelete(node) : setConfirmDelete(true))} onBlur={() => setConfirmDelete(false)}>
            <span className="action-icon danger">
              <Icon name="trash" />
            </span>
            {node.refinement ? (confirmDelete ? 'Drop it?' : 'Drop') : confirmDelete ? `Delete${node.children.length ? ` ${node.stats.items}` : ''}?` : <span className="sr-only">Delete</span>}
          </button>
        )}
      </div>

      {proposals.map(({ cs, item }) => (
        <Refinement key={cs.id} cs={cs} item={item} node={node} editing={editing} comments={comments.filter((c) => c.itemKey === key)} />
      ))}
      <div className="doc" ref={docRef} onFocusCapture={onDocFocus}>
        {editable ? (
          <Suspense fallback={readOnly}>
            <IssueForm
              key={`${key}:${editing.generation}`}
              value={editing.drafts.get(key) ?? editableOf(node)}
              issueNumber={issue?.number}
              areaTexts={texts}
              comments={comments.filter((c) => c.itemKey === key && !(c.anchor?.refinement && reviewing.has(c.anchor.refinement)))}
              commenting={commenting}
              placeholderTitle={Boolean(node.refinement) && !theirs ? `New ${node.kind}` : null}
              conflict={editing.conflicts.has(key)}
              onChange={(after) => editing.change(key, after)}
              onComment={(anchor, text, extra) => editing.comment(key, anchor, text, extra)}
              onPromote={editing.promote}
              onDismiss={editing.dismiss}
              onRestore={editing.restore}
              onAnswerPrompt={editing.answerPrompt}
              you={editing.name}
              hasRead={editing.hasRead}
              onRead={editing.markRead}
            />
          </Suspense>
        ) : (
          readOnly
        )}
      </div>
      <EditBar editing={editing} />

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
