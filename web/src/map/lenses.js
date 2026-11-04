// Lenses are map types: the same geography, a different question answered.
// Political (what is where), On target, Progress (terrain), Bugs (incidents),
// Fog (poorly defined), New features (night lights), Owners.

import { hsl, interpolateRgbBasis } from 'd3';
import { HEALTH_LABEL, isNewFeature } from '../model/tree.js';

const LIGHT = {
  ocean: '#aad3ee',
  oceanRing: '#c6e3f6',
  land: '#f4f1ea',
  coast: '#7fb2d6',
  border: '#6f6a62',
  text: '#202124',
  muted: '#5f6368',
  halo: 'rgba(255,255,255,0.92)',
  water: '#3f6f9c',
  dark: false,
};
const NIGHT = {
  ocean: '#050914',
  oceanRing: '#0b1326',
  land: '#121a2e',
  coast: '#23345e',
  border: '#33467a',
  text: '#e8ecff',
  muted: '#a3b0d6',
  halo: 'rgba(5,9,20,0.9)',
  water: '#7d92c2',
  dark: true,
};

const AREA_HUES = ['#f3d29b', '#bfe3c0', '#f6c1cf', '#cbc3ea', '#d9c6a5', '#ffd8a6', '#d6e9b8', '#f9c8b6', '#c3cbee', '#ecefb6'];

function areaOf(n) {
  let cur = n;
  while (cur.parent && cur.parent.parent) cur = cur.parent;
  return cur;
}

function politicalFill(n) {
  if (n.depth === 0) return LIGHT.land;
  const a = areaOf(n);
  const base = hsl(AREA_HUES[a.index % AREA_HUES.length]);
  base.l = Math.min(0.94, Math.max(0.6, base.l + (n.depth - 1) * 0.025 + ((n.index % 3) - 1) * 0.035));
  base.s *= n.status === 'done' ? 0.55 : 1;
  return base.formatHex();
}

const HEALTH_FILL = { on_track: '#bde5c6', at_risk: '#ffe08f', off_track: '#f7b2ac', not_started: '#e3e5e8', done: '#c3d7f7' };
const HEALTH_SWATCH = { on_track: '#34a853', at_risk: '#f9ab00', off_track: '#ea4335', not_started: '#9aa0a6', done: '#4285f4' };

const terrain = interpolateRgbBasis(['#efe5cf', '#e4e7b4', '#bcdb92', '#86c178', '#4f9c62', '#2f7a4b']);
const heat = interpolateRgbBasis(['#f6f3ee', '#fde3c3', '#fcb27e', '#f2714c', '#c9302c']);
const fog = interpolateRgbBasis(['#c4c9d0', '#e6e1cc', '#d5ead0', '#bfe0bf']);
// Behaviours: kept (green), partly kept (amber), promised but missing (red), undecided (violet).
const kept = interpolateRgbBasis(['#f7b2ac', '#ffe08f', '#bde5c6', '#8fd19e']);
const BEHAVIOUR_FILL = { done: '#8fd19e', in_progress: '#ffe08f', review: '#ffe08f', planned: '#f7b2ac', blocked: '#f7b2ac', idea: '#e3e5e8' };
const BEHAVIOUR_DOT = { in_progress: '#f9ab00', review: '#f9ab00', planned: '#d93025', blocked: '#d93025', idea: '#9b8cff' };
const OWNER_COLORS = ['#a9cdf5', '#f7c59f', '#b6e0b0', '#e9b6e3', '#f5e19c', '#a7e0dc', '#d3c0f0', '#f4b0b0', '#c9d99a', '#b9c7d6'];

const pct = (v) => `${Math.round(v * 100)}%`;
// How charted a region is: its own definition for leaves, the share of clear items (amplified) for containers.
const charted = (n) => (n.children.length ? Math.max(0, 1 - (1.8 * n.stats.poorlyDefined) / n.stats.items) : Math.min(1, n.stats.def));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function childSummary(n) {
  if (!n.children.length) return '';
  const kinds = {};
  for (const c of n.children) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
  const [kind, count] = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0];
  const word = { area: 'area', epic: 'epic', feature: 'feature', story: 'story', task: 'task', bug: 'bug', behavior: 'behaviour' }[kind] ?? 'item';
  return plural(n.children.length, word, word === 'story' ? 'stories' : `${word}s`) + (count < n.children.length ? ' & more' : '');
}

export const LENSES = [
  {
    id: 'map',
    name: 'Map',
    chip: 'Map',
    icon: '🗺️',
    blurb: 'What is where. Each area gets its own colour, like countries.',
    theme: LIGHT,
    fill: politicalFill,
    stat: (n) => [childSummary(n), pct(n.stats.progress) + ' done'].filter(Boolean).join(' · '),
    legend: (tree) => tree.root.children.slice(0, 10).map((a) => ({ color: politicalFill(a), label: a.title })),
  },
  {
    id: 'health',
    name: 'On target',
    chip: 'On target',
    icon: '🎯',
    blurb: 'Rolled-up health. Red is off target, amber at risk, green on target.',
    theme: LIGHT,
    fill: (n) => HEALTH_FILL[n.stats.health],
    stat: (n) => `${HEALTH_LABEL[n.stats.health]} · ${pct(n.stats.progress)} done${n.stats.blocked ? ` · ${n.stats.blocked} blocked` : ''}`,
    // Root causes: unhealthy nodes none of whose children share the problem.
    matches: (n) =>
      (n.stats.health === 'off_track' || n.stats.health === 'at_risk') &&
      !n.children.some((c) => c.stats.health === 'off_track' || c.stats.health === 'at_risk'),
    sort: (a, b) => (a.stats.health === 'off_track' ? 0 : 1) - (b.stats.health === 'off_track' ? 0 : 1),
    count: (tree) => tree.list.filter((n) => LENSES[1].matches(n)).length,
    legend: () => ['off_track', 'at_risk', 'on_track', 'not_started', 'done'].map((h) => ({ color: HEALTH_SWATCH[h], label: HEALTH_LABEL[h] })),
  },
  {
    id: 'progress',
    name: 'Progress',
    chip: 'Progress',
    icon: '⛰️',
    blurb: 'Terrain by completion: sandy lowlands are untouched, deep green is done.',
    theme: LIGHT,
    fill: (n) => terrain(n.stats.progress),
    stat: (n) => `${pct(n.stats.progress)} done · ${n.stats.doneLeaves}/${n.stats.leaves} items`,
    legend: () => [0, 0.25, 0.5, 0.75, 1].map((t) => ({ color: terrain(t), label: pct(t) })),
  },
  {
    id: 'bugs',
    name: 'Bugs',
    chip: 'Bugs',
    icon: '🐞',
    blurb: 'Open bugs as incidents. Hotter regions have more of them.',
    theme: LIGHT,
    fill: (n, tree) => {
      if (n.kind === 'bug') return n.status === 'done' ? '#e8eaed' : '#f28b82';
      const max = tree.maxByDepth.openBugs[n.depth] || 1;
      return n.stats.openBugs ? heat(0.2 + 0.8 * (n.stats.openBugs / max)) : heat(0);
    },
    dots: (n) => n.kind === 'bug' && n.status !== 'done',
    stat: (n) => (n.kind === 'bug' ? `${n.priority || 'Bug'} · ${n.status.replace('_', ' ')}` : n.stats.openBugs ? plural(n.stats.openBugs, 'open bug') : 'No open bugs'),
    matches: (n) => n.kind === 'bug' && n.status !== 'done',
    sort: (a, b) => (a.priority || 'P9').localeCompare(b.priority || 'P9'),
    count: (tree) => tree.root.stats.openBugs,
    legend: () => [
      { color: heat(0), label: 'No open bugs' },
      { color: heat(0.45), label: 'Some' },
      { color: heat(1), label: 'Hotspot' },
      { color: '#d93025', label: 'Bug', dot: true },
    ],
  },
  {
    id: 'definition',
    name: 'Fog',
    chip: 'Poorly defined',
    icon: '🌫️',
    blurb: 'Uncharted territory: items missing a summary, details, acceptance criteria or an estimate.',
    theme: LIGHT,
    fill: (n) => fog(charted(n)),
    hatch: (n) => n.stats.vague,
    stat: (n) =>
      n.stats.vague
        ? `Uncharted · ${pct(n.stats.def)} defined`
        : n.children.length
          ? `${pct(1 - n.stats.poorlyDefined / n.stats.items)} charted${n.stats.poorlyDefined ? ` · ${n.stats.poorlyDefined} vague` : ''}`
          : `${pct(n.stats.def)} defined`,
    matches: (n) => n.stats.vague && n.depth > 0,
    sort: (a, b) => a.depth - b.depth,
    count: (tree) => tree.root.stats.poorlyDefined,
    legend: () => [
      { color: fog(1), label: 'Well defined' },
      { color: fog(0.55), label: 'Partly defined' },
      { color: fog(0), label: 'Uncharted', hatch: true },
    ],
  },
  {
    id: 'behaviours',
    name: 'Behaviours',
    chip: 'Behaviours',
    icon: '📜',
    blurb: 'The laws of each place: what the behaviour specs say the product must do, and whether it does. Hatched land has no spec yet.',
    theme: LIGHT,
    fill: (n) => {
      if (n.kind === 'behavior') return n.definition === 'vague' ? '#d9d2f4' : BEHAVIOUR_FILL[n.status];
      return n.stats.behaviours ? kept(n.stats.behavioursKept / n.stats.behaviours) : '#eceff1';
    },
    hatch: (n) => n.kind !== 'behavior' && !n.stats.behaviours,
    dots: (n) => n.kind === 'behavior' && n.status !== 'done',
    dotColor: (n) => (n.definition === 'vague' ? '#8e7cc3' : BEHAVIOUR_DOT[n.status] ?? '#d93025'),
    stat: (n) =>
      n.kind === 'behavior'
        ? n.status === 'done'
          ? 'Behaviour kept'
          : n.definition === 'vague'
            ? 'Decision needed'
            : `Behaviour ${n.status === 'idea' ? 'deferred' : n.status === 'planned' ? 'missing' : 'partly kept'}`
        : n.stats.behaviours
          ? `${n.stats.behavioursKept} of ${plural(n.stats.behaviours, 'behaviour')} kept`
          : 'No behaviour spec here',
    matches: (n) => n.kind === 'behavior' && n.status !== 'done',
    sort: (a, b) => (a.status === 'planned' ? 0 : 1) - (b.status === 'planned' ? 0 : 1),
    count: (tree) => tree.root.stats.behaviours - tree.root.stats.behavioursKept,
    legend: () => [
      { color: kept(1), label: 'Kept' },
      { color: kept(0.5), label: 'Partly' },
      { color: kept(0), label: 'Missing' },
      { color: '#d9d2f4', label: 'Decision needed' },
      { color: '#eceff1', label: 'No spec', hatch: true },
    ],
  },
  {
    id: 'features',
    name: 'New features',
    chip: 'New features',
    icon: '✨',
    blurb: 'Night view: every new-feature user story is a light. Bright clusters are where new value lands.',
    theme: NIGHT,
    fill: (n) => {
      const c = hsl(NIGHT.land);
      c.l += Math.min(0.06, n.depth * 0.012) + (n.index % 2) * 0.01;
      return c.formatHex();
    },
    lights: (n) => isNewFeature(n),
    stat: (n) =>
      isNewFeature(n)
        ? `User story · ${n.status.replace('_', ' ')}`
        : n.stats.newFeatures + n.stats.newFeaturesDone
          ? `${plural(n.stats.newFeatures, 'new feature')} to build${n.stats.newFeaturesDone ? ` · ${n.stats.newFeaturesDone} shipped` : ''}`
          : 'No new features',
    matches: (n) => isNewFeature(n) && n.status !== 'done',
    count: (tree) => tree.root.stats.newFeatures,
    legend: () => [
      { color: '#9b8cff', label: 'Idea', dot: true },
      { color: '#ffbf5e', label: 'Planned', dot: true },
      { color: '#fff0b8', label: 'In progress', dot: true },
      { color: '#ffffff', label: 'Shipped', dot: true },
    ],
  },
  {
    id: 'owners',
    name: 'Owners',
    chip: 'Owners',
    icon: '👤',
    blurb: 'Who holds each territory. Hatched land has no owner.',
    theme: LIGHT,
    fill: (n, tree) => (n.stats.owner ? OWNER_COLORS[tree.owners.indexOf(n.stats.owner) % OWNER_COLORS.length] : '#eceff1'),
    hatch: (n) => !n.stats.owner,
    stat: (n) => (n.stats.owner ? `${n.assignee ? '' : 'mostly '}@${n.stats.owner}` : 'Unowned'),
    legend: (tree) => [
      ...tree.owners.slice(0, 9).map((o, i) => ({ color: OWNER_COLORS[i % OWNER_COLORS.length], label: `@${o}` })),
      { color: '#eceff1', label: 'Unowned', hatch: true },
    ],
  },
];

export const LENS_BY_ID = Object.fromEntries(LENSES.map((l) => [l.id, l]));

export const LIGHT_COLORS = {
  idea: '#9b8cff',
  planned: '#ffbf5e',
  in_progress: '#fff0b8',
  review: '#fff0b8',
  blocked: '#ff8a80',
  done: '#ffffff',
};
