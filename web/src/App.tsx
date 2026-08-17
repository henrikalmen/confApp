import { useState } from 'react';
import { HealthPanel } from './components/HealthPanel.tsx';

export function App(): React.JSX.Element {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1 className="app__brand">confApp</h1>
          <p className="app__tagline">Conference schedule and participation</p>
        </div>
        <button
          className="app__nav-toggle"
          type="button"
          aria-expanded={navOpen}
          aria-controls="app-nav"
          onClick={() => setNavOpen((open) => !open)}
        >
          <span aria-hidden="true">☰</span> Menu
        </button>
      </header>

      {navOpen ? (
        <nav className="app__nav" id="app-nav" aria-label="Main">
          <ul className="app__nav-list">
            <li>
              <a href="#health-title">Service health</a>
            </li>
          </ul>
        </nav>
      ) : null}

      <main className="app__main">
        <HealthPanel />
      </main>

      <footer className="app__footer">Internal application – employees only.</footer>
    </div>
  );
}
