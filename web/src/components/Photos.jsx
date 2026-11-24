// An item's Photos (#16): screenshots of the running app, with comments pinned on them. Click a spot to pin a comment
// there, or drag to pin one on a region (SHOT-01); a pin is a comment like any other (#15), so @Claude hands it to an
// agent with the image (SHOT-03). A newer screenshot replaces an old one and keeps its pins, marked possibly out of date
// until someone confirms or moves them (SHOT-02). Wherever a screenshot came from, it is shown and pinned the same way
// (SHOT-04): chosen, pasted, or dropped here by a person, or by an agent driving a browser.

import { useEffect, useMemo, useRef, useState } from 'react';
import { initials, isDismissed, threadsOf } from '@shared/annotations.js';
import { MAX_PHOTO_BYTES, PHOTO_TYPES, SOURCE_WORDS, isStale, photoName } from '@shared/photos.js';
import { Composer, Thread } from '../editor/Annotate.jsx';
import { api } from '../api.js';
import { Icon } from './Icon.jsx';

const LONGEST = 2560; // pixels: bigger screenshots are scaled down before they are sent
const shown = new Map(); // `${project}/${photo}/${version}` -> an object URL, so a screenshot loads once

/** A screenshot as the API takes it: base64, scaled down and re-encoded when it is too big to send as it is. */
export async function encode(file) {
  if (!PHOTO_TYPES.includes(file.type)) throw new Error('That isn’t a PNG, JPEG, WebP or GIF screenshot');
  const bitmap = await createImageBitmap(file).catch(() => null);
  const fits = file.size <= MAX_PHOTO_BYTES * 0.7 && (!bitmap || Math.max(bitmap.width, bitmap.height) <= LONGEST);
  let blob = file;
  if (!fits && bitmap) {
    const scale = Math.min(1, LONGEST / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await new Promise((done) => canvas.toBlob(done, 'image/webp', 0.9));
    if (!blob || blob.type !== 'image/webp') blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', 0.88));
  }
  bitmap?.close?.();
  if (blob.size > MAX_PHOTO_BYTES) throw new Error('That screenshot is too big, even scaled down');
  return new Promise((done, failed) => {
    const r = new FileReader();
    r.onload = () => done(String(r.result));
    r.onerror = () => failed(new Error('Couldn’t read that file'));
    r.readAsDataURL(blob);
  });
}

/** The screenshot itself, loaded once per version. */
function useShot(projectId, photo) {
  const at = photo && `${projectId}/${photo.id}/${photo.version}`;
  const [src, setSrc] = useState(() => (at ? shown.get(at) : null));
  useEffect(() => {
    if (!at) return undefined;
    if (shown.has(at)) return setSrc(shown.get(at));
    let live = true;
    setSrc(null);
    api.photo(projectId, photo.itemKey, photo.id).then(
      ({ photo: p, data }) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: p.mime }));
        shown.set(at, url);
        if (live) setSrc(url);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [at, projectId, photo?.itemKey, photo?.id]);
  return src;
}

function Thumb({ projectId, photo, pins, selected, onPick }) {
  const src = useShot(projectId, photo);
  const stale = pins.filter((t) => isStale(t.root.anchor, photo)).length;
  return (
    <button type="button" className={`photo-thumb${selected ? ' selected' : ''}`} onClick={onPick} aria-pressed={selected} title={photoName(photo)}>
      {src ? <img src={src} alt={photoName(photo)} /> : <span className="photo-loading" />}
      {pins.length > 0 && (
        <span className={`photo-count${stale ? ' stale' : ''}`} aria-label={`${pins.length} comment${pins.length === 1 ? '' : 's'}${stale ? `, ${stale} possibly out of date` : ''}`}>
          {pins.length}
        </span>
      )}
    </button>
  );
}

/** Where a pointer is on the screenshot, as fractions of its width and height. */
const fractionAt = (el, e) => {
  const r = el.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
};
const round = (f) => Math.round(f * 10000) / 10000;
const box = (a, b) => ({ x: round(Math.min(a.x, b.x)), y: round(Math.min(a.y, b.y)), w: round(Math.abs(a.x - b.x)), h: round(Math.abs(a.y - b.y)) });
const placeOf = (s) => ({ left: `${s.x * 100}%`, top: `${s.y * 100}%`, ...(s.w != null ? { width: `${s.w * 100}%`, height: `${s.h * 100}%` } : {}) });

/** One screenshot, big, with its pins: click or drag on it to pin a comment. */
function Viewer({ projectId, photo, pins, editing, onReplace, onRemove }) {
  const src = useShot(projectId, photo);
  const surface = useRef(null);
  const [drag, setDrag] = useState(null); // { from, to } while a region is being drawn
  const [writing, setWriting] = useState(null); // the spot a new comment goes on
  const [open, setOpen] = useState(null); // the thread shown
  const [moving, setMoving] = useState(null); // a pin being moved: the next click puts it there
  const thread = pins.find((t) => t.root.id === open);
  const key = photo.itemKey;

  const down = (e) => {
    if (e.button !== 0 || e.target.closest('.photo-pin')) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const at = fractionAt(surface.current, e);
    setDrag({ from: at, to: at });
  };
  const move = (e) => drag && setDrag({ ...drag, to: fractionAt(surface.current, e) });
  const up = async () => {
    if (!drag) return;
    const region = box(drag.from, drag.to);
    // A drag of less than about 2% is a click: a spot, not a region.
    const spot = region.w > 0.02 && region.h > 0.02 ? region : { x: round(drag.to.x), y: round(drag.to.y) };
    setDrag(null);
    if (moving) {
      const t = pins.find((p) => p.root.id === moving);
      setMoving(null);
      if (t && (await editing.movePin(t.root, spot))) setOpen(t.root.id);
      return;
    }
    setOpen(null);
    setWriting(spot);
  };
  const keyOn = (e) => {
    // From the keyboard: Enter pins a comment in the middle, to move it after.
    if (e.key === 'Enter' && e.target === surface.current) setWriting({ x: 0.5, y: 0.5 });
  };

  const stale = thread && isStale(thread.root.anchor, photo);
  return (
    <div className="photo-viewer">
      <div className="photo-tools">
        <span className="photo-name" title={`${SOURCE_WORDS[photo.source] ?? 'added'} by ${photo.addedBy}`}>
          {photoName(photo)}
          {photo.version > 1 && <span className="photo-version"> · version {photo.version}</span>}
        </span>
        <label className="link-btn photo-replace">
          Replace with a newer one
          <input type="file" accept={PHOTO_TYPES.join(',')} className="sr-only" onChange={(e) => e.target.files[0] && onReplace(e.target.files[0], (e.target.value = ''))} />
        </label>
        {!pins.length && (
          <button type="button" className="link-btn" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      <p className="photo-hint">{moving ? 'Click where it belongs now.' : 'Click a spot, or drag over a region, to pin a comment there.'}</p>
      <div
        ref={surface}
        className={`photo-surface${moving ? ' moving' : ''}`}
        tabIndex={0}
        role="application"
        aria-label={`${photoName(photo)}: click a spot to pin a comment`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={keyOn}
      >
        {src ? <img src={src} alt={photoName(photo)} draggable={false} /> : <div className="photo-loading big" style={{ aspectRatio: `${photo.width} / ${photo.height}` }} />}
        {pins.map((t) => {
          const a = t.root.anchor;
          const old = isStale(a, photo);
          return (
            <button
              key={t.root.id}
              type="button"
              className={`photo-pin${a.w != null ? ' region' : ''}${old ? ' stale' : ''}${open === t.root.id ? ' open' : ''}`}
              style={placeOf(a)}
              onClick={() => (setWriting(null), setOpen(open === t.root.id ? null : t.root.id))}
              aria-label={`Comment by ${t.root.author}${old ? ', possibly out of date' : ''}`}
              title={old ? 'Pinned on an older screenshot: possibly out of date' : t.root.text}
            >
              <span className="note-initials">{old ? '?' : initials(t.root.author)}</span>
            </button>
          );
        })}
        {writing && <span className={`photo-pin draft${writing.w != null ? ' region' : ''}`} style={placeOf(writing)} />}
        {drag && <span className="photo-pin draft region" style={placeOf(box(drag.from, drag.to))} />}
      </div>
      {writing && (
        <Composer
          heading={photoName(photo)}
          what={writing.w != null ? 'this region of the screenshot' : 'this spot on the screenshot'}
          onPost={(said) => editing.comment(key, { on: 'image', photo: photo.id, ...writing }, said)}
          onCancel={() => setWriting(null)}
        />
      )}
      {thread && (
        <>
          {stale && (
            <div className="photo-stale" role="status">
              <span>The screenshot was replaced since this was pinned, so it may be out of date.</span>
              <button type="button" className="link-btn" onClick={() => editing.movePin(thread.root)}>
                Still right here
              </button>
              <button type="button" className="link-btn" onClick={() => setMoving(thread.root.id)}>
                Move it
              </button>
            </div>
          )}
          <Thread
            heading={photoName(photo)}
            what={thread.root.anchor.w != null ? 'A region of the screenshot' : 'A spot on the screenshot'}
            thread={thread}
            onReply={(said) => editing.comment(key, thread.root.anchor, said, { replyTo: thread.root.id })}
            onPromote={editing.promote}
            onDismiss={editing.dismiss}
            onClose={() => setOpen(null)}
          />
        </>
      )}
    </div>
  );
}

/** The Photos of one item: its screenshots, a place to add one, and the one being looked at. */
export function Photos({ itemKey, comments, editing }) {
  const projectId = editing.projectId;
  const [photos, setPhotos] = useState(null);
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  useEffect(() => {
    let live = true;
    setPhotos(null);
    setPicked(null);
    api.photos(projectId, itemKey).then((r) => live && setPhotos(r.photos), () => live && setPhotos([]));
    return () => {
      live = false;
    };
  }, [projectId, itemKey]);

  const pinsOf = useMemo(() => {
    const by = new Map();
    for (const t of threadsOf(comments.filter((c) => c.anchor?.photo))) if (!isDismissed(t.root)) by.set(t.root.anchor.photo, [...(by.get(t.root.anchor.photo) ?? []), t]);
    return (p) => by.get(p.id) ?? [];
  }, [comments]);

  async function add(file, replaces = null) {
    if (!file || busy) return;
    setBusy(true);
    try {
      const data = await encode(file);
      const { photo } = await api.addPhoto(projectId, { itemKey, data, by: editing.name || 'Someone', source: 'upload', ...(replaces ? { replaces: replaces.id } : {}), ...(!replaces && file.name && !/^image\.\w+$/.test(file.name) ? { caption: file.name.replace(/\.\w+$/, '').slice(0, 200) } : {}) });
      setPhotos((ps) => [...(ps ?? []).filter((p) => p.id !== photo.id), photo]);
      setPicked(photo.id);
      if (replaces && pinsOf(replaces).length) editing.toast?.('Replaced. Its pins stay, marked possibly out of date until someone confirms or moves them.');
    } catch (err) {
      editing.fail?.(err);
    } finally {
      setBusy(false);
    }
  }
  async function remove(photo) {
    try {
      await api.deletePhoto(projectId, photo);
      setPhotos((ps) => ps.filter((p) => p.id !== photo.id));
      setPicked(null);
    } catch (err) {
      editing.fail?.(err);
    }
  }
  const fromEvent = (list) => [...(list ?? [])].find((f) => f.type?.startsWith('image/'));

  const selected = photos?.find((p) => p.id === picked);
  return (
    <section className="photos" aria-label="Photos">
      <h3>
        Photos{photos?.length ? <span className="photos-count"> {photos.length}</span> : null}
      </h3>
      <div className="photo-strip">
        {photos?.map((p) => (
          <Thumb key={p.id} projectId={projectId} photo={p} pins={pinsOf(p)} selected={p.id === picked} onPick={() => setPicked(p.id === picked ? null : p.id)} />
        ))}
        <label
          className={`photo-add${over ? ' over' : ''}${busy ? ' busy' : ''}`}
          tabIndex={0}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            add(fromEvent(e.dataTransfer?.files));
          }}
          onPaste={(e) => {
            const file = fromEvent(e.clipboardData?.files);
            if (file) e.preventDefault(), add(file);
          }}
        >
          <Icon name="camera" size={18} />
          <span>{busy ? 'Adding…' : 'Add a screenshot'}</span>
          <small>drop, paste or choose</small>
          <input type="file" accept={PHOTO_TYPES.join(',')} className="sr-only" onChange={(e) => add(e.target.files[0], (e.target.value = '', null))} />
        </label>
      </div>
      {selected && <Viewer key={selected.id} projectId={projectId} photo={selected} pins={pinsOf(selected)} editing={editing} onReplace={(file) => add(file, selected)} onRemove={() => remove(selected)} />}
    </section>
  );
}
