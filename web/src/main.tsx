import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { AuthProvider } from './auth/AuthProvider.tsx';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('The #root element is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);

/*
 * The static-asset precache, so the web build launches with no connection (S10 TI10).
 *
 * Registered after the first render rather than before it: the worker's only job is the *next*
 * launch, and installing it in front of the initial paint would delay the render it exists to make
 * possible. A browser without service workers – or a page served over plain HTTP, where they are
 * refused – simply goes without; the offline *data* path is IndexedDB and does not depend on this.
 *
 * **Built output only.** In development Vite serves unbundled modules and its own dependency
 * pre-bundles, which the worker's extension rule would cache-first – so a re-optimize would be
 * served from a stale copy and the edit would appear not to have happened. There is nothing to
 * precache in dev anyway: the thing this makes possible is launching the *shipped* app offline.
 *
 * The Capacitor shells (S11) serve their assets locally and register nothing.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // A worker that will not register is a build that still runs, just without an offline launch.
    });
  });
}
