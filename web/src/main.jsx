import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import './styles.css';

/** Start again on the map, with nothing open: what was open is what failed. */
function backToTheMap() {
  const h = new URLSearchParams(location.hash.slice(1));
  h.delete('n');
  history.replaceState(null, '', `${location.pathname}${location.search}#${h}`);
  location.reload();
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* The last resort (#71 SHIP-14): drafts live inside the app, so the way back from here is a fresh start on the map. */}
    <ErrorBoundary where="app" full onBack={backToTheMap} onUpdate={() => location.reload()}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
