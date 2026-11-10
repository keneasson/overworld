// The map's symbols (#10 SYM-07). This is the only module that knows which icon library draws them:
// to replace Lucide, change the imports and SOURCES below and nothing else. Everyone else asks for a
// symbol by our own name ('bug', 'pull', …) and gets an SVG path for a 24×24 box, which the canvas
// draws with Path2D and the legend draws as an <svg>.

import { BookOpen, Bot, Bug, CircleHelp, Flag, GitPullRequest, Landmark, Map as MapIcon, MessageCircle, Puzzle, ScrollText, SquareCheck } from 'lucide';

const SOURCES = {
  // What kind of work an item is.
  project: MapIcon,
  area: Landmark,
  epic: Flag,
  feature: Puzzle,
  story: BookOpen,
  task: SquareCheck,
  bug: Bug,
  behavior: ScrollText,
  // Badges: who and what is on an item.
  pull: GitPullRequest,
  agent: Bot,
  comment: MessageCircle,
  question: CircleHelp,
};

export const SYMBOL_NAMES = Object.keys(SOURCES);

const num = (v) => Number(v ?? 0);
// An SVG element as path data, so one Path2D (or one <path>) draws the whole icon.
function pathOf([tag, a]) {
  switch (tag) {
    case 'path':
      return a.d;
    case 'line':
      return `M${num(a.x1)} ${num(a.y1)}L${num(a.x2)} ${num(a.y2)}`;
    case 'polyline':
    case 'polygon': {
      const pts = String(a.points).trim().split(/[\s,]+/).map(Number);
      let d = '';
      for (let i = 0; i + 1 < pts.length; i += 2) d += `${i ? 'L' : 'M'}${pts[i]} ${pts[i + 1]}`;
      return tag === 'polygon' ? `${d}Z` : d;
    }
    case 'circle':
    case 'ellipse': {
      const cx = num(a.cx), cy = num(a.cy), rx = num(a.rx ?? a.r), ry = num(a.ry ?? a.r);
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
    }
    case 'rect': {
      const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height), r = Math.min(num(a.rx ?? a.ry), w / 2, h / 2);
      if (!r) return `M${x} ${y}h${w}v${h}h${-w}Z`;
      return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`;
    }
    default:
      return '';
  }
}

const paths = new Map(SYMBOL_NAMES.map((name) => [name, SOURCES[name].map(pathOf).filter(Boolean).join('')]));

/** The symbol's outline as SVG path data in a 24×24 box, drawn as a 2px round-capped stroke. '' for an unknown name. */
export const symbolPath = (name) => paths.get(name) ?? '';

const path2d = new Map();
/** Stroke a symbol centred on (x, y), `size` pixels across. */
export function drawSymbol(ctx, name, x, y, size, color) {
  if (!path2d.has(name)) path2d.set(name, new Path2D(symbolPath(name)));
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(path2d.get(name));
  ctx.restore();
}
