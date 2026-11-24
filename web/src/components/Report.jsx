// Report a bug, from the Bugs lens (#9 REPORT-01 to REPORT-04): say what happened in the document's own editor, add
// screenshots, and the map suggests where it lands, by meaning (REPORT-02) and by what is in view (REPORT-03). Sent, it is a
// draft bug in its own refinement with a thread addressed to agents, who ask there until it is exact (REPORT-05).

import { useEffect, useMemo, useRef, useState } from 'react';
import { itemKeyOf } from '@shared/issue-shape.js';
import { PHOTO_TYPES } from '@shared/photos.js';
import { Box } from '../editor/Annotate.jsx';
import { api } from '../api.js';
import { behaviourVectors, loadEmbedder } from '../model/embedder.js';
import { nearView, placeReport } from '../model/placement.js';
import { pathOf } from '../model/tree.js';
import { encode } from './Photos.jsx';
import { Icon } from './Icon.jsx';

const PLACE_AFTER_MS = 600; // place it once the reporter pauses

/**
 * @param {{ projectId: string, tree: object, focusId: string | null, inView: (n: object) => boolean, name: string,
 *   onSent: (node: object) => void, onClose: () => void, fail: (err: Error) => void }} p
 */
export function Report({ projectId, tree, focusId, inView, name, onSent, onClose, fail }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [shots, setShots] = useState([]); // { file, url }
  const [over, setOver] = useState(false);
  const [model, setModel] = useState({ state: 'loading' }); // loading | ready | words, with embed and vectors when ready
  const [suggested, setSuggested] = useState({ by: 'words', places: [] });
  const [place, setPlace] = useState(null); // the item it lands under, chosen or the first suggestion
  const [broken, setBroken] = useState([]); // behaviour ids, with the item each is on: { id, key }
  const [sending, setSending] = useState(false);
  const near = useMemo(() => nearView(tree, focusId, inView), [tree, focusId]); // eslint-disable-line react-hooks/exhaustive-deps
  const urls = useRef([]);

  // The model and the project's vectors load once Report opens, and only then (REPORT-02).
  useEffect(() => {
    let live = true;
    Promise.all([loadEmbedder(), behaviourVectors(projectId)])
      .then(([embedder, vectors]) => live && setModel(vectors.size ? { state: 'ready', embedder, vectors } : { state: 'words', why: 'This project has no behaviour vectors yet.' }))
      .catch(() => live && setModel({ state: 'words', why: 'The model couldn’t load here.' }));
    return () => {
      live = false;
    };
  }, [projectId]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  // Suggestions follow the words, once the reporter pauses.
  useEffect(() => {
    const words = `${title}\n${text}`.trim();
    let live = true;
    const t = setTimeout(async () => {
      let vector = null;
      if (model.state === 'ready' && words) vector = await model.embedder.embed(words).catch(() => null);
      if (live) setSuggested(placeReport(tree, words, vector ? { vector, vectors: model.vectors } : {}));
    }, PLACE_AFTER_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [title, text, model, tree]);

  const landing = place ?? suggested.places[0]?.node ?? null;
  const toggle = (id, node) => setBroken((bs) => (bs.some((b) => b.id === id) ? bs.filter((b) => b.id !== id) : [...bs, { id, key: itemKeyOf(node) }]));
  const choose = (node) => setPlace(node);

  function addFiles(list) {
    const files = [...(list ?? [])].filter((f) => PHOTO_TYPES.includes(f.type));
    if (!files.length) return;
    const added = files.map((file) => ({ file, url: URL.createObjectURL(file) }));
    urls.current.push(...added.map((s) => s.url));
    setShots((ss) => [...ss, ...added]);
  }

  async function send() {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      const keys = [...new Set(broken.map((b) => b.key))];
      const { node } = await api.report(projectId, { title: title.trim(), text: text.trim(), parentId: landing?.id, behaviours: broken.map((b) => b.id), items: keys, author: name || 'Someone' });
      const key = itemKeyOf(node);
      for (const { file } of shots) {
        await api.addPhoto(projectId, { itemKey: key, data: await encode(file), by: name || 'Someone', source: 'upload', ...(file.name && !/^image\.\w+$/.test(file.name) ? { caption: file.name.replace(/\.\w+$/, '').slice(0, 200) } : {}) });
      }
      onSent(node);
    } catch (err) {
      fail(err);
    } finally {
      setSending(false);
    }
  }

  const where = (node) => pathOf(node).slice(1, -1).map((p) => p.title).join(' › ') || 'Project';
  const status =
    model.state === 'loading' ? 'Loading the model to place it by meaning (once, about 34 MB)…' : model.state === 'ready' ? 'Placed by meaning, from the behaviours’ own words.' : `Placed by shared words: ${model.why}`;

  return (
    <div className="details report">
      <header className="panel-head">
        <div>
          <div className="eyebrow">
            <span aria-hidden="true">🐞</span> Bugs
          </div>
          <h2 className="node-title">Report a bug</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close the report">
          <Icon name="close" />
        </button>
      </header>
      <p className="summary">Say what happened. The map finds where it lands, and an agent asks you here what it needs to make it exact.</p>

      <input className="report-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="In a line: what's wrong" aria-label="Title" maxLength={200} />
      <Box value={text} onChange={setText} onSubmit={send} label="What happened" placeholder="What you did, what you expected, and what happened instead" autoFocus className="report-text" />

      <section className="photos" aria-label="Screenshots">
        <div className="photo-strip">
          {shots.map((s) => (
            <span key={s.url} className="photo-thumb">
              <img src={s.url} alt={s.file.name || 'Screenshot'} />
              <button type="button" className="report-unshot" aria-label="Remove this screenshot" onClick={() => setShots((ss) => ss.filter((x) => x !== s))}>
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
          <label
            className={`photo-add${over ? ' over' : ''}`}
            tabIndex={0}
            onDragOver={(e) => (e.preventDefault(), setOver(true))}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              addFiles(e.dataTransfer?.files);
            }}
            onPaste={(e) => e.clipboardData?.files?.length && (e.preventDefault(), addFiles(e.clipboardData.files))}
          >
            <Icon name="camera" size={18} />
            <span>Add a screenshot</span>
            <small>drop, paste or + browse</small>
            <input type="file" multiple accept={PHOTO_TYPES.join(',')} className="sr-only" onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
          </label>
        </div>
      </section>

      <section className="report-where" aria-label="Where it lands">
        <h3>Where it lands</h3>
        <p className="match-count">{status}</p>
        {landing ? (
          <p className="report-landing">
            Under <strong>{landing.title}</strong>
            {broken.length > 0 && <>, breaking {broken.map((b) => b.id).join(', ')}</>}
          </p>
        ) : (
          <p className="empty-note">Write what happened, or pick a place below.</p>
        )}
        <PlaceList title="Suggested" places={suggested.places} landing={landing} broken={broken} where={where} onChoose={choose} onToggle={toggle} />
        {near.length > 0 && <PlaceList title="In view" places={near} landing={landing} broken={broken} where={where} onChoose={choose} onToggle={toggle} />}
      </section>

      <div className="edit-actions report-actions">
        <button type="button" className="primary" onClick={send} disabled={!text.trim() || sending}>
          {sending ? 'Sending…' : 'Send report'}
        </button>
        <button type="button" className="link-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Places to land on, each with its behaviours as one-tap links (REPORT-03). */
function PlaceList({ title, places, landing, broken, where, onChoose, onToggle }) {
  if (!places.length) return null;
  return (
    <>
      <h4 className="report-list-title">{title}</h4>
      <ul className="rows report-places">
        {places.map(({ node, behaviours }) => (
          <li key={node.id} className={`report-place${landing?.id === node.id ? ' on' : ''}`}>
            <button type="button" className="row" aria-pressed={landing?.id === node.id} onClick={() => onChoose(node)}>
              <span className="row-main">
                <span className="row-title">{node.title}</span>
                <span className="row-sub">{where(node)}</span>
              </span>
              {landing?.id === node.id && <Icon name="check" size={14} />}
            </button>
            {behaviours.length > 0 && (
              <div className="filter-chips">
                {behaviours.slice(0, 6).map((b) => {
                  const on = broken.some((x) => x.id === b.id);
                  return (
                    <button key={b.id} type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on} title={b.words} onClick={() => (onToggle(b.id, node), landing || onChoose(node))}>
                      {b.id}
                    </button>
                  );
                })}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
