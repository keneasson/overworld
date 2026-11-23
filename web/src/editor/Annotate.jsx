// The comment box and the thread (#15): the same in the editor and on the map. The box is headed by where the
// comment goes and quotes what was picked (NOTE-10); a comment is just a comment, with no kinds (NOTE-01). It posts
// with ⌘/Ctrl+Enter (NOTE-12). Everything said is written and shown like the document (EDIT-15).

import { Suspense, createContext, lazy, useContext, useState } from 'react';
import { initials, isDismissed } from '@shared/annotations.js';
import { Icon } from '../components/Icon.jsx';
import { commentHtml } from './comment-text.js';
import { useLinks } from '../components/links-context.js';

// Who is commenting (#15 NOTE-21): the name saved in this browser, and how to save one. With none saved, the box asks for it
// before posting, so no comment shows as "Someone". Sign-in replaces this (#52 AUTH-07).
export const YouContext = createContext({ you: '', setYou: null });

function useAskName() {
  const { you, setYou } = useContext(YouContext);
  const [who, setWho] = useState('');
  const asking = !you?.trim() && Boolean(setYou);
  const field = asking ? (
    <input className="your-name" aria-label="Your name" placeholder="Your name, shown on what you write" value={who} onChange={(e) => setWho(e.target.value)} maxLength={80} />
  ) : null;
  return {
    named: !asking || Boolean(who.trim()),
    field,
    // Saved before the post goes out, so the post carries it.
    save: () => asking && setYou(who.trim()),
  };
}

// A copy of the app on an older version may find the formatted box gone after a deploy: the plain box does the same job,
// and the app offers Update (#71 SHIP-13).
const TextBox = lazy(() =>
  import('./TextBox.jsx').catch(() => {
    window.dispatchEvent(new Event('projectmap:stale'));
    return { default: PlainBox };
  }),
);

const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
/** ⌘/Ctrl+Enter posts what is written (NOTE-12); the formatted box's Mod-Enter is the same key. */
export const posts = (e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey);

/** A plain box to write in: while the formatted one loads, or instead of it. */
function PlainBox({ value, onChange, onSubmit, label, placeholder, autoFocus }) {
  return (
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
}

/** A box to write in, formatted like the document; a plain one does the same job while the editor loads. */
function Box({ value, onChange, onSubmit, label, placeholder, autoFocus, className }) {
  const plain = <PlainBox value={value} onChange={onChange} onSubmit={onSubmit} label={label} placeholder={placeholder} autoFocus={autoFocus} />;
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

/** A new comment: just its words. Posting leaves the Comment control on (NOTE-16). */
export function Composer({ heading, quote, what, src, onPost, onCancel }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const name = useAskName();
  const ready = Boolean(text.trim()) && !busy && name.named;
  const post = async (e) => {
    e?.preventDefault();
    if (!ready) return;
    name.save();
    setBusy(true);
    const ok = await onPost(text.trim());
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
      <Box
        autoFocus
        label="Write a comment"
        value={text}
        onChange={setText}
        onSubmit={post}
        placeholder="Comment… @Claude hands it to an agent"
      />
      {name.field}
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

/** Who dismissed a thread into the conversation log, and why (NOTE-05): a task made from it says which. */
export function dismissedWords(c) {
  const d = c.dismissed ?? {};
  if (d.task) return `Made a task by ${d.by}: ${d.task.title}`;
  return `Dismissed by ${d.by ?? 'someone'}${d.at ? `, ${when(d.at)}` : ''}${d.note ? `: ${d.note}` : ''}`;
}

/** Where an annotation addressed to an agent has got to (NOTE-17). */
function Status({ c }) {
  const lines = [];
  if (isDismissed(c)) lines.push(<p key="x" className="note-status done">{dismissedWords(c)}.</p>);
  const d = c.delivery;
  if (d?.state === 'waiting') lines.push(<p key="d" className="note-status">Sent to {d.for === 'any agent' ? 'Claude' : d.for}. No agent is connected: it is the first thing the next one to call gets.</p>);
  else if (d?.state === 'delivered') lines.push(<p key="d" className="note-status live">With {d.to} since {when(d.at)}. Its reply comes here.</p>);
  else if (d) lines.push(<p key="d" className="note-status done">{d.by} replied.</p>);
  return lines;
}

function Said({ c, children }) {
  return (
    <div className="comment">
      <div className="comment-head">
        <span className="note-initials" aria-hidden="true">
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
 * One comment's thread (NOTE-11): the comment, its replies, and a reply box. Nothing clears it: it stays until someone
 * dismisses it, quietly, after the replies (NOTE-05), or makes it a task (NOTE-06). A reply is a reply, wherever the
 * comment is anchored: a comment is never an open question (NOTE-22).
 */
export function Thread({ heading, quote, what, src, moved, thread, onReply, onPromote, onDismiss, onClose }) {
  const { root, replies } = thread;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const name = useAskName();
  const reply = async (e) => {
    e?.preventDefault();
    if (!text.trim() || busy || !name.named) return;
    name.save();
    setBusy(true);
    if (await onReply(text.trim())) setText('');
    setBusy(false);
  };
  return (
    <div
      className="thread"
      role="dialog"
      aria-label={`Comment on ${heading}`}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="thread-head">
        <span className="thread-label">Comment</span>
        <span className="thread-actions">
          {!isDismissed(root) && onPromote && (
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
      <Said c={root} />
      <Status c={root} />
      {replies.map((c) => (
        <Said key={c.id} c={c} />
      ))}
      {!isDismissed(root) && onDismiss && (
        <button type="button" className="link-btn note-dismiss" onClick={() => onDismiss(root)} title="Move it to the conversation log, still readable there">
          Dismiss
        </button>
      )}
      <form className="comment-form" onSubmit={reply}>
        <Box className="reply" label="Reply" value={text} onChange={setText} onSubmit={reply} placeholder="Reply… (⌘/Ctrl+Enter posts)" />
        {name.field}
        <button type="submit" disabled={!text.trim() || busy || !name.named}>
          Reply
        </button>
      </form>
    </div>
  );
}

/**
 * Answering one open question (ANSWER-01): the answer is written directly under it as "Answer: …", and goes to an agent
 * with one prompt the person can read and change first (ANSWER-05). The prompt is built by the server, so it is the one an
 * agent gets; left as built, it is built again when it goes. `onAnswer(text, prompt)` is true once it is written.
 */
export function AnswerBox({ question, onPrompt, onAnswer, onCancel }) {
  const [text, setText] = useState(question.answer ?? '');
  const [prompt, setPrompt] = useState(null);
  const [built, setBuilt] = useState(null);
  const [busy, setBusy] = useState(false);
  const showPrompt = async () => {
    setBusy(true);
    try {
      const p = await onPrompt(text.trim());
      setBuilt(p);
      setPrompt(p);
    } catch {
      // The editor's toast says what went wrong.
    } finally {
      setBusy(false);
    }
  };
  const answer = async (e) => {
    e?.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onAnswer(text.trim(), prompt != null && prompt !== built ? prompt : undefined);
    setBusy(false);
    if (ok) onCancel();
  };
  return (
    <form
      className="thread composer answer-box"
      aria-label={`Answer: ${question.text}`}
      onSubmit={answer}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onCancel();
      }}
    >
      <Box autoFocus label="Answer" value={text} onChange={setText} onSubmit={answer} placeholder="Answer… written under the question, and an agent applies it (⌘/Ctrl+Enter)" />
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
      <div className="answer-actions">
        <span className="note-keys">⌘/Ctrl+Enter</span>
        <button type="button" className="link-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={!text.trim() || busy} aria-disabled={!text.trim() || busy}>
          Answer
        </button>
      </div>
    </form>
  );
}
