import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

/**
 * S10 TI10 – the service worker precaches static build assets, and stores no user data at all.
 *
 * **The shipped file is what runs here.** `web/public/sw.js` is served as it stands rather than
 * bundled, so this test loads that exact source into a sandbox, gives it a worker global with a
 * recording Cache Storage, and dispatches real `install` and `fetch` events at it. A test that
 * re-implemented the policy would agree with itself forever while the file that ships did
 * something else.
 *
 * The claim under test is a *negative* one and it is load-bearing: cached Schedules live in
 * IndexedDB precisely so the sign-out purge can reach them, and a response cached here would sit
 * outside that purge. So a `/api/` request must leave Cache Storage untouched, and a shared tablet
 * must not keep the previous signer's schedule in a place nothing in the app knows about.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, '..', 'public', 'sw.js'), 'utf8');

const ORIGIN = 'https://confapp.ourcompany.example';

/**
 * The entry document as Vite writes it – the fingerprinted names the worker has to discover, since
 * they cannot be written into `sw.js` and change with every build.
 */
const INDEX_HTML = `<!doctype html><html><head>
  <script src="/config.js"></script>
  <script type="module" crossorigin src="/assets/index-CoPthgbi.js"></script>
  <link rel="stylesheet" crossorigin href="/assets/index-DWcBqn_S.css">
</head><body><div id="root"></div></body></html>`;

/** A minimal `Cache` that records everything put into it, so the test can inspect the store. */
class RecordingCache {
  readonly stored = new Map<string, unknown>();

  /** Accepts a URL string as well as a request, exactly as the real `Cache` does. */
  async match(request: { url: string } | string): Promise<unknown> {
    const href = typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
    return this.stored.get(href);
  }

  async addAll(paths: string[]): Promise<void> {
    for (const path of paths) {
      const href = new URL(path, ORIGIN).href;
      this.stored.set(href, {
        precached: true,
        text: async () => (path.endsWith('.html') || path === '/' ? INDEX_HTML : ''),
      });
    }
  }

  /** Accepts a URL string as well as a request here too, as the real `Cache` does. */
  async put(request: { url: string } | string, response: unknown): Promise<void> {
    const href = typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
    this.stored.set(href, response);
  }
}

interface Worker {
  listeners: Map<string, (event: unknown) => void>;
  cache: RecordingCache;
  /** Every URL the worker actually asked the network for. */
  fetched: string[];
}

/**
 * A response the way the worker sees one.
 *
 * `clone()`, `text()`, `headers` and – load-bearing – `url` are all modelled, because a real
 * `Response` carries the URL it was fetched from *independently of the cache key it is filed
 * under*. A double without `url` would let a worker that stores the network response straight into
 * the shell key look clean while the OAuth callback URL was still readable off the cached entry.
 */
function networkResponse(
  url: string,
  ok = true,
  contentType = 'text/html; charset=utf-8',
  body = INDEX_HTML,
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    ok,
    status: ok ? 200 : 500,
    type: 'basic',
    url,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    text: async () => body,
  };
  response.clone = () => ({ ...response, cloned: true });
  return response;
}

/** What `new Response(body, init)` yields: notably, an **empty** `url`. */
class FakeResponse {
  readonly url = '';
  readonly ok = true;
  readonly status = 200;
  readonly type = 'basic';
  readonly headers: { get: (name: string) => string | null };
  private readonly body: string;

  constructor(body: string, init?: { headers?: Record<string, string> }) {
    this.body = body;
    const type = init?.headers?.['Content-Type'] ?? null;
    this.headers = { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) };
  }

  async text(): Promise<string> {
    return this.body;
  }

  clone(): FakeResponse {
    return this;
  }
}

/** Loads the shipped worker into a sandbox and returns handles on what it did. */
function loadWorker(networkFor: (url: string) => unknown = (url) => networkResponse(url)) {
  const listeners = new Map<string, (event: unknown) => void>();
  const cache = new RecordingCache();
  const fetched: string[] = [];

  const caches = {
    open: async () => cache,
    match: async (request: { url: string } | string) =>
      cache.match(typeof request === 'string' ? { url: new URL(request, ORIGIN).href } : request),
    keys: async () => ['confapp-shell-v1'],
    delete: async () => true,
  };

  const self = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, handler);
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    location: { origin: ORIGIN },
  };

  const sandbox: Record<string, unknown> = {
    self,
    caches,
    URL,
    Error,
    Promise,
    Response: FakeResponse,
    fetch: async (request: { url: string }) => {
      fetched.push(request.url);
      const response = networkFor(request.url);
      if (response === null) throw new TypeError('Failed to fetch');
      return response;
    },
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(SOURCE, sandbox);

  return { listeners, cache, fetched } satisfies Worker;
}

/** A request the way the worker sees one. */
function request(path: string, init: { method?: string; mode?: string } = {}) {
  return {
    url: new URL(path, ORIGIN).href,
    method: init.method ?? 'GET',
    mode: init.mode ?? 'cors',
  };
}

/** Dispatches a `fetch` event and returns what the worker answered, or `undefined` if it passed. */
async function dispatchFetch(
  worker: Worker,
  req: ReturnType<typeof request>,
): Promise<unknown | undefined> {
  let answered: Promise<unknown> | undefined;
  const waited: Promise<unknown>[] = [];

  worker.listeners.get('fetch')!({
    request: req,
    respondWith: (value: Promise<unknown>) => {
      answered = value;
      waited.push(value);
    },
  });

  await Promise.all(waited);
  return answered === undefined ? undefined : await answered;
}

/**
 * Lets the worker's un-awaited cache writes settle.
 *
 * `fetchAndStore` fires them with `void` on purpose – the page is answered without waiting on a
 * cache write – so a test that inspects the store straight after dispatching must give those
 * promises a turn, or it asserts on a store nothing has been written to yet and passes whatever
 * the worker does.
 */
async function flushPendingWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let worker: Worker;

beforeEach(() => {
  worker = loadWorker();
});

// ---------- what it precaches ----------

describe('installing', () => {
  it('precaches the application shell and nothing else', async () => {
    const waited: Promise<unknown>[] = [];
    worker.listeners.get('install')!({
      waitUntil: (value: Promise<unknown>) => waited.push(value),
    });
    await Promise.all(waited);

    /*
     * The entry document, its two forms, the runtime configuration it loads first, and the
     * fingerprinted bundle it names – and nothing else.
     *
     * `/config.js` is public values only (API base URL, confApp's own OAuth client ID, the
     * hosted-domain hint); without it a cold offline launch renders "sign-in is not configured"
     * instead of the cached Schedule, which is the failure TI10 exists to prevent.
     *
     * The two `/assets/` entries are the point of parsing the document: the browser fetched them
     * before this worker controlled the page, so no `fetch` event ever saw them and nothing else
     * would have put them in the cache.
     */
    expect([...worker.cache.stored.keys()].sort()).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/assets/index-CoPthgbi.js`,
      `${ORIGIN}/assets/index-DWcBqn_S.css`,
      `${ORIGIN}/config.js`,
      `${ORIGIN}/index.html`,
    ]);
  });

  /** No API response is precached either – the manifest scan is scoped to the asset directory. */
  it('precaches nothing from the API, whatever the entry document contains', async () => {
    const waited: Promise<unknown>[] = [];
    worker.listeners.get('install')!({
      waitUntil: (value: Promise<unknown>) => waited.push(value),
    });
    await Promise.all(waited);

    expect([...worker.cache.stored.keys()].some((url) => url.includes('/api/'))).toBe(false);
  });
});

// ---------- what it refuses to touch ----------

describe('an API request', () => {
  it('is passed straight through, with nothing written to Cache Storage', async () => {
    const answer = await dispatchFetch(
      worker,
      request('/api/conferences/11111111-1111-4111-8111-111111111111/schedule'),
    );

    // Not answered by the worker at all: it declined to handle the event.
    expect(answer).toBeUndefined();
    expect(worker.cache.stored.size).toBe(0);
    expect(worker.fetched).toEqual([]);
  });

  it('is still untouched for every other API path and method', async () => {
    for (const path of ['/api/me', '/api/me/conferences', '/api/auth/token', '/api/health']) {
      expect(await dispatchFetch(worker, request(path))).toBeUndefined();
    }
    expect(await dispatchFetch(worker, request('/api/join', { method: 'POST' }))).toBeUndefined();

    expect(worker.cache.stored.size).toBe(0);
  });

  it('leaves cross-origin requests alone', async () => {
    const google = {
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      method: 'GET',
      mode: 'cors',
    };
    expect(await dispatchFetch(worker, google)).toBeUndefined();
    expect(worker.cache.stored.size).toBe(0);
  });

  /** A write is never cached, whatever its path. */
  it('leaves every non-GET request alone', async () => {
    expect(
      await dispatchFetch(worker, request('/assets/app-abc123.js', { method: 'POST' })),
    ).toBeUndefined();
    expect(worker.cache.stored.size).toBe(0);
  });
});

// ---------- what it does cache ----------

describe('a fingerprinted build asset', () => {
  it('is fetched once and served from the cache afterwards', async () => {
    await dispatchFetch(worker, request('/assets/index-9f3a2b.js'));

    expect(worker.fetched).toEqual([`${ORIGIN}/assets/index-9f3a2b.js`]);
    expect(worker.cache.stored.has(`${ORIGIN}/assets/index-9f3a2b.js`)).toBe(true);

    await dispatchFetch(worker, request('/assets/index-9f3a2b.js'));
    // Still one network call: the second read came out of the cache.
    expect(worker.fetched).toHaveLength(1);
  });

  it('is not cached when the network answered with an error', async () => {
    const failing = loadWorker((url) => networkResponse(url, false));
    await dispatchFetch(failing, request('/assets/index-9f3a2b.js'));

    expect(failing.cache.stored.size).toBe(0);
  });
});

// ---------- what must stay fresh ----------

/**
 * The container rewrites `/config.js` at start and a deployment rewrites `index.html` to reference
 * new fingerprinted assets. Serving either from the cache while the network is available would pin
 * a browser to the previous deployment – at the wrong API, or at asset names that no longer exist.
 */
describe('the runtime configuration and the entry document', () => {
  it('come from the network whenever there is one, even after being cached', async () => {
    const waited: Promise<unknown>[] = [];
    worker.listeners.get('install')!({
      waitUntil: (value: Promise<unknown>) => waited.push(value),
    });
    await Promise.all(waited);

    // Precached, so a cache-first strategy would answer without touching the network.
    expect(worker.cache.stored.has(`${ORIGIN}/config.js`)).toBe(true);

    await dispatchFetch(worker, request('/config.js'));
    await dispatchFetch(worker, request('/', { mode: 'navigate' }));

    expect(worker.fetched).toEqual([`${ORIGIN}/config.js`, `${ORIGIN}/`]);
  });

  it('fall back to the cached copy once the network has actually failed', async () => {
    const offline = loadWorker(() => null);

    const waited: Promise<unknown>[] = [];
    offline.listeners.get('install')!({
      waitUntil: (value: Promise<unknown>) => waited.push(value),
    });
    await Promise.all(waited);

    expect(await dispatchFetch(offline, request('/config.js'))).toMatchObject({ precached: true });
  });
});

// ---------- what happens offline ----------

describe('a cold launch with no connection', () => {
  it('answers the navigation from the precached shell rather than a browser error', async () => {
    const offline = loadWorker(() => null);

    const waited: Promise<unknown>[] = [];
    offline.listeners.get('install')!({
      waitUntil: (value: Promise<unknown>) => waited.push(value),
    });
    await Promise.all(waited);

    const answer = await dispatchFetch(offline, request('/', { mode: 'navigate' }));

    // The shell, so the app boots and renders its own offline states (TI04, TI05).
    expect(answer).toMatchObject({ precached: true });
  });

  /**
   * The same has to hold for a **deep link**, and it is the case a path-based rule silently misses:
   * `/auth/callback` has no file extension, is not under `/assets/`, and is not a precached path,
   * so a whitelist that only looked at the path would decline the event and hand the browser its
   * own offline error page. It is a live route – the default OAuth `redirectUri` – and nginx serves
   * the entry document for it, so the worker has to as well.
   */
  it.each(['/auth/callback', '/conferences/kickoff-2026', '/some/deep/route'])(
    'answers a navigation to %s from the precached shell too',
    async (path) => {
      const offline = loadWorker(() => null);

      const waited: Promise<unknown>[] = [];
      offline.listeners.get('install')!({
        waitUntil: (value: Promise<unknown>) => waited.push(value),
      });
      await Promise.all(waited);

      expect(await dispatchFetch(offline, request(path, { mode: 'navigate' }))).toMatchObject({
        precached: true,
      });
    },
  );

  /** A deep-link navigation is still network-first, so nothing stale is served while online. */
  it('serves a deep-link navigation from the network whenever there is one', async () => {
    const waited: Promise<unknown>[] = [];
    worker.listeners.get('install')!({
      waitUntil: (value: Promise<unknown>) => waited.push(value),
    });
    await Promise.all(waited);

    await dispatchFetch(worker, request('/auth/callback', { mode: 'navigate' }));

    expect(worker.fetched).toEqual([`${ORIGIN}/auth/callback`]);
  });

  /*
   * The navigation is answered but never *stored*, and this asserts the cache contents rather than
   * the requests issued – the distinction the earlier version of this suite missed. A cache key is
   * the whole URL, so storing the OIDC redirect would put the authorization code in Cache Storage,
   * where no application-level purge reaches it: `purgeScheduleCache` clears IndexedDB, and the
   * `activate` handler deletes only caches whose name differs from the constant.
   */
  it('stores nothing for a callback navigation carrying an authorization code', async () => {
    const waited: Promise<unknown>[] = [];
    worker.listeners.get('install')!({
      waitUntil: (value: Promise<unknown>) => waited.push(value),
    });
    await Promise.all(waited);

    const precached = [...worker.cache.stored.keys()].sort();

    await dispatchFetch(
      worker,
      request('/auth/callback?code=SECRET-AUTHZ-CODE&state=nonce-abc123&hd=example.test', {
        mode: 'navigate',
      }),
    );

    expect([...worker.cache.stored.keys()].some((url) => url.includes('code='))).toBe(false);
    expect([...worker.cache.stored.keys()].sort()).toEqual(precached);
  });

  /*
   * The shell has to stay current across deployments, and this is the only path that refreshes it:
   * `precacheShell` runs on `install`, and `sw.js` carries no build-varying token, so a deployment
   * produces no byte change in this file and the browser does not re-install. Without the store
   * side writing navigations to the shell key, an offline launch would boot the install-time bundle
   * forever – including past any offline-visible fix.
   */
  it('refreshes the offline shell from a later navigation', async () => {
    /*
     * One worker throughout: install seeds the shell, an online navigation lands the redeployed
     * document, and the network then goes away. Using the same instance is the point – the cache is
     * what has to carry the newer build across, exactly as it does on a device.
     */
    let online = true;
    const REDEPLOYED_HTML = '<!doctype html><html><body>after-deploy</body></html>';

    const instance = loadWorker((url) => {
      if (!online) return null;
      return url.endsWith('/conferences/kickoff-2026')
        ? networkResponse(url, true, 'text/html; charset=utf-8', REDEPLOYED_HTML)
        : networkResponse(url);
    });

    const waited: Promise<unknown>[] = [];
    instance.listeners.get('install')!({
      waitUntil: (value: Promise<unknown>) => waited.push(value),
    });
    await Promise.all(waited);

    // Online navigation after a deployment: this is the write that keeps the shell current.
    await dispatchFetch(instance, request('/conferences/kickoff-2026', { mode: 'navigate' }));

    online = false;

    // A *different* deep link, offline. It is served the redeployed shell, not the install-time one.
    const answered = (await dispatchFetch(
      instance,
      request('/some/other/route', { mode: 'navigate' }),
    )) as { text: () => Promise<string> } | undefined;

    expect(await answered!.text()).toBe(REDEPLOYED_HTML);

    // And the bare origin agrees – one shell key, so the two cannot drift apart.
    const bare = (await dispatchFetch(instance, request('/', { mode: 'navigate' }))) as
      { text: () => Promise<string> } | undefined;
    expect(await bare!.text()).toBe(REDEPLOYED_HTML);
  });

  /*
   * The key is only half of it. A `Response` carries the URL it was fetched from independently of
   * the key it is filed under, so a worker that re-keyed but stored the *network* response would
   * pass every key-based assertion above while `(await caches.match(SHELL_PATH)).url` still read
   * `/auth/callback?code=…`. Asserting the stored entry's own contents is what closes that gap –
   * the trap `docs/LEARNINGS.md` records for exactly this bug.
   */
  it('leaves no trace of the callback URL on the stored shell itself', async () => {
    const waited: Promise<unknown>[] = [];
    worker.listeners.get('install')!({
      waitUntil: (value: Promise<unknown>) => waited.push(value),
    });
    await Promise.all(waited);

    await dispatchFetch(
      worker,
      request('/auth/callback?code=SECRET-AUTHZ-CODE&state=nonce-abc123', { mode: 'navigate' }),
    );
    await flushPendingWrites();

    const shell = (await worker.cache.match('/index.html')) as { url?: string } | undefined;
    expect(shell).toBeDefined();
    expect(shell?.url ?? '').not.toContain('code=');
    expect(shell?.url ?? '').not.toContain('state=');

    // Nothing anywhere in the store carries it, on the key or on the entry.
    for (const [key, value] of worker.cache.stored) {
      expect(key).not.toContain('code=');
      expect(String((value as { url?: string } | undefined)?.url ?? '')).not.toContain('code=');
    }
  });

  /*
   * The shell key is picked from `request.mode`, but nginx `try_files $uri` serves a real file when
   * one exists – so a *top-level* navigation to `/config.js` returns JavaScript, not the SPA. Filed
   * as the shell it would be served to every later offline navigation, which is the blank-screen
   * failure TI10 exists to prevent, made permanent and un-evictable.
   */
  it('never files a non-HTML response as the application shell', async () => {
    const instance = loadWorker((url) =>
      url.endsWith('/config.js')
        ? networkResponse(url, true, 'application/javascript', 'window.__CONFAPP_CONFIG__ = {};')
        : networkResponse(url),
    );

    const waited: Promise<unknown>[] = [];
    instance.listeners.get('install')!({
      waitUntil: (value: Promise<unknown>) => waited.push(value),
    });
    await Promise.all(waited);

    await dispatchFetch(instance, request('/config.js', { mode: 'navigate' }));
    /*
     * The store side is fired with `void` and deliberately not awaited by `fetchAndStore` – the
     * page must not wait on a cache write. Without letting those microtasks run, this test would
     * assert before any write could have landed and would pass even with the guard removed, which
     * is a vacuous test rather than a guard.
     */
    await flushPendingWrites();

    const shell = (await instance.cache.match('/index.html')) as
      { text: () => Promise<string> } | undefined;
    expect(await shell!.text()).toBe(INDEX_HTML);
  });

  /*
   * One entry per sign-in and per token renewal was the actual cost of the bug: every callback URL
   * is distinct, so the entries accumulated without ever being read back – an exact-query match
   * never recurs. Distinct navigations must leave the key set exactly where the precache left it.
   */
  it('does not grow the cache across repeated distinct navigations', async () => {
    const waited: Promise<unknown>[] = [];
    worker.listeners.get('install')!({
      waitUntil: (value: Promise<unknown>) => waited.push(value),
    });
    await Promise.all(waited);

    const precached = worker.cache.stored.size;

    for (const nonce of ['abc', 'def', 'ghi', 'jkl']) {
      await dispatchFetch(
        worker,
        request(`/auth/callback?code=code-${nonce}&state=state-${nonce}`, { mode: 'navigate' }),
      );
    }

    expect(worker.cache.stored.size).toBe(precached);
  });
});
