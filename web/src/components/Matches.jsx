// The list of matches (#53), from a search or a lens: each with its symbol, name and markers, the ones in view first
// (FIND-01), filter chips above it from what the matches in view carry (FIND-02), kept as the map moves (FIND-03).

import { markersOf } from '../map/labels.js';
import { pathOf } from '../model/tree.js';
import { chipLabel } from '../model/find.js';
import { Icon } from './Icon.jsx';
import { MapSymbol } from './Chrome.jsx';
import { StatusDot } from './Panel.jsx';

const SHOWN = 200;

function Row({ m, live, active, sub, onPick }) {
  const { node, behaviour } = m;
  const markers = behaviour ? [] : markersOf(node, live);
  return (
    <li>
      <button className={`row match${active ? ' active' : ''}`} aria-current={active || undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(m)}>
        <span className="symbol-chip" aria-hidden="true">
          <MapSymbol name={behaviour ? 'behavior' : node.kind} size={12} />
        </span>
        <span className="row-main">
          <span className="row-title">{behaviour ? `${behaviour.id} ${behaviour.words}` : node.title}</span>
          <span className="row-sub">{sub}</span>
        </span>
        {markers.length > 0 && (
          <span className="match-markers">
            {markers.map((mk) => (
              <span key={mk.type} className={`badge-chip ${mk.type}`} title={`${mk.count} ${mk.type}`}>
                <MapSymbol name={mk.type} size={11} />
              </span>
            ))}
          </span>
        )}
        <StatusDot status={node.status} />
      </button>
    </li>
  );
}

/**
 * @param {{ eyebrow: any, heading: string, blurb?: string, list: ReturnType<import('../model/find.js').findList>, chosen: string[],
 *   active?: number, live?: object, stat?: (node: object) => string, onChoose: (chosen: string[]) => void, onPick: (m: object) => void, onClose: () => void }} p
 */
export function Matches({ eyebrow, heading, blurb, list, chosen, active = -1, live, stat, onChoose, onPick, onClose }) {
  const { rows, chips, inView } = list;
  const sub = ({ node, behaviour }) => (behaviour ? node.title : [stat?.(node), pathOf(node).slice(1, -1).map((p) => p.title).join(' › ') || 'Project'].filter(Boolean).join(' — '));
  return (
    <div className="details matches">
      <header className="panel-head">
        <div>
          <div className="eyebrow">{eyebrow}</div>
          <h2 className="node-title">{heading}</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close the list">
          <Icon name="close" />
        </button>
      </header>
      {blurb && <p className="summary">{blurb}</p>}
      {(chosen.length > 0 || chips.length > 0) && (
        <div className="filter-chips" role="group" aria-label="Filters">
          {chosen.map((k) => (
            <button key={k} className="chip on" aria-pressed="true" onClick={() => onChoose(chosen.filter((c) => c !== k))}>
              {chipLabel(k)} <Icon name="close" size={12} />
            </button>
          ))}
          {chips.map((c) => (
            <button key={c.key} className="chip" aria-pressed="false" onClick={() => onChoose([...chosen, c.key])}>
              {c.label} <span className="chip-count">{c.count}</span>
            </button>
          ))}
          {chosen.length > 1 && (
            <button className="link-btn" onClick={() => onChoose([])}>
              Clear filters
            </button>
          )}
        </div>
      )}
      <p className="match-count">{rows.length ? `${inView} in view${rows.length > inView ? `, ${rows.length - inView} elsewhere` : ''}` : chosen.length ? 'Nothing matches these filters.' : 'Nothing matches.'}</p>
      <ul className="rows">
        {rows.slice(0, SHOWN).map((m, i) => (
          <Row key={m.behaviour ? `${m.node.id}:${m.behaviour.id}` : m.node.id} m={m} live={live} active={i === active} sub={sub(m)} onPick={onPick} />
        ))}
      </ul>
      {rows.length > SHOWN && <p className="empty-note">And {rows.length - SHOWN} more: narrow it with a filter.</p>}
    </div>
  );
}
