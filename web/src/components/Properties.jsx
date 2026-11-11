import { useEffect, useId, useMemo, useState } from 'react';
import { DEFINITION, HEALTH, KINDS, KIND_LABEL, LINK_LABEL, LINK_TYPES, PLACE_LABEL, PRIORITIES, STATUSES, STATUS_LABEL, SURFACES, SURFACE_LABEL } from '@shared/schema.js';
import { isInside } from '../model/tree.js';
import { guessPlace, guessSurface, resolveSite } from '../map/places.js';
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

/** One property: its name and its control, side by side. */
function Row({ label, children }) {
  const id = useId();
  return (
    <div className="prop">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

function Choice({ label, value, options, text, onChange }) {
  return (
    <Row label={label}>
      {(id) => (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {text(o)}
            </option>
          ))}
        </select>
      )}
    </Row>
  );
}

/** Typed text, kept when you leave the field or press Enter, so a property isn't written on every keystroke. */
function Text({ label, value, onChange, ...props }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const commit = () => v !== (value ?? '') && onChange(v);
  return (
    <Row label={label}>
      {(id) => <input id={id} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} {...props} />}
    </Row>
  );
}

/**
 * An item's properties, changed where they are (#41 EDIT-11): each change is kept as soon as it is made.
 * The most used ones show; the rest are one click away.
 */
export function Properties({ node, tree, onPatch }) {
  const isRoot = node.depth === 0;
  const [open, setOpen] = useState(false);
  const site = useMemo(() => resolveSite(tree), [tree]);
  const parents = useMemo(() => tree.list.filter((n) => !isInside(n, node)), [tree, node]);
  const placeLabelId = useId();
  const parent = node.parent ?? tree.root;
  const topLevel = !isRoot && parent.depth === 0;
  const probe = { title: node.title, tags: node.tags };
  const surfaceGuess = guessSurface(probe);
  const surface = topLevel ? (!node.surface || node.surface === 'auto' ? surfaceGuess : node.surface) : 'none';
  const grammar = site.grammar.get(parent.id) ?? 'web';
  let placeGuess = guessPlace(probe, grammar);
  if (parent.depth > 0 && placeGuess === site.places.get(parent.id)) placeGuess = 'center';
  const set = (k) => (v) => onPatch({ [k]: v });

  return (
    <div className="props">
      {!isRoot && <Choice label="Kind" value={node.kind} options={KINDS.filter((k) => k !== 'project')} text={(k) => KIND_LABEL[k]} onChange={set('kind')} />}
      <Choice label="Status" value={node.status} options={STATUSES} text={(s) => STATUS_LABEL[s]} onChange={set('status')} />
      <Choice label="Priority" value={node.priority ?? ''} options={PRIORITIES} text={(p) => p || 'None'} onChange={set('priority')} />
      <Text label="Owner" value={node.assignee} onChange={set('assignee')} placeholder="handle" maxLength={80} />
      <button type="button" className="link-btn props-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? 'Fewer properties' : 'More properties'}
      </button>
      {open && (
        <>
          <Text label="Estimate" value={node.estimate ?? ''} onChange={(v) => onPatch({ estimate: v === '' ? null : Number(v) })} type="number" min="0" step="0.5" inputMode="decimal" />
          <Text label="Due" value={node.due} onChange={set('due')} type="date" />
          <Text label="Tags" value={(node.tags ?? []).join(', ')} onChange={set('tags')} placeholder="new-feature, page, a11y" />
          <Choice label="Health" value={node.health ?? 'auto'} options={HEALTH} text={(h) => HEALTH_TEXT[h]} onChange={set('health')} />
          <Choice label="Definition" value={node.definition ?? 'auto'} options={DEFINITION} text={(d) => DEF_TEXT[d]} onChange={set('definition')} />
          <Text label="Summary" value={node.summary} onChange={set('summary')} maxLength={1000} placeholder="One or two sentences" />
          {!isRoot && (
            <Row label="Inside">
              {(id) => (
                <select id={id} value={parent.id} onChange={(e) => onPatch({ parentId: e.target.value })}>
                  {parents.map((p) => (
                    <option key={p.id} value={p.id}>
                      {' '.repeat(p.depth)}
                      {p.title}
                    </option>
                  ))}
                </select>
              )}
            </Row>
          )}
          {topLevel && (
            <Choice
              label="Continent"
              value={node.surface ?? 'auto'}
              options={SURFACES}
              text={(v) => (v === 'auto' ? `Automatic (${surfaceGuess === 'none' ? 'no' : SURFACE_LABEL[surfaceGuess].toLowerCase()})` : SURFACE_LABEL[v])}
              onChange={set('surface')}
            />
          )}
          {!isRoot && surface === 'none' && (
            <div className="prop prop-wide">
              <label id={placeLabelId}>Where it sits</label>
              <PlacePicker value={node.place ?? 'auto'} guess={placeGuess} back={grammar === 'back'} labelId={placeLabelId} onChange={set('place')} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Add a connection from this item to another, found by typing its name. */
export function AddLink({ node, tree, onPatch }) {
  const [target, setTarget] = useState('');
  const [type, setType] = useState('depends');
  const listId = useId();
  const index = useMemo(() => {
    const m = new Map();
    for (const n of tree.list) if (n !== node) m.set(`${n.title} — ${n.parent?.title ?? 'project'}`, n.id);
    return m;
  }, [tree, node]);
  const add = () => {
    const to = index.get(target);
    if (!to || node.links.some((l) => l.to === to && l.type === type)) return;
    onPatch({ links: [...node.links, { to, type, label: '' }] });
    setTarget('');
  };
  return (
    <div className="link-add">
      <select aria-label="Connection type" value={type} onChange={(e) => setType(e.target.value)}>
        {LINK_TYPES.map((t) => (
          <option key={t} value={t}>
            {LINK_LABEL[t]}
          </option>
        ))}
      </select>
      <input aria-label="Connect to" list={listId} value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Connect to…" />
      <datalist id={listId}>
        {[...index.keys()].map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <button type="button" onClick={add} disabled={!index.has(target)} aria-label="Add connection">
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}
