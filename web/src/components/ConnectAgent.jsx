import { useEffect, useState } from 'react';
import { APP_NAME } from '@shared/brand.js';
import { api } from '../api.js';
import { Icon } from './Icon.jsx';

// Connecting an agent (#34 CONN-07): name it, get its token once, copy one ready-made command or setting for the
// tool, and watch it turn connected on its first call. Below, the project's agents, any of which can be revoked.

const SERVER = 'overworld';

const TOOLS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    where: 'Run this in the repository’s folder. It applies to that folder only; use --scope user instead to have it everywhere (it still reaches only this project).',
    text: (url, token) => `claude mcp add --transport http --scope local ${SERVER} ${url} --header "Authorization: Bearer ${token}"`,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    where: 'Add this to .cursor/mcp.json in the repository (or ~/.cursor/mcp.json for every project). Keep the file out of git: it holds the token.',
    text: (url, token) => JSON.stringify({ mcpServers: { [SERVER]: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
  },
  {
    id: 'vscode',
    label: 'VS Code',
    where: 'Add this to .vscode/mcp.json in the repository. Keep the file out of git: it holds the token.',
    text: (url, token) => JSON.stringify({ servers: { [SERVER]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
  },
  {
    id: 'other',
    label: 'Other',
    where: 'Any MCP client that can reach a remote server over streamable HTTP with a header. Claude on the web and the desktop app need sign-in instead, which comes with GitHub sign-in.',
    text: (url, token) => `URL:     ${url}\nHeader:  Authorization: Bearer ${token}`,
  },
];

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

function Copy({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // no clipboard (an insecure page): the text is still there to select
        }
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={16} /> {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export function ConnectAgent({ projectId, projectTitle, onClose, onError }) {
  const [agents, setAgents] = useState(null);
  const [name, setName] = useState('');
  const [made, setMade] = useState(null); // { agent, token }: the token is held here only, and only until this closes
  const [tool, setTool] = useState(TOOLS[0].id);
  const [armed, setArmed] = useState(null);
  const [busy, setBusy] = useState(false);
  const url = `${window.location.origin}/api/mcp`;

  const load = () =>
    api
      .listAgents(projectId)
      .then((r) => setAgents(r.agents))
      .catch(onError);
  useEffect(() => {
    load();
  }, [projectId]);

  const live = made && agents?.find((a) => a.id === made.agent.id);
  const connected = Boolean(live?.lastSeenAt);
  // Until the new agent's first call, look again every few seconds.
  useEffect(() => {
    if (!made || connected) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [made, connected]);

  const chosen = TOOLS.find((t) => t.id === tool);
  const listed = (agents ?? []).slice().sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer wide" onClick={(e) => e.stopPropagation()} aria-label="Connect an agent">
        <header className="drawer-head">
          <span className="brand">
            <Icon name="link" /> Connect an agent
          </span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <p className="muted small">
          Your coding agent (Claude Code, Cursor, VS Code…) reads {APP_NAME}’s instructions for <b>{projectTitle}</b>, claims work, asks questions and hands off through {APP_NAME}’s MCP
          server. It codes on your machine, with your own AI.
        </p>

        {!made ? (
          <section>
            <h3>1. Name it</h3>
            <form
              className="stack-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  setMade(await api.createAgent(projectId, { name: name.trim() }));
                  load();
                } catch (err) {
                  onError(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <input aria-label="Agent name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Code on my laptop" maxLength={80} required />
              <button type="submit" className="primary" disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create its token'}
              </button>
            </form>
          </section>
        ) : (
          <>
            <section>
              <h3>2. Add it to your tool</h3>
              <p className="warn small">
                <Icon name="lock" size={14} /> This token is shown once. Copy it now; {APP_NAME} keeps only its fingerprint. Don’t paste it into chats or commit it.
              </p>
              <div className="tool-tabs" role="tablist">
                {TOOLS.map((t) => (
                  <button key={t.id} role="tab" aria-selected={tool === t.id} className={`chip-btn${tool === t.id ? ' on' : ''}`} onClick={() => setTool(t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="muted small">{chosen.where}</p>
              <div className="snippet">
                <pre>{chosen.text(url, made.token)}</pre>
                <Copy text={chosen.text(url, made.token)} />
              </div>
            </section>
            <section>
              <h3>3. Start it</h3>
              <p className="small">
                Restart your agent. In Claude Code, run <code>/mcp__overworld__standup</code>; in other tools, ask it to call <code>standup</code> (or <code>prime</code>).
              </p>
              <p className={`status small${connected ? ' ok' : ''}`} aria-live="polite">
                <Icon name={connected ? 'check' : 'refresh'} size={14} />{' '}
                {connected ? `${made.agent.name} (${made.agent.id}) is connected.` : `Waiting for ${made.agent.name} (${made.agent.id}) to call…`}
              </p>
              <button className="link-btn" onClick={() => (setMade(null), setName(''))}>
                <Icon name="plus" size={16} /> Connect another
              </button>
            </section>
          </>
        )}

        <section>
          <h3>This project’s agents</h3>
          {!agents ? (
            <p className="muted small">Loading…</p>
          ) : !listed.length ? (
            <p className="muted small">None yet.</p>
          ) : (
            <ul className="agent-list">
              {listed.map((a) => (
                <li key={a.id} className={a.revokedAt ? 'revoked' : ''}>
                  <span className="row-title">
                    {a.name} <span className="muted">({a.id})</span>
                  </span>
                  <span className="row-sub">
                    created {when(a.createdAt)} · {a.lastSeenAt ? `last seen ${when(a.lastSeenAt)}` : 'never connected'}
                    {a.revokedAt ? ` · revoked ${when(a.revokedAt)}` : ''}
                  </span>
                  {!a.revokedAt && (
                    <button
                      className={`link-btn danger${armed === a.id ? ' armed' : ''}`}
                      onClick={async () => {
                        if (armed !== a.id) return setArmed(a.id);
                        try {
                          await api.revokeAgent(projectId, a.id);
                          setArmed(null);
                          load();
                        } catch (err) {
                          onError(err);
                        }
                      }}
                      onBlur={() => setArmed(null)}
                    >
                      {armed === a.id ? 'Click again to revoke' : 'Revoke'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}
