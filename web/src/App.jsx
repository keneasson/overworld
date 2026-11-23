import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { itemKeyOf } from '@shared/issue-shape.js';
import { isDismissed, isOpen, threadsOf } from '@shared/annotations.js';
import { KIND_LABEL } from '@shared/schema.js';
import { api, AuthError, setAccessKey, storage } from './api.js';
import { buildScene } from './map/scene.js';
import { MapView } from './map/MapView.jsx';
import { LENS_BY_ID, lensesWith, needsApproval } from './map/lenses.js';
import { Breadcrumbs, Chips, CommentToggle, escapeDoes, Hint, LayerButton, Legend, MapControls, SearchBar, Toasts } from './components/Chrome.jsx';
import { Composer, YouContext } from './editor/Annotate.jsx';
import { Details, Results, ReviewList } from './components/Panel.jsx';
import { useItemEditing } from './editor/useItemEditing.js';
import { isMapped } from './editor/items.js';
import { Drawer, Unlock } from './components/Drawer.jsx';
import { ConnectAgent } from './components/ConnectAgent.jsx';
import { Icon } from './components/Icon.jsx';
import { isNewer } from './model/version.js';
import { backOf, followLink, linkTarget, repoOf } from './model/links.js';
import { LinkContext } from './components/links-context.js';
import { claimsByNode, openedBy, waitingByNode } from './map/houses.js';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { waitingForReview } from './model/review.js';
import { changesetContents } from './model/changesets.js';

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

// A newer deploy is noticed when the app comes back to the foreground, and every few minutes (SHIP-12): on a phone
// the map takes every touch, so pull-to-refresh can't, and an app opened from the home screen has no reload button.
const VERSION_CHECK_MS = 5 * 60_000;
const NO_BUILDS = { requests: [], buildable: {}, notes: [] };
function useNewVersion() {
  const [newer, setNewer] = useState(false);
  useEffect(() => {
    const running = document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src');
    if (!running) return undefined;
    let stop = false;
    const check = async () => {
      if (stop || document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/', { cache: 'no-store' });
        if (res.ok && isNewer(running, await res.text())) setNewer(true);
      } catch {
        // Offline or between deploys: the next check tries again.
      }
    };
    const timer = setInterval(check, VERSION_CHECK_MS);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      stop = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, []);
  // A part of the app the deploy removed was asked for (#71 SHIP-13): there is certainly a newer version.
  useEffect(() => {
    const stale = () => setNewer(true);
    window.addEventListener('projectmap:stale', stale);
    return () => window.removeEventListener('projectmap:stale', stale);
  }, []);
  return newer;
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
  const [commenting, setCommenting] = useState(false); // the Comment control (#15 NOTE-10)
  const [placePick, setPlacePick] = useState(null); // a place on the map picked to comment on: { id, x, y }
  const [resultsOpen, setResultsOpen] = useState(false);
  const [reviewingId, setReviewingId] = useState(null); // the item opened from it, which offers the next one (REVIEW-03)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
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
  const [openNotes, setOpenNotes] = useState({}); // comments not dismissed by item, and who has read them all, for the map's badges (NOTE-04)
  const [openQuestions, setOpenQuestions] = useState({}); // open questions waiting on someone, by item (#62 REVIEW-02)
  const notesFrom = (pid) => (d) => {
    if (latest.current.projectId !== pid) return;
    setOpenNotes(d.open);
    setOpenQuestions(d.questions ?? {});
  };
  useEffect(() => {
    setComments([]);
    setOpenNotes({});
    setOpenQuestions({});
    commentsFor.current = new Set();
    if (!projectId) return;
    api
      .openNotes(projectId)
      .then(notesFrom(projectId))
      .catch(() => {});
  }, [projectId]);
  // Questions waiting on someone change while the map is open (#62 REVIEW-02): look again with the refinements.
  const reloadNotes = useCallback(() => {
    const pid = projectId;
    if (!pid) return;
    api
      .openNotes(pid)
      .then(notesFrom(pid))
      .catch(() => {});
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Live claims (MCP-04): a house being coded has a bulldozer on its lot (#46 MARK-17), and the item an agent badge. Agents
  // claim through MCP while the map is open, so look again now and then; a claim that ends takes its bulldozer with it.
  // Build requests (#14 HANDOFF-05) come with them: what waits for a builder, and what the card can offer to build.
  const [claims, setClaims] = useState([]);
  const [builds, setBuilds] = useState(NO_BUILDS);
  const loadBuilds = useCallback(
    (pid) =>
      api
        .builds(pid)
        .then((d) => latest.current.projectId === pid && setBuilds({ requests: d.requests ?? [], buildable: d.buildable ?? {}, notes: d.notes ?? [] }))
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    setClaims([]);
    setBuilds(NO_BUILDS);
    if (!projectId) return undefined;
    const pid = projectId;
    const load = () => {
      api
        .claims(pid)
        .then((d) => latest.current.projectId === pid && setClaims(d.claims ?? []))
        .catch(() => {});
      loadBuilds(pid);
    };
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 30000);
    return () => clearInterval(t);
  }, [projectId, loadBuilds]);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!claims.length) return undefined;
    const t = setInterval(() => setClock(Date.now()), 15000);
    return () => clearInterval(t);
  }, [claims.length]);
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
  const offered = LENS_BY_ID[lensId]; // the lens chosen; Review is drawn over what is waiting, below
  const selected = selectedId ? tree?.byId.get(selectedId) : null;
  useEffect(() => {
    if (selected) loadComments([itemKeyOf(selected)]);
  }, [selected, loadComments]);
  // While an open item has an annotation with an agent, look for its reply every few seconds (NOTE-14, NOTE-19).
  const selectedKey = selected ? itemKeyOf(selected) : null;
  const withAgent = Boolean(selectedKey) && comments.some((c) => c.itemKey === selectedKey && !isDismissed(c) && ['waiting', 'delivered'].includes(c.delivery?.state));

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
  const hashOf = useCallback(() => {
    const s = latest.current;
    const p = new URLSearchParams();
    if (s.projectId) p.set('p', s.projectId);
    if (s.selectedId) p.set('n', s.selectedId);
    if (s.lensId !== 'map') p.set('lens', s.lensId);
    if (s.showLinks) p.set('routes', '1');
    if (s.projection !== 'site') p.set('proj', s.projection);
    const v = mapRef.current?.getView();
    if (v) p.set('v', `${v.cx.toFixed(1)},${v.cy.toFixed(1)},${v.k.toFixed(3)}`);
    return `#${p}`;
  }, []);
  // The address is replaced as things change, except when a link is followed (EDIT-14): that is a new history entry.
  const following = useRef(null); // { fromId, from } while a followed item opens
  const [trail, setTrail] = useState(() => backOf(history.state));
  const writeHash = useCallback(() => {
    const f = following.current;
    following.current = null;
    if (f) {
      followLink(history, { ...f, to: hashOf() });
      setTrail(backOf(history.state));
    } else history.replaceState(history.state, '', hashOf());
  }, [hashOf]);
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

  // The Review lens's list is the Review list (REVIEW-05): the chip beside Fog and Bugs is the one way in (REVIEW-01).
  const panelMode = selected ? 'details' : resultsOpen && lensId === 'approval' ? 'review' : resultsOpen && offered.matches ? 'results' : null;
  const insets = useMemo(() => {
    if (mobile) return { top: 130, bottom: panelMode ? Math.round(window.innerHeight * (sheetFull ? 0.92 : 0.46)) : 72 };
    return { left: panelMode ? panelW + 24 : 0, top: 60 };
  }, [panelMode, mobile, sheetFull, panelW]);

  // The panel holds one item at a time (EDIT-13): picking another replaces it, and its edits wait in the changeset.
  // Choosing a behaviour's house on the map opens its issue at that behaviour (MARK-16).
  const [atBehaviour, setAtBehaviour] = useState(null);
  const pick = useCallback((target) => {
    const { id, behaviour } = openedBy(target);
    setSelectedId(id);
    setAtBehaviour(behaviour);
    if (id) mapRef.current?.flyTo(id);
  }, []);
  const onMapSelect = useCallback((target) => {
    const { id, behaviour } = openedBy(target);
    setSelectedId(id);
    setAtBehaviour(behaviour);
  }, []);
  // Following a link in an item's text (EDIT-14): the map flies to the item and it opens, and Back returns here.
  const follow = useCallback(
    (id) => {
      const fromId = latest.current.selectedId;
      if (id !== fromId) {
        following.current = { fromId, from: hashOf() };
        setSelectedId(id);
      }
      mapRef.current?.flyTo(id);
    },
    [hashOf],
  );
  // Back (the browser's, or the panel's) returns to the item and the view the address keeps.
  useEffect(() => {
    const onPop = () => {
      const h = readHash();
      setTrail(backOf(history.state));
      if (h.p && h.p !== latest.current.projectId) setProjectId(h.p);
      setSelectedId(h.n);
      if (h.view) mapRef.current?.showView(h.view);
      else if (h.n) mapRef.current?.flyTo(h.n);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const links = useMemo(() => {
    const target = (ref) => linkTarget(tree, ref);
    return {
      repo: repoOf(tree),
      target,
      follow: (ref) => {
        const t = target(ref);
        if (t?.node) follow(t.node.id);
        else if (t?.url ?? /^https?:/.test(ref)) window.open(t?.url ?? ref, '_blank', 'noopener');
      },
    };
  }, [tree, follow]);
  // A link in text shown as it was written (read-only items, comments): one on the map is followed, not opened on GitHub.
  // In the editor a click edits; the editor follows its own links.
  const onPanelClick = useCallback(
    (e) => {
      const a = e.target.closest?.('a[href], .issue-ref');
      if (!a || a.closest('.issue-doc-text') || e.button || e.shiftKey || e.altKey) return;
      if ((e.metaKey || e.ctrlKey) && a.href) return; // a new tab, as asked
      const t = links.target(a.dataset.issue ? Number(a.dataset.issue) : a.getAttribute('href'));
      if (!t?.node) return;
      e.preventDefault();
      follow(t.node.id);
    },
    [links, follow],
  );
  const setLens = useCallback((id) => {
    setLensId(id);
    const hasResults = Boolean(LENS_BY_ID[id].matches);
    setResultsOpen(hasResults);
    if (hasResults) setSelectedId(null);
  }, []);
  const closePanel = useCallback(() => {
    setSelectedId(null);
    setResultsOpen(false);
    setReviewingId(null);
    setSheetFull(false);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || drawerOpen) return;
      if (connectOpen) return setConnectOpen(false);
      const el = document.activeElement;
      const inBox = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName) || el?.isContentEditable || Boolean(el?.closest?.('.thread-pop'));
      const does = escapeDoes({ commenting, inBox });
      if (does === 'stop commenting') setCommenting(false);
      else if (does === 'close') closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, connectOpen, closePanel, commenting]);
  useEffect(() => {
    if (!commenting) setPlacePick(null);
  }, [commenting]);
  // A comment on a house is a comment on its issue.
  // Anything else picked (a park, a lot the map made up) is on the issue whose land it is, or on nothing.
  const onCommentPick = useCallback((id, x, y) => typeof id === 'string' && setPlacePick({ id: openedBy(id).id, x, y }), []);

  const replaceNodes = (fn) => setData((d) => d && { ...d, nodes: fn(d.nodes) });
  const newVersion = useNewVersion();
  const editing = useItemEditing({
    projectId: data?.project.id,
    tree,
    setComments,
    toast,
    fail,
    onAnswered: reloadNotes,
    onAccepted: (nodes) => {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      replaceNodes((ns) => [...ns.map((n) => byId.get(n.id) ?? n), ...nodes.filter((n) => !ns.some((x) => x.id === n.id))]);
    },
    onRemoved: (ids, updated = []) => {
      const gone = new Set(ids);
      const byId = new Map(updated.map((n) => [n.id, n]));
      replaceNodes((ns) => ns.filter((n) => !gone.has(n.id)).map((n) => byId.get(n.id) ?? n));
      setSelectedId((id) => (gone.has(id) ? null : id));
    },
    reloadNodes: async () => {
      const pid = data.project.id;
      const d = await api.getProject(pid);
      if (latest.current.projectId !== pid) return null;
      replaceNodes(() => d.nodes);
      return d.nodes;
    },
  });
  const build = useCallback(
    async (node, behaviours) => {
      const pid = projectId;
      try {
        const { request, already } = await api.requestBuild(pid, { item: itemKeyOf(node), ...(behaviours ? { behaviours } : {}), by: editing.name || undefined });
        toast(already ? 'Already waiting for a builder' : `Build asked for: ${request.behaviours.join(', ')}`);
      } catch (err) {
        toast(err.message);
      }
      await loadBuilds(pid);
    },
    [projectId, editing.name, loadBuilds, toast],
  );
  const update = useCallback(async () => {
    await editing.flush();
    location.reload();
  }, [editing]);
  // When the panel, the editor or a comment box fails to draw (#71 SHIP-14): back to the map closes what failed, and the
  // drafts, kept up here, stay. Update saves them and loads the new version (SHIP-12, SHIP-13).
  const backToMap = useCallback(() => {
    setCommenting(false);
    setPlacePick(null);
    closePanel();
  }, [closePanel]);

  // The changeset's box (#62 SYNC-01): what it holds across issues, and its comments, kept on the area its edits are in.
  const box = useMemo(() => changesetContents({ tree, edited: editing.edited, unsaved: editing.unsaved, drafts: editing.drafts }), [tree, editing.edited, editing.unsaved, editing.drafts]);
  const boxArea = box ? itemKeyOf(box.area) : null;
  useEffect(() => {
    if (boxArea) loadComments([boxArea]);
  }, [boxArea, loadComments]);

  // Everything waiting on someone's review (#62): the Review lens, its list and the "to review" marker.
  const review = useMemo(() => waitingForReview({ changesets: editing.others, notes: openQuestions, tree }), [editing.others, openQuestions, tree]);
  const approval = useMemo(() => needsApproval(review), [review]);
  const lenses = useMemo(() => lensesWith(approval), [approval]);
  const lens = lensId === approval.id ? approval : offered;
  // Choosing the Review lens fetches what's waiting now, so its count and list are fresh the moment it opens (REVIEW-01).
  useEffect(() => {
    if (lensId !== approval.id) return;
    setReviewingId(null);
    editing.reloadRefinements();
    reloadNotes();
  }, [lensId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Choosing one goes there and opens it at its proposed changes (REVIEW-03).
  const pickReview = useCallback(
    (e) => {
      setReviewingId(e.node.id);
      pick(e.node.id);
    },
    [pick],
  );

  // Items with someone else's refinement waiting are marked on the map (ADOPT-02), so they can be found.
  const live = useMemo(() => {
    // One badge per item (NOTE-04): its comments not dismissed, marked when any are unread for this person (NOTE-03). The
    // project's counts come from the server; the threads loaded here are counted again as they change.
    const you = editing.name;
    const loaded = {};
    for (const t of threadsOf(comments)) {
      if (!isOpen(t.root)) continue;
      const it = (loaded[t.root.itemKey] ??= { count: 0, unread: false });
      it.count += 1;
      it.unread ||= !editing.hasRead(t);
    }
    const keys = new Set(comments.map((c) => c.itemKey));
    const fromServer = Object.entries(openNotes).filter(([k]) => !keys.has(k)).map(([k, v]) => [k, { count: v.count, unread: Boolean(you) && !v.read?.includes(you) }]);
    const byItem = { ...Object.fromEntries(fromServer), ...loaded };
    const nodeOf = new Map(tree ? tree.list.map((x) => [itemKeyOf(x), x.id]) : []);
    const notes = new Map(Object.entries(byItem).flatMap(([k, v]) => (nodeOf.has(k) ? [[nodeOf.get(k), v]] : [])));
    // An issue with changes waiting carries a "to review" marker (#62 REVIEW-04), from the same list as the Review lens.
    const refinements = new Map(review.filter((e) => e.changes > 0).map((e) => [e.node.id, e.changes]));
    const agents = tree ? claimsByNode(claims, tree, clock) : new Map();
    const waiting = tree ? waitingByNode(builds.requests, tree) : new Map();
    return { refinements, notes, agents, waiting };
  }, [review, editing.name, editing.hasRead, tree, comments, openNotes, claims, builds, clock]);
  // Agents propose through MCP while the map is open: look again when an item opens, and now and then.
  const { reloadRefinements } = editing;
  useEffect(() => {
    if (selectedId) reloadRefinements();
  }, [selectedId, reloadRefinements]);
  useEffect(() => {
    // Proposed, adopted or declined elsewhere: the Review count follows within half a minute (REVIEW-01).
    const t = setInterval(() => document.visibilityState === 'visible' && (reloadRefinements(), reloadNotes()), 30000);
    return () => clearInterval(t);
  }, [reloadRefinements, reloadNotes]);
  useEffect(() => {
    if (!withAgent) return undefined;
    const pid = projectId;
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      api
        .itemComments(pid, selectedKey)
        .then((d) => latest.current.projectId === pid && setComments((cs) => [...cs.filter((c) => c.itemKey !== selectedKey), ...d.comments]))
        .catch(() => {});
      reloadRefinements();
    }, 4000);
    return () => clearInterval(t);
  }, [withAgent, selectedKey, projectId, reloadRefinements]);

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
  // On a map read from GitHub it is part of the open refinement, in the strict shape's template, until it is adopted (NEW-01).
  async function add(parentId, kind) {
    if (isMapped(tree)) {
      const node = await editing.addItem(parentId, kind);
      if (!node) return;
      replaceNodes((ns) => [...ns, node]);
      setSelectedId(node.id);
      pendingFly.current = node.id;
      toast(`Added a new ${KIND_LABEL[kind].toLowerCase()}. Accept to adopt it, or discard to drop it.`);
      return;
    }
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
    if (node.refinement) {
      const deleted = await editing.drop(node);
      if (deleted) toast(`Dropped ${deleted.length === 1 ? `“${node.title}”` : `${deleted.length} new items`}`);
      return;
    }
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

  // Who is commenting, and how to save a name when none is (#15 NOTE-21).
  const you = useMemo(() => ({ you: editing.name, setYou: editing.setName }), [editing.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const classes = ['app', mobile && 'mobile', panelMode && 'panel-open', sheetFull && 'sheet-full', lens.theme.dark && 'night', commenting && 'commenting'].filter(Boolean).join(' ');
  // One Comment control: on the map's controls, or at the top of the sheet on a phone, where the sheet covers them.
  const commentControl = tree && <CommentToggle on={commenting} onToggle={() => setCommenting((c) => !c)} />;
  const inSheet = mobile && panelMode === 'details';
  const placed = placePick && tree?.byId.get(placePick.id);

  return (
    <YouContext.Provider value={you}>
    <div className={classes}>
      {scene ? (
        <MapView
          ref={mapRef}
          scene={scene}
          lens={lens}
          showLinks={showLinks}
          selectedId={selectedId}
          insets={insets}
          live={live}
          initialView={initial.view}
          commenting={commenting}
          outlineId={placePick?.id ?? null}
          onSelect={onMapSelect}
          onMarker={pick}
          onCommentPick={onCommentPick}
          onFocus={setFocusId}
          onView={onView}
        />
      ) : (
        <div className="loading">{projects && !projects.length ? '' : 'Charting the map…'}</div>
      )}

      <div className="top">
        <SearchBar tree={tree} projectTitle={tree?.root.title} onPick={pick} onMenu={() => setDrawerOpen(true)} />
        {tree && <Chips tree={tree} lensId={lensId} setLens={setLens} showLinks={showLinks} setShowLinks={setShowLinks} lenses={lenses} />}
        {tree && <Breadcrumbs tree={tree} focusId={focusId} onFly={(id) => mapRef.current?.flyTo(id)} />}
      </div>

      {panelMode && tree && (
        <aside className="panel" aria-label="Details" style={mobile ? undefined : { width: panelW }} onClick={onPanelClick}>
          {mobile && (
            <button className="sheet-handle" onPointerDown={onSheetDown} aria-label={sheetFull ? 'Show the map' : 'Pull up to edit'}>
              <span />
            </button>
          )}
          <LinkContext.Provider value={links}>
            <div className="panel-scroll">
              <ErrorBoundary key={selected?.id ?? panelMode} where="panel" onBack={backToMap} onUpdate={update}>
              {panelMode === 'details' && (
                <Details
                  key={selected.id}
                  node={selected}
                  atBehaviour={atBehaviour}
                  tree={tree}
                  lens={lens}
                  comments={comments}
                  editing={editing}
                  builds={builds}
                  claims={claims}
                  review={reviewingId === selected.id ? review : null}
                  box={box}
                  onNextReview={pickReview}
                  onBuild={build}
                  commenting={commenting}
                  commentControl={inSheet ? commentControl : null}
                  back={trail && { label: trail.id && tree.byId.get(trail.id) ? `Back to ${tree.byId.get(trail.id).title}` : 'Back', go: () => history.back() }}
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
              {panelMode === 'review' && <ReviewList review={review} onPick={pickReview} onClose={closePanel} />}
              </ErrorBoundary>
            </div>
          </LinkContext.Provider>
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
            lenses={lenses}
          />
          <Legend lens={lens} tree={tree} live={live} />
        </div>
      )}
      {scene && (
        <MapControls onZoom={(f) => mapRef.current?.zoomBy(f)} onOverview={() => mapRef.current?.overview()}>
          {!inSheet && commentControl}
        </MapControls>
      )}
      {commenting && !placed && (
        <div className="comment-banner" role="status">
          {mobile ? 'Tap what it’s about, then tap again to comment' : 'Click what it’s about, or drag across words'} · <button type="button" className="link-btn" onClick={() => setCommenting(false)}>{mobile ? 'Done' : 'Esc to stop'}</button>
        </div>
      )}
      {placed && (
        <ErrorBoundary where="comment" onBack={backToMap} onUpdate={update}>
        <div className="thread-pop map-note" style={mobile ? undefined : { left: Math.min(placePick.x + 12, window.innerWidth - 380), top: Math.min(placePick.y + 12, window.innerHeight - 340) }}>
          <Composer
            key={placed.id}
            heading={placed.title}
            what="The place on the map"
            onPost={(text, extra) => editing.comment(itemKeyOf(placed), { on: 'place' }, text, extra)}
            onCancel={() => setPlacePick(null)}
          />
        </div>
        </ErrorBoundary>
      )}
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
          onConnectAgent={() => {
            setDrawerOpen(false);
            setConnectOpen(true);
          }}
          onLock={() => {
            setAccessKey('');
            setDrawerOpen(false);
            setLocked(true);
          }}
        />
      )}
      {connectOpen && projectId && (
        <ConnectAgent projectId={projectId} projectTitle={tree?.root.title ?? 'this project'} onClose={() => setConnectOpen(false)} onError={(err) => toast(err.message, 'error')} />
      )}
      {newVersion && (
        <button
          type="button"
          className="update-chip"
          onClick={async () => {
            await editing.flush();
            location.reload();
          }}
        >
          <Icon name="refresh" size={16} /> A new version is out · Update
        </button>
      )}
      <Toasts toasts={toasts} />
    </div>
    </YouContext.Provider>
  );
}
