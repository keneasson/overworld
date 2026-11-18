// When part of the app fails to draw (#71 SHIP-14), only that part is replaced: by what went wrong, and a way back that
// closes what failed (comment mode, the panel, the editor) and keeps drafts, which live above it. The error is sent to the
// API, to be read without the device it happened on. Code an older version can no longer load offers Update (SHIP-13).

import { Component } from 'react';
import { api } from '../api.js';
import { crashReport, isStaleBuild, reporter } from '../model/crash.js';
import { Icon } from './Icon.jsx';

const build = () => document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? undefined;
const send = reporter((r) => api.reportError(r));

/** Report an error the app caught, wherever it was. */
export const reportCrash = (err, where, componentStack) => send(crashReport(err, { where, componentStack, url: location.href, userAgent: navigator.userAgent, build: build() }));

export class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (!isStaleBuild(error)) reportCrash(error, this.props.where, info?.componentStack);
    else window.dispatchEvent(new Event('projectmap:stale'));
  }

  back = () => {
    this.props.onBack?.();
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = isStaleBuild(error);
    return (
      <div className={`crash${this.props.full ? ' full' : ''}`} role="alert">
        <h2>{stale ? 'A new version is out' : 'Something went wrong'}</h2>
        <p>{stale ? 'This part of the app changed in the last update, so this copy can’t open it. Update to carry on: your edits are saved first.' : String(error.message ?? error)}</p>
        <div className="button-row">
          {stale && this.props.onUpdate && (
            <button type="button" className="primary" onClick={this.props.onUpdate}>
              <Icon name="refresh" size={16} /> Update
            </button>
          )}
          <button type="button" className={stale ? '' : 'primary'} onClick={this.back}>
            Back to the map
          </button>
        </div>
        {!stale && <p className="muted small">It has been reported.</p>}
      </div>
    );
  }
}
