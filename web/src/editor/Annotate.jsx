// The comment box and the thread (#15): the same in the editor and on the map. The box is headed by where the
// annotation goes and quotes what was picked (NOTE-10), offers the fixed kinds (NOTE-01) and a Change's value
// (NOTE-02), and posts with ⌘/Ctrl+Enter (NOTE-12). Everything said is written and shown like the document (EDIT-15).

import { Suspense, lazy, useState } from 'react';
import { NOTE_KINDS, NOTE_KIND_HINT, NOTE_KIND_LABEL, answers, initials, isColour, kindOf } from '@shared/annotations.js';
import { Icon } from '../components/Icon.jsx';
import { commentHtml } from './comment-text.js';
import { useLinks } from '../components/links-context.js';

const TextBox = lazy(() => import('./TextBox.jsx'));

const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const posts = (e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey);

/** A box to write in, formatted like the document; a plain one does the same job while the editor loads. */
function Box({ value, onChange, onSubmit, label, placeholder, autoFocus, className }) {
  const plain = (
    <textarea
      autoFocus={autoFocus}
      aria-label={label}
      rows={2}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => posts(e) && (e.preventDefault(), onSubmit())}
      placeholder={placeholder}
      maxLength={4000}
    />
  );
  return (
    <Suspense fallback={plain}>
      <TextBox value={value} onChange={onChange} onSubmit={onSubmit} label={label} placeholder={placeholder} autoFocus={autoFocus} className={className} />
    </Suspense>
  );
}

/** What was said, as the markdown it was written in, mentions standing out (NOTE-14). */
function SaidText({ text }) {
  const { repo } = useLinks();
  return <div className="comment-text" dangerouslySetInnerHTML={{ __html: commentHtml(text, repo) }} />;
}

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
      <Box
        autoFocus
        label="Write a comment"
        value={text}
        onChange={setText}
        onSubmit={post}
        placeholder={`${kind === 'question' ? 'Ask…' : kind === 'change' ? 'What to change… e.g. Make this blue' : kind === 'refactor' ? 'What to refactor, and to what…' : 'Comment…'} @Claude hands it to an agent`}
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

/** What cleared an annotation, for the conversation log (NOTE-05): the task made from it, the refinement adopted, or reading it. */
export function clearedWords(c) {
  const x = c.cleared;
  if (!c.resolved) return 'Read'; // a plain Comment, cleared for this person once they read it
  if (x?.task) return `Made a task by ${x.by}: ${x.task.title}`;
  if (x?.refinement) return `Acted on in refinement ${x.refinement}, adopted ${when(x.at)}`;
  return 'Cleared';
}

/** Where an annotation addressed to an agent has got to (NOTE-17), and its answer (ANSWER-01). */
function Status({ c }) {
  if (c.resolved) return <p className="note-status done">{clearedWords(c)}.</p>;
  const lines = [];
  if (c.answer) lines.push(<p key="answer" className="note-status">{c.answer.by}’s answer is with an agent to apply.</p>);
  const d = c.delivery;
  if (d?.state === 'waiting') lines.push(<p key="d" className="note-status">Sent to {d.for === 'any agent' ? 'Claude' : d.for}. No agent is connected: it is the first thing the next one to call gets.</p>);
  else if (d?.state === 'delivered') lines.push(<p key="d" className="note-status live">With {d.to} since {when(d.at)}. Its reply comes here.</p>);
  else if (d) lines.push(<p key="d" className="note-status done">{d.by} replied.</p>);
  return lines;
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
      <SaidText text={c.text} />
      {c.refinement && <p className="note-status">Proposed in refinement {c.refinement}, waiting for adoption on this item.</p>}
    </div>
  );
}

/**
 * One annotation's thread (NOTE-11): the annotation, its replies, and a reply box. Nobody resolves it: it clears once it
 * is acted on (NOTE-05). A person's reply to a question is its answer (ANSWER-01), and they can read and change the
 * prompt it goes out with before posting it (ANSWER-05). The prompt is built by the server, so it is the one an agent
 * gets; left as built, it is built again when it goes.
 */
export function Thread({ heading, quote, what, src, moved, thread, you, onReply, onPromote, onAnswerPrompt, onClose }) {
  const { root, replies } = thread;
  const [text, setText] = useState('');
  const [prompt, setPrompt] = useState(null);
  const [built, setBuilt] = useState(null);
  const [busy, setBusy] = useState(false);
  const kind = kindOf(root);
  const answering = answers(root, you || 'Someone') && Boolean(onAnswerPrompt);
  const showPrompt = async () => {
    setBusy(true);
    try {
      const p = await onAnswerPrompt(root, text.trim());
      setBuilt(p);
      setPrompt(p);
    } catch {
      // The editor's toast says what went wrong.
    } finally {
      setBusy(false);
    }
  };
  const reply = async (e) => {
    e?.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    const changed = answering && prompt != null && prompt !== built ? prompt : undefined;
    if (await onReply(text.trim(), changed)) {
      setText('');
      setPrompt(null);
      setBuilt(null);
    }
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
          {!root.resolved && onPromote && ['problem', 'refactor'].includes(kind) && (
            <button type="button" className="link-btn" onClick={() => onPromote(root)}>
              Make it a task
            </button>
          )}
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
      {replies.map((c) => (
        <Said key={c.id} c={c} />
      ))}
      <form className="comment-form" onSubmit={reply}>
        <Box
          className="reply"
          label={answering ? 'Answer' : 'Reply'}
          value={text}
          onChange={setText}
          onSubmit={reply}
          placeholder={answering ? 'Answer… goes to an agent to apply (⌘/Ctrl+Enter posts)' : 'Reply… (⌘/Ctrl+Enter posts)'}
        />
        <button type="submit" disabled={!text.trim() || busy}>
          Reply
        </button>
      </form>
      {answering && (
        <div className="answer-prompt">
          {prompt != null && (
            <label>
              <span>The prompt an agent gets. Change it if you like.</span>
              <textarea aria-label="The prompt an agent gets" rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={40000} />
            </label>
          )}
          <button type="button" className="link-btn" disabled={!text.trim() || busy} onClick={showPrompt}>
            {prompt == null ? 'See the prompt' : 'Build it again'}
          </button>
        </div>
      )}
    </div>
  );
}
