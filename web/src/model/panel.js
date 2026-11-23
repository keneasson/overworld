// The panel beside the map (#41): its expand handle (EDIT-10), the bottom sheet on a phone (EDIT-12), and keeping the map
// still while someone scrolls or pinches inside it (EDIT-23).

export const PANEL_KEY = 'projectmap.panelWidth';
export const PANEL_MIN = 400;
const PANEL_WIDE = 900;
const MAP_ROOM = 220; // the map always keeps this much beside the panel

const maxWidth = (viewport) => Math.max(PANEL_MIN, viewport - MAP_ROOM);
/** A width the panel can take in a window `viewport` wide: never narrower than its minimum, and the map always beside it. */
export const fitWidth = (w, viewport) => Math.round(Math.min(Math.max(w, PANEL_MIN), maxWidth(viewport)));
export const wideWidth = (viewport) => Math.min(PANEL_WIDE, maxWidth(viewport));
export const isWide = (w) => w > PANEL_MIN + 40;

/** The width after the handle is let go: dragged, wherever it was dragged to; clicked, wide when narrow and narrow when wide. */
export const afterHandle = ({ startW, dx, moved }, viewport) => (moved ? fitWidth(startW + dx, viewport) : isWide(startW) ? PANEL_MIN : wideWidth(viewport));

/** The width the panel remembers (`store` is localStorage, or anything with getItem), or its minimum. */
export function readWidth(store, viewport) {
  try {
    const w = Number(store.getItem(PANEL_KEY));
    return w >= PANEL_MIN ? fitWidth(w, viewport) : PANEL_MIN;
  } catch {
    return PANEL_MIN;
  }
}

export function rememberWidth(store, w) {
  try {
    store.setItem(PANEL_KEY, String(w));
  } catch {
    // Not remembered in a private window; the panel still works.
  }
}

/** The sheet after its handle is let go `dy` pixels from where it was pressed: pulled up fills the screen, pulled down shows the map, a tap switches. */
export const sheetAfter = (dy, full) => (Math.abs(dy) < 8 ? !full : dy < 0);

/**
 * Scrolling and pinching inside `el` (the panel) never reach the map or zoom the page under it: a trackpad pinch (a wheel with
 * Ctrl), a two-finger pinch, and Safari's gesture events stop at the panel; scrolling scrolls the panel. Returns the undo.
 */
export function keepMapStill(el) {
  const wheel = (e) => {
    e.stopPropagation();
    if (e.ctrlKey) e.preventDefault();
  };
  const touch = (e) => {
    e.stopPropagation();
    if (e.touches?.length > 1) e.preventDefault();
  };
  const gesture = (e) => e.preventDefault();
  const opts = { passive: false };
  el.addEventListener('wheel', wheel, opts);
  el.addEventListener('touchmove', touch, opts);
  for (const g of ['gesturestart', 'gesturechange']) el.addEventListener(g, gesture, opts);
  return () => {
    el.removeEventListener('wheel', wheel, opts);
    el.removeEventListener('touchmove', touch, opts);
    for (const g of ['gesturestart', 'gesturechange']) el.removeEventListener(g, gesture, opts);
  };
}
