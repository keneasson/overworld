// What every prompt to an agent says about the item it is about: the whole item in the strict shape, its parent and its
// neighbours on the map. Applying an answer (#68), acting on an annotation (#15) and handing off an issue (#14) all
// build on this, so an agent gets the same picture of an item however the work reaches it.

import { STATUS_LABEL } from '../shared/schema.js';
import { editableOf, itemKeyOf, parseIssue, sectionText } from '../shared/issue-shape.js';

const SIBLINGS_SHOWN = 30;

export const quote = (s) => String(s).split('\n').map((l) => `> ${l}`).join('\n');
export const stateWords = (status) => (STATUS_LABEL[status] ?? status).toLowerCase();

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
 * @param {{ nodes: object[], node: object, behaviours: { id: string, text: string }[] }} o
 */
export function buildPrompt({ nodes, node, behaviours }) {
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
    '',
    ...itemContext(nodes, node),
    ...(roads.length ? ['Its roads:', ...roads] : ['It has no roads to other items.']),
    '',
    'How:',
    `First claim(behaviours: [${ids}]), so the map shows them being coded and nobody else builds them; claim again to hold them longer. Work on a branch of your own and open a pull request; never push to main. Name each test by the behaviour ID it proves. If you can't finish (tests fail, or a question you can't settle), ask() on the item or handoff(behaviours, note) saying where it stands, so the claim is released and the card says why.`,
  ].join('\n');
}
