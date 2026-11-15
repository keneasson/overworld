import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { Icon } from '../components/Icon.jsx';

const link = (c, e) => {
  if (e.isActive('link')) return c.unsetLink();
  const href = window.prompt('Link to', 'https://')?.trim();
  return href ? c.extendMarkRange('link').setLink({ href }) : c;
};

// The one menu: it appears at a selection (EDIT-06), in the document and in every comment box (EDIT-15), so no
// section carries a toolbar of its own. Indent and outdent show only in a list (EDIT-17), as Tab and Shift+Tab do.
const TOOLS = [
  ['bold', 'Bold', (c) => c.toggleBold(), 'bold'],
  ['italic', 'Italic', (c) => c.toggleItalic(), 'italic'],
  ['code', 'Code', (c) => c.toggleCode(), 'code'],
  ['link', 'Link', link, 'link'],
  ['list', 'Bulleted list', (c) => c.toggleBulletList(), 'bulletList'],
  ['numbered', 'Numbered list', (c) => c.toggleOrderedList(), 'orderedList'],
  ['indent', 'Make a sub-item (Tab)', (c) => c.sinkListItem('listItem'), null, (e) => e.can().sinkListItem('listItem')],
  ['outdent', 'Lift out of the list above (Shift+Tab)', (c) => c.liftListItem('listItem'), null, (e) => e.isActive('listItem')],
];

/** The formatting menu at a selection in `editor`; `hidden()` keeps it closed (the Comment control is on). */
export function SelectionMenu({ editor, hidden = () => false }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      Object.fromEntries(TOOLS.map(([icon, , , mark, show]) => [icon, { on: Boolean(mark && e?.isActive(mark)), shown: !show || Boolean(e && show(e)) }])),
  });
  return (
    <BubbleMenu editor={editor} className="selection-menu" shouldShow={({ editor: e, state: s }) => !hidden() && e.isEditable && !s.selection.empty}>
      {TOOLS.filter(([icon]) => state?.[icon]?.shown ?? true).map(([icon, label, run]) => (
        <button
          key={icon}
          type="button"
          className={`icon-btn small${state?.[icon]?.on ? ' on' : ''}`}
          aria-label={label}
          aria-pressed={state?.[icon]?.on ?? false}
          title={label}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run(editor.chain().focus(), editor).run()}
        >
          <Icon name={icon} size={16} />
        </button>
      ))}
    </BubbleMenu>
  );
}
