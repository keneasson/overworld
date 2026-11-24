import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getSchema } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { Markdown } from '@tiptap/markdown';
import { Placeholder } from '@tiptap/extensions';
import { titleShown, titleToSave } from './title.js';
import { behaviourPrefix, parseBehaviours, parseIssue, placeholderId, sectionText } from '@shared/issue-shape.js';
import { initials, isDismissed, threadsOf, whereOf } from '@shared/annotations.js';
import { EXTENSIONS, parseMarkdown } from './rich-text.js';
import { fromDocument, toDocument } from './document.js';
import { IssueShape, hintAt, openWithBodies, refreshNotes, swapIds } from './shape-extension.js';
import { onNumbered } from './useItemEditing.js';
import { describe, rangeOf, rectsOf, selectedTarget, targetAt, widen } from './targets.js';
import { AnswerBox, Composer, Thread, dismissedWords } from './Annotate.jsx';
import { SelectionMenu } from './SelectionMenu.jsx';
import { SectionMenu } from './SectionMenu.jsx';
import { Icon } from '../components/Icon.jsx';
import { useLinks } from '../components/links-context.js';
import { IssueLinks, linkAt } from './issue-links.js';

const TAP = 10; // a touch that moves less than this is a tap, not a scroll

const LABEL = { phrase: 'these words', paragraph: 'this paragraph', image: 'this image' };
const labelOf = (t) => (t.on === 'word' ? `“${t.anchor.quote}”` : t.on === 'behaviour' ? t.anchor.behaviour : t.on === 'section' ? t.anchor.section : LABEL[t.on]);
const below = (rects) => Math.max(0, ...rects.map((r) => r.top + r.height));

/** The outline around what a comment would be on (NOTE-15): a box per line of words, or one around a block. */
function Outline({ rects, picked }) {
  return rects.map((r, i) => <span key={i} className={`note-outline${picked ? ' picked' : ''}`} style={{ left: r.left - 2, top: r.top - 1, width: r.width + 4, height: r.height + 2 }} />);
}

/**
 * One item as one document (EDIT-01): the title, the head, then each section as a heading.
 * `value` is { title, markdown }, and `onChange` gets the same, with unchanged sections written back exactly as they came.
 * With the Comment control on (`commenting`, #15 NOTE-10), the text stops being editable and pointing at it outlines
 * what a comment would be on; a click, or a second tap, opens the comment box there.
 * Each unanswered open question (`questions`, from questionsIn) has its Answer control directly under it in the text (#68
 * ANSWER-01): `onAnswer(question, text, prompt)` writes the answer, `onAnswerPrompt(question, text)` builds its prompt.
 */
export function IssueForm({ value, itemKey = null, issueNumber, areaTexts, comments, questions = [], commenting = false, placeholderTitle = null, onChange, onComment, onAnswer, onAnswerPrompt, onPromote, onDismiss, onRestore, hasRead, onRead, conflict }) {
  // Fixed at open: everything is written back relative to the issue as it was then.
  const original = useMemo(() => value.markdown, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The title that stands in for an empty one (EDIT-22): a new item's placeholder, or the title it opened with.
  const standIn = useMemo(() => placeholderTitle ?? value.title, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [title, setTitle] = useState(() => titleShown(value.title, placeholderTitle));
  const savedTitle = titleToSave(title, standIn);
  const [thread, setThread] = useState(null); // { id, top }
  const [answering, setAnswering] = useState(null); // the question being answered: { id, top }
  const [hover, setHover] = useState(null); // the target outlined, with its rects
  const [picked, setPicked] = useState(null); // the target the comment box is open on
  const [linkChip, setLinkChip] = useState(null); // the link the caret is on, to follow (EDIT-14): { ref, top, left }
  const links = useLinks();
  const wrap = useRef(null);
  const titleRef = useRef(null);
  const opened = useRef(null);
  const live = useRef({});
  live.current = { title: savedTitle, areaTexts, onChange, hover, picked, commenting, links };
  const itemLabel = issueNumber ? `#${issueNumber}` : savedTitle || 'This item';

  // A new behaviour starts with a placeholder, never a number: its first save numbers it (#13 ADOPT-11), so drafts written
  // at the same time by others never clash, and one abandoned uses none. Each placeholder in this document is its own.
  const drafted = useRef(0);
  const nextId = () => {
    const doc = editor.getMarkdown();
    const rows = parseBehaviours(sectionText(parseIssue(doc), 'Behaviours'));
    const id = placeholderId(behaviourPrefix(rows, live.current.title), doc, drafted.current);
    drafted.current = Number(id.split('?')[1]);
    return id;
  };
  const onThread = (id, button) => {
    const box = wrap.current.getBoundingClientRect();
    const at = button.getBoundingClientRect();
    setPicked(null);
    setAnswering(null);
    setThread((t) => (t?.id === id ? null : { id, top: at.bottom - box.top + 4 }));
  };
  const onAnswerControl = (id, button) => {
    const box = wrap.current.getBoundingClientRect();
    const at = button.getBoundingClientRect();
    setPicked(null);
    setThread(null);
    setAnswering((a) => (a?.id === id ? null : { id, top: at.bottom - box.top + 4 }));
  };

  // Empty sections open with a line to type on (EDIT-16).
  const content = useMemo(() => openWithBodies(parseMarkdown(toDocument(original)), getSchema(EXTENSIONS)), [original]);
  const editor = useEditor({
    extensions: [
      ...EXTENSIONS,
      Markdown,
      IssueShape.configure({ nextId: () => nextId(), onThread: (id, b) => onThread(id, b), onAnswer: (id, b) => onAnswerControl(id, b) }),
      IssueLinks.configure({ onFollow: (ref) => !live.current.commenting && live.current.links.follow(ref) }),
      Placeholder.configure({
        showOnlyCurrent: false,
        placeholder: ({ editor: e, node, pos }) => hintAt(e.state.doc, node, pos),
      }),
    ],
    content,
    editorProps: { attributes: { class: 'issue-doc-text', 'aria-label': issueNumber ? `#${issueNumber}` : 'Item text', 'aria-multiline': 'true', role: 'textbox' } },
    onCreate: ({ editor: e }) => {
      opened.current = e.getMarkdown();
    },
    // Changes before the editor has opened are its own setup, not the person's; nor is redrawing the comment markers,
    // which changes no text: without this, an item changed underneath (part of a refinement adopted) got its old text back as a draft.
    onUpdate: ({ editor: e, transaction }) => opened.current != null && transaction.docChanged && live.current.onChange({ title: live.current.title, markdown: fromDocument(original, opened.current, e.getMarkdown()) }),
  });

  // The numbers its save gave new behaviours take their placeholders' places (#13 ADOPT-11).
  useEffect(() => {
    if (!editor || !itemKey) return undefined;
    return onNumbered((key, given) => {
      if (key !== itemKey || editor.isDestroyed) return;
      const tr = swapIds(editor.state, given);
      if (tr) editor.view.dispatch(tr);
    });
  }, [editor, itemKey]);

  // A new item opens with its title box empty and ready, its placeholder shown faintly (EDIT-22).
  useEffect(() => {
    if (!placeholderTitle || !titleRef.current) return;
    titleRef.current.focus({ preventScroll: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The caret on a link (EDIT-14) offers to follow it, just below the link: a tap or a click in the text still edits.
  useEffect(() => {
    if (!editor) return undefined;
    const update = () => {
      const { state, view } = editor;
      const link = !live.current.commenting && editor.isFocused && state.selection.empty ? linkAt(state, state.selection.from) : null;
      const target = link && live.current.links.target(link.ref);
      if (!(target?.node || target?.url || (link && !target && /^https?:/.test(link.ref))) || !wrap.current) return setLinkChip(null);
      const box = wrap.current.getBoundingClientRect();
      const at = view.coordsAtPos(link.at);
      setLinkChip({ ref: link.ref, target, top: at.bottom - box.top + 4, left: Math.max(0, Math.min(at.left - box.left, box.width - 260)) });
    };
    const blur = () => setLinkChip(null);
    editor.on('selectionUpdate', update);
    editor.on('focus', update);
    editor.on('blur', blur);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('focus', update);
      editor.off('blur', blur);
    };
  }, [editor]);
  useEffect(() => {
    if (commenting) setLinkChip(null);
  }, [commenting]);

  // Each annotation is its own thread (NOTE-11), marked at its words (NOTE-13); the open one is highlighted.
  const threads = useMemo(() => threadsOf(comments), [comments]);
  // Only threads not dismissed sit on the text; dismissed ones are in the conversation log (NOTE-05). Each marker shows
  // whether it is unread for this person (NOTE-03); opening a thread reads it, and reading moves nothing.
  const openThreads = useMemo(() => threads.filter((t) => !isDismissed(t.root)), [threads]);
  const unread = (t) => Boolean(hasRead) && !hasRead(t);
  useEffect(() => refreshNotes(editor, openThreads.map((t) => ({ ...t.root, unread: unread(t) })), thread?.id ?? null, onAnswer ? questions : []), [editor, openThreads, thread?.id, hasRead, questions]); // eslint-disable-line react-hooks/exhaustive-deps
  const read = useRef(onRead);
  read.current = onRead;
  const shownThread = thread && openThreads.find((t) => t.root.id === thread.id);
  const lastSaid = shownThread && (shownThread.replies.at(-1) ?? shownThread.root).id;
  useEffect(() => {
    if (shownThread && unread(shownThread)) read.current?.(shownThread);
  }, [thread?.id, lastSaid]); // eslint-disable-line react-hooks/exhaustive-deps

  const withRects = (t) => t && { ...t, rects: rectsOf(editor.view, t, wrap.current.getBoundingClientRect()) };
  const pick = (t) => {
    window.getSelection?.()?.removeAllRanges();
    setHover(null);
    setThread(null);
    setAnswering(null);
    setPicked(withRects(t));
  };

  // The Comment control (NOTE-15): the pointer outlines what it is over; a click picks it, and dragging across words
  // picks exactly those. On a touch screen a tap outlines, and a second tap on the same thing picks it.
  useEffect(() => {
    if (!editor) return undefined;
    // The view mounts after the editor exists (and again under StrictMode), so it is looked up as each event arrives.
    const viewNow = () => {
      try {
        return editor.isDestroyed || !editor.view.dom ? null : editor.view;
      } catch {
        return null;
      }
    };
    const editable = () => !live.current.commenting && viewNow() && (editor.setEditable(true, false), true);
    if (!commenting) {
      editable() || setTimeout(editable);
      setHover(null);
      setPicked(null);
      return undefined;
    }
    const still = () => live.current.commenting && viewNow() && (editor.setEditable(false, false), true);
    still() || setTimeout(still);
    const el = wrap.current;
    const inText = (e) => Boolean(e.target.closest?.('.issue-doc-text'));
    let down = null;
    let touchy = false;
    const busy = () => Boolean(live.current.picked);
    const move = (e) => {
      const view = viewNow();
      if (e.pointerType !== 'mouse' || e.buttons || busy() || !view) return;
      const t = inText(e) ? targetAt(view, e.clientX, e.clientY) : null;
      if (t?.key !== live.current.hover?.key) setHover(withRects(t));
    };
    const leave = (e) => e.pointerType === 'mouse' && !busy() && setHover(null);
    const pointerDown = (e) => {
      if (!inText(e)) return;
      touchy = e.pointerType !== 'mouse';
      down = { x: e.clientX, y: e.clientY, touch: touchy };
    };
    const pointerUp = (e) => {
      const d = down;
      down = null;
      const view = viewNow();
      if (!d || !view || busy() || e.target.closest?.('.note-marker')) return;
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      const words = selectedTarget(view);
      if (!d.touch) {
        if (words) pick(words);
        else if (moved < 5) {
          const t = targetAt(view, e.clientX, e.clientY);
          if (t) pick(t);
        }
        return;
      }
      if (words) return setHover({ ...withRects(words), touch: true });
      if (moved >= TAP) return;
      const t = targetAt(view, e.clientX, e.clientY);
      if (t && t.key === live.current.hover?.key) pick(t);
      else setHover(t && { ...withRects(t), touch: true });
    };
    // A long press selects words on a phone; dragging its handles changes them.
    const selection = () => {
      const view = viewNow();
      if (!touchy || busy() || !view) return;
      const words = selectedTarget(view);
      if (words) setHover({ ...withRects(words), touch: true });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('pointerdown', pointerDown);
    el.addEventListener('pointerup', pointerUp);
    document.addEventListener('selectionchange', selection);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointerdown', pointerDown);
      el.removeEventListener('pointerup', pointerUp);
      document.removeEventListener('selectionchange', selection);
    };
  }, [editor, commenting]); // eslint-disable-line react-hooks/exhaustive-deps

  // The outline follows the text when markers or the panel's width move it.
  useLayoutEffect(() => {
    if (!picked || !editor) return undefined;
    const ro = new ResizeObserver(() => setPicked((p) => p && withRects(p)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [picked?.key, editor]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTitleText = (t) => {
    setTitle(t);
    const markdown = editor && opened.current != null ? fromDocument(original, opened.current, editor.getMarkdown()) : original;
    onChange({ title: titleToSave(t, standIn), markdown });
  };

  const open = thread && openThreads.find((t) => t.root.id === thread.id);
  const answeringQ = answering && questions.find((q) => q.id === answering.id);
  const openAt = open && editor && open.root.anchor?.on !== 'place' ? rangeOf(editor.state.doc, open.root.anchor ?? {}) : null;
  const onMap = openThreads.filter((t) => t.root.anchor?.on === 'place');
  // Dismissed, a thread is in the item's conversation log, still readable there, and can be brought back (NOTE-05).
  const settled = threads.filter((t) => !openThreads.includes(t));
  const about = picked && editor ? describe(editor.view, picked) : null;
  const wider = hover?.touch && editor ? widen(editor.view, hover) : null;

  return (
    <div className={`issue-doc${commenting ? ' commenting' : ''}`} ref={wrap}>
      {conflict && (
        <p className="conflict" role="alert">
          This changed on GitHub after you started editing it. Your version is kept here; compare it with the source before accepting.
        </p>
      )}
      <textarea
        ref={titleRef}
        className="issue-doc-title"
        aria-label={issueNumber ? `Title of #${issueNumber}` : 'Title'}
        rows={1}
        maxLength={190}
        value={title}
        placeholder={standIn}
        readOnly={commenting}
        onBlur={() => !placeholderTitle && !title.trim() && setTitle(standIn)}
        onChange={(e) => setTitleText(e.target.value.replace(/\n/g, ' '))}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          editor?.commands.focus('start');
        }}
      />
      {onMap.length > 0 && (
        <div className="note-row">
          <span>On the map</span>
          {onMap.map((t) => (
            <button
              key={t.root.id}
              type="button"
              className={`note-marker${unread(t) ? ' unread' : ' read'}`}
              aria-label={`${unread(t) ? 'Unread: ' : ''}${t.root.author} on the map: ${t.root.text.slice(0, 80)}`}
              onClick={(e) => onThread(t.root.id, e.currentTarget)}
            >
              {initials(t.root.author)}
            </button>
          ))}
        </div>
      )}
      {settled.length > 0 && (
        <details className="note-history">
          <summary>Conversation log ({settled.length})</summary>
          <ul>
            {settled.map(({ root: c, replies }) => (
              <li key={c.id}>
                <p>
                  <span className="note-initials">{initials(c.author)}</span> <strong>{c.author}</strong>, on {whereOf(c.anchor)}: {c.text}
                </p>
                {replies.map((r) => (
                  <p key={r.id} className="note-log-reply">
                    <strong>{r.author}:</strong> {r.text}
                  </p>
                ))}
                <p className="note-status done">
                  {dismissedWords(c)}.{' '}
                  {onRestore && (
                    <button type="button" className="link-btn" onClick={() => onRestore(c)}>
                      Restore
                    </button>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
      {editor && <SelectionMenu editor={editor} hidden={() => live.current.commenting} />}
      {editor && <SectionMenu editor={editor} within={wrap} hidden={() => live.current.commenting} />}
      <EditorContent editor={editor} />
      <div className="note-layer" aria-hidden="true">
        {hover && !picked && <Outline rects={hover.rects} />}
        {picked && <Outline rects={picked.rects} picked />}
      </div>
      {linkChip && (
        // Pressing the chip keeps the caret where it is, so the chip is still there for the click.
        <div className="link-chip" style={{ top: linkChip.top, left: linkChip.left }} onMouseDown={(e) => e.preventDefault()}>
          {linkChip.target?.node ? (
            <button type="button" className="link-chip-go" onClick={() => links.follow(linkChip.ref)} title="Or ⌘/Ctrl-click the link">
              <Icon name="target" size={14} /> <span>Go to {linkChip.target.node.title}</span>
            </button>
          ) : (
            <a className="link-chip-go" href={linkChip.target?.url ?? linkChip.ref} target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={14} /> <span>{linkChip.target ? `#${linkChip.target.number} on GitHub` : linkChip.ref}</span>
            </a>
          )}
        </div>
      )}
      {hover?.touch && !picked && (
        <div className="note-chip" style={{ top: below(hover.rects) + 6 }}>
          <button type="button" className="note-chip-go" onClick={() => pick(hover)}>
            <Icon name="comment" size={14} /> Comment on {labelOf(hover)}
          </button>
          {wider && (
            <button type="button" className="link-btn" onClick={() => setHover({ ...withRects(wider), touch: true })}>
              Wider
            </button>
          )}
        </div>
      )}
      {picked && about && (
        <div className="thread-pop" style={{ top: below(picked.rects) + 6 }}>
          <Composer
            key={picked.key}
            heading={`${itemLabel} · ${about.where}`}
            quote={about.quote}
            what={about.what}
            src={about.src}
            onPost={(text) => onComment(picked.anchor, text)}
            onCancel={() => setPicked(null)}
          />
        </div>
      )}
      {answeringQ && (
        <div className="thread-pop" style={{ top: answering.top }}>
          <AnswerBox key={answeringQ.id} question={answeringQ} onPrompt={(t) => onAnswerPrompt(answeringQ, t)} onAnswer={(t, p) => onAnswer(answeringQ, t, p)} onCancel={() => setAnswering(null)} />
        </div>
      )}
      {open && (
        <div className="thread-pop" style={{ top: thread.top }}>
          <Thread
            key={open.root.id}
            heading={`${itemLabel} · ${whereOf(open.root.anchor)}`}
            quote={open.root.anchor?.quote}
            what={open.root.anchor?.on === 'section' ? 'The whole section' : open.root.anchor?.on === 'place' ? title : null}
            src={open.root.anchor?.src}
            moved={openAt?.moved}
            thread={open}
            onReply={(text) => onComment(open.root.anchor, text, { replyTo: open.root.id })}
            onPromote={onPromote}
            onDismiss={onDismiss}
            onClose={() => setThread(null)}
          />
        </div>
      )}
    </div>
  );
}
