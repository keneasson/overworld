import { useEffect, useMemo, useRef, useState } from 'react';
import { KIND_LABEL } from '@shared/schema.js';
import { LENSES } from '../map/lenses.js';
import { PROJECTIONS } from '../map/layout.js';
import { renderThumbnail } from '../map/scene.js';
import { pathOf } from '../model/tree.js';
import { Icon } from './Icon.jsx';
import { KindBadge } from './Panel.jsx';

function score(n, q) {
  const t = n.title.toLowerCase();
  if (t.startsWith(q)) return 0;
  if (t.includes(` ${q}`)) return 1;
  if (t.includes(q)) return 2;
  if (n.tags?.some((tag) => tag.includes(q))) return 3;
  if ((n.summary ?? '').toLowerCase().includes(q) || n.assignee?.toLowerCase() === q.replace(/^@/, '')) return 4;
  return -1;
}

export function SearchBar({ tree, projectTitle, onPick, onMenu }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query || !tree) return [];
    return tree.list
      .map((n) => [n, score(n, query)])
      .filter(([, s]) => s >= 0)
      .sort((a, b) => a[1] - b[1] || a[0].depth - b[0].depth)
      .slice(0, 8)
      .map(([n]) => n);
  }, [q, tree]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (n) => {
    onPick(n.id);
    setOpen(false);
    setQ('');
    inputRef.current?.blur();
  };

  return (
    <div className="search" role="search">
      <button className="icon-btn" onClick={onMenu} aria-label="Projects and settings">
        <Icon name="menu" />
      </button>
      <input
        ref={inputRef}
        value={q}
        placeholder={projectTitle ? `Search ${projectTitle}` : 'Search'}
        aria-label="Search this project"
        aria-expanded={open && results.length > 0}
        aria-controls="search-results"
        role="combobox"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(results.length - 1, a + 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
          else if (e.key === 'Enter' && results[active]) pick(results[active]);
          else if (e.key === 'Escape') {
            setQ('');
            inputRef.current?.blur();
          } else return;
          e.preventDefault();
        }}
      />
      {q ? (
        <button className="icon-btn" onClick={() => setQ('')} aria-label="Clear search">
          <Icon name="close" />
        </button>
      ) : (
        <span className="search-icon">
          <Icon name="search" />
        </span>
      )}
      {open && results.length > 0 && (
        <ul className="search-results" id="search-results" role="listbox">
          {results.map((n, i) => (
            <li key={n.id} role="option" aria-selected={i === active}>
              <button className={i === active ? 'active' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(n)}>
                <KindBadge kind={n.kind} />
                <span className="row-main">
                  <span className="row-title">{n.title}</span>
                  <span className="row-sub">
                    {pathOf(n)
                      .slice(1, -1)
                      .map((p) => p.title)
                      .join(' › ') || 'Project'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Chips({ tree, lensId, setLens, showLinks, setShowLinks }) {
  return (
    <div className="chips" role="toolbar" aria-label="Map lenses">
      {LENSES.filter((l) => l.id !== 'map').map((l) => {
        const count = l.count?.(tree);
        const on = l.id === lensId;
        return (
          <button key={l.id} className={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setLens(on ? 'map' : l.id)}>
            <span aria-hidden="true">{l.icon}</span> {l.chip}
            {count != null && <span className="chip-count">{count}</span>}
          </button>
        );
      })}
      <button className={`chip${showLinks ? ' on' : ''}`} aria-pressed={showLinks} onClick={() => setShowLinks(!showLinks)}>
        <Icon name="route" size={16} /> Routes
      </button>
    </div>
  );
}

const plural = { area: 'areas', epic: 'epics', feature: 'features', story: 'stories', task: 'tasks', bug: 'bugs' };

export function Breadcrumbs({ tree, focusId, onFly }) {
  const focus = focusId ? tree.byId.get(focusId) : null;
  const path = focus ? pathOf(focus) : [tree.root];
  let level = 'Overview';
  if (focus?.children.length) {
    const kinds = {};
    for (const c of focus.children) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
    const top = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0][0];
    level = `Showing ${plural[top] ?? 'items'}`;
  }
  return (
    <nav className="breadcrumbs" aria-label="You are here">
      {path.map((n, i) => (
        <span key={n.id} className="crumb">
          {i > 0 && <Icon name="right" size={14} />}
          <button onClick={() => onFly(n.id)}>{n.title}</button>
        </span>
      ))}
      <span className="level">{level}</span>
    </nav>
  );
}

export function Legend({ lens, tree }) {
  const [open, setOpen] = useState(() => !matchMedia('(max-width: 720px)').matches);
  const items = lens.legend(tree);
  return (
    <div className={`legend${open ? '' : ' closed'}`}>
      <button className="legend-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span aria-hidden="true">{lens.icon}</span> {lens.name}
        <Icon name={open ? 'down' : 'up'} size={16} />
      </button>
      {open && (
        <ul>
          {items.map((it) => (
            <li key={it.label}>
              <span className={`swatch${it.dot ? ' dot' : ''}${it.hatch ? ' hatch' : ''}`} style={{ background: it.color }} />
              {it.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LayerButton({ scene, lensId, setLens, showLinks, setShowLinks, projection, setProjection }) {
  const [open, setOpen] = useState(false);
  const thumbs = useMemo(() => (open && scene ? Object.fromEntries(LENSES.map((l) => [l.id, renderThumbnail(scene, l)])) : {}), [open, scene]);
  const current = LENSES.find((l) => l.id === lensId);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <>
      <button className="layer-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Map layers">
        <Icon name="layers" />
        <span>Layers</span>
      </button>
      {open && (
        <div className="layer-sheet" role="dialog" aria-label="Choose a map lens">
          <div className="layer-sheet-head">
            <strong>Map lens</strong>
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close layers">
              <Icon name="close" />
            </button>
          </div>
          <div className="projections" role="radiogroup" aria-label="Map projection">
            {PROJECTIONS.map((p) => (
              <button key={p.id} role="radio" aria-checked={p.id === projection} className={`projection${p.id === projection ? ' on' : ''}`} onClick={() => setProjection(p.id)}>
                <strong>{p.name}</strong>
                <span>{p.blurb}</span>
              </button>
            ))}
          </div>
          <div className="layer-grid">
            {LENSES.map((l) => (
              <button
                key={l.id}
                className={`layer-tile${l.id === lensId ? ' on' : ''}`}
                onClick={() => {
                  setLens(l.id);
                  setOpen(false);
                }}
              >
                {thumbs[l.id] ? <img src={thumbs[l.id]} alt="" width="132" height="88" /> : <span className="thumb-ph" />}
                <span className="layer-name">
                  {l.icon} {l.name}
                </span>
                <span className="layer-blurb">{l.blurb}</span>
              </button>
            ))}
          </div>
          <label className="toggle">
            <input type="checkbox" checked={showLinks} onChange={(e) => setShowLinks(e.target.checked)} />
            <span>
              <strong>Routes</strong> — draw dependencies and page-to-page navigation as roads between regions.
            </span>
          </label>
          <p className="muted small">Current: {current?.name}</p>
        </div>
      )}
    </>
  );
}

export function MapControls({ onZoom, onOverview }) {
  return (
    <div className="map-controls">
      <button onClick={onOverview} aria-label="Zoom all the way out" title="Whole project">
        <Icon name="globe" />
      </button>
      <div className="zoom-pair">
        <button onClick={() => onZoom(1.8)} aria-label="Zoom in">
          <Icon name="plus" />
        </button>
        <button onClick={() => onZoom(1 / 1.8)} aria-label="Zoom out">
          <Icon name="minus" />
        </button>
      </div>
    </div>
  );
}

export function Tooltip({ hover, tree, lens }) {
  if (!hover) return null;
  const n = tree.byId.get(hover.id);
  if (!n) return null;
  const left = Math.min(hover.x + 14, window.innerWidth - 260);
  return (
    <div className="tooltip" style={{ left, top: hover.y + 14 }} role="tooltip">
      <div className="tt-kind">{KIND_LABEL[n.kind]}</div>
      <div className="tt-title">{n.title}</div>
      <div className="tt-stat">{lens.stat(n)}</div>
    </div>
  );
}

export function Toasts({ toasts }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind ?? ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Hint({ onDismiss }) {
  return (
    <div className="hint" role="note">
      <p>
        <strong>Read it like a map.</strong> Scroll or pinch to zoom: each level trades breadth for depth. Click a region for details, use the chips to
        switch what the map shows, and turn on <em>Routes</em> to see connections.
      </p>
      <button onClick={onDismiss}>Got it</button>
    </div>
  );
}
