// The rich-text side of the editor: which TipTap extensions a section may use, and how a section's
// markdown passes through them. The tests run the same pipeline in Node, so what they prove holds
// for the editor in the browser.

import { Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Paragraph from '@tiptap/extension-paragraph';
import { MarkdownManager } from '@tiptap/markdown';
import { SuggestionDelete, SuggestionInsert } from './suggestions.js';

// Images in an issue (screenshots, mock-ups) show where they are and are saved as they were written, so they can be
// commented on (#15 NOTE-15) and an edit nearby never drops them.
const Image = Node.create({
  name: 'image',
  inline: true,
  group: 'inline',
  atom: true,
  draggable: false,
  addAttributes: () => ({ src: { default: null }, alt: { default: '' }, title: { default: null } }),
  parseHTML: () => [{ tag: 'img[src]' }],
  renderHTML: ({ HTMLAttributes }) => ['img', { ...HTMLAttributes, loading: 'lazy' }],
  renderText: ({ node }) => node.attrs.alt ?? '',
  markdownTokenName: 'image',
  parseMarkdown: (token) => ({ type: 'image', attrs: { src: token.href, alt: token.text ?? '', title: token.title || null } }),
  renderMarkdown: (node) => `![${node.attrs.alt ?? ''}](${node.attrs.src}${node.attrs.title ? ` "${node.attrs.title}"` : ''})`,
});

// A paragraph that is only an image stays a paragraph holding it, so the image is inline wherever it is written.
const ImageParagraph = Paragraph.extend({
  parseMarkdown: (token, helpers) => {
    const tokens = token.tokens || [];
    if (tokens.length === 1 && tokens[0].type === 'image') return helpers.createNode('paragraph', undefined, helpers.parseInline(tokens));
    return Paragraph.config.parseMarkdown(token, helpers);
  },
});

// "## " starts a section of the issue; "### " and smaller are headings inside one.
// Suggestions (the live document's insertions and deletions, by author) are part of the schema everywhere, so a shared document
// that holds one opens in any editor; what is saved never includes an open suggestion (withoutSuggestions).
const kit = (more = {}) => StarterKit.configure({ heading: { levels: [2, 3, 4] }, link: { openOnClick: false, autolink: true }, paragraph: false, ...more });
export const EXTENSIONS = [kit(), ImageParagraph, Image, SuggestionInsert, SuggestionDelete];
// The same schema for a live, shared document: its undo is the collaboration's own, which undoes only your changes.
export const LIVE_EXTENSIONS = [kit({ undoRedo: false }), ImageParagraph, Image, SuggestionInsert, SuggestionDelete];

let manager = null;
const md = () => (manager ??= new MarkdownManager({ extensions: EXTENSIONS }));

/** Markdown as the editor's document (JSON). */
export const parseMarkdown = (markdown) => md().parse(markdown);

/** The editor's document (JSON) as markdown. */
export const serializeMarkdown = (json) => md().serialize(json);

/** Markdown -> the editor's document -> markdown: exactly what the editor saves for this text. */
export const throughEditor = (markdown) => md().serialize(md().parse(markdown));
