// Shared vocabulary for the map. Imported by the Lambda API and the web app.

export const KINDS = ['project', 'area', 'epic', 'feature', 'story', 'task', 'bug', 'behavior'];
export const STATUSES = ['idea', 'planned', 'in_progress', 'review', 'blocked', 'done'];
export const HEALTH = ['auto', 'on_track', 'at_risk', 'off_track'];
export const DEFINITION = ['auto', 'clear', 'vague'];
export const PRIORITIES = ['', 'P0', 'P1', 'P2', 'P3'];
export const LINK_TYPES = ['depends', 'navigates', 'relates'];
// Roughly where something sits on the website, relative to what it is inside.
export const PLACES = ['auto', 'top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right', 'offscreen'];
// Top-level items can be a continent of their own, shaped like what they are.
export const SURFACES = ['auto', 'none', 'web', 'mobile', 'email', 'api', 'service', 'external', 'uncharted'];

// What you most likely want to add underneath a node of a given kind.
export const CHILD_KIND = {
  project: 'area',
  area: 'epic',
  epic: 'feature',
  feature: 'story',
  story: 'task',
  task: 'task',
  bug: 'task',
  behavior: 'task',
};

export const KIND_LABEL = {
  project: 'Project',
  area: 'Area',
  epic: 'Epic',
  feature: 'Feature',
  story: 'Story',
  task: 'Task',
  bug: 'Bug',
  behavior: 'Behaviour',
};

export const STATUS_LABEL = {
  idea: 'Idea',
  planned: 'Planned',
  in_progress: 'In progress',
  review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
};

export const LINK_LABEL = {
  depends: 'depends on',
  navigates: 'navigates to',
  relates: 'relates to',
};

export const PLACE_LABEL = {
  auto: 'Automatic',
  'top-left': 'Top left',
  top: 'Top',
  'top-right': 'Top right',
  left: 'Left',
  center: 'Middle',
  right: 'Right',
  'bottom-left': 'Bottom left',
  bottom: 'Bottom',
  'bottom-right': 'Bottom right',
  offscreen: 'Behind the screen',
};

export const SURFACE_LABEL = {
  auto: 'Automatic',
  none: 'No, part of the shared map',
  web: 'Web app (wide screen)',
  mobile: 'Mobile app (phone)',
  email: 'Emails (letters people receive)',
  api: 'API (the bridge between front and back)',
  service: 'Back-end service',
  external: 'Third-party service (island)',
  uncharted: 'Uncharted (not placed yet)',
};

export const ROOT_ID = 'root';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

const str = (max) => (v) => {
  if (v == null) return '';
  if (typeof v !== 'string') throw new ValidationError('expected a string');
  return v.slice(0, max);
};
const oneOf = (list, fallback = list[0]) => (v) => {
  if (v == null || v === '') return fallback;
  if (!list.includes(v)) throw new ValidationError(`must be one of: ${list.filter(Boolean).join(', ')}`);
  return v;
};
const num = (min, max) => (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ValidationError('expected a number');
  return Math.min(max, Math.max(min, n));
};
const date = (v) => {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) throw new ValidationError('expected YYYY-MM-DD');
  return v.slice(0, 10);
};
const id = (v) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^[\w-]{1,64}$/.test(v)) throw new ValidationError('invalid id');
  return v;
};
const tags = (v) => {
  if (v == null) return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  return [...new Set(list.map((t) => String(t).trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20);
};
const links = (v) => {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new ValidationError('links must be an array');
  const seen = new Set();
  const out = [];
  for (const l of v.slice(0, 100)) {
    const to = id(l?.to);
    const type = oneOf(LINK_TYPES, 'relates')(l?.type);
    if (!to || seen.has(type + to)) continue;
    seen.add(type + to);
    out.push({ to, type, label: str(80)(l?.label ?? '') });
  }
  return out;
};

const FIELDS = {
  parentId: id,
  title: str(200),
  summary: str(1000),
  body: str(20000),
  kind: oneOf(KINDS, 'task'),
  status: oneOf(STATUSES, 'planned'),
  health: oneOf(HEALTH),
  definition: oneOf(DEFINITION),
  priority: oneOf(PRIORITIES),
  place: oneOf(PLACES),
  surface: oneOf(SURFACES),
  tags,
  estimate: num(0, 1000),
  weight: num(0.1, 1000),
  assignee: str(80),
  due: date,
  order: num(-1e9, 1e9),
  url: str(500),
  links,
};

export const NODE_FIELDS = Object.keys(FIELDS);

/**
 * Validate and normalise a node payload. With `partial`, only the provided
 * fields are returned so the result can be merged into an existing node.
 */
export function sanitizeNode(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object') throw new ValidationError('node must be an object');
  const out = {};
  for (const [key, clean] of Object.entries(FIELDS)) {
    if (partial && !(key in input)) continue;
    try {
      out[key] = clean(input[key]);
    } catch (err) {
      throw new ValidationError(`${key}: ${err.message}`);
    }
  }
  if (!partial && !out.title) out.title = 'Untitled';
  if ('title' in out && !out.title.trim()) throw new ValidationError('title: required');
  return out;
}

export function newId() {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
