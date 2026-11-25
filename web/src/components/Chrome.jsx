import { useEffect, useMemo, useRef, useState } from 'react';
import { LENSES } from '../map/lenses.js';
import { PROJECTIONS } from '../map/layout.js';
import { renderThumbnail } from '../map/scene.js';
import { symbolsInUse } from '../map/labels.js';
import { symbolPath } from '../map/symbols.js';
import { pathOf } from '../model/tree.js';
import { Icon } from './Icon.jsx';

/**
 * The search box. What it finds is listed in the panel, beside the map that marks it (#53 FIND-01): arrows move through the
 * list and Enter picks, so the box is the keyboard's way into the list. `/` focuses it from anywhere.
 */
export function SearchBar({ q, projectTitle, touch = false, onQuery, onMove, onEnter, onMenu }) {
  const inputRef = useRef(null);

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
        enterKeyHint="search"
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') onMove(1);
          else if (e.key === 'ArrowUp') onMove(-1);
          // On a phone the keyboard covers the list, so Enter puts the keyboard away to show it, and a tap picks; with a keyboard
          // and arrows, Enter picks.
          else if (e.key === 'Enter') (touch || onEnter()) && inputRef.current?.blur();
          else if (e.key === 'Escape') {
            onQuery('');
            inputRef.current?.blur();
          } else return;
          e.preventDefault();
        }}
      />
      {q ? (
        <button className="icon-btn" onClick={() => onQuery('')} aria-label="Clear search">
          <Icon name="close" />
        </button>
      ) : (
        <span className="search-icon">
          <Icon name="search" />
        </span>
      )}
    </div>
  );
}

export function Chips({ tree, lensId, setLens, showLinks, setShowLinks, lenses = LENSES }) {
  return (
    <div className="chips" role="toolbar" aria-label="Map lenses">
      {lenses.filter((l) => l.id !== 'map').map((l) => {
        const count = l.count?.(tree);
        const on = l.id === lensId;
        const waiting = l.waiting && count > 0; // Review's count stands out while anything waits (REVIEW-01)
        return (
          <button key={l.id} className={`chip${on ? ' on' : ''}${waiting ? ' waiting' : ''}`} aria-pressed={on} onClick={() => setLens(on ? 'map' : l.id)} title={l.title?.(count)}>
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

// The place in view (MARK-19), and the way to it: named here even where its name and its region's have faded from the map.
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
        <span key={n.id} className={i === path.length - 1 ? 'crumb here' : 'crumb'}>
          {i > 0 && <Icon name="right" size={14} />}
          <button onClick={() => onFly(n.id)} aria-current={i === path.length - 1 ? 'location' : undefined}>
            {n.title}
          </button>
        </span>
      ))}
      <span className="level">{level}</span>
    </nav>
  );
}

export function MapSymbol({ name, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={symbolPath(name)} />
    </svg>
  );
}

// The key to the land (the lens's colours) and to every symbol, fill and badge this map uses (SYM-04).
export function Legend({ lens, tree, live }) {
  const [open, setOpen] = useState(() => !matchMedia('(max-width: 720px)').matches);
  const items = lens.legend(tree);
  const used = useMemo(() => symbolsInUse(tree, live), [tree, live]);
  return (
    <div className={`legend${open ? '' : ' closed'}`}>
      <button className="legend-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span aria-hidden="true">{lens.icon}</span> {lens.name}
        <Icon name={open ? 'down' : 'up'} size={16} />
      </button>
      {open && (
        <div className="legend-body">
          <ul>
            {items.map((it) => (
              <li key={it.label}>
                <span className={`swatch${it.dot ? ' dot' : ''}${it.hatch ? ' hatch' : ''}${it.fog ? ' fog' : ''}${it.cracks ? ' cracks' : ''}`} style={{ background: it.color }} />
                {it.label}
              </li>
            ))}
          </ul>
          <h4>Symbols</h4>
          <ul className="legend-symbols">
            {used.kinds.map((it) => (
              <li key={it.symbol}>
                <span className="symbol-chip">
                  <MapSymbol name={it.symbol} size={12} />
                </span>
                {it.label}
              </li>
            ))}
          </ul>
          <h4>Fill: where it stands</h4>
          <ul className="legend-symbols">
            {used.fills.map((it) => (
              <li key={it.label}>
                <span className="swatch dot" style={{ background: it.color }} />
                {it.label}
              </li>
            ))}
          </ul>
          {used.markers.length > 0 && (
            <>
              <h4>Markers</h4>
              <ul className="legend-symbols">
                {used.markers.map((it) => (
                  <li key={`${it.symbol}${it.on ?? ''}`}>
                    <span className={`badge-chip ${it.symbol}${it.on ? ' wide' : ''}`}>
                      {it.on && <MapSymbol name={it.on} size={11} />}
                      <MapSymbol name={it.symbol} size={11} />
                    </span>
                    {it.label}
                  </li>
                ))}
              </ul>
            </>
          )}
          {used.badges.length > 0 && (
            <>
              <h4>Badges</h4>
              <ul className="legend-symbols">
                {used.badges.map((it) => (
                  <li key={it.symbol}>
                    <span className={`badge-chip ${it.symbol}`}>
                      <MapSymbol name={it.symbol} size={11} />
                    </span>
                    {it.label}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function LayerButton({ scene, lensId, setLens, showLinks, setShowLinks, projection, setProjection, lenses = LENSES }) {
  const [open, setOpen] = useState(false);
  const thumbs = useMemo(() => (open && scene ? Object.fromEntries(lenses.map((l) => [l.id, renderThumbnail(scene, l)])) : {}), [open, scene, lenses]);
  const current = lenses.find((l) => l.id === lensId);
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
            {lenses.map((l) => (
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

/**
 * The one way in to commenting (#15 NOTE-10): switched on, whatever is pointed at or tapped, in the text or on the map,
 * is outlined to comment on (NOTE-15). It stays on after each comment; Esc or the control itself switches it off (NOTE-16).
 */
export function CommentToggle({ on, onToggle }) {
  return (
    <button type="button" className={`comment-toggle${on ? ' on' : ''}`} aria-pressed={on} onClick={onToggle} title={on ? 'Stop commenting (Esc)' : 'Comment on anything: words, a paragraph, an image or a place on the map'}>
      <Icon name="comment" size={18} />
      <span>Comment</span>
    </button>
  );
}

/**
 * What Esc does on the page (NOTE-16): in a comment box, or any field, the box or field has it (a comment box closes itself and
 * leaves the control on); otherwise it switches the Comment control off before it closes anything.
 */
export const escapeDoes = ({ commenting, inBox }) => (inBox ? null : commenting ? 'stop commenting' : 'close');

export function MapControls({ onZoom, onOverview, children }) {
  return (
    <div className="map-controls">
      {children}
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
