import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { Markdown } from '@tiptap/markdown';
import { Placeholder } from '@tiptap/extensions';
import { EXTENSIONS } from './rich-text.js';
import { Icon } from '../components/Icon.jsx';

const TOOLS = [
  ['bold', 'Bold', (c) => c.toggleBold(), 'bold'],
  ['italic', 'Italic', (c) => c.toggleItalic(), 'italic'],
  ['code', 'Code', (c) => c.toggleCode(), 'code'],
  ['list', 'Bulleted list', (c) => c.toggleBulletList(), 'bulletList'],
  ['numbered', 'Numbered list', (c) => c.toggleOrderedList(), 'orderedList'],
];

/**
 * One section of an issue as rich text. It speaks markdown both ways: `value` comes in as markdown
 * and `onChange` gets markdown, only when the person changes something.
 */
export function RichField({ value, onChange, placeholder, labelId }) {
  const latest = useRef(onChange);
  latest.current = onChange;
  const editor = useEditor({
    extensions: [...EXTENSIONS, Markdown, Placeholder.configure({ placeholder: placeholder || 'Nothing yet' })],
    content: value,
    contentType: 'markdown',
    editorProps: { attributes: { class: 'rich-input', 'aria-labelledby': labelId, 'aria-multiline': 'true', role: 'textbox' } },
    onUpdate: ({ editor: e }) => latest.current(e.getMarkdown()),
  });
  // Another source (discarding the changeset, say) replaced the text: show it without reporting a change.
  useEffect(() => {
    if (editor && !editor.isFocused && editor.getMarkdown() !== value) editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
  }, [editor, value]);
  const active = useEditorState({ editor, selector: ({ editor: e }) => Object.fromEntries(TOOLS.map(([, , , mark]) => [mark, Boolean(e?.isFocused && e.isActive(mark))])) });

  return (
    <div className="rich">
      <div className="rich-tools" role="toolbar" aria-label="Formatting">
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
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
