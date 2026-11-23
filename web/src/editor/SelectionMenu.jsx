import { isMarkActive, isNodeActive } from '@tiptap/core';
import { sinkListItem } from '@tiptap/pm/schema-list';
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
  ['bold', 'Bold', (c) => c.toggleBold(), (s) => isMarkActive(s, 'bold')],
  ['italic', 'Italic', (c) => c.toggleItalic(), (s) => isMarkActive(s, 'italic')],
  ['code', 'Code', (c) => c.toggleCode(), (s) => isMarkActive(s, 'code')],
  ['link', 'Link', link, (s) => isMarkActive(s, 'link')],
  ['list', 'Bulleted list', (c) => c.toggleBulletList(), (s) => isNodeActive(s, 'bulletList')],
  ['numbered', 'Numbered list', (c) => c.toggleOrderedList(), (s) => isNodeActive(s, 'orderedList')],
  ['indent', 'Make a sub-item (Tab)', (c) => c.sinkListItem('listItem'), null, (s) => sinkListItem(s.schema.nodes.listItem)(s)],
  ['outdent', 'Lift out of the list above (Shift+Tab)', (c) => c.liftListItem('listItem'), null, (s) => isNodeActive(s, 'listItem')],
];
const RUN = Object.fromEntries(TOOLS.map(([icon, , run]) => [icon, run]));

/** What the menu offers at the selection in `state`: nothing without a selection, else each tool shown there and whether it is on. */
export function menuAt(state) {
  if (state.selection.empty) return [];
  return TOOLS.filter(([, , , , show]) => !show || show(state)).map(([icon, label, , on]) => ({ icon, label, on: Boolean(on?.(state)) }));
}

/** The formatting menu at a selection in `editor`; `hidden()` keeps it closed (the Comment control is on). */
export function SelectionMenu({ editor, hidden = () => false }) {
  const tools = useEditorState({ editor, selector: ({ editor: e }) => (e ? menuAt(e.state) : []), equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  return (
    <BubbleMenu editor={editor} className="selection-menu" shouldShow={({ editor: e, state: s }) => !hidden() && e.isEditable && menuAt(s).length > 0}>
      {(tools ?? []).map(({ icon, label, on }) => (
        <button
          key={icon}
          type="button"
          className={`icon-btn small${on ? ' on' : ''}`}
          aria-label={label}
          aria-pressed={on}
          title={label}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => RUN[icon](editor.chain().focus(), editor).run()}
        >
          <Icon name={icon} size={16} />
        </button>
      ))}
    </BubbleMenu>
  );
}
