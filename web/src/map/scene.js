import { buildTree } from '../model/tree.js';
import { computeLayout } from './layout.js';
import { resolveSite } from './places.js';
import { drawMap, fitScale } from './renderer.js';

/** Tree + geometry. Geometry is reused when only text changed, so the map never jumps. */
export function buildScene(nodes, projectId, prev, projection = 'site') {
  const tree = buildTree(nodes);
  if (!tree) return null;
  const site = projection === 'site' ? resolveSite(tree) : null;
  // Anything that moves land: structure, size, and (in the Site projection) where things sit.
  const where = (n) => (site ? `:${site.places.get(n.id)}:${site.continents.get(n.id)?.surface ?? ''}${site.continents.get(n.id)?.own ? '!' : ''}` : '');
  const sig = `${projection}|${tree.list.map((n) => `${n.id}:${n.parent?.id ?? ''}:${n.stats.raw.toFixed(2)}${where(n)}`).join('|')}`;
  const reuse = prev && prev.sig === sig && prev.projectId === projectId;
  const layout = reuse ? prev.layout : computeLayout(tree, projectId, { projection, site });
  let minLeafSize = Infinity;
  for (const n of tree.list) if (!n.children.length) minLeafSize = Math.min(minLeafSize, layout.geo.get(n.id).size);
  return {
    tree,
    layout,
    geo: layout.geo,
    land: layout.land,
    world: layout.world,
    notes: layout.notes,
    projection,
    site,
    sig,
    projectId,
    minLeafSize,
    coastPath: reuse ? prev.coastPath : undefined,
  };
}

/** Small preview images of the whole map under each lens (for the layer picker). */
export function renderThumbnail(scene, lens, w = 132, h = 88) {
  const canvas = document.createElement('canvas');
  const dpr = 2;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const k = fitScale(w, h, scene.world) * 0.9 * 1.25;
  const { cx, cy } = scene.world;
  drawMap(canvas.getContext('2d'), scene, { x: w / 2 - cx * k, y: h / 2 - cy * k, k, width: w, height: h, dpr }, { lens, thumbnail: true, T: { vmin: h, yld: 400, sub: 34 } });
  return canvas.toDataURL('image/png');
}
