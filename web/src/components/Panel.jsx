import { useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { CHILD_KIND, KIND_LABEL, LINK_LABEL, STATUS_LABEL } from '@shared/schema.js';
import { HEALTH_COLOR, HEALTH_LABEL, isInside, pathOf } from '../model/tree.js';
import { Icon } from './Icon.jsx';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function Markdown({ text }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text ?? '', { gfm: true, breaks: true })), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function HealthPill({ health, large }) {
  return (
    <span className={`pill${large ? ' pill-lg' : ''}`} style={{ background: HEALTH_COLOR[health] }}>
      {HEALTH_LABEL[health]}
    </span>
  );
}

export function KindBadge({ kind }) {
  return <span className={`kind kind-${kind}`}>{KIND_LABEL[kind]}</span>;
}

const STATUS_DOT = { idea: '#a142f4', planned: '#9aa0a6', ready: '#2da44e', needs_decision: '#8b5cf6', in_progress: '#1a73e8', review: '#12b5cb', blocked: '#d93025', done: '#1e8e3e', rejected: '#bdc1c6' };

export function StatusDot({ status }) {
  return <span className="status-dot" style={{ background: STATUS_DOT[status] }} title={STATUS_LABEL[status]} />;
}

function NodeRow({ node, onPick, sub }) {
  return (
    <li>
      <button className="row" onClick={() => onPick(node.id)}>
        <StatusDot status={node.status} />
        <span className="row-main">
          <span className="row-title">{node.title}</span>
          {sub && <span className="row-sub">{sub}</span>}
        </span>
        <KindBadge kind={node.kind} />
      </button>
    </li>
  );
}

const pct = (v) => `${Math.round(v * 100)}%`;

export function Details({ node, tree, lens, onPick, onFly, onEdit, onAdd, onClose, onCopyLink }) {
  const s = node.stats;
  const path = pathOf(node).slice(0, -1);
  const incoming = tree.incoming.get(node.id) ?? [];
  const childKind = CHILD_KIND[node.kind] ?? 'task';
  return (
    <div className="details">
      <header className="panel-head">
        <div className="crumbs-small">
          {path.map((p) => (
            <button key={p.id} onClick={() => onPick(p.id)}>
              {p.title}
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close panel">
          <Icon name="close" />
        </button>
      </header>
      <div className="title-row">
        <KindBadge kind={node.kind} />
        {node.priority && <span className="tag tag-strong">{node.priority}</span>}
        <span className="status-text">
          <StatusDot status={node.status} /> {STATUS_LABEL[node.status]}
        </span>
      </div>
      <h2 className="node-title">{node.title}</h2>
      <div className="pill-row">
        <HealthPill health={s.health} />
        {s.overdue && <span className="pill pill-outline">Overdue</span>}
        {s.vague && <span className="pill pill-fog">Poorly defined</span>}
      </div>

      <div className="actions">
        <button onClick={() => onFly(node.id)}>
          <span className="action-icon">
            <Icon name="target" />
          </span>
          Zoom to
        </button>
        <button onClick={onEdit}>
          <span className="action-icon">
            <Icon name="edit" />
          </span>
          Edit
        </button>
        <button onClick={() => onAdd(node.id, childKind)}>
          <span className="action-icon">
            <Icon name="plus" />
          </span>
          Add {KIND_LABEL[childKind].toLowerCase()}
        </button>
        <button onClick={onCopyLink}>
          <span className="action-icon">
            <Icon name="link" />
          </span>
          Share
        </button>
        {node.url && (
          <a href={node.url} target="_blank" rel="noopener noreferrer">
            <span className="action-icon">
              <Icon name="external" />
            </span>
            Source
          </a>
        )}
      </div>

      {node.summary && <p className="summary">{node.summary}</p>}

      <div className="progress" aria-label={`Progress ${pct(s.progress)}`}>
        <div className="progress-bar">
          <span style={{ width: pct(s.progress) }} />
        </div>
        <span>{pct(s.progress)} done</span>
      </div>

      <dl className="stats">
        <div>
          <dt>Items</dt>
          <dd>{s.items - 1 || '—'}</dd>
        </div>
        <div className={s.openBugs ? 'warn' : ''}>
          <dt>Open bugs</dt>
          <dd>{s.openBugs}</dd>
        </div>
        <div>
          <dt>New features</dt>
          <dd>{s.newFeatures}</dd>
        </div>
        <div className={s.poorlyDefined ? 'fog' : ''}>
          <dt>Vague</dt>
          <dd>{s.poorlyDefined}</dd>
        </div>
        <div className={s.blocked ? 'warn' : ''}>
          <dt>Blocked</dt>
          <dd>{s.blocked}</dd>
        </div>
        <div>
          <dt>Defined</dt>
          <dd>{pct(s.def)}</dd>
        </div>
      </dl>

      <dl className="meta">
        {node.assignee && (
          <div>
            <dt>Owner</dt>
            <dd>@{node.assignee}</dd>
          </div>
        )}
        {node.estimate != null && (
          <div>
            <dt>Estimate</dt>
            <dd>{node.estimate} pts</dd>
          </div>
        )}
        {node.due && (
          <div>
            <dt>Due</dt>
            <dd>{node.due}</dd>
          </div>
        )}
        {node.tags?.length > 0 && (
          <div>
            <dt>Tags</dt>
            <dd className="tags">
              {node.tags.map((t) => (
                <span key={t} className="tag">
                  #{t}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>

      {node.body ? (
        <section>
          <h3>Details</h3>
          <Markdown text={node.body} />
        </section>
      ) : (
        <section className="empty-note">
          <p>
            No details yet. Add a description, acceptance criteria and an estimate to chart this territory.{' '}
            <button className="link-btn" onClick={onEdit}>
              Add details
            </button>
          </p>
        </section>
      )}

      {node.children.length > 0 && (
        <section>
          <h3>
            Inside this {KIND_LABEL[node.kind].toLowerCase()} <span className="count">{node.children.length}</span>
          </h3>
          <ul className="rows">
            {node.children.map((c) => (
              <NodeRow key={c.id} node={c} onPick={onPick} sub={lens.stat(c)} />
            ))}
          </ul>
        </section>
      )}

      {(node.links.length > 0 || incoming.length > 0) && (
        <section>
          <h3>Connections</h3>
          <ul className="rows">
            {node.links.map((l) => {
              const t = tree.byId.get(l.to);
              return t && <NodeRow key={`o${l.type}${l.to}`} node={t} onPick={onPick} sub={`This ${LINK_LABEL[l.type]} it`} />;
            })}
            {incoming.map((l) => {
              const f = tree.byId.get(l.from);
              return f && <NodeRow key={`i${l.type}${l.from}`} node={f} onPick={onPick} sub={`It ${LINK_LABEL[l.type]} this`} />;
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

export function Results({ lens, tree, focusId, onPick, onClose }) {
  const [everywhere, setEverywhere] = useState(false);
  const scope = !everywhere && focusId ? tree.byId.get(focusId) : tree.root;
  const items = useMemo(() => {
    const list = tree.list.filter((n) => lens.matches(n) && isInside(n, scope));
    return lens.sort ? list.sort(lens.sort) : list;
  }, [tree, lens, scope]);
  return (
    <div className="details">
      <header className="panel-head">
        <div>
          <div className="eyebrow">
            {lens.icon} {lens.name}
          </div>
          <h2 className="node-title">
            {items.length} {lens.chip.toLowerCase()} {scope === tree.root ? 'in the project' : `in ${scope.title}`}
          </h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close results">
          <Icon name="close" />
        </button>
      </header>
      <p className="summary">{lens.blurb}</p>
      {scope !== tree.root && (
        <button className="link-btn" onClick={() => setEverywhere(true)}>
          Search the whole project
        </button>
      )}
      {everywhere && focusId && focusId !== tree.root.id && (
        <button className="link-btn" onClick={() => setEverywhere(false)}>
          Only {tree.byId.get(focusId)?.title}
        </button>
      )}
      <ul className="rows">
        {items.map((n) => (
          <NodeRow
            key={n.id}
            node={n}
            onPick={onPick}
            sub={[lens.stat(n), pathOf(n).slice(1, -1).map((p) => p.title).join(' › ')].filter(Boolean).join(' — ')}
          />
        ))}
      </ul>
      {!items.length && <p className="empty-note">Nothing here. Zoom out or search the whole project.</p>}
    </div>
  );
}
