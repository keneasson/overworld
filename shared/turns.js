// Whose turn it is in a refinement (#13 ADOPT-20, ADOPT-21). A person's own edit is a turn in the conversation, not a
// decision waiting to be made: it goes to an agent, and it is offered for adoption once an agent has marked it ready.
// The API, the agents' hand-off, the panel and the Review list all read it here, so they never disagree.

/** An agent writes as "Name (a1b2c)", its name and its short id (AGENT-01); a person writes as their name. */
export const byAgent = (author) => /\s\(a[0-9a-f]{4}\)$/.test(String(author ?? ''));

/**
 * Whose turn an item's change in a refinement is: 'agent' while a person's own change waits for an agent to look at it,
 * 'talking' once an agent has answered it without marking anything ready, and null when it is there to adopt or
 * decline (an agent's proposal, a new item, a bug report, or anything marked ready for adoption).
 */
export function turnOf(cs, item) {
  if (!cs || !item || item.new || cs.report || byAgent(cs.author)) return null;
  if (item.readyForAdoption?.length) return null;
  return item.looked ? 'talking' : 'agent';
}
