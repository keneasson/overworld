import { Fragment, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { CHILD_KIND, KIND_LABEL, LINK_LABEL, STATUS_LABEL } from '@shared/schema.js';
import { HEALTH_COLOR, HEALTH_LABEL, pathOf } from '../model/tree.js';
import { Icon } from './Icon.jsx';
import { fogReason } from '../map/fog.js';
import { OTHER_CHANGES, changeKeys, compareItems, editableOf, issueOf, itemKeyOf, reshapeIssue, splitNote } from '@shared/issue-shape.js';
import { isEditable, isMapped } from '../editor/items.js';
import { Composer, Thread, useAskName } from '../editor/Annotate.jsx';
import { questionsIn } from '@shared/questions.js';
import { changeSummary, foldUnchanged, wordDiff } from '@shared/word-diff.js';
import { clausesOf, isDismissed, locate, piecesOf, quoteOf, refinementThreads, threadsOf } from '@shared/annotations.js';
import { AddLink, Properties } from './Properties.jsx';
import { syncBadge } from '../model/sync.js';
import { issueRefExtension } from '../model/links.js';
import { useLinks } from './links-context.js';
import { reviewingAt, titleWithNumber, waitedFor, waitingWords } from '../model/review.js';
import { wasteCard } from '../map/wasteland.js';
import { behavioursReaching, isStale, linesOf } from '@shared/proof.js';
import { houseId } from '../map/houses.js';
import { provenSummary } from '../map/lenses.js';
import { Photos } from './Photos.jsx';
import { BUILD_FOG, buildOffer } from '../model/build.js';
import { turnOf } from '@shared/turns.js';
import { authorOf } from '../model/changesets.js';

// Only where there is a page to sanitise for (not when the panel is read in a test).
DOMPurify.addHook?.('afterSanitizeAttributes', (node) => {
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
  // Nothing unsanitised is ever shown: with no page to sanitise for (the panel read in a test), it shows nothing.
  const html = useMemo(() => (DOMPurify.sanitize ? DOMPurify.sanitize(markedFor(repo).parse(text ?? '')) : ''), [text, repo]);
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

/**
 * What the open changeset holds, and the three things to do with it, in one quiet line below the text (EDIT-21). Review
 * opens what it holds across issues, and its comments: #15's, on the area its edits are in (#62 SYNC-01).
 */
function EditBar({ editing, box = null, comments = [], onPick }) {
  const { edited, unsaved, saving, busy, onItsWay, changeset, name, setName, accept, discard, saveToGithub } = editing;
  const [naming, setNaming] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  if (!edited.length && !unsaved.length && !saving && !onItsWay) return null;
  const status = saving ? 'Saving…' : edited.length ? `${edited.length} edited` : `${unsaved.length} not on GitHub yet`;
  const talk = box ? threadsOf(comments.filter((c) => c.itemKey === itemKeyOf(box.area) && c.anchor?.on === 'changeset')).filter((t) => !isDismissed(t.root)) : [];
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
        {box && (
          <button type="button" className="link-btn" onClick={() => setReviewing((r) => !r)} aria-expanded={reviewing}>
            {talk.length > 0 && <Icon name="comment" size={12} />} Review{talk.length > 0 ? ` · ${talk.length}` : ''}
          </button>
        )}
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
      {box && reviewing && <ChangesetReview box={box} threads={talk} editing={editing} onPick={onPick} />}
    </div>
  );
}

/** The changeset as one (#62 SYNC-01): each issue it holds and what it changes, and the comments on it as a whole. */
function ChangesetReview({ box, threads, editing, onPick }) {
  const [writing, setWriting] = useState(false);
  const [shut, setShut] = useState(() => new Set());
  const at = itemKeyOf(box.area);
  const heading = `The changeset in ${titleWithNumber(box.area)}`;
  return (
    <div className="changeset-review">
      <ul className="changeset-items">
        {box.items.map((it) => (
          <li key={it.key}>
            <button type="button" className="link-btn" onClick={() => onPick(it.node.id)}>
              {titleWithNumber(it.node)}
            </button>
            <span className="row-sub">{changesetWords(it)}</span>
          </li>
        ))}
      </ul>
      {threads
        .filter((t) => !shut.has(t.root.id))
        .map((t) => (
          <Thread
            key={t.root.id}
            heading={heading}
            thread={t}
            you={editing.name}
            onReply={(said) => editing.comment(at, t.root.anchor, said, { replyTo: t.root.id })}
            onDismiss={editing.dismiss}
            onClose={() => setShut((s) => new Set([...s, t.root.id]))}
          />
        ))}
      {writing ? (
        <Composer heading={heading} what="as a whole" onPost={(said) => editing.comment(at, { on: 'changeset' }, said)} onCancel={() => setWriting(false)} />
      ) : (
        <button type="button" className="link-btn" onClick={() => setWriting(true)}>
          <Icon name="comment" size={12} /> Comment on the changeset
        </button>
      )}
    </div>
  );
}

/** What one item of the changeset is, in a few words: new, or which behaviours it changes, and whether it is accepted. */
function changesetWords(it) {
  const parts = it.new ? ['new'] : [];
  if (it.added.length) parts.push(`new ${it.added.join(', ')}`);
  if (it.changed.length) parts.push(`changed ${it.changed.join(', ')}`);
  if (it.removed.length) parts.push(`removed ${it.removed.join(', ')}`);
  if (!it.edited) parts.push('not on GitHub yet');
  else if (!parts.length) parts.push('edited');
  return parts.join(' · ');
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

/**
 * Words as one text (ADOPT-18): those a change removes struck through and those it adds marked, in their place. With
 * `fold`, long unchanged runs shrink to "…" with a few words either side of each change, and open on a tap.
 */
function WordDiff({ before, after, fold = false }) {
  const [open, setOpen] = useState(false);
  const parts = useMemo(() => (fold && !open ? foldUnchanged(wordDiff(before, after)) : wordDiff(before, after)), [before, after, fold, open]);
  return parts.map((p, i) => {
    if (p.kind === 'del') return <del key={i} className="diff-del">{p.text}</del>;
    if (p.kind === 'ins') return <ins key={i} className="diff-ins">{p.text}</ins>;
    if (p.kind === 'fold')
      return (
        <Fragment key={i}>
          {p.head}
          <button type="button" className="link-btn diff-fold" onClick={() => setOpen(true)} title="Show the unchanged words" aria-label="Show the unchanged words">
            …
          </button>
          {p.tail}
        </Fragment>
      );
    return <Fragment key={i}>{p.text}</Fragment>;
  });
}

const CONFLICT = (
  <span className="pill pill-conflict" title="This part of the item has changed since it was proposed: adopting it is a conflict to resolve first">
    Changed since
  </span>
);

/** One change in a refinement: a changed one as one text with its edits marked in it, an added or removed one whole, and its conversation. */
function Change({ label, change, before, after, ready, conflict = false, tick = null, talk = null }) {
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
        {conflict && CONFLICT}
        {talk?.head}
      </div>
      {change === 'changed' && before && after ? (
        (talk?.proposed ?? (
          <span className="change-after">
            <WordDiff before={before} after={after} />
          </span>
        ))
      ) : (
        <>
          {before && <del className="change-before">{before}</del>}
          {after && (talk?.proposed ?? <ins className="change-after">{after}</ins>)}
        </>
      )}
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
function useTalk({ cs, item, on, label, text = '', before = '', threads, editing }) {
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
  // Where a selection is in the proposed text, as offsets into it, trimmed of the spaces either side. Struck words aren't in it.
  const offsetOf = (node, offset) => {
    const r = document.createRange();
    r.selectNodeContents(words.current);
    r.setEnd(node, offset);
    const upTo = r.cloneContents();
    upTo.querySelectorAll('del').forEach((d) => d.remove());
    return upTo.textContent.length;
  };
  // With what it says now, the proposed text shows its edits in place (ADOPT-18): where each removed run was, and which words are new.
  const runs = useMemo(() => {
    if (!before || !text) return null;
    let at = 0;
    return wordDiff(before, text).map((p) => (p.kind === 'del' ? { at, del: p.text } : { start: at, end: (at += p.text.length), ins: p.kind === 'ins' }));
  }, [before, text]);
  const marked = (start, end) => {
    if (!runs) return text.slice(start, end);
    return runs.flatMap((r) => {
      if (r.del != null) return r.at >= start && (r.at < end || (r.at === end && end === text.length)) ? [<del key={`d${r.at}`} className="diff-del">{r.del}</del>] : [];
      const a = Math.max(r.start, start), b = Math.min(r.end, end);
      if (a >= b) return [];
      return [r.ins ? <ins key={`i${a}`} className="diff-ins">{text.slice(a, b)}</ins> : <Fragment key={`s${a}`}>{text.slice(a, b)}</Fragment>];
    });
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
            const said = marked(p.start, p.end);
            if (p.threads.length)
              return (
                <mark key={p.start} className="noted" title="Open its comment" onClick={() => window.getSelection()?.isCollapsed && show(p.threads)}>
                  {said}
                </mark>
              );
            if (!p.clause) return <Fragment key={p.start}>{said}</Fragment>;
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
  const talk = useTalk({ cs, item, on: b.id, label: b.id, text: b.after, before: b.change === 'changed' ? b.before : '', threads, editing });
  return <Change label={b.id || 'Behaviour'} change={b.change} before={b.before} after={b.after} ready={ready} conflict={Boolean(b.conflict)} tick={tick} talk={b.id ? talk : null} />;
}

/** One of a refinement's other changes as a line of what it did ("Why: 1 sentence reworded"), with its words under a disclosure (ADOPT-18). */
function SectionChange({ label, c, summary }) {
  return (
    <li className={`section-change change-${c.change}`}>
      <details>
        <summary>
          <span className="change-label">{label}</span>
          {label === 'Title' ? ' ' : ': '}
          {summary}
          {c.conflict && <> {CONFLICT}</>}
        </summary>
        <span className="change-after">
          <WordDiff before={c.before} after={c.after} fold />
        </span>
      </details>
    </li>
  );
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
  // What it changed from the item as it found it (ADOPT-17), not every way the item differs from it now.
  const diff = useMemo(() => compareItems(editableOf(node), item.after, item.base ?? null), [node, item.after, item.base]);
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
  const other = Boolean(diff.title || diff.sections.length);
  // A person's own change goes to an agent first (ADOPT-20), and isn't offered as a decision until one marks it ready (ADOPT-21).
  const turn = turnOf(cs, item);
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
                <ul className="change-summary">
                  {diff.title && <SectionChange label="Title" c={{ change: 'changed', ...diff.title }} summary="changed" />}
                  {diff.sections.map((c) => (
                    <SectionChange key={`s${c.name}`} label={c.name === 'Head' ? 'Part of · Kind · Place' : c.name} c={c} summary={changeSummary(c)} />
                  ))}
                </ul>
              </li>
            )}
          </ul>
        </>
      )}
      {ready.size > 0 && <p className="refinement-ready">Ready for adoption: {[...ready].join(', ')}</p>}
      {turn ? (
        <WithAnAgent turn={turn} cs={cs} item={item} editing={editing} />
      ) : declining ? (
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
 * A person's own change, still with an agent (#13 ADOPT-21): it says so in place of Adopt and Decline, which come once an
 * agent marks it ready. A small menu keeps a way out, so nobody is stuck waiting: adopt it as it is, or withdraw it.
 */
function WithAnAgent({ turn, cs, item, editing }) {
  const yours = cs.author === authorOf(editing.name);
  const [open, setOpen] = useState(false);
  const words = turn === 'agent' ? 'Sent to an agent · waiting' : 'An agent answered · not ready yet';
  const why = turn === 'agent' ? 'An agent reads it first: questions in it become conversation, and it comes back ready to adopt.' : 'Its questions are in the threads above; it comes back once an agent marks it ready.';
  return (
    <div className="refinement-turn">
      <p className="turn-note" role="status">
        <Icon name="comment" size={16} /> <strong>{words}</strong>
        <span className="empty-note"> {why}</span>
      </p>
      <div className="edit-actions">
        <button type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label="More" title="More" onClick={() => setOpen((o) => !o)}>
          …
        </button>
        {open && (
          <span role="menu" className="turn-menu">
            <button type="button" role="menuitem" onClick={async () => (await editing.decline(cs, item.key, yours ? 'Withdrawn by its author' : '')) && setOpen(false)} disabled={editing.busy}>
              {yours ? 'Withdraw' : 'Decline'}
            </button>
            <button type="button" role="menuitem" onClick={async () => (await editing.adopt(cs, item.key)) && setOpen(false)} disabled={editing.busy} title="Adopt it without waiting for an agent: the item takes it, and waits for a save to reach GitHub">
              Adopt as is
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A new item in someone else's refinement (NEW-03), decided as a whole, its title and its behaviours (ADOPT-05): adopted,
 * it joins the spec and waits for a save to reach GitHub (NEW-04); declined, it is dropped, with what is inside it, and
 * never reaches GitHub (NEW-06). The rest of the refinement stays to decide (ADOPT-06).
 */
function NewItemReview({ cs, node, editing }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const ids = useMemo(() => compareItems({ title: '', markdown: '' }, editableOf(node)).behaviours.map((b) => b.id).filter(Boolean), [node]);
  // The spec takes a new item's parent first, when that is new too.
  const waitsOn = node.parent?.refinement ? node.parent : null;
  const inside = node.children.filter((c) => c.refinement).length;
  const key = itemKeyOf(node);
  return (
    <section className="refinement" aria-label={`New item in a refinement by ${cs.author}`}>
      <div className="refinement-head">
        <Icon name="plus" size={16} />
        <span>
          New in a refinement by <strong>{cs.author}</strong> · {when(cs.updatedAt)}
        </span>
      </div>
      <p className="refinement-note">
        It isn’t in the spec until it is adopted. Adopt or Decline takes the whole {KIND_LABEL[node.kind]?.toLowerCase() ?? 'item'}: its title{ids.length ? ` and ${ids.join(', ')}` : ''}.
      </p>
      {waitsOn && <p className="empty-note">It is inside “{waitsOn.title}”, which is new too: adopt that first.</p>}
      {declining ? (
        <div className="refinement-decline">
          <textarea aria-label="Why decline (optional)" placeholder="Why not? (optional: its author sees this)" value={reason} maxLength={2000} rows={2} onChange={(e) => setReason(e.target.value)} />
          <div className="edit-actions">
            <button type="button" onClick={() => setDeclining(false)} disabled={editing.busy}>
              Keep it
            </button>
            <button type="button" className="armed" onClick={() => editing.decline(cs, key, reason)} disabled={editing.busy} title={inside ? `Drops it, and the ${inside} new item${inside === 1 ? '' : 's'} inside it` : 'Drops it: it never reaches GitHub'}>
              Decline{inside ? ` with ${inside} inside` : ''}
            </button>
          </div>
        </div>
      ) : (
        <div className="edit-actions">
          <button type="button" onClick={() => setDeclining(true)} disabled={editing.busy}>
            Decline…
          </button>
          <button type="button" className="primary" onClick={() => editing.adopt(cs, key)} disabled={editing.busy || Boolean(waitsOn)} title="Adopt it: it joins the spec, and waits for a save to reach GitHub">
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
const ago = (iso) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};

/**
 * Where each claim on the item has got to (#14 HANDOFF-11): being built, in a pull request, merged and waiting for the
 * deploy, or back with its builder because the pull request closed unmerged or the deploy failed. A claim ends when the
 * deploy that carries it succeeds, and the agent badge with it (HANDOFF-04).
 */
function claimWords({ agent, ids, pr }) {
  const who = `${agent}: ${ids.join(', ')}`;
  if (!pr) return { text: `${who}, being built.` };
  if (pr.state === 'open') return { text: `${who}, in pull request #${pr.number}${pr.builtWith ? `, built with ${pr.builtWith}` : ''}. Held until it is deployed.`, warn: /falling back/.test(pr.builtWith ?? '') };
  if (pr.deploy?.state === 'failed') return { text: `${who}: pull request #${pr.number} is merged, but the deploy of ${pr.deploy.sha.slice(0, 7)} failed, ${ago(pr.deploy.at)}. The claim stays with its builder.`, warn: true };
  if (pr.state === 'merged') return { text: `${who}: pull request #${pr.number} is merged, waiting for the deploy to production.` };
  return { text: `${who}: pull request #${pr.number} was closed without merging, ${ago(pr.at)}. The claim stays with its builder for now.`, warn: true };
}

/**
 * Wasteland (#24 WASTE-03, WASTE-04): why this ground is waste and which mark said so, the behaviours that cross it, the
 * repair handed to an agent as a comment addressed to it (handed over at once, #15 NOTE-17) with those behaviours' tests as
 * the safety net, and the repairs already made with the pull request that made each.
 */
// A label starts a sentence; mid-sentence only its first letter is lowered, so an acronym in it keeps its case.
const lower = (label) => label.charAt(0).toLowerCase() + label.slice(1);
function WasteBar({ node, tree, editing }) {
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const card = useMemo(() => wasteCard(node, tree), [node, tree]);
  const ask = useAskName();
  if (!card) return null;
  const hand = async () => {
    setBusy(true);
    ask.save();
    if (await editing.comment(itemKeyOf(node), { on: 'place' }, card.prompt)) setAsked(true);
    setBusy(false);
  };
  return (
    <section className="waste-bar" aria-label="Wasteland">
      {card.marks.length > 0 && (
        <>
          <p>
            <strong>Wasteland.</strong> This code is in use but marked as technical debt: {card.kinds.map(lower).join('; ')}.
          </p>
          <ul className="waste-marks">
            {card.marks.map((m) => (
              <li key={`${m.path}:${m.line}:${m.mark}`}>
                <span className="waste-kind">{m.label}</span>{' '}
                <a href={m.url} target="_blank" rel="noopener noreferrer">
                  {m.path}:{m.line}
                </a>
                <span className="waste-text">{m.text}</span>
              </li>
            ))}
          </ul>
          <p>
            {card.behaviours.length ? (
              <>
                Crossed by{' '}
                {card.behaviours.map((b, i) => (
                  <span key={b.id} title={`${b.title}: ${b.words}`}>
                    {i ? ', ' : ''}
                    {b.id}
                  </span>
                ))}
                : their tests are the safety net for the repair.
              </>
            ) : (
              'No behaviour crosses it yet, so no test guards a repair.'
            )}
          </p>
          {asked ? (
            <p className="build-note" role="status">
              Handed to an agent: the comment on this place reaches the next agent session.
            </p>
          ) : (
            <div className="build-actions">
              {ask.field}
              <button type="button" disabled={busy || !ask.named} onClick={hand} title="Address a comment on this place to an agent, asking for the repair">
                <Icon name="build" size={16} /> Hand the repair to an agent
              </button>
            </div>
          )}
        </>
      )}
      {card.cleared.length > 0 && (
        <ul className="waste-cleared" aria-label="Repaired">
          {card.cleared.map((c) => (
            <li key={`${c.path}:${c.mark}:${c.text}:${c.at}`}>
              Cleared {c.at.slice(0, 10)}
              {c.pr ? (
                <>
                  {' '}by{' '}
                  <a href={c.pr.url} target="_blank" rel="noopener noreferrer">
                    #{c.pr.number}
                  </a>
                  {c.pr.title ? ` ${c.pr.title}` : ''}
                </>
              ) : (
                ''
              )}
              : {lower(c.label)} in {c.path}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Build (#14 HANDOFF-05): offered for the behaviours that are new and unclaimed, all of them or the one whose house opened
 * the card, when the issue is under the fog line (HANDOFF-12); otherwise the card says what is missing (HANDOFF-03) and
 * what to define. Build shows the prompt first, to read, change or copy before it goes (HANDOFF-02). Once asked for, the
 * card says they wait for a builder, and says so plainly after an hour (HANDOFF-06), and whether the project's runner was
 * started (HANDOFF-07). A builder that stopped says why, or where its pull request is (HANDOFF-09). The server decides
 * what can be built, and only a person can ask.
 */
function BuildBar({ node, atBehaviour, builds, claims = [], onBuild, onBuildPrompt }) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null); // { behaviours, built, prompt } while the prompt is being read
  const key = itemKeyOf(node);
  const { fog, offer, foggy, missing, why } = buildOffer(node, builds);
  const asked = (builds?.requests ?? []).filter((r) => r.itemKey === key);
  const said = (builds?.notes ?? []).filter((n) => n.itemKey === key);
  // Grouped by hand, not with Object.groupBy: Safari before 17.4 has none, and the card must open everywhere.
  const groups = new Map();
  for (const c of claims) {
    if (c.item !== key || !(Date.parse(c.until) > Date.now())) continue;
    const g = `${c.owner}|${c.pr?.number ?? ''}|${c.pr?.state ?? ''}|${c.pr?.deploy?.state ?? ''}`;
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const held = [...groups.values()].map((cs) => ({ agent: `${cs[0].agentName} (${cs[0].owner})`, ids: cs.map((c) => c.behaviour), pr: cs[0].pr }));
  // Nothing to build, nothing going on: say what it lacks, unless that is nothing a person could add.
  const lacking = !offer.length && !asked.length && !held.length && (missing.length > 0 || foggy);
  if (!onBuild || !onBuildPrompt || (!offer.length && !asked.length && !said.length && !held.length && !lacking)) return null;
  const look = async (behaviours) => {
    setBusy(true);
    const built = await onBuildPrompt(node, behaviours);
    setBusy(false);
    if (built != null) setDraft({ behaviours, built, prompt: built });
  };
  const send = async (behaviours, prompt) => {
    setBusy(true);
    if (await onBuild(node, behaviours, prompt)) setDraft(null);
    setBusy(false);
  };
  const one = atBehaviour && offer.includes(atBehaviour) && offer.length > 1;
  return (
    <section className="build-bar" aria-label="Build">
      {offer.length > 0 && !draft && (
        <div className="build-actions">
          {one && (
            <button type="button" className="primary" disabled={busy} onClick={() => look([atBehaviour])} title={`See the prompt for ${atBehaviour}, then ask for a builder`}>
              <Icon name="build" size={16} /> Build {atBehaviour}
            </button>
          )}
          <button type="button" className={one ? '' : 'primary'} disabled={busy} onClick={() => look(null)} title={`See the prompt for ${offer.join(', ')}, then ask for a builder`}>
            <Icon name="build" size={16} /> Build {offer.length === 1 ? offer[0] : `all ${offer.length}`}
          </button>
        </div>
      )}
      {draft && (
        <div className="build-prompt">
          <label>
            <span>The prompt the builder gets. Read it, and change it if you like.</span>
            <textarea aria-label="The prompt the builder gets" rows={12} value={draft.prompt} maxLength={40000} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
          </label>
          <div className="build-actions">
            <button type="button" className="primary" disabled={busy || !draft.prompt.trim()} onClick={() => send(draft.behaviours, draft.prompt !== draft.built ? draft.prompt : null)}>
              <Icon name="build" size={16} /> Ask for a builder
            </button>
            <CopyPrompt text={draft.prompt} />
            {draft.prompt !== draft.built && (
              <button type="button" className="link-btn" disabled={busy} onClick={() => setDraft({ ...draft, prompt: draft.built })}>
                Undo my changes
              </button>
            )}
            <button type="button" className="link-btn" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {lacking && (
        <div className="build-missing" role="status">
          <p>Not ready to build yet.</p>
          <ul>
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
            {/* A leaf with no behaviours, or none worked out, is all fog: the server has already said so. */}
            {fog >= BUILD_FOG && !(fog === 100 && !node.children.length && missing.length > 0) && (
              <li>
                It is {fog}% fog{node.children.length ? '' : ` (${why[0]})`}: Build is offered only under {BUILD_FOG}% fog, when its behaviours are worked out.
                {node.children.length > 0 && why.length > 0 && ` Foggiest: ${why.join('; ')}.`}
              </li>
            )}
          </ul>
        </div>
      )}
      {asked.map((r) => (
        <p key={r.id} className={`build-waiting${r.stale ? ' stale' : ''}`} role="status">
          Waiting for a builder: {r.waiting.join(', ')}. Asked by {r.by}, {ago(r.at)}.
          {r.runner?.state === 'started' && ' The runner was started.'}
          {r.runner?.state === 'not_started' && ` The runner couldn’t be started (${r.runner.reason}); an agent session can still take it.`}
          {r.stale && ' Nobody has picked it up in over an hour: an agent session takes it at its standup, or with next_work.'}
        </p>
      ))}
      {held.map((h) => {
        const { text, warn } = claimWords(h);
        return (
          <p key={`${h.agent}${h.pr?.number}`} className={`build-claim${warn ? ' stale' : ''}`}>
            {text}
          </p>
        );
      })}
      {said.map((n) => (
        <p key={n.request} className={`build-note${n.expired ? ' stale' : ''}`}>
          <strong>{n.by}</strong>, {ago(n.at)}: {n.note}
        </p>
      ))}
    </section>
  );
}

// An item that needs a split before it can be built (#32 STATE-10), and the way to do it (STATE-14): what it still has to
// build moves into a child task, in your changeset. Agents see the same in their standup.
function SplitBar({ node, editing, onPick }) {
  const [split, setSplit] = useState(null);
  const [busy, setBusy] = useState(false);
  const key = itemKeyOf(node);
  useEffect(() => {
    let live = true;
    setSplit(null);
    if (!editing?.splitOf || node.refinement) return;
    editing.splitOf(node).then((s) => live && setSplit(s));
    return () => {
      live = false;
    };
  }, [key, editing?.generation]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!split) return null;
  const go = async () => {
    setBusy(true);
    const child = await editing.split(node);
    setBusy(false);
    if (child) setSplit(null);
  };
  return (
    <section className="split-bar" aria-label="Needs a split">
      <p>
        <strong>Needs a split.</strong> {split.reason}
        {split.looks_built.length > 0 && <> Built: {split.looks_built.join(', ')}.</>} Still to build: {split.still_to_build.join(', ')}.
      </p>
      <button type="button" className="primary" disabled={busy || editing.busy} onClick={go} title={`Move ${split.still_to_build.join(', ')} into a new child task, in your changeset`}>
        <Icon name="split" size={16} /> Split what's left into a child
      </button>
    </section>
  );
}

const NO_PROOF = { report: null, code: null, repo: null };

/** Where a file is on GitHub at the report's commit, at its first reached line when given ranges. */
const sourceAt = (repo, commit, path, ranges = '') => {
  if (!repo || !commit) return null;
  const first = String(ranges).split(',')[0];
  return `https://github.com/${repo}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}${first ? `#L${first.replace('-', '-L')}` : ''}`;
};
const PROOF_WORDS = { done: 'Done, proven', broken: 'Broken: its proof fails', unproven: 'Unproven: nothing shows it', passing: 'Tests pass', failing: 'Tests fail', untested: 'No tests yet' };
const proofWords = (b) => PROOF_WORDS[b.done ?? (b.proof.state === 'untested' && b.proof.proven ? 'passing' : b.proof.state)];
const proofClass = (b) => (b.done === 'broken' || b.proof.state === 'failing' ? 'failing' : b.proof.proven ? 'passing' : 'untested');

/** Which commit the report is from, and whether the code has moved on since (#21 PROVEN-05). */
function ReportFrom({ proof }) {
  const { report, code } = proof;
  if (!report) return null;
  const short = (c) => String(c).slice(0, 7);
  return isStale(report, code) ? (
    <p className="proof-from stale" role="status">
      This report is from {short(report.commit)}, older than the code, which is now at {short(code)}.
    </p>
  ) : (
    <p className="proof-from muted small">From the coverage report for {short(report.commit)}{report.coverage === 'file' ? ', measured per test file' : ''}.</p>
  );
}

/**
 * The proof of each behaviour an issue lists (#21 PROVEN-03): the tests that prove it and the files they reach, from the
 * latest coverage report, and any screenshot or other viewable proof its line links to, each linked to its source. The
 * behaviour opened from its house on the map is open here too.
 */
export function ProofSection({ node, atBehaviour, proof }) {
  const rows = (node.behaviourRows ?? []).filter((b) => !b.fog);
  if (!rows.length || !(proof.report || rows.some((b) => b.proof.viewable.length))) return null;
  const at = (path, ranges) => sourceAt(proof.repo, proof.report?.commit, path, ranges);
  return (
    <section className="proof">
      <h3>
        Proof <span className="count">{rows.filter((b) => b.proof.proven).length}/{rows.length}</span>
      </h3>
      <ReportFrom proof={proof} />
      {rows.map((b) => (
        <details key={b.id} className={`proof-row ${proofClass(b)}`} open={b.id === atBehaviour}>
          <summary>
            <span className={`proof-dot ${proofClass(b)}`} aria-hidden="true" />
            <span className="proof-id">{b.id}</span>
            <span className="row-sub">{proofWords(b)}</span>
          </summary>
          {b.proof.viewable.map((v) => (
            <a key={v.url} className="proof-view" href={v.url} target="_blank" rel="noopener noreferrer">
              {v.kind === 'image' ? <img src={v.url} alt={v.label} loading="lazy" /> : v.label}
            </a>
          ))}
          {b.proof.tests.length > 0 && (
            <>
              <h4>Tests</h4>
              <ul className="proof-list">
                {b.proof.tests.map((t) => (
                  <li key={`${t.file}:${t.name}`} className={t.passed ? 'passing' : 'failing'}>
                    <span className={`proof-dot ${t.passed ? 'passing' : 'failing'}`} aria-label={t.passed ? 'passes' : 'fails'} />
                    {at(t.file) ? <a href={at(t.file)} target="_blank" rel="noopener noreferrer">{t.name}</a> : t.name}
                    <span className="row-sub"> {t.file}</span>
                  </li>
                ))}
              </ul>
              <h4>Code they reach</h4>
              <ul className="proof-list">
                {Object.entries(b.proof.files).map(([path, ranges]) => (
                  <li key={path}>
                    {at(path, ranges) ? <a href={at(path, ranges)} target="_blank" rel="noopener noreferrer">{path}</a> : path}
                    <span className="row-sub"> {ranges ? `${linesOf(ranges).length} lines` : 'reached'}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {!b.proof.tests.length && !b.proof.viewable.length && <p className="muted small">No test is named {b.id}, and nothing viewable shows it yet.</p>}
        </details>
      ))}
    </section>
  );
}

// The files a code area lists: "- [path](url)" lines (api/engine/project.mjs), with markdown's escapes undone.
const filesIn = (body) => [...String(body ?? '').matchAll(/^- \[((?:\\.|[^\]])+)\]\(/gm)].map((m) => m[1].replace(/\\(.)/g, '$1'));

/**
 * For each file a code area holds, the behaviours whose tests reach it (#21 PROVEN-04); Directions lights those
 * behaviours up on the map.
 */
export function FileProof({ node, tree, proof, lit, onPick, onDirections }) {
  if (!proof.report || !node.tags?.includes('code')) return null;
  const houseOf = new Map(tree.list.flatMap((n) => (n.behaviourRows ?? []).map((b) => [b.id, houseId(n, b.id)])));
  const files = filesIn(node.body).map((path) => ({ path, ids: behavioursReaching(proof.report, path) }));
  if (!files.length) return null;
  return (
    <section className="proof">
      <h3>Behaviours that reach its files</h3>
      <ReportFrom proof={proof} />
      <ul className="rows">
        {files.map(({ path, ids }) => {
          const houses = ids.map((id) => houseOf.get(id)).filter(Boolean);
          const on = houses.length > 0 && lit?.path === path;
          return (
            <li key={path} className="file-proof">
              <div className="row-main">
                <span className="row-title">{path}</span>
                <span className="row-sub">{ids.length ? `${ids.length} behaviour${ids.length === 1 ? '' : 's'} reach it` : 'No behaviour’s tests reach it'}</span>
                {houses.length > 0 && (
                  <span className="proof-ids">
                    {ids
                      .filter((id) => houseOf.has(id))
                      .map((id) => (
                        <button key={id} type="button" className="tag" onClick={() => onPick(houseOf.get(id))}>
                          {id}
                        </button>
                      ))}
                  </span>
                )}
                {houses.length < ids.length && <span className="row-sub">{ids.length - houses.length} not on this map</span>}
              </div>
              {houses.length > 0 && (
                <button type="button" className={`directions${on ? ' on' : ''}`} aria-pressed={on} onClick={() => onDirections(on ? null : { path, houses })}>
                  <Icon name="target" size={16} /> Directions
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Copies the prompt, for anyone who would rather paste it into their own agent's chat (#14). */
function CopyPrompt({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // no clipboard (an insecure page): the text is still there to select
        }
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={16} /> {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export function Details({ node, atBehaviour = null, tree, lens, comments = [], editing, builds = null, claims = [], review = null, box = null, onNextReview = null, onBuild = null, onBuildPrompt = null, commenting = false, commentControl = null, back = null, proof = NO_PROOF, lit = null, onDirections = () => {}, onPick, onFly, onAdd, onPatch, onDelete, onClose, onCopyLink, onDocFocus }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const docRef = useRef(null);
  const rootRef = useRef(null);
  // Opened from the Review list (#62 REVIEW-03): at its proposed changes, once they've rendered.
  const fromReview = Boolean(review);
  useEffect(() => {
    if (!fromReview) return undefined;
    let tries = 0, frame = 0;
    const look = () => {
      const at = rootRef.current?.querySelector('.next-review');
      if (at) return at.scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (++tries < 60) frame = requestAnimationFrame(look);
    };
    look();
    return () => cancelAnimationFrame(frame);
  }, [fromReview, node.id]);
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
  // Your own change to it, as an agent sees it (#13 ADOPT-21): with an agent until one marks it ready.
  const yourEdit = editing.changeset?.items?.find((it) => it.key === key && !it.new);
  const yourTurn = yourEdit ? turnOf(editing.changeset, yourEdit) : null;
  const madeIn = theirs ? editing.others.find((cs) => cs.id === node.refinement && cs.items.some((it) => it.key === key && it.new)) : null;
  // The item's open questions as the map has them, each answered directly under itself in the text (#68 ANSWER-01).
  const questions = useMemo(() => (editable ? questionsIn(key, editableOf(node).markdown) : []), [editable, key, node.body]); // eslint-disable-line react-hooks/exhaustive-deps
  // Every behaviour already written, drafts included, so a new behaviour's ID never collides.
  const texts = useMemo(() => (editable ? tree.list.map((n) => editing.drafts.get(itemKeyOf(n))?.markdown ?? n.body ?? '') : []), [editable, tree, editing.drafts]);
  const readOnly = (
    <>
      <h2 className="node-title">{node.title}</h2>
      {node.body && <Markdown text={shaped(node.body)} />}
    </>
  );

  return (
    <div className="details" ref={rootRef}>
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
        {issue && <span className="issue-number">#{issue.number}</span>}
        {node.priority && <span className="tag tag-strong">{node.priority}</span>}
        {/* Each fact once (EDIT-21): a new item is just new; a leaf's health only says more than its status when it is off track or at risk. */}
        {!node.refinement && (
          <span className="status-text">
            <StatusDot status={node.status} /> {STATUS_LABEL[node.status]}
          </span>
        )}
        {s.broken > 0 && (
          <span className="pill pill-broken" title="Done, but the proof of some of its behaviours now fails: they are work again (#21)">
            {s.broken} broken
          </span>
        )}
        {!node.refinement && saysMore(node, s.health) && <HealthPill health={s.health} />}
        {s.overdue && <span className="pill pill-outline">Overdue</span>}
        {/* Always as a number, with its reason (HANDOFF-12, FOG-06), so people learn what the build line looks like. */}
        {!isRoot && (
          <span className={`pill ${s.fog > 0.005 ? 'pill-fog' : 'pill-fog-level'}`} title={`How foggy it is, as the Fog lens shows it. Build is offered under ${BUILD_FOG}%.`}>
            {buildOffer(node, builds).fog}% fog{s.fog > 0.005 ? `: ${fogReason(node)}` : ''}
          </span>
        )}
        {node.refinement && (
          <span className="pill pill-new" title={theirs ? 'New in someone else’s refinement: adopt or decline it below.' : 'New in your refinement: Accept adopts it, Discard drops it.'}>
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

      <SplitBar node={node} editing={editing} onPick={onPick} />
      <BuildBar node={node} atBehaviour={atBehaviour} builds={builds} claims={claims} onBuild={onBuild} onBuildPrompt={onBuildPrompt} />
      <WasteBar node={node} tree={tree} editing={editing} />

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

      {review && <NextReview node={node} review={review} onNext={onNextReview} />}
      {madeIn && <NewItemReview key={madeIn.id} cs={madeIn} node={node} editing={editing} />}
      {proposals.map(({ cs, item }) => (
        <Refinement key={cs.id} cs={cs} item={item} node={node} editing={editing} comments={comments.filter((c) => c.itemKey === key)} />
      ))}
      {yourTurn && (
        <p className="turn-note your-turn" role="status">
          <Icon name="comment" size={16} /> <strong>{yourTurn === 'agent' ? 'Your change is with an agent · waiting' : 'An agent answered your change · not ready yet'}</strong>
          <span className="empty-note"> Keep editing: each edit goes back to it.</span>
        </p>
      )}
      <div className="doc" ref={docRef} onFocusCapture={onDocFocus}>
        {editable ? (
          <Suspense fallback={readOnly}>
            <IssueForm
              key={`${key}:${editing.generation}`}
              value={editing.drafts.get(key) ?? editableOf(node)}
              issueNumber={issue?.number}
              areaTexts={texts}
              comments={comments.filter((c) => c.itemKey === key && c.anchor?.on !== 'changeset' && !c.anchor?.photo && !(c.anchor?.refinement && reviewing.has(c.anchor.refinement)))}
              questions={questions}
              commenting={commenting}
              placeholderTitle={Boolean(node.refinement) && !theirs ? `New ${node.kind}` : null}
              conflict={editing.conflicts.has(key)}
              onChange={(after) => editing.change(key, after)}
              onComment={(anchor, text, extra) => editing.comment(key, anchor, text, extra)}
              onAnswer={(q, text, prompt) => editing.answer(key, q, text, prompt)}
              onAnswerPrompt={(q, text) => editing.answerPrompt(key, q, text)}
              onPromote={editing.promote}
              onDismiss={editing.dismiss}
              onRestore={editing.restore}
              hasRead={editing.hasRead}
              onRead={editing.markRead}
            />
          </Suspense>
        ) : (
          readOnly
        )}
      </div>
      <EditBar editing={editing} box={box} comments={comments} onPick={onPick} />

      <ProofSection node={node} atBehaviour={atBehaviour} proof={proof} />
      <FileProof node={node} tree={tree} proof={proof} lit={lit} onPick={onPick} onDirections={onDirections} />
      {editing.projectId && <Photos itemKey={key} comments={comments.filter((c) => c.itemKey === key)} editing={editing} />}

      <section>
        <h3>Properties</h3>
        <Properties node={node} tree={tree} onPatch={onPatch} />
      </section>

      {node.summary && <p className="summary">{node.summary}</p>}

      <div className="progress" aria-label={`Progress ${pct(s.progress)}`}>
        <div className="progress-bar">
          <span style={{ width: pct(s.progress) }} />
        </div>
        <span>{s.measured && s.adopted ? provenSummary(s) : `${pct(s.progress)} done`}</span>
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
          <dt>In the Fog</dt>
          <dd>{s.poorlyDefined}</dd>
        </div>
        <div className={s.blocked ? 'warn' : ''}>
          <dt>Blocked</dt>
          <dd>{s.blocked}</dd>
        </div>
        <div>
          <dt>Fog</dt>
          <dd title={fogReason(node)}>{pct(s.fog)}</dd>
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

/**
 * Reviewing one item from the Review list (#62 REVIEW-03): how many more are waiting, and once this one is decided it
 * has left the list and the next one is offered.
 */
function NextReview({ node, review, onNext }) {
  const { here, more, next } = reviewingAt(review, node.id);
  return (
    <div className={`next-review${here ? '' : ' decided'}`} role="status">
      <span>{here ? `Reviewing · ${more ? `${more} more waiting` : 'the last one waiting'}` : 'Decided.'}</span>
      {next ? (
        <button type="button" className="link-btn" onClick={() => onNext(next)}>
          Next: {titleWithNumber(next.node)} <Icon name="right" size={14} />
        </button>
      ) : (
        !here && <span>Nothing else is waiting for review.</span>
      )}
    </div>
  );
}

/**
 * Everything waiting on someone (#62 REVIEW-02), the longest waiting first: proposed changes by issue, who proposed them
 * and how long ago, which behaviours are new or changed and which are marked ready, with the questions waiting to be
 * answered or written in. The Review lens lists the same (REVIEW-05).
 */
export function ReviewList({ review, onPick, onClose }) {
  const now = Date.now();
  const ago = (since) => {
    const w = waitedFor(since, now);
    return w && (w === 'just now' ? w : `${w} ago`);
  };
  return (
    <div className="details review-list">
      <header className="panel-head">
        <div>
          <div className="eyebrow">
            <Icon name="edit" size={14} /> Review
          </div>
          <h2 className="node-title">{review.length ? `${review.length} waiting for review` : 'Nothing waiting for review'}</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close review">
          <Icon name="close" />
        </button>
      </header>
      <p className="summary">Proposed changes to adopt or decline, and questions waiting on someone, the longest waiting first.</p>
      <ul className="rows">
        {review.map((e) => (
          <li key={e.key}>
            <button className="row review-row" onClick={() => onPick(e)}>
              <StatusDot status={e.node.status} />
              <span className="row-main">
                <span className="row-title">{titleWithNumber(e.node)}</span>
                <span className="row-sub">{[e.by.length ? `by ${e.by.join(', ')}` : '', ago(e.since)].filter(Boolean).join(' · ')}</span>
                <span className="row-sub review-what">{waitingWords(e)}</span>
                {e.ready.length > 0 && <span className="row-sub review-ready">Ready for adoption: {e.ready.join(', ')}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!review.length && <p className="empty-note">Proposed changes and questions waiting on someone show here as soon as they're made.</p>}
    </div>
  );
}
