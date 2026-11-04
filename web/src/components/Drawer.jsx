import { useRef, useState } from 'react';
import { APP_NAME } from '@shared/brand.js';
import { Icon } from './Icon.jsx';

export function Drawer({ projects, currentId, onOpen, onClose, onCreate, onDelete, onImportGithub, onRefreshGithub, onImportJson, onExport, onLock, busy }) {
  const [title, setTitle] = useState('');
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [armed, setArmed] = useState(null);
  const fileRef = useRef(null);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Projects">
        <header className="drawer-head">
          <span className="brand">
            <Icon name="map" /> {APP_NAME}
          </span>
          <button className="icon-btn" onClick={onClose} aria-label="Close menu">
            <Icon name="close" />
          </button>
        </header>

        <section>
          <h3>Projects</h3>
          <ul className="project-list">
            {projects.map((p) => (
              <li key={p.id} className={p.id === currentId ? 'current' : ''}>
                <button className="project-open" onClick={() => onOpen(p.id)}>
                  <span className="row-title">{p.title}</span>
                  <span className="row-sub">
                    {p.nodeCount ?? '?'} items · {p.source === 'github' ? 'GitHub import · ' : ''}updated {new Date(p.updatedAt).toLocaleDateString()}
                  </span>
                </button>
                {p.githubRepo && (
                  <button
                    className="icon-btn small"
                    aria-label={`Refresh ${p.title} from GitHub`}
                    title="Map the repository again (same link)"
                    disabled={busy}
                    onClick={() => onRefreshGithub(p.id, { token: token.trim() })}
                  >
                    <Icon name="refresh" size={16} />
                  </button>
                )}
                <button
                  className={`icon-btn small${armed === p.id ? ' armed' : ''}`}
                  aria-label={armed === p.id ? `Confirm delete ${p.title}` : `Delete ${p.title}`}
                  title={armed === p.id ? 'Click again to delete' : 'Delete'}
                  onClick={() => (armed === p.id ? onDelete(p.id) : setArmed(p.id))}
                  onBlur={() => setArmed(null)}
                >
                  <Icon name="trash" size={16} />
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3>New project</h3>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              onCreate({ title: title.trim() || 'New project' });
              setTitle('');
            }}
          >
            <input aria-label="Project title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project title" maxLength={200} />
            <button type="submit" disabled={busy}>
              Create
            </button>
          </form>
          <button className="link-btn" onClick={() => onCreate({ template: 'demo' })} disabled={busy}>
            <Icon name="sparkle" size={16} /> Add another copy of the demo project
          </button>
        </section>

        <section>
          <h3>
            <Icon name="github" size={18} /> Map a GitHub repository
          </h3>
          <p className="muted small">
            The code becomes the land: pages, API, apps, shared packages, and the services it uses as islands. Issues nest under the issues they name (sub-issues, task lists,
            “Part of #12”) and sit where their code lives. Behaviour specs in <code>docs/behavior</code> become laws you can check with the Behaviours lens. No AI: the same repository
            always draws the same map, and every issue says why it is where it is.
          </p>
          <form
            className="stack-form"
            onSubmit={(e) => {
              e.preventDefault();
              onImportGithub({ repo: repo.trim(), token: token.trim() });
            }}
          >
            <input aria-label="Repository" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo or github.com URL" required />
            <input
              aria-label="GitHub token (optional)"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Token (optional: private repos, and what each fix changed)"
            />
            <small className="muted">The token is used for this one import and never stored.</small>
            <button type="submit" disabled={busy || !repo.trim()}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </form>
        </section>

        <section>
          <h3>Data</h3>
          <div className="button-row">
            <button onClick={onExport}>
              <Icon name="download" size={18} /> Export JSON
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={busy}>
              <Icon name="upload" size={18} /> Import JSON
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) onImportJson(await file.text());
              }}
            />
          </div>
        </section>

        <footer className="drawer-foot">
          <button className="link-btn" onClick={onLock}>
            <Icon name="lock" size={16} /> Forget access key on this device
          </button>
        </footer>
      </aside>
    </div>
  );
}

export function Unlock({ onSubmit, error }) {
  const [key, setKey] = useState('');
  return (
    <div className="unlock">
      <form
        className="unlock-card"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(key.trim());
        }}
      >
        <div className="brand big">
          <Icon name="map" size={28} /> {APP_NAME}
        </div>
        <p>See your project the way you read a map.</p>
        <label htmlFor="key">Access key</label>
        <input id="key" type="password" autoComplete="current-password" value={key} onChange={(e) => setKey(e.target.value)} autoFocus required />
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary">
          Unlock
        </button>
        <p className="muted small">The key is saved in .conf/deploy.json on the machine you deployed from.</p>
      </form>
    </div>
  );
}
