// The rich-text side of the editor: which TipTap extensions a section may use, and how a section's
// markdown passes through them. The tests run the same pipeline in Node, so what they prove holds
// for the editor in the browser.

import StarterKit from '@tiptap/starter-kit';
import { MarkdownManager } from '@tiptap/markdown';

// "## " starts a section of the issue; "### " and smaller are headings inside one.
export const EXTENSIONS = [StarterKit.configure({ heading: { levels: [2, 3, 4] }, link: { openOnClick: false, autolink: true } })];

let manager = null;
const md = () => (manager ??= new MarkdownManager({ extensions: EXTENSIONS }));

/** Markdown -> the editor's document -> markdown: exactly what the editor saves for this text. */
export const throughEditor = (markdown) => md().serialize(md().parse(markdown));
