// 2026-11-22: open questions move out of comments and into their items' text (#68 ANSWER-08).
//
//   node scripts/migrations/002-questions-into-sections.mjs            # back up, then move them
//   node scripts/migrations/002-questions-into-sections.mjs --dry-run  # back up, and say what would move
//
// Before, a question was a comment on an item's Open questions heading, and a person's reply in its thread was its answer.
// Now a question is a line in the item's Open questions section, with its answer written directly under it as "Answer: …",
// and a comment is never a question (NOTE-22). Each one still open becomes a line in its item's Open questions, in place
// of "None.", with its answer under it if it has one; who asked and answered, and when, are kept beside the text. The
// comment is dismissed to the conversation log, saying where it went. An item from a store is then unsaved, like any
// accepted edit, and reaches the store with the next save. One already applied, or dismissed, stays as it is.
//
// It's safe to repeat: a question already in its item's text is not written twice, and a moved comment is dismissed.
// The app keeps working with the old comments still there: they read as plain comments.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from '../../shared/brand.js';
import { editableOf, itemKeyOf } from '../../shared/issue-shape.js';
import { questionId, questionsIn, withAnswer, withQuestion } from '../../shared/questions.js';
import { isDismissed } from '../../shared/annotations.js';

const MOVED = 'Moved into the item\'s Open questions section: a question is a line there now, and its answer is written under it.';

/**
 * What the move changes in one project, decided from its nodes and comments alone.
 * @returns {{ items: { node: object, markdown: string }[], questions: object[], dismissed: object[] }} the new text of each
 *   item that changes, what is kept beside each question, and the comments, dismissed
 */
export function questionsIntoSections({ nodes, comments, at }) {
  const asked = comments.filter((c) => !c.replyTo && c.anchor?.section === 'Open questions' && !c.anchor?.refinement && !isDismissed(c) && !c.answer?.appliedAt);
  const items = [];
  const questions = [];
  const dismissed = [];
  for (const key of [...new Set(asked.map((c) => c.itemKey))]) {
    const node = nodes.find((n) => itemKeyOf(n) === key);
    if (!node) continue; // its item is gone: the comment stays where it is
    const before = editableOf(node).markdown;
    let markdown = before;
    for (const c of asked.filter((x) => x.itemKey === key)) {
      const text = c.text.replace(/\s+/g, ' ').trim();
      const id = questionId(key, text);
      if (!questionsIn(key, markdown).some((q) => q.id === id)) markdown = withQuestion(markdown, text);
      if (c.answer?.text) markdown = withAnswer(markdown, key, id, c.answer.text);
      const answer = questionsIn(key, markdown).find((q) => q.id === id)?.answer;
      const agentId = c.author.match(/\((a[\w-]+)\)$/)?.[1];
      questions.push({
        itemKey: key, id, text,
        asked: { by: c.author, at: c.createdAt, ...(agentId ? { agentId } : {}) },
        ...(c.answer?.text ? { answered: { text: answer, by: c.answer.by, at: c.answer.at, ...(c.answer.prompt ? { prompt: c.answer.prompt } : {}) } } : {}),
      });
      dismissed.push({ ...c, dismissed: { by: APP_NAME, at, note: MOVED } });
    }
    if (markdown !== before) items.push({ node, markdown });
  }
  return { items, questions, dismissed };
}

async function main() {
  const { dynamoTable } = await import('../../api/model/table.mjs');
  const { modelFor } = await import('../../api/model/index.mjs');
  const { readDeployConfig } = await import('../local-config.mjs');
  const { applyTo } = await import('../../api/edits.mjs');
  const { markEdited } = await import('../../api/sync.mjs');
  const { createStores } = await import('../../api/stores/index.mjs');
  const root = new URL('../../', import.meta.url).pathname;
  const dry = process.argv.includes('--dry-run');
  const local = readDeployConfig();
  const table = await dynamoTable(local.tableName, { region: local.region });
  const model = modelFor(table);

  const all = await table.scan();
  mkdirSync(`${root}.data/backups`, { recursive: true });
  const backup = `${root}.data/backups/${local.tableName}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(backup, JSON.stringify(all));
  console.log(`Backed up ${all.length} items to ${backup}`);

  const stores = createStores();
  const at = new Date().toISOString();
  for (const p of await model.projects.list()) {
    const { project, nodes } = await model.projects.getWithNodes(p.id);
    const comments = await model.comments.list(p.id);
    const { items, questions, dismissed } = questionsIntoSections({ nodes, comments, at });
    if (!dismissed.length) continue;
    console.log(`${project.title} (${p.id}): ${dismissed.length} question${dismissed.length === 1 ? '' : 's'} into ${items.length} item${items.length === 1 ? '' : 's'}: ${items.map((i) => i.node.title).join('; ')}`);
    if (dry) continue;
    const store = stores.forProject(project);
    const changed = items.map(({ node, markdown }) => markEdited(node, applyTo(node, { ...editableOf(node), markdown }, at), store));
    if (changed.length) await model.nodes.put(p.id, changed);
    for (const q of questions) await model.questions.put(p.id, { ...(await model.questions.get(p.id, q)), ...q });
    for (const c of dismissed) {
      await model.comments.put(p.id, c);
      await model.inbox.delete(p.id, c.id);
    }
  }
  console.log(dry ? 'Dry run: nothing changed.' : 'Done. The items moved are unsaved: Save in the app sends them to GitHub.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
