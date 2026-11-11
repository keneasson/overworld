import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { itemKeyOf } from '@shared/issue-shape.js';
import { KIND_LABEL } from '@shared/schema.js';
import { api, AuthError, setAccessKey, storage } from './api.js';
import { buildScene } from './map/scene.js';
import { MapView } from './map/MapView.jsx';
import { LENS_BY_ID } from './map/lenses.js';
import { Breadcrumbs, Chips, Hint, LayerButton, Legend, MapControls, SearchBar, Toasts } from './components/Chrome.jsx';
import { Details, Results } from './components/Panel.jsx';
import { useItemEditing } from './editor/useItemEditing.js';
import { Drawer, Unlock } from './components/Drawer.jsx';
import { Icon } from './components/Icon.jsx';

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const v = p.get('v')?.split(',').map(Number);
  return {
    p: p.get('p'),
    n: p.get('n'),
    lens: p.get('lens'),
    routes: p.get('routes') === '1',
    proj: p.get('proj'),
    view: v?.length === 3 && v.every(Number.isFinite) ? { cx: v[0], cy: v[1], k: v[2] } : null,
  };
}

const PANEL_KEY = 'projectmap.panelWidth';
const PANEL_MIN = 400;
const maxWidth = () => Math.max(PANEL_MIN, window.innerWidth - 220);
const wideWidth = () => Math.min(900, maxWidth());
function readWidth() {
  try {
    const w = Number(localStorage.getItem(PANEL_KEY));
    return w >= PANEL_MIN ? Math.min(w, maxWidth()) : PANEL_MIN;
  } catch {
    return PANEL_MIN;
  }
}

function useMedia(query) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

export function App() {
  const initial = useRef(readHash()).current;
  const [locked, setLocked] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const [projects, setProjects] = useState(null);
  const [projectId, setProjectId] = useState(initial.p);
  const [data, setData] = useState(null);
  const [lensId, setLensId] = useState(LENS_BY_ID[initial.lens] ? initial.lens : 'map');
  const [showLinks, setShowLinks] = useState(initial.routes);
  const [projection, setProjection] = useState(() => {
    const p = initial.proj ?? storage.get('projectmap.projection');
    return p === 'organic' ? 'organic' : 'site';
  });
  const [selectedId, setSelectedId] = useState(initial.n);
  const [comments, setComments] = useState([]);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [focusId, setFocusId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [sheetFull, setSheetFull] = useState(false);
  const [panelW, setPanelW] = useState(() => readWidth());
  const [hint, setHint] = useState(() => !storage.get('projectmap.hint'));
  const mapRef = useRef(null);
  const sceneRef = useRef(null);
  const pendingFly = useRef(initial.n && !initial.view ? initial.n : null);
  const mobile = useMedia('(max-width: 720px)');

  const toast = useCallback((text, kind) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const fail = useCallback(
    (err) => {
      if (err instanceof AuthError) setLocked(true);
      else toast(err.message, 'error');
    },
    [toast],
  );

  const loadProjects = useCallback(async () => {
    try {
      const { projects } = await api.listProjects();
      setProjects(projects);
      setLocked(false);
      return projects;
    } catch (err) {
      fail(err);
      return null;
    }
  }, [fail]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!projects) return;
    if (!projects.length) setData(null);
    else if (!projectId || !projects.some((p) => p.id === projectId)) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => {
    if (!projectId || !projects?.some((p) => p.id === projectId)) return;
    let cancelled = false;
    api
      .getProject(projectId)
      .then((d) => !cancelled && setData(d))
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [projectId, projects, fail]);

  // Comments load one item at a time, when its details or its editor column open; a large project never
  // pays for every thread up front. `commentsFor` remembers which items it has asked for.
  const commentsFor = useRef(new Set());
  useEffect(() => {
    setComments([]);
    commentsFor.current = new Set();
  }, [projectId]);
  const loadComments = useCallback(
    (keys) => {
      const pid = projectId;
      for (const key of keys) {
        if (commentsFor.current.has(key)) continue;
        commentsFor.current.add(key);
        api
          .itemComments(pid, key)
          .then((d) => latest.current.projectId === pid && setComments((cs) => [...cs.filter((c) => c.itemKey !== key), ...d.comments]))
          .catch((err) => {
            commentsFor.current.delete(key);
            fail(err);
          });
      }
    },
    [projectId, fail],
  );

  const scene = useMemo(() => {
    if (!data) return null;
    const s = buildScene(data.nodes, data.project.id, sceneRef.current, projection);
    sceneRef.current = s;
    return s;
  }, [data, projection]);
  const tree = scene?.tree;
  const lens = LENS_BY_ID[lensId];
  const selected = selectedId ? tree?.byId.get(selectedId) : null;
  useEffect(() => {
    if (selected) loadComments([itemKeyOf(selected)]);
  }, [selected, loadComments]);

  useEffect(() => {
    if (tree && selectedId && !tree.byId.has(selectedId)) setSelectedId(null);
  }, [tree, selectedId]);

  useEffect(() => {
    const id = pendingFly.current;
    if (scene && id && scene.tree.byId.has(id)) {
      pendingFly.current = null;
      requestAnimationFrame(() => mapRef.current?.flyTo(id));
    }
  }, [scene]);

  // Switching project: start from the overview.
  const lastProject = useRef(data?.project.id);
  useEffect(() => {
    const id = data?.project.id;
    if (lastProject.current && id && id !== lastProject.current) mapRef.current?.overview(0);
    lastProject.current = id;
  }, [data?.project.id]);

  // Keep the URL shareable: project, selection, lens, projection and view.
  const latest = useRef({});
  latest.current = { projectId, selectedId, lensId, showLinks, projection };
  const writeHash = useCallback(() => {
    const s = latest.current;
    const p = new URLSearchParams();
    if (s.projectId) p.set('p', s.projectId);
    if (s.selectedId) p.set('n', s.selectedId);
    if (s.lensId !== 'map') p.set('lens', s.lensId);
    if (s.showLinks) p.set('routes', '1');
    if (s.projection !== 'site') p.set('proj', s.projection);
    const v = mapRef.current?.getView();
    if (v) p.set('v', `${v.cx.toFixed(1)},${v.cy.toFixed(1)},${v.k.toFixed(3)}`);
    history.replaceState(null, '', `#${p}`);
  }, []);
  useEffect(writeHash, [projectId, selectedId, lensId, showLinks, projection, writeHash]);

  // A new projection redraws the whole world: keep the selection in view, or show everything.
  const lastProjection = useRef(projection);
  useEffect(() => {
    if (lastProjection.current === projection) return;
    lastProjection.current = projection;
    storage.set('projectmap.projection', projection);
    const id = latest.current.selectedId;
    requestAnimationFrame(() => (id ? mapRef.current?.flyTo(id) : mapRef.current?.overview()));
  }, [projection]);
  const hashTimer = useRef(0);
  const onView = useCallback(() => {
    clearTimeout(hashTimer.current);
    hashTimer.current = setTimeout(writeHash, 400);
  }, [writeHash]);

  const panelMode = selected ? 'details' : resultsOpen && lens.matches ? 'results' : null;
  const insets = useMemo(() => {
    if (mobile) return { top: 130, bottom: panelMode ? Math.round(window.innerHeight * (sheetFull ? 0.92 : 0.46)) : 72 };
    return { left: panelMode ? panelW + 24 : 0, top: 60 };
  }, [panelMode, mobile, sheetFull, panelW]);

  // The panel holds one item at a time (EDIT-13): picking another replaces it, and its edits wait in the changeset.
  const pick = useCallback((id) => {
    setSelectedId(id);
    if (id) mapRef.current?.flyTo(id);
  }, []);
  const onMapSelect = useCallback((id) => setSelectedId(id), []);
  const setLens = useCallback((id) => {
    setLensId(id);
    const hasResults = Boolean(LENS_BY_ID[id].matches);
    setResultsOpen(hasResults);
    if (hasResults) setSelectedId(null);
  }, []);
  const closePanel = useCallback(() => {
    setSelectedId(null);
    setResultsOpen(false);
    setSheetFull(false);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || drawerOpen) return;
      const el = document.activeElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName) || el?.isContentEditable || el?.closest?.('.thread-pop')) return;
      closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, closePanel]);

  const replaceNodes = (fn) => setData((d) => d && { ...d, nodes: fn(d.nodes) });
  const editing = useItemEditing({
    projectId: data?.project.id,
    tree,
    setComments,
    toast,
    fail,
    onAccepted: (nodes) => {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      replaceNodes((ns) => ns.map((n) => byId.get(n.id) ?? n));
    },
    reloadNodes: async () => {
      const pid = data.project.id;
      const d = await api.getProject(pid);
      if (latest.current.projectId !== pid) return null;
      replaceNodes(() => d.nodes);
      return d.nodes;
    },
  });

  // The panel's expand handle (EDIT-10): drag to any width, or click to switch between narrow and wide.
  const setWidth = (w) => {
    const next = Math.round(Math.min(Math.max(w, PANEL_MIN), maxWidth()));
    setPanelW(next);
    try {
      localStorage.setItem(PANEL_KEY, String(next));
    } catch {
      // Not remembered in a private window; the panel still works.
    }
  };
  const onHandleDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelW;
    let moved = false;
    const move = (ev) => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      if (moved) setPanelW(Math.round(Math.min(Math.max(startW + ev.clientX - startX, PANEL_MIN), maxWidth())));
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWidth(moved ? startW + ev.clientX - startX : startW > PANEL_MIN + 40 ? PANEL_MIN : wideWidth());
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // The bottom sheet on a phone (EDIT-12): pull it up to edit full screen, down to see the map.
  const onSheetDown = (e) => {
    const startY = e.clientY;
    const up = (ev) => {
      window.removeEventListener('pointerup', up);
      const dy = ev.clientY - startY;
      if (Math.abs(dy) < 8) setSheetFull((f) => !f);
      else setSheetFull(dy < 0);
    };
    window.addEventListener('pointerup', up);
  };

  async function patch(node, fields) {
    try {
      const { node: next } = await api.patchNode(data.project.id, node.id, fields);
      replaceNodes((ns) => ns.map((n) => (n.id === next.id ? next : n)));
      if ('parentId' in fields) pendingFly.current = next.id;
    } catch (err) {
      fail(err);
    }
  }

  // A new item opens in the panel at once, its title ready to write over: there is no form to fill first.
  async function add(parentId, kind) {
    setBusy(true);
    try {
      const { nodes } = await api.createNode(data.project.id, { parentId, kind, title: `New ${KIND_LABEL[kind].toLowerCase()}`, tags: kind === 'story' ? ['new-feature'] : [] });
      replaceNodes((ns) => [...ns, ...nodes]);
      setSelectedId(nodes[0].id);
      pendingFly.current = nodes[0].id;
      toast(`Added a ${KIND_LABEL[kind].toLowerCase()} to the map`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove(node) {
    setBusy(true);
    try {
      const res = await api.deleteNode(data.project.id, node.id);
      const gone = new Set(res.deleted);
      const updated = new Map(res.updated.map((n) => [n.id, n]));
      replaceNodes((ns) => ns.filter((n) => !gone.has(n.id)).map((n) => updated.get(n.id) ?? n));
      setSelectedId(node.parent?.id ?? null);
      toast(`Deleted ${res.deleted.length === 1 ? `“${node.title}”` : `${res.deleted.length} items`}`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function openNew(promise, message) {
    setBusy(true);
    try {
      const { project } = await promise;
      await loadProjects();
      setProjectId(project.id);
      setSelectedId(null);
      setDrawerOpen(false);
      if (message) toast(message);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function refreshGithub(id, body) {
    setBusy(true);
    try {
      const { project } = await api.refreshGithub(id, body);
      await loadProjects(); // reloads the open project too
      setProjectId(id);
      setSelectedId(null);
      setDrawerOpen(false);
      toast(`Mapped ${project.title} again`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject(id) {
    try {
      await api.deleteProject(id);
      if (id === projectId) {
        setProjectId(null);
        setData(null);
      }
      await loadProjects();
      toast('Project deleted');
    } catch (err) {
      fail(err);
    }
  }

  function exportJson() {
    if (!data) return;
    const blob = new Blob([JSON.stringify({ project: data.project, nodes: data.nodes }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${data.project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function unlock(key) {
    setAccessKey(key);
    try {
      const { projects } = await api.listProjects();
      setProjects(projects);
      setLocked(false);
      setUnlockError('');
    } catch (err) {
      setUnlockError(err instanceof AuthError ? 'That key did not work.' : err.message);
    }
  }

  if (locked) return <Unlock onSubmit={unlock} error={unlockError} />;

  const classes = ['app', mobile && 'mobile', panelMode && 'panel-open', sheetFull && 'sheet-full', lens.theme.dark && 'night'].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      {scene ? (
        <MapView
          ref={mapRef}
          scene={scene}
          lens={lens}
          showLinks={showLinks}
          selectedId={selectedId}
          insets={insets}
          initialView={initial.view}
          onSelect={onMapSelect}
          onMarker={pick}
          onFocus={setFocusId}
          onView={onView}
        />
      ) : (
        <div className="loading">{projects && !projects.length ? '' : 'Charting the map…'}</div>
      )}

      <div className="top">
        <SearchBar tree={tree} projectTitle={tree?.root.title} onPick={pick} onMenu={() => setDrawerOpen(true)} />
        {tree && <Chips tree={tree} lensId={lensId} setLens={setLens} showLinks={showLinks} setShowLinks={setShowLinks} />}
        {tree && <Breadcrumbs tree={tree} focusId={focusId} onFly={(id) => mapRef.current?.flyTo(id)} />}
      </div>

      {panelMode && tree && (
        <aside className="panel" aria-label="Details" style={mobile ? undefined : { width: panelW }}>
          {mobile && (
            <button className="sheet-handle" onPointerDown={onSheetDown} aria-label={sheetFull ? 'Show the map' : 'Pull up to edit'}>
              <span />
            </button>
          )}
          <div className="panel-scroll">
            {panelMode === 'details' && (
              <Details
                key={selected.id}
                node={selected}
                tree={tree}
                lens={lens}
                comments={comments}
                editing={editing}
                onPick={pick}
                onFly={(id) => mapRef.current?.flyTo(id)}
                onAdd={add}
                onPatch={(fields) => patch(selected, fields)}
                onDelete={remove}
                onClose={closePanel}
                onDocFocus={mobile ? () => setSheetFull(true) : undefined}
                onCopyLink={async () => {
                  writeHash();
                  try {
                    await navigator.clipboard.writeText(location.href);
                    toast('Link copied');
                  } catch {
                    toast('Copy the address bar to share this view');
                  }
                }}
              />
            )}
            {panelMode === 'results' && <Results lens={lens} tree={tree} focusId={focusId} onPick={pick} onClose={() => setResultsOpen(false)} />}
          </div>
          {!mobile && (
            <button
              type="button"
              className="panel-grip"
              onPointerDown={onHandleDown}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') setWidth(panelW + 40);
                else if (e.key === 'ArrowLeft') setWidth(panelW - 40);
                else if (e.key === 'Enter' || e.key === ' ') setWidth(panelW > PANEL_MIN + 40 ? PANEL_MIN : wideWidth());
              }}
              aria-label={panelW > PANEL_MIN + 40 ? 'Narrow the panel' : 'Widen the panel'}
              title="Drag to resize, click to widen or narrow"
            >
              <span />
            </button>
          )}
        </aside>
      )}

      {tree && (
        <div className="bottom-left">
          <LayerButton
            scene={scene}
            lensId={lensId}
            setLens={setLens}
            showLinks={showLinks}
            setShowLinks={setShowLinks}
            projection={projection}
            setProjection={setProjection}
          />
          <Legend lens={lens} tree={tree} />
        </div>
      )}
      {scene && <MapControls onZoom={(f) => mapRef.current?.zoomBy(f)} onOverview={() => mapRef.current?.overview()} />}
      {hint && tree && (
        <Hint
          onDismiss={() => {
            storage.set('projectmap.hint', '1');
            setHint(false);
          }}
        />
      )}

      {projects && !projects.length && (
        <div className="empty-state">
          <Icon name="map" size={36} />
          <h2>No projects yet</h2>
          <p>Start blank, explore the demo, or import a GitHub repository’s issues.</p>
          <div className="button-row">
            <button className="primary" onClick={() => openNew(api.createProject({ template: 'demo' }))}>
              Open the demo
            </button>
            <button onClick={() => setDrawerOpen(true)}>More options</button>
          </div>
        </div>
      )}

      {drawerOpen && projects && (
        <Drawer
          projects={projects}
          currentId={projectId}
          busy={busy}
          onClose={() => setDrawerOpen(false)}
          onOpen={(id) => {
            setProjectId(id);
            setSelectedId(null);
            setDrawerOpen(false);
          }}
          onCreate={(body) => openNew(api.createProject(body), body.template ? 'Demo project created' : 'Project created — click the island to start adding areas')}
          onDelete={deleteProject}
          onImportGithub={(body) => openNew(api.importGithub(body), `Mapped ${body.repo}`)}
          onRefreshGithub={refreshGithub}
          onImportJson={(text) => {
            let parsed;
            try {
              parsed = JSON.parse(text);
            } catch {
              toast('That file is not valid JSON', 'error');
              return;
            }
            openNew(api.importJson(parsed), 'Imported');
          }}
          onExport={exportJson}
          onLock={() => {
            setAccessKey('');
            setDrawerOpen(false);
            setLocked(true);
          }}
        />
      )}
      <Toasts toasts={toasts} />
    </div>
  );
}
