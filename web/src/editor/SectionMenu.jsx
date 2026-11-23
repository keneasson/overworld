import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { addSection, missingSections } from './sections.js';

/**
 * The right-click menu in the document (#41 EDIT-25): the shape's sections it is missing, and a click adds one in its place,
 * empty and ready to type in. A document with every section keeps the browser's own menu. `within` is the element it listens on.
 */
export function SectionMenu({ editor, within, hidden = () => false }) {
  const [menu, setMenu] = useState(null); // { x, y, names }
  const box = useRef(null);

  useEffect(() => {
    const el = within.current;
    if (!el || !editor) return undefined;
    const open = (e) => {
      if (hidden() || editor.isDestroyed || !e.target.closest?.('.issue-doc-text')) return;
      const names = missingSections(editor.state.doc).map((m) => m.name);
      if (!names.length) return;
      e.preventDefault();
      setMenu({ x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 40 - names.length * 36), names });
    };
    el.addEventListener('contextmenu', open);
    return () => el.removeEventListener('contextmenu', open);
  }, [editor, within]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => !box.current?.contains(e.target) && setMenu(null);
    const key = (e) => e.key === 'Escape' && setMenu(null);
    const gone = () => setMenu(null);
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', key);
    window.addEventListener('blur', gone);
    window.addEventListener('resize', gone);
    box.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('blur', gone);
      window.removeEventListener('resize', gone);
    };
  }, [menu]);

  if (!menu) return null;
  const add = (name) => {
    setMenu(null);
    const tr = addSection(editor.state, name);
    if (tr) editor.view.dispatch(tr);
    editor.commands.focus();
  };
  // On the page, not in the panel, so the panel's scrolling and clipping never move or cut it.
  return createPortal(
    <div className="section-menu" role="menu" aria-label="Add a missing section" ref={box} style={{ left: menu.x, top: menu.y }}>
      <p className="section-menu-head">Add a section</p>
      {menu.names.map((name) => (
        <button key={name} type="button" role="menuitem" onClick={() => add(name)}>
          {name}
        </button>
      ))}
    </div>,
    document.body,
  );
}
