/**
 * The service worker: **static build assets only** (S10 TI10).
 *
 * Its one job is that the web build launches with no connection. On the Capacitor shells (S11) the
 * assets are already on the device, which is why this half is web-specific and why it carries no
 * user data at all.
 *
 * **Nothing from the API is ever stored here, and that is a hard rule rather than a default.**
 * Cached Schedules live in IndexedDB at application level, where they are keyed per employee and
 * per Conference and can be purged whole when somebody signs out or a different employee signs in.
 * A response cached by a service worker would sit outside that purge – a shared tablet would keep
 * the previous signer's Schedule in Cache Storage with nothing in the app aware of it – so every
 * request whose path is the API's is passed straight to the network and never written.
 *
 * Written as a plain classic worker rather than a bundled module: it is served from `public/` as it
 * stands, so what ships is exactly what is reviewed here, and `web/test/service-worker.test.ts`
 * drives this very file.
 */

const CACHE_NAME = 'confapp-shell-v1';

/**
 * The application shell: the entry document, and the runtime configuration it loads first.
 *
 * `/config.js` is here because without it the app cannot start at all. It is a `<script src>` in
 * `index.html`, and a cold offline launch that could not load it would render "sign-in is not
 * configured" instead of the cached Schedule – which is the exact failure this worker exists to
 * prevent. It carries public values only (the API base URL, confApp's own OAuth client ID, the
 * hosted-domain hint) and no user data, so caching it keeps the sign-out purge complete.
 *
 * Vite fingerprints everything else, so those names cannot be listed here – `precacheShell` reads
 * them out of the entry document instead, which always names exactly the build it belongs to.
 */
const PRECACHE_PATHS = ['/', '/index.html', '/config.js'];

/**
 * The one key every navigation is stored under and served from.
 *
 * Every route is the same document, so keying them separately would store N copies of one file and
 * let them drift apart – `/` refreshed by a visit to the bare origin while `/conferences/x` still
 * answered from install. One key means one shell, and it is the key `precacheShell` already seeds.
 */
const SHELL_PATH = '/index.html';

/** Where the API lives. Every request under it is network-only, forever. */
const API_PREFIX = '/api/';

/**
 * The projected Board (S04). Network-only, forever, and for **two** separate reasons.
 *
 * `/display/<token>` is its own entry document, not a route of this app – and every navigation
 * here is otherwise stored under the one shell key *and* answered from it. Without this exclusion
 * one omission causes two defects:
 *
 *   - the room machine's navigation would be answered from the cached shell, so a projector on a
 *     browser that had ever visited the signed-in app would get **that** document instead of the
 *     display one; and
 *   - the visit would overwrite the cached shell with the display document, so the employee whose
 *     browser it was would launch the app offline into a board page that cannot sign in. That half
 *     only shows up offline, which is where nobody looks.
 *
 * There is nothing to trade away by excluding it. A projector is a wall-mounted screen on the
 * venue's network; offline support in confApp is schedule reads and post-it queueing and is
 * widened by nothing here. And the board is behind a bearer token whose revocation has to take
 * effect at the next poll, which any cached copy anywhere would defeat.
 */
const DISPLAY_PREFIX = '/display/';

/**
 * The bare entry document, which the prefix above does **not** cover.
 *
 * nginx serves `/display.html` as a real file through `location /`, so a navigation straight to it
 * would reach the navigation clause below, be filed under `SHELL_PATH`, and replace the signed-in
 * app's cached shell - the exact second defect the prefix exclusion exists to prevent, reached
 * through a different URL (review 2026-08-31, L1). Nothing in the product links here, but the
 * failure is silent and only surfaces offline.
 */
const DISPLAY_DOCUMENT = '/display.html';

/**
 * Paths that must be **fresh** whenever there is a connection, and are cached only as a fallback.
 *
 * The container rewrites `/config.js` at start and a deployment rewrites `index.html` to reference
 * new fingerprinted assets. Serving either from the cache while the network is available would pin
 * a browser to the previous deployment – pointing it at the wrong API, or at asset names that no
 * longer exist – for as long as the entry survived. Navigations are treated the same way, and the
 * cache answers only once the network has actually failed.
 */
function isNetworkFirst(request, pathname) {
  return request.mode === 'navigate' || pathname === '/config.js' || pathname === '/index.html';
}

/**
 * Whether a request may be stored.
 *
 * Deliberately a whitelist of static build output rather than a blacklist of the API. A blacklist
 * fails open: the next endpoint added under a different prefix would be cached by default, which is
 * how user data ends up outside the sign-out purge without anybody deciding that it should.
 */
function isCacheableAsset(request, origin) {
  if (request.method !== 'GET') return false;

  const url = new URL(request.url);
  // Same origin only. A cross-origin response is somebody else's to cache.
  if (url.origin !== origin) return false;
  if (url.pathname.startsWith(API_PREFIX)) return false;
  // The projected board: never stored, and never answered from here. Checked *before* the
  // navigation clause below, which would otherwise claim it like any other deep link.
  if (url.pathname.startsWith(DISPLAY_PREFIX) || url.pathname === DISPLAY_DOCUMENT) return false;

  /*
   * **Every navigation, whatever path it names.** This is a SPA behind `try_files … /index.html`,
   * so `/auth/callback` and any other route are the same document – and without this clause the
   * handler returns early for all of them, leaving the shell fallback below reachable only from the
   * bare origin. A cold offline launch on a deep link would then show the browser's error page
   * instead of the app's own offline states, which is exactly what TI10 exists to prevent. Such a
   * navigation is network-first (see `isNetworkFirst`), so nothing stale is served while online.
   */
  if (request.mode === 'navigate') return true;

  // Vite's fingerprinted output, plus the shell paths above.
  return (
    url.pathname.startsWith('/assets/') ||
    PRECACHE_PATHS.includes(url.pathname) ||
    /\.(?:css|js|svg|png|ico|webmanifest|woff2?)$/.test(url.pathname)
  );
}

/**
 * Precaches the shell, and then the fingerprinted assets the shell names.
 *
 * **The entry document is the asset manifest.** Vite fingerprints its output, so the hashed names
 * cannot be written into this file – but `index.html` lists every one of them, and it has just been
 * cached. Parsing it here is what makes the *first* offline launch work at all: the browser fetched
 * the app's own bundle before this worker was controlling the page, so no `fetch` event ever saw
 * those requests, and nothing else would put them in the cache until some later visit that may well
 * never happen while there is a connection.
 */
async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(PRECACHE_PATHS);

  const shell = await cache.match('/index.html');
  if (shell === undefined) return;

  const html = await shell.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  if (assets.length > 0) await cache.addAll(assets);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precacheShell()
      // A precache that fails is a worker that still works, just without a warm shell. It must not
      // fail installation and leave the page with no worker at all.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Anything a previous version left behind, including any cache a future mistake might make.
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * Fetches, storing a copy of anything complete and successful. Rejects when the network is gone.
 *
 * **A navigation is stored under the shell key, never under its own URL.** `isCacheableAsset`
 * deliberately answers `true` for every navigation so the offline fallback below is reachable from
 * a deep link – but a cache key is the whole URL, query string included, and the OIDC redirect
 * lands on `/auth/callback?code=…&state=…&hd=…`. Keyed on itself, that write would put the
 * authorization code into an origin-scoped cache no application purge reaches: `purgeScheduleCache`
 * clears the two IndexedDB stores, and the `activate` handler above deletes only caches whose
 * *name* differs from the constant. It would also undo `AuthProvider`'s `history.replaceState`
 * scrub of those same values by writing them back one layer down. Such an entry could never be read
 * back either – an exact-query match never recurs – so it would be pure accumulation.
 *
 * Storing it under `/index.html` instead keeps the one thing that write was worth: freshness. Every
 * route is the same SPA document (nginx `try_files`), so any navigation carries the current shell,
 * and this is the **only** path that refreshes it – `precacheShell` runs on `install`, and this file
 * has no build-varying token, so a deployment does not re-install the worker. Without this the
 * offline shell would be pinned to whichever build was installed first, forever.
 *
 * **Re-keying alone is not enough, and the response is rebuilt rather than copied.** A `Response`
 * carries its own URL independently of the key it is filed under, so storing the network response
 * would leave `code=` readable at `(await caches.match(SHELL_PATH)).url` even though no cache *key*
 * contains it. `storeShell` therefore constructs a new `Response` from the body: a constructed one
 * has an empty URL, so nothing of the callback survives the write.
 *
 * **And only HTML is accepted.** The shell key is chosen from `request.mode`, but nginx serves a
 * real file when one exists (`try_files $uri`), so a *top-level* navigation to `/config.js` or to a
 * fingerprinted asset would otherwise file that file's bytes as the application shell and every
 * later offline navigation would be answered with it – the blank-screen failure TI10 exists to
 * prevent, made permanent.
 */
function isHtml(response) {
  const type = response.headers === undefined ? null : response.headers.get('content-type');
  return typeof type === 'string' && type.includes('text/html');
}

/**
 * Files a navigation's body under the shell key, with no trace of the URL it came from.
 *
 * Reading the body is why this is async: the URL is only shed by building a new `Response`, and a
 * new one needs the bytes. The read happens on a clone, so the response handed to the page is
 * untouched.
 */
async function storeShell(response) {
  const body = await response.clone().text();
  const cache = await caches.open(CACHE_NAME);
  await cache.put(SHELL_PATH, new Response(body, { headers: { 'Content-Type': 'text/html' } }));
}

function fetchAndStore(request) {
  return fetch(request).then((response) => {
    // Only a complete, successful, same-origin response is worth storing. An opaque or error
    // response cached here would be served in place of a working one until the cache turned over.
    if (response.ok && response.type === 'basic') {
      if (request.mode === 'navigate') {
        if (isHtml(response)) void storeShell(response);
      } else {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
    }
    return response;
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Not ours: straight to the network, nothing stored, no response inspected. This is the branch
  // every `/api/` request takes.
  if (!isCacheableAsset(request, self.location.origin)) return;

  const pathname = new URL(request.url).pathname;

  if (isNetworkFirst(request, pathname)) {
    event.respondWith(
      fetchAndStore(request).catch(() =>
        /*
         * Offline. The shell answers instead, so the app boots and renders its own offline states
         * (TI04, TI05) rather than the browser's error page – which is the difference between an
         * attendee reading a cached Schedule and an attendee seeing "no internet". A navigation
         * falls back to the entry document whatever path it asked for, because this is a SPA and
         * every route is that same document.
         *
         * A navigation looks **only** at `SHELL_PATH`, deliberately skipping its own URL. That is
         * the key the store side writes, so it holds the newest shell seen; matching `request`
         * first would let the bare origin answer from the never-refreshed precached `/` while a
         * deep link got the current document, which is the drift one key exists to prevent.
         */
        caches.match(request.mode === 'navigate' ? SHELL_PATH : request).then(async (hit) => {
          if (hit !== undefined) return hit;

          const shell = request.mode === 'navigate' ? await caches.match(SHELL_PATH) : undefined;
          if (shell !== undefined) return shell;

          // Nothing precached and nothing to fall back on – a first-ever visit made offline. The
          // browser's own error is the honest answer; `respondWith(undefined)` would be a
          // `TypeError` in the console and a blank page instead of it.
          throw new Error('offline and not cached');
        }),
      ),
    );
    return;
  }

  // Fingerprinted output: cache-first is safe because the name changes whenever the bytes do.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit !== undefined) return hit;
      return fetchAndStore(request).catch(() => {
        throw new Error('offline and not cached');
      });
    }),
  );
});
