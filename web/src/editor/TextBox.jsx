// A comment, reply or answer written like the document (EDIT-15): the same extensions and the same menu at a
// selection, its value in and out as markdown, and ⌘/Ctrl+Enter posting it (NOTE-12).

import { useEffect, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import { Placeholder } from '@tiptap/extensions';
import { EXTENSIONS } from './rich-text.js';
import { SelectionMenu } from './SelectionMenu.jsx';

/** `value` and `onChange` are markdown; `onSubmit` runs on ⌘/Ctrl+Enter. */
export default function TextBox({ value, onChange, onSubmit, label, placeholder = '', autoFocus = false, className = '' }) {
  const live = useRef({});
  live.current = { onChange, onSubmit };
  const said = useRef(value);
  const editor = useEditor({
    extensions: [
      ...EXTENSIONS,
      Markdown,
      Placeholder.configure({ placeholder }),
      Extension.create({ name: 'post', addKeyboardShortcuts: () => ({ 'Mod-Enter': () => (live.current.onSubmit?.(), true) }) }),
    ],
    content: value,
    contentType: 'markdown',
    autofocus: autoFocus ? 'end' : false,
    editorProps: { attributes: { class: 'text-box-text', role: 'textbox', 'aria-multiline': 'true', 'aria-label': label } },
    onUpdate: ({ editor: e }) => {
      said.current = e.isEmpty ? '' : e.getMarkdown().trim();
      live.current.onChange(said.current);
    },
  });
  // Set from outside, as when a posted reply clears the box.
  useEffect(() => {
    if (!editor || value === said.current) return;
    said.current = value;
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
  }, [editor, value]);
  return (
    <div className={`text-box ${className}`}>
      {editor && <SelectionMenu editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}
