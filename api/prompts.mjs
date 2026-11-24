// What every prompt to an agent says about the item it is about: the whole item in the strict shape, its parent and its
// neighbours on the map. Applying an answer (#68), acting on an annotation (#15) and handing off an issue (#14) all
// build on this, so an agent gets the same picture of an item however the work reaches it.

import { STATUS_LABEL } from '../shared/schema.js';
import { OTHER_CHANGES, TITLE_CHANGE, editableOf, itemKeyOf, parseIssue, sectionText } from '../shared/issue-shape.js';
import { isOpen, threadsOf } from '../shared/annotations.js';
import { skeletonLines, skeletonsOf } from './skeletons.mjs';
import { SOURCE_WORDS, isPin, isStale, photoName, spotWords } from '../shared/photos.js';

const SIBLINGS_SHOWN = 30;

export const quote = (s) => String(s).split('\n').map((l) => `> ${l}`).join('\n');
export const stateWords = (status) => (STATUS_LABEL[status] ?? status).toLowerCase();

/** What a comment is anchored to, in words: the first line, then any quoted words. */
export function anchorWords(a = {}, photo = null) {
  if (isPin(a)) return pinWords(a, photo);
  if (a.refinement) {
    const what = a.behaviour === OTHER_CHANGES ? 'the other changes (title and sections)' : a.behaviour === TITLE_CHANGE ? 'the title' : a.behaviour?.startsWith('section:') ? `the ${a.behaviour.slice(8)} section` : `behaviour ${a.behaviour}`;
    return a.quote ? [`on these words of ${what}, as your refinement ${a.refinement} proposes it:`, quote(a.quote)] : [`on ${what}, as your refinement ${a.refinement} proposes it`];
  }
  switch (a.on) {
    case 'place':
      return ['on its place on the map'];
    case 'changeset':
      return ['on the changeset of edits in this area that are not on GitHub yet, as a whole'];
    case 'section':
      return [`on the whole ${a.section} section`];
    case 'behaviour':
      return [`on behaviour ${a.behaviour}`];
    case 'image':
      return [`on an image in ${a.section} (${a.src}${a.quote ? `, "${a.quote}"` : ''})`];
    default:
      return a.quote ? [`on these words in ${a.behaviour ? `behaviour ${a.behaviour}` : a.section}:`, quote(a.quote)] : [`on ${a.behaviour ?? a.section}`];
  }
}

/**
 * Where a pin on a screenshot is (#16 SHOT-03): which screenshot, the spot, and whether it may be out of date. The image
 * itself comes with the prompt that hands the pin over: the MCP server attaches it, and photo() shows it again.
 */
function pinWords(a, photo) {
  const what = photo ? `"${photoName(photo)}" (photo ${a.photo}, ${SOURCE_WORDS[photo.source] ?? 'added'}, version ${photo.version})` : `"${a.quote || 'a screenshot'}" (photo ${a.photo})`;
  return [
    `pinned on a screenshot in its Photos, ${what}, at ${spotWords(a, photo)}.`,
    `${photo ? 'The screenshot comes with this prompt as an image; ' : ''}photo(item, photo: "${a.photo}") shows it${photo ? ' again' : ''}, with every pin on it.`,
    ...(photo && isStale(a, photo) ? [`The screenshot has been replaced by a newer one since this was pinned (on version ${a.version ?? 1}), so the spot may be out of date: look at the newer one before acting.`] : []),
  ];
}

/** The item's comments still open (#15 NOTE-07), oldest first: each with what it is anchored to and its whole thread. */
function openComments(comments, key) {
  const open = threadsOf(comments.filter((c) => c.itemKey === key)).filter((t) => isOpen(t.root));
  if (!open.length) return [];
  const said = (c) => `${c.author}: ${c.text.replace(/\n/g, ' ')}`;
  return [
    '',
    `Its open comments (${open.length}), each with what it is on and its thread. Take them into account; they are not settled:`,
    ...open.flatMap(({ root, replies }) => {
      const [where, ...quoted] = anchorWords(root.anchor);
      return [`- ${root.author}, ${where}`, ...quoted.map((q) => q.replace(/^/gm, '  ')), `  ${said(root)}`, ...replies.map((r) => `  - ${said(r)}`)];
    }),
  ];
}

/** The item as it stands, then where it sits: lines of a prompt. */
export function itemContext(nodes, node) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parent = byId.get(node.parentId);
  const siblings = nodes.filter((n) => n.parentId === node.parentId && n.id !== node.id && n.kind !== 'behavior');
  const { title, markdown } = editableOf(node);
  return [
    `The item as it stands: its title is "${title}", and its text, in the strict shape, is:`,
    '',
    '~~~markdown',
    markdown.trim(),
    '~~~',
    '',
    parent ? `Its parent: ${parent.title} (${itemKeyOf(parent)}).` : 'It sits at the top of the map.',
    ...(siblings.length ? ['Its siblings:', ...siblings.slice(0, SIBLINGS_SHOWN).map((s) => `- ${s.title} (${itemKeyOf(s)}), ${stateWords(s.status)}`), ...(siblings.length > SIBLINGS_SHOWN ? [`- and ${siblings.length - SIBLINGS_SHOWN} more`] : [])] : ['It has no siblings.']),
  ];
}

/**
 * The prompt a build goes out with (#14 HANDOFF-01): the behaviours to build, the issue's acceptance and out of scope, and
 * the map around it, its parent, its neighbours and its roads, so a builder needs no chat history.
 * Its comments still open come with it (#15 NOTE-07). Behaviours with no test yet come with their test skeletons, which
 * must pass (#23 SKETCH-02); those with one point to it (SKETCH-03).
 * @param {{ nodes: object[], node: object, behaviours: { id: string, text: string }[], comments?: object[], testing?: object|null, tested?: string[] }} o testing: the project's tests, as the mapper read them
 */
export function buildPrompt({ nodes, node, behaviours, comments = [], testing = null, tested = [] }) {
  const key = itemKeyOf(node);
  const issue = parseIssue(editableOf(node).markdown);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const road = (l, n, way) => `- ${l.type === 'depends' ? (way === 'out' ? 'depends on' : 'is needed by') : `${l.type} ${way === 'out' ? 'to' : 'from'}`} ${n.title} (${itemKeyOf(n)}), ${stateWords(n.status)}`;
  const roads = [
    ...(node.links ?? []).filter((l) => byId.has(l.to)).map((l) => road(l, byId.get(l.to), 'out')),
    ...nodes.flatMap((n) => (n.links ?? []).filter((l) => l.to === node.id).map((l) => road(l, n, 'in'))),
  ];
  const section = (name) => sectionText(issue, name).trim();
  const ids = behaviours.map((b) => `"${b.id}"`).join(', ');
  return [
    `Build ${behaviours.length === 1 ? 'this behaviour' : 'these behaviours'} of ${node.title} (${key}). This prompt holds everything you need.`,
    '',
    ...behaviours.map((b) => `- ${b.id} ${b.text}`),
    ...(section('Acceptance') ? ['', 'Its acceptance:', section('Acceptance')] : []),
    ...(section('Out of scope') ? ['', 'Out of scope, so leave it alone:', section('Out of scope')] : []),
    ...openComments(comments, key),
    '',
    ...skeletonLines(skeletonsOf({ node, testing, tested, ids: behaviours.map((b) => b.id) })),
    ...itemContext(nodes, node),
    ...(roads.length ? ['Its roads:', ...roads] : ['It has no roads to other items.']),
    '',
    'How:',
    `First claim(behaviours: [${ids}]), so the map shows them being coded and nobody else builds them; claim again to hold them longer. Work on a branch of your own and open a pull request; never push to main. Name each test by the behaviour ID it proves. If you can't finish (tests fail, or a question you can't settle), ask() on the item or handoff(behaviours, note) saying where it stands, so the claim is released and the card says why.`,
  ].join('\n');
}
