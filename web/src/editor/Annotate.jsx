// The comment box and the thread (#15): the same in the editor and on the map. The box is headed by where the
// annotation goes and quotes what was picked (NOTE-10), offers the fixed kinds (NOTE-01) and a Change's value
// (NOTE-02), and posts with ⌘/Ctrl+Enter (NOTE-12).

import { useState } from 'react';
import { NOTE_KINDS, NOTE_KIND_HINT, NOTE_KIND_LABEL, initials, isColour, isQuestion, kindOf } from '@shared/annotations.js';
import { Icon } from '../components/Icon.jsx';

const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const posts = (e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey);

/** What the annotation is about: where, then the words, the image, or what kind of thing it is. */
function About({ heading, quote, what, src }) {
  return (
    <div className="note-about">
      <strong>{heading}</strong>
      {src && <img className="note-thumb" src={src} alt="" />}
      {quote ? <blockquote>{quote.length > 280 ? `${quote.slice(0, 280)}…` : quote}</blockquote> : what && <span className="note-what">{what}</span>}
    </div>
  );
}

function Value({ value }) {
  if (!value) return null;
  return (
    <span className="note-value">
      {isColour(value) && <span className="swatch-dot" style={{ background: value }} />}
      <code>{value}</code>
    </span>
  );
}

/** A new annotation: its kind, its words and, for a Change, its value. Posting leaves the Comment control on (NOTE-16). */
export function Composer({ heading, quote, what, src, onPost, onCancel }) {
  const [kind, setKind] = useState('comment');
  const [text, setText] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = Boolean(text.trim()) && !busy;
  const post = async (e) => {
    e?.preventDefault();
    if (!ready) return;
    setBusy(true);
    const ok = await onPost(text.trim(), { kind, ...(kind === 'change' && value.trim() ? { value: value.trim() } : {}) });
    setBusy(false);
    if (ok) onCancel();
  };
  return (
    <form
      className="thread composer"
      role="dialog"
      aria-label={`Comment on ${heading}`}
      onSubmit={post}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onCancel();
      }}
    >
      <About heading={heading} quote={quote} what={what} src={src} />
      <div className="note-kinds" role="radiogroup" aria-label="Kind">
        {NOTE_KINDS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={`note-kind kind-${k}${kind === k ? ' on' : ''}`} title={NOTE_KIND_HINT[k]} onClick={() => setKind(k)}>
            {NOTE_KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <textarea
        autoFocus
        aria-label="Write a comment"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => posts(e) && post(e)}
        placeholder={`${kind === 'question' ? 'Ask…' : kind === 'change' ? 'What to change… e.g. Make this blue' : kind === 'refactor' ? 'What to refactor, and to what…' : 'Comment…'} @Claude hands it to an agent`}
        maxLength={4000}
      />
      {kind === 'change' && (
        <label className="note-value-field">
          <span>Value</span>
          {isColour(value) && <span className="swatch-dot" style={{ background: value.trim() }} />}
          <input aria-label="The value to apply" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => posts(e) && post(e)} placeholder="#EEAA18, a label’s text, a size" maxLength={200} />
        </label>
      )}
      <div className="answer-actions">
        <span className="note-keys">⌘/Ctrl+Enter</span>
        <button type="button" className="link-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={!ready} aria-disabled={!ready}>
          Comment
        </button>
      </div>
    </form>
  );
}

/**
 * Writing an answer under a question (ANSWER-01), and the prompt it goes out with, to read and change first (ANSWER-05).
 * The prompt is built by the server, so it is the one an agent gets; left as built, it is built again when it goes.
 */
function AnswerForm({ question, onAnswer, onPrompt, onCancel }) {
  const [text, setText] = useState(question.answer?.text ?? '');
  const [prompt, setPrompt] = useState(question.answer?.prompt ?? null);
  const [built, setBuilt] = useState(null);
  const [busy, setBusy] = useState(false);
  const showPrompt = async () => {
    setBusy(true);
    try {
      const p = await onPrompt(question, text.trim());
      setBuilt(p);
      setPrompt(p);
    } catch {
      // The editor's toast says what went wrong.
    } finally {
      setBusy(false);
    }
  };
  const send = async (e) => {
    e?.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    const changed = prompt != null && prompt !== built ? prompt : undefined;
    if (await onAnswer(question, text.trim(), changed)) onCancel();
    setBusy(false);
  };
  return (
    <form className="answer-form" onSubmit={send}>
      <textarea
        autoFocus
        aria-label="Write the answer"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => posts(e) && send(e)}
        placeholder="The answer… (⌘/Ctrl+Enter sends)"
        maxLength={4000}
      />
      {prompt != null && (
        <label className="answer-prompt">
          <span>The prompt an agent gets. Change it if you like.</span>
          <textarea aria-label="The prompt an agent gets" rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={40000} />
        </label>
      )}
      <div className="answer-actions">
        <button type="button" className="link-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="link-btn" disabled={!text.trim() || busy} onClick={showPrompt}>
          {prompt == null ? 'See the prompt' : 'Build it again'}
        </button>
        <button type="submit" disabled={!text.trim() || busy}>
          Send answer
        </button>
      </div>
    </form>
  );
}

/** Where an annotation addressed to an agent has got to (NOTE-17), or what became of it. */
function Status({ c }) {
  const o = c.outcome;
  if (o?.state === 'applied') return <p className="note-status done">Applied when refinement {o.refinement} was adopted{o.by ? `, from ${o.by}` : ''}.</p>;
  const d = c.delivery;
  if (!d) return null;
  if (d.state === 'waiting') return <p className="note-status">Sent to {d.for === 'any agent' ? 'Claude' : d.for}. No agent is connected: it is the first thing the next one to call gets.</p>;
  if (d.state === 'delivered') return <p className="note-status live">With {d.to} since {when(d.at)}. Its reply comes here.</p>;
  return <p className="note-status done">{d.by} replied.</p>;
}

/** Mentions stand out in what was said (NOTE-14). */
function Words({ text }) {
  return text.split(/(@[A-Za-z][\w.-]*)/g).map((part, i) => (i % 2 ? <span key={i} className="note-mention">{part}</span> : part));
}

function Said({ c, children }) {
  return (
    <div className={`comment${c.resolved ? ' resolved' : ''}`}>
      <div className="comment-head">
        <span className={`note-initials kind-${kindOf(c)}`} aria-hidden="true">
          {initials(c.author)}
        </span>
        <strong>{c.author}</strong>
        <time dateTime={c.createdAt}>{when(c.createdAt)}</time>
        {children}
      </div>
      <p>
        <Words text={c.text} />
      </p>
      {c.refinement && <p className="note-status">Proposed in refinement {c.refinement}, waiting for adoption on this item.</p>}
    </div>
  );
}

/** One annotation's thread (NOTE-11): the annotation, its replies, and a reply box. */
export function Thread({ heading, quote, what, src, moved, thread, onReply, onResolve, onAnswer, onAnswerPrompt, onClose }) {
  const { root, replies } = thread;
  const [text, setText] = useState('');
  const [answering, setAnswering] = useState(false);
  const [busy, setBusy] = useState(false);
  const kind = kindOf(root);
  const reply = async (e) => {
    e?.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    if (await onReply(text.trim())) setText('');
    setBusy(false);
  };
  return (
    <div
      className="thread"
      role="dialog"
      aria-label={`${NOTE_KIND_LABEL[kind]} on ${heading}`}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="thread-head">
        <span className={`note-kind kind-${kind} on`}>{NOTE_KIND_LABEL[kind]}</span>
        <span className="thread-actions">
          {isQuestion(root) && !root.resolved && onAnswer && !answering && (
            <button type="button" className="link-btn" onClick={() => setAnswering(true)}>
              {root.answer ? 'Change answer' : 'Answer'}
            </button>
          )}
          <button type="button" className="link-btn" onClick={() => onResolve(root, !root.resolved)}>
            {root.resolved ? 'Reopen' : 'Resolve'}
          </button>
          <button type="button" className="icon-btn small" aria-label="Close the thread" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </span>
      </div>
      <About heading={heading} quote={quote} what={what} src={src} />
      {moved && <p className="note-moved">The words this was on have changed since.</p>}
      <Said c={root}>
        <Value value={root.value} />
      </Said>
      <Status c={root} />
      {root.answer && !answering && (
        <div className="answer">
          <div className="comment-head">
            <strong>Answer · {root.answer.by}</strong>
            <span className={`answer-state${root.resolved ? ' applied' : ''}`}>{root.resolved ? (root.answer.appliedAt ? 'Applied' : 'Resolved') : 'Waiting to be applied'}</span>
          </div>
          <p>{root.answer.text}</p>
        </div>
      )}
      {answering && <AnswerForm question={root} onAnswer={onAnswer} onPrompt={onAnswerPrompt} onCancel={() => setAnswering(false)} />}
      {replies.map((c) => (
        <Said key={c.id} c={c} />
      ))}
      <form className="comment-form" onSubmit={reply}>
        <textarea
          aria-label="Reply"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => posts(e) && reply(e)}
          placeholder="Reply… (⌘/Ctrl+Enter posts)"
          maxLength={4000}
        />
        <button type="submit" disabled={!text.trim() || busy}>
          Reply
        </button>
      </form>
    </div>
  );
}
