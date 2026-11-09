import { useId, useMemo, useRef, useState } from 'react';
import {
  SECTIONS,
  behaviourPrefix,
  blankBehaviour,
  contentOf,
  hasOpenQuestions,
  hintOf,
  isGwt,
  nextBehaviourId,
  parseBehaviours,
  parseIssue,
  writeBehaviours,
  writeIssue,
} from '@shared/issue-shape.js';
import { RichField } from './RichField.jsx';
import { Icon } from '../components/Icon.jsx';

const HINTS = {
  Why: 'The problem, for whom, and why now.',
  Acceptance: 'How everyone will know it is done.',
  'Out of scope': 'What this deliberately leaves out.',
  'Open questions': 'While anything is listed here, the issue needs a decision before work starts.',
};

const anchorKey = (a) => (a.behaviour ? `b:${a.behaviour}` : `s:${a.section}`);

/** A comment thread anchored to one section or behaviour, opened from its speech bubble. */
function Thread({ comments, onPost, onResolve }) {
  const [text, setText] = useState('');
  const post = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    onPost(text.trim());
    setText('');
  };
  return (
    <div className="thread">
      {comments.map((c) => (
        <div key={c.id} className={`comment${c.resolved ? ' resolved' : ''}`}>
          <div className="comment-head">
            <strong>{c.author}</strong>
            <time dateTime={c.createdAt}>{new Date(c.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
            <button type="button" className="link-btn" onClick={() => onResolve(c, !c.resolved)}>
              {c.resolved ? 'Reopen' : 'Resolve'}
            </button>
          </div>
          <p>{c.text}</p>
        </div>
      ))}
      <form className="comment-form" onSubmit={post}>
        <textarea aria-label="Write a comment" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Comment on this…" maxLength={4000} />
        <button type="submit" disabled={!text.trim()}>
          Comment
        </button>
      </form>
    </div>
  );
}

function CommentButton({ count, open, onClick, label }) {
  return (
    <button type="button" className={`comment-btn${count ? ' has' : ''}${open ? ' on' : ''}`} aria-expanded={open} aria-label={`${label}: ${count || 'no'} comments`} onClick={onClick}>
      <Icon name="comment" size={15} />
      {count > 0 && <span>{count}</span>}
    </button>
  );
}

/**
 * One item in the strict shape. `value` is { title, markdown }, and `onChange` gets the same,
 * with untouched sections and behaviours written back exactly as they came.
 */
export function IssueForm({ value, issueNumber, areaTexts, comments, onChange, onComment, onResolve, conflict }) {
  // Parsed once: everything is written back relative to the text as it was when the form opened.
  const shape = useMemo(() => parseIssue(value.markdown), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [title, setTitle] = useState(value.title);
  const [head, setHead] = useState(shape.head.trim());
  const [texts, setTexts] = useState(() => Object.fromEntries(shape.sections.map((s) => [s.name, contentOf(s.raw)])));
  const [rows, setRows] = useState(() => parseBehaviours(shape.sections.find((s) => s.name === 'Behaviours')?.raw ?? ''));
  const touched = useRef(new Set());
  const [thread, setThread] = useState(null);
  const ids = { title: useId(), head: useId(), section: useId() };

  const names = [...SECTIONS, ...shape.sections.map((s) => s.name).filter((n) => !SECTIONS.includes(n))];
  const prefix = behaviourPrefix(rows, value.title);

  function emit(next) {
    const t = next.title ?? title;
    const h = next.head ?? head;
    const all = { ...texts, ...next.texts };
    const edits = Object.fromEntries([...touched.current].filter((n) => n !== 'Behaviours').map((n) => [n, all[n] ?? '']));
    if (touched.current.has('Behaviours')) edits.Behaviours = writeBehaviours(next.rows ?? rows);
    const headed = h === shape.head.trim() ? shape : { ...shape, head: h ? `${h}\n\n` : '' };
    onChange({ title: t, markdown: writeIssue(headed, edits) });
  }

  const setSection = (name) => (md) => {
    touched.current.add(name);
    setTexts((prev) => ({ ...prev, [name]: md }));
    emit({ texts: { [name]: md } });
  };
  const editRows = (fn) => {
    touched.current.add('Behaviours');
    const next = fn(rows);
    setRows(next);
    emit({ rows: next });
  };
  const setRow = (key, field) => (e) => editRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: e.target.value, dirty: true } : r)));
  const addRow = () => editRows((rs) => [...rs, blankBehaviour(nextBehaviourId(prefix, [...areaTexts, rs.map((r) => r.id).join(' ')]))]);

  const byAnchor = useMemo(() => {
    const m = new Map();
    for (const c of comments) {
      const k = anchorKey(c.anchor);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(c);
    }
    return m;
  }, [comments]);
  const toggle = (anchor) => setThread((t) => (t === anchorKey(anchor) ? null : anchorKey(anchor)));
  const threadFor = (anchor) =>
    thread === anchorKey(anchor) && <Thread comments={byAnchor.get(anchorKey(anchor)) ?? []} onPost={(text) => onComment(anchor, text)} onResolve={onResolve} />;
  const unresolved = (anchor) => (byAnchor.get(anchorKey(anchor)) ?? []).filter((c) => !c.resolved).length;

  return (
    <div className="issue-form">
      {conflict && (
        <p className="conflict" role="alert">
          This changed on GitHub after you started editing it. Your version is kept here; compare it with the source before accepting.
        </p>
      )}
      <div className="field wide">
        <label htmlFor={ids.title}>{issueNumber ? `Title of #${issueNumber}` : 'Title'}</label>
        <input
          id={ids.title}
          className="title-input"
          value={title}
          maxLength={190}
          onChange={(e) => {
            setTitle(e.target.value);
            emit({ title: e.target.value });
          }}
        />
      </div>
      <div className="field wide">
        <label htmlFor={ids.head}>Part of, kind and place</label>
        <textarea
          id={ids.head}
          className="head-input"
          rows={2}
          value={head}
          placeholder={'Part of #1\nKind: Feature · Place: …'}
          onChange={(e) => {
            setHead(e.target.value);
            emit({ head: e.target.value });
          }}
        />
      </div>

      {names.map((name) => {
        const anchor = { section: name };
        const raw = shape.sections.find((s) => s.name === name)?.raw ?? '';
        const labelId = `${ids.section}-${name.replace(/\W/g, '')}`;
        const asking = name === 'Open questions' && hasOpenQuestions(texts[name] ?? '');
        return (
          <section key={name} className={`shape-section${asking ? ' asking' : ''}`}>
            <div className="section-head">
              <h4 id={labelId}>{name}</h4>
              {asking && <span className="pill pill-question">? Needs a decision</span>}
              {!SECTIONS.includes(name) && <span className="tag">Not in the shape</span>}
              <CommentButton label={name} count={unresolved(anchor)} open={thread === anchorKey(anchor)} onClick={() => toggle(anchor)} />
            </div>
            {threadFor(anchor)}
            {name === 'Behaviours' ? (
              <Behaviours rows={rows} setRow={setRow} editRows={editRows} addRow={addRow} prefix={prefix} thread={thread} toggle={toggle} threadFor={threadFor} unresolved={unresolved} />
            ) : (
              <RichField labelId={labelId} value={texts[name] ?? ''} onChange={setSection(name)} placeholder={hintOf(raw) || HINTS[name]} />
            )}
          </section>
        );
      })}
    </div>
  );
}

function Behaviours({ rows, setRow, editRows, addRow, prefix, thread, toggle, threadFor, unresolved }) {
  return (
    <div className="behaviours">
      {rows.map((r) => {
        // A comment needs an ID to hold on to: that is what lets it follow the behaviour around.
        const anchor = r.id ? { behaviour: r.id } : null;
        return (
          <div key={r.key} className="behaviour">
            <div className="behaviour-head">
              <input aria-label="Behaviour ID" className="behaviour-id" value={r.id} onChange={setRow(r.key, 'id')} placeholder={`${prefix}-01`} maxLength={30} />
              <span className="spacer" />
              {anchor && <CommentButton label={r.id} count={unresolved(anchor)} open={thread === anchorKey(anchor)} onClick={() => toggle(anchor)} />}
              <button type="button" className="icon-btn small" aria-label={`Remove ${r.id || 'behaviour'}`} onClick={() => editRows((rs) => rs.filter((x) => x.key !== r.key))}>
                <Icon name="close" size={16} />
              </button>
            </div>
            {anchor && threadFor(anchor)}
            {isGwt(r) ? (
              ['given', 'when', 'then'].map((f) => (
                <label key={f} className="gwt">
                  <span>{f[0].toUpperCase() + f.slice(1)}</span>
                  <textarea rows={1} value={r[f]} onChange={setRow(r.key, f)} placeholder={{ given: 'a situation', when: 'something happens', then: 'what must be true' }[f]} />
                </label>
              ))
            ) : (
              <textarea aria-label={`${r.id || 'Behaviour'} text`} rows={2} value={r.text} onChange={setRow(r.key, 'text')} />
            )}
          </div>
        );
      })}
      <button type="button" className="add-behaviour" onClick={addRow}>
        <Icon name="plus" size={16} /> Add behaviour
      </button>
    </div>
  );
}
