// The Fog (#44): behaviour nobody knows yet, drawn as cloud over the land it lies on. How much fog an item holds is
// measured in tree.js from its behaviours (FOG-05); this module says where it lies (FOG-01, FOG-06), how the cloud looks
// and drifts (FOG-02, FOG-03), and where lightning strikes fog that has sat too long (FOG-04).

const pct = (v) => `${Math.round(v * 100)}%`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The behaviour row a house stands for, or null for anything else. */
const rowOf = (n) => (n.issue && n.behaviour ? (n.issue.behaviourRows?.find((b) => b.id === n.behaviour) ?? null) : null);

/**
 * How thick the fog over an item is, 0 to 1 (FOG-05): the share of its behaviours not worked out yet, all of it for an
 * issue with none, and for a region the size-weighted average of what is inside it, so zooming never changes how much
 * there is (FOG-01). A house is as foggy as its own behaviour (FOG-06).
 */
export function fogOver(n) {
  const row = rowOf(n);
  if (row) return row.fog ? 1 : 0;
  return n.stats?.fog ?? 0;
}

/** What the fog over an item is, in words (FOG-06): never a bare percentage without its reason. */
export function fogReason(n) {
  const row = rowOf(n);
  if (row) return row.fog ? 'Not worked out yet' : 'Worked out';
  const s = n.stats;
  const own = s.behaviourCount ?? 0;
  const mine = own
    ? s.foggy
      ? `${s.foggy} of ${plural(own, 'behaviour')} not worked out yet`
      : `${own === 1 ? 'Its behaviour is' : `All ${own} behaviours are`} worked out`
    : '';
  if (!n.children.length) {
    if (!s.fog) return mine || 'Nothing to work out here';
    return mine || 'No behaviours yet: nobody knows what it does';
  }
  const inside = s.poorlyDefined - (s.vague ? 1 : 0);
  const region = s.fog > 0.005 ? `${pct(s.fog)} in the Fog${inside ? `: ${plural(inside, 'item')} inside not worked out` : ''}` : 'No fog: everything inside is worked out';
  return mine && s.foggy ? `${mine} · ${region}` : region;
}

/**
 * Where the fog over a place lies (FOG-01, FOG-06): over the land of the parts nobody knows yet, not spread across all
 * of it. A part goes down to its own parts (its child issues and, at street zoom, its behaviours' houses, `kidsOf`)
 * until it is all fog, or too small on screen to tell apart; each patch is as thick as its own part is uncharted.
 * @returns {{ n, g, w }[]}  the parts, their geometry and how thick their fog is
 */
export function fogPatches(n, { fog = fogOver, geo, k, inView = () => true, kidsOf = (m) => m.children }) {
  const out = [];
  (function visit(m) {
    const w = fog(m);
    const g = geo.get(m.id);
    if (!g || w <= 0.02 || !inView(g.bbox)) return;
    const kids = kidsOf(m).filter((c) => geo.has(c.id));
    // Fog in behaviours with no house of their own (written without an ID) lies over the whole block.
    if (!kids.length || w >= 0.98 || g.size * k < 6 || m.stats?.unhoused) out.push({ n: m, g, w });
    else for (const c of kids) visit(c);
  })(n);
  return out;
}

// ---------- the cloud ----------

/**
 * Two layers of cloud drifting at different speeds and scales (FOG-03), in screen pixels per second: slow enough to
 * notice only when you look.
 */
export const FOG_LAYERS = [
  { seed: 11, scale: 1, vx: 11, vy: 3.5, alpha: 1 },
  { seed: 71, scale: 2.4, vx: -6, vy: 2, alpha: 0.9 },
];

/** The fog's clock in seconds: it stands still for someone who asks their system for reduced motion (FOG-03). */
export const fogClock = (seconds, reducedMotion) => (reducedMotion ? 0 : seconds);

/** Where each cloud layer has drifted to after `t` seconds, in screen pixels, at a cloud scale `f`. */
export const driftOf = (t, f = 1) => FOG_LAYERS.map((l) => ({ x: t * l.vx * f, y: t * l.vy * f }));

const fogTiles = new Map();
function fogTile(dark, seed) {
  const key = `${dark}|${seed}`;
  if (!fogTiles.has(key)) {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    let r = seed;
    const rand = () => (r = (r * 9301 + 49297) % 233280) / 233280;
    const tone = dark ? '205,214,228' : '255,255,255';
    const shade = dark ? '40,46,58' : '118,128,146';
    for (let i = 0; i < 30; i++) {
      const x = rand() * S;
      const y = rand() * S;
      const rad = S * (0.09 + rand() * 0.2);
      const a = 0.6 + rand() * 0.4;
      // Every blob is drawn wrapped around the edges, so the tile repeats without a seam.
      for (const dx of [-S, 0, S])
        for (const dy of [-S, 0, S]) {
          const cx = x + dx;
          const cy = y + dy;
          if (cx + rad < 0 || cx - rad > S || cy + rad < 0 || cy - rad > S) continue;
          // A shadowed underside, then the lit top: what makes a soft blob read as cloud.
          for (const [ox, oy, rgb, aa] of [
            [0.22, 0.3, shade, a * 0.7],
            [0, 0, tone, a],
          ]) {
            const px = cx + ox * rad;
            const py = cy + oy * rad;
            const gr = g.createRadialGradient(px, py, 0, px, py, rad);
            gr.addColorStop(0, `rgba(${rgb},${aa})`);
            gr.addColorStop(0.55, `rgba(${rgb},${aa * 0.45})`);
            gr.addColorStop(1, `rgba(${rgb},0)`);
            g.fillStyle = gr;
            g.fillRect(px - rad, py - rad, rad * 2, rad * 2);
          }
        }
    }
    fogTiles.set(key, c);
  }
  return fogTiles.get(key);
}

/**
 * Cloud over the fogged patches (`fogPatches`, each with its region's screen size `s`), in world coordinates. The map
 * draws it over the land, its borders and its houses, and under every symbol, label, badge and pin (FOG-02).
 */
export function drawFog(ctx, items, { k, t, dark, pathFor }) {
  // A veil under the clouds, so even a gap between them still reads as fog.
  ctx.fillStyle = dark ? '#8d99ab' : '#eef1f5';
  for (const { g, w } of items) {
    ctx.globalAlpha = Math.min(1, w * 0.62);
    ctx.fill(pathFor(g));
  }
  FOG_LAYERS.forEach((layer, i) => {
    const p = ctx.createPattern(fogTile(dark, layer.seed), 'repeat');
    ctx.fillStyle = p;
    for (const { g, w, s } of items) {
      // Clouds shrink with the region on screen, so a small region zoomed out still shows whole clouds, not a tint.
      const f = Math.min(1, Math.max(0.18, s / 900)) * layer.scale;
      const d = driftOf(t, f)[i];
      p.setTransform(new DOMMatrix().translate(d.x / k, d.y / k).scale(f / k));
      ctx.globalAlpha = Math.min(1, w * layer.alpha);
      const path = pathFor(g);
      ctx.fill(path);
      // Cloud has no straight edges: it billows a little past its patch, thinning out, so a lot under fog reads as
      // cloud rather than a grey block. Only a little, so a worked-out house beside it still stands clear (FOG-06).
      const feather = Math.min(12, g.size * k * 0.12);
      if (feather > 1.5) {
        ctx.lineJoin = 'round';
        for (const [width, a] of [
          [2, 0.22],
          [1, 0.4],
        ]) {
          ctx.globalAlpha = Math.min(1, w * layer.alpha * a);
          ctx.lineWidth = (feather * width) / k;
          ctx.strokeStyle = p;
          ctx.stroke(path);
        }
      }
    }
  });
}

// ---------- lightning over stale fog (FOG-04) ----------

const DAY = 86_400_000;
/** Fog that hasn't changed for longer than this has sat too long. */
export const STALE_AFTER_DAYS = 14;
/** At most this share of the project's places is ever struck, the oldest first. */
export const STALE_SHARE = 0.05;

/**
 * The places lightning strikes (FOG-04): in the Fog of their own (no behaviours, or one not worked out yet), unchanged
 * for more than 14 days, and among the oldest such, up to 5% of every place in the project, oldest first.
 * @returns {Set<string>} their node ids
 */
export function staleFog(tree, now = Date.now()) {
  const cap = Math.floor(tree.list.length * STALE_SHARE);
  if (!cap) return new Set();
  const changed = (n) => Date.parse(n.updatedAt ?? n.createdAt ?? '');
  const old = tree.list
    .filter((n) => n.stats?.vague && n.status !== 'done' && n.status !== 'rejected' && now - changed(n) > STALE_AFTER_DAYS * DAY)
    .sort((a, b) => changed(a) - changed(b) || a.id.localeCompare(b.id));
  return new Set(old.slice(0, cap).map((n) => n.id));
}

// A place's own random numbers, the same every time it is drawn.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}
function rng(seed) {
  let a = Math.floor(seed * 4294967296) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const pulse = (x, at, width) => Math.exp(-(((x - at) / width) ** 2));

/**
 * The storm over one stale place at time `t` (seconds): now and then a strike, a branching bolt with a flash that
 * flickers two or three times and fades. Between strikes the cloud is dark and still. For someone who asks for reduced
 * motion there is no strike, only a soft glow.
 * @returns {{ flash: number, bolt: number, strike: number|null, glow: number }} flash and bolt brightness, 0 to 1, and
 *   which strike it is (each strike's bolt has its own shape)
 */
export function stormAt(id, t, reducedMotion = false) {
  if (reducedMotion) return { flash: 0, bolt: 0, strike: null, glow: 0.5 };
  const h = hash(id);
  const period = 5 + 7 * h; // seconds between chances to strike
  const u = t / period + h * 13;
  const strike = Math.floor(u);
  const local = (u - strike) * period;
  // Some chances pass without a strike, so it never keeps time.
  if (rng(h + strike * 0.618)() < 0.3 || local > 0.9) return { flash: 0, bolt: 0, strike: null, glow: 0 };
  const flash = Math.max(pulse(local, 0.05, 0.05), 0.8 * pulse(local, 0.27, 0.06), 0.55 * pulse(local, 0.5, 0.05));
  const bolt = local < 0.62 ? Math.max(flash, 0.35 * (1 - local / 0.62)) : 0;
  return { flash, bolt, strike, glow: 0 };
}

const bolts = new Map();
/**
 * A lightning bolt as polylines in a unit box (x across, y from -0.5 at the cloud to 0.5), with a trunk that jags its
 * way down and branches forking off it. The same place and strike always give the same bolt.
 * @returns {{ points: [number, number][], width: number }[]} the trunk first
 */
export function boltOf(id, strike) {
  const key = `${id}|${strike}`;
  if (bolts.has(key)) return bolts.get(key);
  const rand = rng(hash(key));
  const jag = (a, b, depth, rough) => {
    let pts = [a, b];
    for (let d = 0; d < depth; d++) {
      const next = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        const len = Math.hypot(x1 - x0, y1 - y0);
        const off = (rand() - 0.5) * rough * len;
        // Pushed sideways, across the segment.
        next.push([(x0 + x1) / 2 + (-(y1 - y0) / len) * off, (y0 + y1) / 2 + ((x1 - x0) / len) * off], pts[i]);
      }
      pts = next;
    }
    return pts;
  };
  const top = [(rand() - 0.5) * 0.3, -0.5];
  const trunk = jag(top, [(rand() - 0.5) * 0.5, 0.5], 6, 0.55);
  const out = [{ points: trunk, width: 1 }];
  const forks = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < forks; i++) {
    const at = trunk[Math.floor((0.15 + rand() * 0.55) * trunk.length)];
    const side = rand() < 0.5 ? -1 : 1;
    const len = 0.18 + rand() * 0.28;
    const ang = Math.PI / 2 + side * (0.35 + rand() * 0.6);
    const branch = jag(at, [at[0] + Math.cos(ang) * len, at[1] + Math.sin(ang) * len], 4, 0.6);
    out.push({ points: branch, width: 0.5 });
    // Now and then a branch forks again.
    if (rand() < 0.4) {
      const at2 = branch[Math.floor(branch.length * (0.4 + rand() * 0.3))];
      const a2 = ang + side * (0.3 + rand() * 0.4);
      out.push({ points: jag(at2, [at2[0] + Math.cos(a2) * len * 0.5, at2[1] + Math.sin(a2) * len * 0.5], 3, 0.6), width: 0.3 });
    }
  }
  if (bolts.size > 400) bolts.clear();
  bolts.set(key, out);
  return out;
}

/**
 * Lightning in the cloud over each stale place on screen (`places`: { n, g, alpha }), in world coordinates, over the fog
 * and under every label (FOG-04). The storm is sized to the place on screen, within bounds, so it can be seen at any zoom.
 */
export function drawLightning(ctx, places, { k, t, dark, reducedMotion, pathFor }) {
  for (const { n, g, alpha } of places) {
    const [cx, cy] = g.label;
    const L = Math.min(220, Math.max(46, g.size * k * 0.7)) / k; // the bolt's height, in world units
    const storm = stormAt(n.id, t, reducedMotion);
    // A storm cloud: the fog over a stale place darkens, so the flash has something to light up.
    const dim = ctx.createRadialGradient(cx, cy, 0, cx, cy, L * 0.85);
    dim.addColorStop(0, dark ? 'rgba(10,14,26,0.55)' : 'rgba(70,78,98,0.42)');
    dim.addColorStop(1, 'rgba(70,78,98,0)');
    ctx.globalAlpha = alpha;
    ctx.fillStyle = dim;
    ctx.fillRect(cx - L, cy - L, L * 2, L * 2);
    const light = Math.max(storm.flash, storm.glow * 0.6);
    if (light > 0.01) {
      // The cloud lit from inside.
      const fl = ctx.createRadialGradient(cx, cy - L * 0.1, 0, cx, cy - L * 0.1, L * (storm.glow ? 0.7 : 0.95));
      fl.addColorStop(0, storm.glow ? 'rgba(255,236,190,0.75)' : 'rgba(236,242,255,0.95)');
      fl.addColorStop(0.45, storm.glow ? 'rgba(255,226,170,0.3)' : 'rgba(200,214,255,0.45)');
      fl.addColorStop(1, 'rgba(200,214,255,0)');
      ctx.globalAlpha = alpha * light;
      ctx.fillStyle = fl;
      ctx.fillRect(cx - L, cy - L * 1.1, L * 2, L * 2);
      // A flash brightens the place's own fogged land too, not just a disc.
      if (storm.flash > 0.3) {
        ctx.globalAlpha = alpha * storm.flash * 0.25;
        ctx.fillStyle = '#f4f7ff';
        ctx.fill(pathFor(g));
      }
    }
    if (storm.bolt > 0.01) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const parts = boltOf(n.id, storm.strike);
      // A wide soft glow, then the white-hot core.
      for (const [rgb, grow, a] of [
        ['160,180,255', 7, 0.35],
        ['225,232,255', 3, 0.7],
        ['255,255,255', 1.2, 1],
      ]) {
        ctx.strokeStyle = `rgb(${rgb})`;
        for (const { points, width } of parts) {
          ctx.globalAlpha = alpha * storm.bolt * a * (width < 1 ? 0.8 : 1);
          ctx.lineWidth = (Math.max(0.6, width * grow) * Math.min(1.6, Math.max(0.8, L * k / 120))) / k;
          ctx.beginPath();
          points.forEach(([x, y], i) => (i ? ctx.lineTo(cx + x * L, cy + y * L) : ctx.moveTo(cx + x * L, cy + y * L)));
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}
