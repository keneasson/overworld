// What was said in a comment, reply or answer, shown as the markdown it was written in (EDIT-15), with mentions
// standing out (NOTE-14). Sanitised wherever there is a page to put it on.

import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const MENTION = /^@[A-Za-z][\w.-]*/;
const escape = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const marked = new Marked({ gfm: true, breaks: true }).use({
  extensions: [
    {
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
    },
  ],
});

/** The HTML for a comment's markdown. */
export const commentHtml = (text = '') => {
  const html = marked.parse(text);
  return DOMPurify.isSupported ? DOMPurify.sanitize(html) : html;
};
