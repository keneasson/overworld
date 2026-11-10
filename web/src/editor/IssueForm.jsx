import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { Markdown } from '@tiptap/markdown';
import { Placeholder } from '@tiptap/extensions';
import { behaviourPrefix, nextBehaviourId, parseBehaviours, parseIssue, sectionText } from '@shared/issue-shape.js';
import { EXTENSIONS } from './rich-text.js';
import { fromDocument, sectionAt, toDocument } from './document.js';
import { IssueShape, refreshNotes } from './shape-extension.js';
import { Icon } from '../components/Icon.jsx';

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

const anchorKey = (a) => (a.behaviour ? `b:${a.behaviour}` : `s:${a.section}`);

/** A comment thread on one section or behaviour, opened from its marker in the text. */
function Thread({ anchor, comments, onPost, onResolve, onClose }) {
  const [text, setText] = useState('');
  const post = (e) => {
    e?.preventDefault();
    if (!text.trim()) return;
    onPost(text.trim());
    setText('');
  };
  return (
    <div className="thread" role="dialog" aria-label={`Comments on ${anchor.behaviour ?? anchor.section}`}>
      <div className="thread-head">
        <strong>{anchor.behaviour ?? anchor.section}</strong>
        <button type="button" className="icon-btn small" aria-label="Close comments" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
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
        <textarea
          autoFocus
          aria-label="Write a comment"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && post(e)}
          placeholder="Comment on this… (⌘/Ctrl+Enter posts)"
          maxLength={4000}
        />
        <button type="submit" disabled={!text.trim()}>
          Comment
        </button>
      </form>
    </div>
  );
}

/**
 * One item as one document (EDIT-01): the title, the head, then each section as a heading.
 * `value` is { title, markdown }, and `onChange` gets the same, with unchanged sections written back exactly as they came.
 */
export function IssueForm({ value, issueNumber, areaTexts, comments, onChange, onComment, onResolve, conflict }) {
  // Fixed at open: everything is written back relative to the issue as it was then.
  const original = useMemo(() => value.markdown, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [title, setTitle] = useState(value.title);
  const [thread, setThread] = useState(null); // { anchor, top }
  const wrap = useRef(null);
  const opened = useRef(null);
  const live = useRef({});
  live.current = { title, areaTexts, onChange };

  const nextId = () => {
    const doc = editor.getMarkdown();
    const rows = parseBehaviours(sectionText(parseIssue(doc), 'Behaviours'));
    return nextBehaviourId(behaviourPrefix(rows, live.current.title), [...live.current.areaTexts, doc]);
  };
  const onThread = (anchor, button) => {
    const box = wrap.current.getBoundingClientRect();
    const at = button.getBoundingClientRect();
    setThread((t) => (t && anchorKey(t.anchor) === anchorKey(anchor) ? null : { anchor, top: at.bottom - box.top + 4 }));
  };

  const editor = useEditor({
    extensions: [
      ...EXTENSIONS,
      Markdown,
      IssueShape.configure({ nextId: () => nextId(), onThread: (a, b) => onThread(a, b) }),
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

  const counts = useMemo(() => {
    const m = new Map();
    for (const c of comments) if (!c.resolved) m.set(anchorKey(c.anchor), (m.get(anchorKey(c.anchor)) ?? 0) + 1);
    return m;
  }, [comments]);
  useEffect(() => refreshNotes(editor, counts), [editor, counts]);

  const active = useEditorState({ editor, selector: ({ editor: e }) => Object.fromEntries(TOOLS.map(([, , , mark]) => [mark, Boolean(e?.isActive(mark))])) });

  const setTitleText = (t) => {
    setTitle(t);
    const markdown = editor && opened.current != null ? fromDocument(original, opened.current, editor.getMarkdown()) : original;
    onChange({ title: t, markdown });
  };

  return (
    <div className="issue-doc" ref={wrap}>
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
        onChange={(e) => setTitleText(e.target.value.replace(/\n/g, ' '))}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          editor?.commands.focus('start');
        }}
      />
      {editor && (
        <BubbleMenu editor={editor} className="selection-menu">
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
      {thread && (
        <div className="thread-pop" style={{ top: thread.top }}>
          <Thread
            anchor={thread.anchor}
            comments={comments.filter((c) => anchorKey(c.anchor) === anchorKey(thread.anchor))}
            onPost={(text) => onComment(thread.anchor, text)}
            onResolve={onResolve}
            onClose={() => setThread(null)}
          />
        </div>
      )}
    </div>
  );
}
