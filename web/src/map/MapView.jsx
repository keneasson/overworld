import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { select, zoom as d3zoom, zoomIdentity } from 'd3';
import { drawMap, hitTest, nodeView, overviewView, thresholds, fitScale } from './renderer.js';

/**
 * The zoomable canvas. Pan/zoom state lives here (not in React) so frames are cheap;
 * the parent hears about focus changes and selection through callbacks.
 */
export const MapView = forwardRef(function MapView(
  { scene, lens, showLinks, selectedId, insets, initialView, onSelect, onFocus, onView },
  ref,
) {
  const canvasRef = useRef(null);
  const st = useRef({ transform: zoomIdentity, w: 0, h: 0, dpr: 1, hoverId: null, info: null, frame: 0, ready: false });
  const props = useRef({});
  props.current = { scene, lens, showLinks, selectedId, insets, onSelect, onFocus, onView };
  const zoomRef = useRef(null);

  const view = () => {
    const s = st.current;
    return { x: s.transform.x, y: s.transform.y, k: s.transform.k, width: s.w, height: s.h, dpr: s.dpr };
  };

  const still = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const schedule = () => {
    const s = st.current;
    if (s.frame) return;
    s.frame = requestAnimationFrame(() => {
      s.frame = 0;
      draw();
    });
  };

  const draw = () => {
    const s = st.current;
    const p = props.current;
    const canvas = canvasRef.current;
    if (!canvas || !p.scene || !s.w) return;
    const ctx = canvas.getContext('2d');
    const ins = p.insets ?? {};
    const center = [(ins.left ?? 0) + (s.w - (ins.left ?? 0)) / 2, (ins.top ?? 0) + (s.h - (ins.top ?? 0) - (ins.bottom ?? 0)) / 2];
    s.info = drawMap(ctx, p.scene, view(), { lens: p.lens, selectedId: p.selectedId, hoverId: s.hoverId, showLinks: p.showLinks, center, insets: ins, time: still() ? 0 : performance.now() / 1000 });
    // Fog drifts: while any is on screen, redraw a few times a second. Nothing moves for people who ask for less motion.
    if (s.info?.drifting && !still() && !s.drift) s.drift = setTimeout(() => ((s.drift = 0), schedule()), 50);
    if (s.info && s.info.focusId !== s.lastFocus) {
      s.lastFocus = s.info.focusId;
      p.onFocus?.(s.info.focusId);
    }
  };

  const toTransform = (v) => zoomIdentity.translate(v.x, v.y).scale(v.k);

  const animateTo = (v, duration = 750) => {
    const sel = select(canvasRef.current);
    sel.interrupt();
    sel.transition().duration(duration).call(zoomRef.current.transform, toTransform(v));
  };

  const updateExtent = () => {
    const s = st.current;
    const sc = props.current.scene;
    if (!zoomRef.current || !sc || !s.w) return;
    const T = thresholds(s.w, s.h);
    const { world } = sc;
    const minK = fitScale(s.w, s.h, world) * 0.45;
    const maxK = Math.max(minK * 4, (T.vmin * 1.1) / sc.minLeafSize);
    sc.maxK = maxK;
    const m = Math.max(world.w, world.h) * 1.2;
    zoomRef.current.scaleExtent([minK, maxK]).translateExtent([
      [world.x0 - m, world.y0 - m],
      [world.x1 + m, world.y1 + m],
    ]);
  };

  useImperativeHandle(ref, () => ({
    flyTo(id, duration) {
      if (!st.current.ready) {
        setTimeout(() => this.flyTo(id, duration), 60);
        return;
      }
      const sc = props.current.scene;
      const n = sc?.tree.byId.get(id);
      if (!n) return;
      animateTo(nodeView(sc, n, st.current.w, st.current.h, props.current.insets), duration);
    },
    overview(duration) {
      const sc = props.current.scene;
      if (sc) animateTo(overviewView(sc, st.current.w, st.current.h, props.current.insets), duration);
    },
    zoomBy(f) {
      select(canvasRef.current).transition().duration(300).call(zoomRef.current.scaleBy, f);
    },
    getView() {
      const s = st.current;
      if (!s.w) return null;
      const { x, y, k } = s.transform;
      return { cx: (s.w / 2 - x) / k, cy: (s.h / 2 - y) / k, k };
    },
    snapshot() {
      return { ...view(), info: st.current.info };
    },
  }));

  // One-time setup: zoom behaviour, resize observer, pointer handlers.
  useEffect(() => {
    const canvas = canvasRef.current;
    const s = st.current;
    const z = d3zoom()
      .clickDistance(6)
      .tapDistance(12)
      .on('zoom', (e) => {
        s.transform = e.transform;
        schedule();
        props.current.onView?.();
      });
    zoomRef.current = z;
    const sel = select(canvas).call(z);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const first = !s.w;
      s.w = rect.width;
      s.h = rect.height;
      s.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      canvas.width = Math.round(s.w * s.dpr);
      canvas.height = Math.round(s.h * s.dpr);
      updateExtent();
      if (first && s.w) {
        let v = overviewView(props.current.scene, s.w, s.h, props.current.insets);
        if (initialView?.k) v = { k: initialView.k, x: s.w / 2 - initialView.cx * initialView.k, y: s.h / 2 - initialView.cy * initialView.k };
        sel.call(z.transform, toTransform(v));
        s.ready = true;
      }
      schedule();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const pointer = (e) => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const onMove = (e) => {
      if (e.pointerType !== 'mouse' || e.buttons) return;
      const sc = props.current.scene;
      if (!sc) return;
      const [px, py] = pointer(e);
      // Hover only outlines what a click here would open (SYM-08); it shows nothing else.
      const id = hitTest(sc, view(), s.info, px, py);
      if (id !== s.hoverId) {
        s.hoverId = id;
        schedule();
      }
      canvas.style.cursor = id ? 'pointer' : 'grab';
    };
    const onLeave = () => {
      s.hoverId = null;
      schedule();
    };
    const onClick = (e) => {
      const sc = props.current.scene;
      if (!sc || e.defaultPrevented) return;
      const [px, py] = pointer(e);
      props.current.onSelect?.(hitTest(sc, view(), s.info, px, py));
    };
    const onKey = (e) => {
      const step = 80;
      const keys = {
        '+': () => sel.transition().duration(250).call(z.scaleBy, 1.6),
        '=': () => sel.transition().duration(250).call(z.scaleBy, 1.6),
        '-': () => sel.transition().duration(250).call(z.scaleBy, 1 / 1.6),
        ArrowLeft: () => sel.transition().duration(150).call(z.translateBy, step / s.transform.k, 0),
        ArrowRight: () => sel.transition().duration(150).call(z.translateBy, -step / s.transform.k, 0),
        ArrowUp: () => sel.transition().duration(150).call(z.translateBy, 0, step / s.transform.k),
        ArrowDown: () => sel.transition().duration(150).call(z.translateBy, 0, -step / s.transform.k),
      };
      if (keys[e.key]) {
        e.preventDefault();
        keys[e.key]();
      }
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('keydown', onKey);
    return () => {
      ro.disconnect();
      sel.on('.zoom', null);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('keydown', onKey);
      cancelAnimationFrame(s.frame);
      clearTimeout(s.drift);
      s.frame = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    updateExtent();
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, lens, showLinks, selectedId, insets]);

  return <canvas ref={canvasRef} className="map-canvas" tabIndex={0} aria-label="Project map. Scroll or pinch to zoom, drag to pan." />;
});
