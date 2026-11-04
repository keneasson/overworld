import { useId, useMemo, useState } from 'react';
import {
  DEFINITION,
  HEALTH,
  KINDS,
  KIND_LABEL,
  LINK_LABEL,
  LINK_TYPES,
  PLACE_LABEL,
  PRIORITIES,
  STATUSES,
  STATUS_LABEL,
  SURFACES,
  SURFACE_LABEL,
} from '@shared/schema.js';
import { isInside } from '../model/tree.js';
import { guessPlace, guessSurface, resolveSite } from '../map/places.js';
import { Markdown } from './Panel.jsx';
import { Icon } from './Icon.jsx';

const HEALTH_TEXT = { auto: 'Automatic (roll up)', on_track: 'On target', at_risk: 'At risk', off_track: 'Off target' };
const DEF_TEXT = { auto: 'Automatic', clear: 'Clearly defined', vague: 'Needs definition' };

const SPOTS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

/** A tiny screen: click where the item sits. Clicking the chosen spot again goes back to automatic. */
function PlacePicker({ value, guess, back, labelId, onChange }) {
  const toggle = (p) => onChange(value === p ? 'auto' : p);
  return (
    <div className="place-picker">
      <div className="place-screen" role="radiogroup" aria-labelledby={labelId}>
        {SPOTS.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={value === p}
            aria-label={PLACE_LABEL[p]}
            title={PLACE_LABEL[p]}
            className={`place-cell${value === p ? ' on' : value === 'auto' && guess === p ? ' guess' : ''}`}
            onClick={() => toggle(p)}
          />
        ))}
      </div>
      <div className="place-side">
        {!back && (
          <button type="button" role="radio" aria-checked={value === 'offscreen'} className={`chip-btn${value === 'offscreen' ? ' on' : ''}`} onClick={() => toggle('offscreen')}>
            Behind the screen
          </button>
        )}
        <button type="button" role="radio" aria-checked={value === 'auto'} className={`chip-btn${value === 'auto' ? ' on' : ''}`} onClick={() => onChange('auto')}>
          Automatic
        </button>
        <small>{value === 'auto' ? `Guess: ${PLACE_LABEL[guess].toLowerCase()}` : PLACE_LABEL[value]}</small>
      </div>
    </div>
  );
}

function Field({ label, children, hint, wide }) {
  const id = useId();
  return (
    <div className={`field${wide ? ' wide' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {typeof children === 'function' ? children(id) : children}
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** Edit an existing node, or create one (node = null, draft = { parentId, kind }). */
export function Editor({ node, draft, tree, onSave, onCancel, onDelete, busy }) {
  const isRoot = node?.depth === 0;
  const [f, setF] = useState(() => ({
    title: node?.title ?? '',
    summary: node?.summary ?? '',
    body: node?.body ?? '',
    kind: node?.kind ?? draft?.kind ?? 'task',
    status: node?.status ?? 'planned',
    health: node?.health ?? 'auto',
    definition: node?.definition ?? 'auto',
    priority: node?.priority ?? '',
    assignee: node?.assignee ?? '',
    estimate: node?.estimate ?? '',
    due: node?.due ?? '',
    tags: (node?.tags ?? (draft?.kind === 'story' ? ['new-feature'] : [])).join(', '),
    parentId: node?.parent?.id ?? draft?.parentId ?? 'root',
    links: node?.links ?? [],
    url: node?.url ?? '',
    place: node?.place ?? 'auto',
    surface: node?.surface ?? 'auto',
  }));
  const [preview, setPreview] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [linkTarget, setLinkTarget] = useState('');
  const [linkType, setLinkType] = useState('depends');
  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }));

  const parents = useMemo(() => tree.list.filter((n) => !node || !isInside(n, node)), [tree, node]);
  const titleIndex = useMemo(() => {
    const m = new Map();
    for (const n of tree.list) if (n !== node) m.set(`${n.title} — ${n.parent?.title ?? 'project'}`, n.id);
    return m;
  }, [tree, node]);
  const listId = useId();
  const placeLabelId = useId();

  // Where it sits in the Site projection: its own continent (top level only), or a spot inside its parent.
  const site = useMemo(() => resolveSite(tree), [tree]);
  const parent = tree.byId.get(f.parentId) ?? tree.root;
  const topLevel = !isRoot && parent.depth === 0;
  const probe = { title: f.title, tags: f.tags.split(',').map((t) => t.trim().toLowerCase()) };
  const surfaceGuess = guessSurface(probe);
  const surface = topLevel ? (f.surface === 'auto' ? surfaceGuess : f.surface) : 'none';
  const grammar = site.grammar.get(parent.id) ?? 'web';
  let placeGuess = guessPlace(probe, grammar);
  if (parent.depth > 0 && placeGuess === site.places.get(parent.id)) placeGuess = 'center';

  const addLink = () => {
    const to = titleIndex.get(linkTarget);
    if (!to || f.links.some((l) => l.to === to && l.type === linkType)) return;
    setF((p) => ({ ...p, links: [...p.links, { to, type: linkType, label: '' }] }));
    setLinkTarget('');
  };

  const submit = (e) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    const out = {
      ...f,
      title: f.title.trim(),
      estimate: f.estimate === '' ? null : Number(f.estimate),
      tags: f.tags,
    };
    if (isRoot) {
      delete out.parentId;
      delete out.kind;
      delete out.place;
      delete out.surface;
    }
    onSave(out);
  };

  return (
    <form className="editor" onSubmit={submit}>
      <header className="panel-head">
        <div>
          <div className="eyebrow">{node ? `Edit ${KIND_LABEL[node.kind].toLowerCase()}` : `New ${KIND_LABEL[f.kind].toLowerCase()}`}</div>
        </div>
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="Cancel editing">
          <Icon name="close" />
        </button>
      </header>

      <Field label="Title" wide>
        {(id) => <input id={id} value={f.title} onChange={set('title')} required autoFocus maxLength={200} placeholder="What is this?" />}
      </Field>
      <Field label="Summary" wide hint="One or two sentences. Shown on the map when zoomed in.">
        {(id) => <textarea id={id} rows={2} value={f.summary} onChange={set('summary')} maxLength={1000} />}
      </Field>

      <div className="grid2">
        {!isRoot && (
          <Field label="Kind">
            {(id) => (
              <select id={id} value={f.kind} onChange={set('kind')}>
                {KINDS.filter((k) => k !== 'project').map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label="Status">
          {(id) => (
            <select id={id} value={f.status} onChange={set('status')}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Health">
          {(id) => (
            <select id={id} value={f.health} onChange={set('health')}>
              {HEALTH.map((h) => (
                <option key={h} value={h}>
                  {HEALTH_TEXT[h]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Priority">
          {(id) => (
            <select id={id} value={f.priority} onChange={set('priority')}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p || 'None'}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Owner">{(id) => <input id={id} value={f.assignee} onChange={set('assignee')} placeholder="handle" maxLength={80} />}</Field>
        <Field label="Estimate (pts)">
          {(id) => <input id={id} type="number" min="0" step="0.5" value={f.estimate} onChange={set('estimate')} inputMode="decimal" />}
        </Field>
        <Field label="Due">{(id) => <input id={id} type="date" value={f.due} onChange={set('due')} />}</Field>
        <Field label="Definition">
          {(id) => (
            <select id={id} value={f.definition} onChange={set('definition')}>
              {DEFINITION.map((d) => (
                <option key={d} value={d}>
                  {DEF_TEXT[d]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <Field label="Tags" wide hint='Comma separated. "new-feature" lights a story up on the New features map; "page" marks a site page.'>
        {(id) => <input id={id} value={f.tags} onChange={set('tags')} placeholder="new-feature, page, a11y" />}
      </Field>

      {!isRoot && (
        <Field label="Inside" wide hint="Move this to another place on the map.">
          {(id) => (
            <select id={id} value={f.parentId} onChange={set('parentId')}>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {' '.repeat(p.depth)}
                  {p.title}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      {topLevel && (
        <Field label="Its own continent?" wide hint="Web and mobile apps, APIs, services and third parties can each be a continent shaped like what they are.">
          {(id) => (
            <select id={id} value={f.surface} onChange={set('surface')}>
              {SURFACES.map((v) => (
                <option key={v} value={v}>
                  {v === 'auto' ? `Automatic (${surfaceGuess === 'none' ? 'no' : SURFACE_LABEL[surfaceGuess].toLowerCase()})` : SURFACE_LABEL[v]}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      {!isRoot && surface === 'none' && (
        <div className="field wide">
          <label id={placeLabelId}>Where it sits</label>
          <PlacePicker
            value={f.place}
            guess={placeGuess}
            back={grammar === 'back'}
            labelId={placeLabelId}
            onChange={(place) => setF((p) => ({ ...p, place }))}
          />
          <small>
            {grammar === 'back'
              ? `Roughly where it sits inside “${parent.title}”: entry points on top, storage at the bottom.`
              : `Roughly where it sits on screen inside “${parent.title}”. The Site layout puts it there.`}
          </small>
        </div>
      )}

      <div className="field wide">
        <div className="label-row">
          <label>Details (Markdown)</label>
          <button type="button" className="link-btn" onClick={() => setPreview((p) => !p)}>
            {preview ? 'Write' : 'Preview'}
          </button>
        </div>
        {preview ? (
          <div className="md-preview">
            <Markdown text={f.body || '_Nothing yet._'} />
          </div>
        ) : (
          <textarea
            aria-label="Details in Markdown"
            rows={8}
            value={f.body}
            onChange={set('body')}
            maxLength={20000}
            placeholder={'Context, decisions, links…\n\n**Acceptance criteria**\n\n- [ ] …'}
          />
        )}
      </div>

      {!isRoot && (
        <div className="field wide">
          <label>Connections</label>
          <ul className="link-list">
            {f.links.map((l, i) => (
              <li key={`${l.type}${l.to}`}>
                <span>
                  {LINK_LABEL[l.type]} <strong>{tree.byId.get(l.to)?.title ?? 'missing'}</strong>
                </span>
                <button
                  type="button"
                  className="icon-btn small"
                  aria-label="Remove connection"
                  onClick={() => setF((p) => ({ ...p, links: p.links.filter((_, j) => j !== i) }))}
                >
                  <Icon name="close" size={16} />
                </button>
              </li>
            ))}
          </ul>
          <div className="link-add">
            <select aria-label="Connection type" value={linkType} onChange={(e) => setLinkType(e.target.value)}>
              {LINK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {LINK_LABEL[t]}
                </option>
              ))}
            </select>
            <input aria-label="Connect to" list={listId} value={linkTarget} onChange={(e) => setLinkTarget(e.target.value)} placeholder="Type to find an item…" />
            <datalist id={listId}>
              {[...titleIndex.keys()].map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <button type="button" onClick={addLink} disabled={!titleIndex.has(linkTarget)}>
              Add
            </button>
          </div>
        </div>
      )}

      <div className="editor-actions">
        {node && !isRoot && onDelete && (
          <button
            type="button"
            className={`danger${confirmDelete ? ' armed' : ''}`}
            onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
            onBlur={() => setConfirmDelete(false)}
          >
            <Icon name="trash" size={18} />
            {confirmDelete ? `Delete${node.children.length ? ` with ${node.stats.items - 1} inside` : ''}?` : 'Delete'}
          </button>
        )}
        <span className="spacer" />
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy || !f.title.trim()}>
          {busy ? 'Saving…' : node ? 'Save' : 'Create'}
        </button>
      </div>
    </form>
  );
}
