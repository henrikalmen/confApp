import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DisplayBoardView } from './DisplayBoardView.tsx';
import { displayTokenFrom } from './display-token.ts';
import '../styles.css';
/*
 * The projection viewport class's own layout and type scale, loaded *after* the shared sheet so it
 * wins where the two ever meet. It brings the tokens `styles.css` defines onto a layout that is not
 * `styles.css`'s - the projected screen is read at metres by nobody who can touch it, which is a
 * different design problem from a desktop window and not the 1280px layout at a larger root font
 * (S07, `prd.md#non-functional-requirements`).
 */
import './display.css';

/**
 * The projected Board's bootstrap – **the second entry point, and deliberately the smaller one**
 * (S04 TI09, FR7).
 *
 * Compare `web/src/main.tsx`, and read the differences as the contract:
 *
 *   - **no `AuthProvider`**, and no import that reaches one. A room machine has no Workspace session
 *     and must not acquire one on shared hardware, so nothing here can start a sign-in - there is no
 *     sign-in code in this bundle to start. The token in the path is the whole credential.
 *   - **no service-worker registration.** The projected page is explicitly excluded from the
 *     worker's cache (`web/public/sw.js`), so registering one here would either do nothing or - if
 *     the exclusion were ever dropped - file the display document as the signed-in app's cached
 *     shell and answer every later navigation with it. Offline is not in scope for a projector
 *     anyway: it is a wall-mounted screen on the venue's network, and the offline scope confApp
 *     supports is schedule reads and post-it queueing, widened by nothing here.
 *   - **no application shell.** No navigation, no account menu, no conference switcher. The link is
 *     scoped to one Board and powerless everywhere else, and the page says so by having nowhere
 *     else to go.
 *
 * The token comes out of `window.location.pathname` because there is no client-side router, by
 * decision: a routing dependency would have made the projected surface a *route of the signed-in
 * app*, which is how the auth, offline and service-worker machinery would have come with it.
 */

const container = document.getElementById('display-root');
if (!container) {
  throw new Error('The #display-root element is missing from display.html.');
}

createRoot(container).render(
  <StrictMode>
    <DisplayBoardView token={displayTokenFrom(window.location.pathname)} />
  </StrictMode>,
);
