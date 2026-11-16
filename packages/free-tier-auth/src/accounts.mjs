import { AuthError, normalEmail, random } from './util.mjs';

// Accounts (tenants), their members and invites (AUTH-05, AUTH-06). Two roles: owner and member.
export function createAccounts({ store, endSessionsOf, clock = Date.now }) {
  const roleIn = async (accountId, personId) => (await store.get(`member#${accountId}#${personId}`))?.role;
  const join = async (accountId, personId, role) => {
    await store.put(`member#${accountId}#${personId}`, { role });
    await store.put(`memberof#${personId}#${accountId}`, { role });
  };
  const requireOwner = async (accountId, personId) => { if (await roleIn(accountId, personId) !== 'owner') throw new AuthError(403, 'Only the account\'s owner can do that'); };

  const api = {
    async create(personId, name) {
      const account = { id: random(12), name: String(name || 'My account'), ownerId: personId, createdAt: clock() };
      await store.put(`account#${account.id}`, account);
      await join(account.id, personId, 'owner');
      return account;
    },
    // The accounts a person belongs to, and nothing else.
    async of(personId) {
      const rows = await store.list(`memberof#${personId}#`);
      const accounts = await Promise.all(rows.map(async ({ key, value }) => ({ ...(await store.get(`account#${key.split('#')[2]}`)), role: value.role })));
      return accounts.filter((a) => a.id);
    },
    // Every call that acts within an account goes through this: a person outside it gets a 403, never the account's data.
    async require(personId, accountId) {
      const role = await roleIn(accountId, personId);
      if (!role) throw new AuthError(403, 'Not a member of this account');
      return role;
    },
    async members(accountId) {
      return (await store.list(`member#${accountId}#`)).map(({ key, value }) => ({ personId: key.split('#')[2], role: value.role }));
    },
    async invite(byPersonId, accountId, email) {
      await requireOwner(accountId, byPersonId);
      const e = normalEmail(email);
      if (!e.includes('@')) throw new AuthError(400, 'An invite needs an email address');
      await store.put(`invite#${accountId}#${e}`, { email: e, invitedBy: byPersonId, at: clock() });
      await store.put(`invitefor#${e}#${accountId}`, {});
      return { accountId, email: e };
    },
    async invites(accountId) { return (await store.list(`invite#${accountId}#`)).map(({ value }) => value); },
    async cancelInvite(byPersonId, accountId, email) {
      await requireOwner(accountId, byPersonId);
      const e = normalEmail(email);
      await store.delete(`invite#${accountId}#${e}`);
      await store.delete(`invitefor#${e}#${accountId}`);
    },
    // Called at each sign-in with the emails the provider has verified: an invite to one of them is accepted.
    async claimInvites(personId, verifiedEmails = []) {
      const joined = [];
      for (const e of new Set(verifiedEmails.map(normalEmail))) {
        for (const { key } of await store.list(`invitefor#${e}#`)) {
          const accountId = key.split('#')[2];
          if (!(await roleIn(accountId, personId))) { await join(accountId, personId, 'member'); joined.push(accountId); }
          await store.delete(key);
          await store.delete(`invite#${accountId}#${e}`);
        }
      }
      return joined;
    },
    // Removing someone ends their sessions at once.
    async remove(byPersonId, accountId, personId) {
      await requireOwner(accountId, byPersonId);
      if (await roleIn(accountId, personId) === 'owner') throw new AuthError(400, 'The owner can\'t be removed');
      await store.delete(`member#${accountId}#${personId}`);
      await store.delete(`memberof#${personId}#${accountId}`);
      await endSessionsOf(personId);
    },
  };
  return api;
}
