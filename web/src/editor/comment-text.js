// What was said in a comment, reply or answer, shown as the markdown it was written in (EDIT-15), with mentions
// standing out (NOTE-14) and "#12" a link to the item (EDIT-14). Sanitised wherever there is a page to put it on.

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { issueRefExtension } from '../model/links.js';

const MENTION = /^@[A-Za-z][\w.-]*/;
const escape = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const mention = {
  name: 'mention',
  level: 'inline',
  start: (src) => {
    const at = src.search(/@[A-Za-z]/);
    return at < 0 ? undefined : at;
  },
  tokenizer: (src) => {
    const m = MENTION.exec(src);
    return m ? { type: 'mention', raw: m[0] } : undefined;
  },
  renderer: (t) => `<span class="note-mention">${escape(t.raw)}</span>`,
};

// "#12" links to its issue on the map's repository, so a parser per repository.
const parsers = new Map();
const parser = (repo) => {
  if (!parsers.has(repo)) parsers.set(repo, new Marked({ gfm: true, breaks: true }).use({ extensions: [mention, issueRefExtension(repo)] }));
  return parsers.get(repo);
};

/** The HTML for a comment's markdown; `repo` is the map's repository ("owner/name"), for its "#12" links. */
export const commentHtml = (text = '', repo = null) => {
  const html = parser(repo).parse(text);
  return DOMPurify.isSupported ? DOMPurify.sanitize(html) : html;
};
