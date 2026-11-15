import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { Markdown } from '@tiptap/markdown';
import { Placeholder } from '@tiptap/extensions';
import { behaviourPrefix, nextBehaviourId, parseBehaviours, parseIssue, sectionText } from '@shared/issue-shape.js';
import { NOTE_KIND_LABEL, OUTCOME_LABEL, initials, kindOf, threadsOf, whereOf } from '@shared/annotations.js';
import { EXTENSIONS } from './rich-text.js';
import { fromDocument, sectionAt, toDocument } from './document.js';
import { IssueShape, refreshNotes } from './shape-extension.js';
import { describe, rangeOf, rectsOf, selectedTarget, targetAt, widen } from './targets.js';
import { Composer, Thread } from './Annotate.jsx';
import { Icon } from '../components/Icon.jsx';

const TAP = 10; // a touch that moves less than this is a tap, not a scroll

const HINTS = {
  Why: 'The problem, for whom, and why now.',
  Behaviours: '- AREA-01 Given a situation, when something happens, then what must be true',
  Acceptance: 'How everyone will know it is done.',
  'Out of scope': 'What this deliberately leaves out.',
  'Open questions': 'While anything is listed here, the issue needs a decision before work starts.',
};

// The one menu: it appears at a selection (EDIT-06), so no section carries a toolbar of its own.
const TOOLS = [
  ['bold', 'Bold', (c) => c.toggleBold(), 'bold'],
  ['italic', 'Italic', (c) => c.toggleItalic(), 'italic'],
  ['code', 'Code', (c) => c.toggleCode(), 'code'],
  ['list', 'Bulleted list', (c) => c.toggleBulletList(), 'bulletList'],
  ['numbered', 'Numbered list', (c) => c.toggleOrderedList(), 'orderedList'],
];

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
 */
export function IssueForm({ value, issueNumber, areaTexts, comments, commenting = false, onChange, onComment, onResolve, onSettle, onPromote, onAnswer, onAnswerPrompt, conflict }) {
  // Fixed at open: everything is written back relative to the issue as it was then.
  const original = useMemo(() => value.markdown, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [title, setTitle] = useState(value.title);
  const [thread, setThread] = useState(null); // { id, top }
  const [hover, setHover] = useState(null); // the target outlined, with its rects
  const [picked, setPicked] = useState(null); // the target the comment box is open on
  const wrap = useRef(null);
  const opened = useRef(null);
  const live = useRef({});
  live.current = { title, areaTexts, onChange, hover, picked, commenting };
  const itemLabel = issueNumber ? `#${issueNumber}` : title || 'This item';

  const nextId = () => {
    const doc = editor.getMarkdown();
    const rows = parseBehaviours(sectionText(parseIssue(doc), 'Behaviours'));
    return nextBehaviourId(behaviourPrefix(rows, live.current.title), [...live.current.areaTexts, doc]);
  };
  const onThread = (id, button) => {
    const box = wrap.current.getBoundingClientRect();
    const at = button.getBoundingClientRect();
    setPicked(null);
    setThread((t) => (t?.id === id ? null : { id, top: at.bottom - box.top + 4 }));
  };

  const editor = useEditor({
    extensions: [
      ...EXTENSIONS,
      Markdown,
      IssueShape.configure({ nextId: () => nextId(), onThread: (id, b) => onThread(id, b) }),
      Placeholder.configure({
        showOnlyCurrent: false,
        placeholder: ({ editor: e, node, pos }) => {
          if (node.type.name !== 'paragraph' || pos === 0) return '';
          const before = e.state.doc.resolve(pos).nodeBefore;
          return before?.type.name === 'heading' && before.attrs.level === 2 ? (HINTS[sectionAt(e.state.doc, pos)] ?? '') : '';
        },
      }),
    ],
    content: toDocument(original),
    contentType: 'markdown',
    editorProps: { attributes: { class: 'issue-doc-text', 'aria-label': issueNumber ? `#${issueNumber}` : 'Item text', 'aria-multiline': 'true', role: 'textbox' } },
    onCreate: ({ editor: e }) => {
      opened.current = e.getMarkdown();
    },
    // Changes before the editor has opened are its own setup, not the person's.
    onUpdate: ({ editor: e }) => opened.current != null && live.current.onChange({ title: live.current.title, markdown: fromDocument(original, opened.current, e.getMarkdown()) }),
  });

  // Each annotation is its own thread (NOTE-11), marked at its words (NOTE-13); the open one is highlighted.
  const threads = useMemo(() => threadsOf(comments), [comments]);
  useEffect(() => refreshNotes(editor, threads.map((t) => t.root), thread?.id ?? null), [editor, threads, thread?.id]);

  const withRects = (t) => t && { ...t, rects: rectsOf(editor.view, t, wrap.current.getBoundingClientRect()) };
  const pick = (t) => {
    window.getSelection?.()?.removeAllRanges();
    setHover(null);
    setThread(null);
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

  const active = useEditorState({ editor, selector: ({ editor: e }) => Object.fromEntries(TOOLS.map(([, , , mark]) => [mark, Boolean(e?.isActive(mark))])) });

  const setTitleText = (t) => {
    setTitle(t);
    const markdown = editor && opened.current != null ? fromDocument(original, opened.current, editor.getMarkdown()) : original;
    onChange({ title: t, markdown });
  };

  const open = thread && threads.find((t) => t.root.id === thread.id);
  const openAt = open && editor && open.root.anchor?.on !== 'place' ? rangeOf(editor.state.doc, open.root.anchor ?? {}) : null;
  const onMap = threads.filter((t) => t.root.anchor?.on === 'place');
  // Dealt with stays in the item's history (NOTE-05).
  const settled = threads.filter((t) => t.root.resolved);
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
        className="issue-doc-title"
        aria-label={issueNumber ? `Title of #${issueNumber}` : 'Title'}
        rows={1}
        maxLength={190}
        value={title}
        readOnly={commenting}
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
              className={`note-marker kind-${kindOf(t.root)}${t.root.resolved ? ' resolved' : ''}`}
              aria-label={`${t.root.author} on the map: ${t.root.text.slice(0, 80)}`}
              onClick={(e) => onThread(t.root.id, e.currentTarget)}
            >
              {initials(t.root.author)}
            </button>
          ))}
        </div>
      )}
      {settled.length > 0 && (
        <details className="note-history">
          <summary>
            {settled.length} annotation{settled.length === 1 ? '' : 's'} dealt with
          </summary>
          <ul>
            {settled.map(({ root: c }) => (
              <li key={c.id}>
                <button type="button" className="link-btn" onClick={(e) => onThread(c.id, e.currentTarget)}>
                  <span className={`note-initials kind-${kindOf(c)}`}>{initials(c.author)}</span> {NOTE_KIND_LABEL[kindOf(c)]}: {c.text.slice(0, 60)}
                </button>
                <span className="note-outcome">{OUTCOME_LABEL[c.outcome?.state ?? 'resolved']}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {editor && (
        <BubbleMenu editor={editor} className="selection-menu" shouldShow={({ editor: e, state }) => !live.current.commenting && e.isEditable && !state.selection.empty}>
          {TOOLS.map(([icon, label, run, mark]) => (
            <button
              key={icon}
              type="button"
              className={`icon-btn small${active?.[mark] ? ' on' : ''}`}
              aria-label={label}
              aria-pressed={active?.[mark] ?? false}
              title={label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(editor.chain().focus()).run()}
            >
              <Icon name={icon} size={16} />
            </button>
          ))}
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
      <div className="note-layer" aria-hidden="true">
        {hover && !picked && <Outline rects={hover.rects} />}
        {picked && <Outline rects={picked.rects} picked />}
      </div>
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
            onPost={(text, extra) => onComment(picked.anchor, text, extra)}
            onCancel={() => setPicked(null)}
          />
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
            onResolve={onResolve}
            onSettle={onSettle}
            onPromote={onPromote}
            onAnswer={onAnswer}
            onAnswerPrompt={onAnswerPrompt}
            onClose={() => setThread(null)}
          />
        </div>
      )}
    </div>
  );
}
