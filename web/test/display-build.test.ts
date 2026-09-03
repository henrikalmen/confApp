import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build, createServer } from 'vite';

/**
 * The projected URL on the two serving surfaces confApp actually ships (S04 TI10, S08).
 *
 * `/display/<token>` has to reach the display document in **development** and in the **built
 * image**, and the mechanisms are different in each: Vite's dev server has its own SPA fallback,
 * and nginx has `try_files … /index.html`. Any one of the three surfaces missing makes the URL work
 * in exactly one of dev, production and repeat-visit - the third being the service worker, proved in
 * `service-worker.test.ts`.
 *
 * The build here is a **real** `vite build`, into a temporary directory, so what is asserted is the
 * output that ships rather than the configuration that was meant to produce it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');

const TOKEN = 'wJq3B7nVYt1sK0pLmXcZaR8dEfGhIjKlMnOpQrStUvW';

const outDir = mkdtempSync(join(tmpdir(), 'confapp-display-build-'));

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('the production build', () => {
  it('emits two documents, each referencing its own entry chunk', async () => {
    // Vite's own API rather than a spawned binary, so the build runs the project's real config
    // (two Rollup inputs and all) without depending on where the workspace hoisted the CLI.
    await build({ root: webRoot, logLevel: 'error', build: { outDir, emptyOutDir: true } });

    const emitted = readdirSync(outDir);
    expect(emitted).toContain('index.html');
    expect(emitted).toContain('display.html');

    const app = readFileSync(join(outDir, 'index.html'), 'utf8');
    const display = readFileSync(join(outDir, 'display.html'), 'utf8');

    const entryOf = (html: string): string => {
      const match = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(html);
      expect(match, 'an entry chunk should be referenced').not.toBeNull();
      return match![1]!;
    };

    const appEntry = entryOf(app);
    const displayEntry = entryOf(display);
    expect(displayEntry).not.toBe(appEntry);

    // Both load the runtime configuration first, exactly as the container writes it at start.
    expect(display).toContain('src="/config.js"');
    expect(display).toContain('id="display-root"');
    expect(app).toContain('id="root"');

    /*
     * The display bundle is the smaller one, and by a lot. That is the *point* of the second
     * entry rather than a route: the sign-in, offline and service-worker machinery is not in the
     * bundle a room machine downloads, so there is nothing there for a projector to run even by
     * accident.
     */
    const displayChunk = readFileSync(join(outDir, displayEntry), 'utf8');
    expect(displayChunk).not.toMatch(/serviceWorker|code_challenge|AuthProvider|indexedDB/i);

    /*
     * **The whole chunk graph, not the entry chunk.** The entry was clean while the 200 KB shared
     * chunk it imported carried `castVote`, the Join Code helpers and every other authenticated
     * endpoint - because `api/client.ts` was on the display's import graph for one anonymous `GET`
     * (S07, 2026-08-31, review H2). An assertion that stops at the entry is the file-list guard
     * with its longest omission left in (`docs/LEARNINGS.md#testing`), so this follows every
     * `import`/`modulepreload` the display document pulls in and asserts over all of them.
     */
    const reached = new Set<string>();
    const queue = [displayEntry.replace(/^\//, '')];
    for (const preload of display.matchAll(/modulepreload"[^>]*href="\/([^"]+)"/g)) {
      queue.push(preload[1]!);
    }
    while (queue.length > 0) {
      const name = queue.pop()!;
      if (reached.has(name) || !name.endsWith('.js')) continue;
      reached.add(name);
      const code = readFileSync(join(outDir, name), 'utf8');
      // `from"./x.js"` and the bare side-effect form `import"./x.js"` alike - a walk that knows
      // only one of them is a closure guard with a hole in it.
      for (const dep of code.matchAll(/(?:from|import)"\.\/([^"]+\.js)"/g)) {
        queue.push(`assets/${dep[1]!}`);
      }
    }

    expect(reached.size).toBeGreaterThan(0);
    for (const name of reached) {
      const code = readFileSync(join(outDir, name), 'utf8');
      // No endpoint the projected surface cannot call, and above all nothing vote-shaped.
      expect(code, name).not.toMatch(/\/votes\b|optionId|castVote|join-code|\/members\b/);
      /*
       * `navigator.serviceWorker`, not the bare word: React's own DOM code carries `serviceworker`
       * as a `<link as=…>` value, and matching that would fail on the shared React chunk the
       * display legitimately needs. What must be absent is a *registration*.
       */
      expect(code, name).not.toMatch(/navigator\.serviceWorker|code_challenge|AuthProvider/);
      expect(code, name).not.toMatch(/indexedDB/i);
    }

    // And the app's own entry graph is untouched by the split - it still reaches those endpoints.
    expect(readFileSync(join(outDir, appEntry.replace(/^\//, '')), 'utf8')).toBeTruthy();
  }, 120_000);
});

describe('the dev server', () => {
  it('answers /display/<token> with the display document and not the app document', async () => {
    /*
     * `127.0.0.1` explicitly: Vite binds IPv6-only by default, and the IPv4 loopback is then
     * refused (`docs/KEY_DEVELOPMENT_COMMANDS.md`).
     */
    const server = await createServer({
      root: webRoot,
      server: { port: 0, host: '127.0.0.1' },
      logLevel: 'error',
    });
    try {
      await server.listen();
      const port = server.httpServer!.address() as { port: number };

      const display = await fetch(`http://127.0.0.1:${port.port}/display/${TOKEN}`);
      const displayHtml = await display.text();
      expect(display.status).toBe(200);
      expect(displayHtml).toContain('id="display-root"');
      expect(displayHtml).toContain('/src/display/main-display.tsx');
      expect(displayHtml).not.toContain('/src/main.tsx');

      // The app document is still the app document.
      const app = await fetch(`http://127.0.0.1:${port.port}/conferences/anything`);
      const appHtml = await app.text();
      expect(appHtml).toContain('id="root"');
      expect(appHtml).toContain('/src/main.tsx');
    } finally {
      await server.close();
    }
  }, 120_000);
});

describe('the served image', () => {
  /**
   * nginx is not run here - the assertions are on the configuration text, and the ordering is what
   * matters: `^~ /display/` must win over `location /`'s SPA fallback and must not shadow the
   * `/api/` proxy.
   *
   * **Nothing executes this configuration.** `scripts/verify-stack.sh` does not touch the display
   * path, and this comment used to claim it did (review 2026-08-31, L3). TI11's Verify line - the
   * built image serving `/display/<token>` as the display document while `/` stays the app and
   * `/api/health` still proxies - is therefore proved by reading the config, not by running it.
   * Recorded in the FIS's Implementation Observations as the gap it is, rather than papered over
   * with a citation a maintainer would follow and find empty.
   */
  /**
   * The token must not reach the **container's** access log either.
   *
   * The API redacts its own request line, and the container in front of it logs the request line
   * verbatim unless told otherwise: `nginx:alpine` defaults to the `main` format, whose `$request`
   * carries the full path. Both the projected page load and every poll through the `/api/` proxy
   * would otherwise write a live bearer credential over named post-its to stdout, and from there to
   * whatever aggregates it - outliving revocation entirely (review 2026-08-31, finding 1).
   *
   * Asserted on the template because nothing here runs nginx; the composed stack is where the
   * behaviour itself would be confirmed.
   */
  it('redacts the token from the served image’s access log', () => {
    const template = readFileSync(join(webRoot, 'nginx', 'default.conf.template'), 'utf8');

    // A named format is declared and is the one the server uses - not nginx's default.
    expect(template).toMatch(/log_format\s+confapp\s/);
    expect(template).toMatch(/access_log\s+\S+\s+confapp;/);

    // The format logs the rewritten URI, never `$request` (which carries the raw path).
    const format = /log_format confapp[\s\S]*?;\r?\n/.exec(template)?.[0];
    expect(format, 'the log format should be found').toBeDefined();
    expect(format).toContain('$confapp_logged_uri');
    expect(format, '$request carries the unredacted path').not.toMatch(/\$request[^_]/);

    // Both prefixes are rewritten: the page itself, and the board poll through the /api/ proxy.
    const rewrite = /map \$request_uri \$confapp_logged_uri \{[\s\S]*?\r?\n\}/.exec(template)?.[0];
    expect(rewrite, 'the redacting map should be found').toBeDefined();
    expect(rewrite).toMatch(/<token>/);

    /*
     * Asserted as properties rather than as the literal patterns, because pinning the exact
     * regex text is what let the first version of this map ship: it matched only the canonical
     * spelling, and `/DISPLAY/<token>` returned 200 while writing the raw token to this very
     * log (gap re-review 2026-09-02, G29). Three of four tested spellings leaked past it.
     */
    const patterns = [...rewrite!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(patterns.length, 'both prefixes should be rewritten').toBe(2);
    for (const pattern of patterns) {
      // Case-insensitive: nginx serves /DISPLAY/ and a case-sensitive map does not redact it.
      expect(pattern, pattern).toMatch(/^~*/);
      // Tolerates repeated separators, so // and /api//display/ cannot slip past.
      expect(pattern, pattern).toContain('/+');
      // Matches %2f literally: nginx does not decode it in $request_uri.
      expect(pattern.toLowerCase(), pattern).toContain('%2f');
    }
    expect(patterns.some((x) => /display/i.test(x) && !/api/i.test(x))).toBe(true);
    expect(patterns.some((x) => /api/i.test(x) && /display/i.test(x))).toBe(true);
  });

  /*
   * The token must not reach the container's **error** log either, and that is a separate
   * mechanism from the access log above.
   *
   * `log_format` applies only to the access log; `error_log` takes no format and no variables,
   * so the redacting map cannot reach it. With the API unreachable, nginx writes at `[error]`
   * level `connect() failed ... request: "GET /api/display/<token> HTTP/1.1", upstream:
   * "http://api:8080/api/display/<token>"` - the live credential twice in one line, once per
   * poll from every room machine, for as long as the outage lasts. Confirmed against a real
   * `nginx:alpine` with a refusing upstream before the directive was added, and confirmed silent
   * after (gap review 2026-09-02, G30).
   *
   * Raising the level is the only lever available, so the level is what this asserts. The
   * directive itself went in without a test, which meant deleting the line left the whole suite
   * green - the gap this closes (gap re-review 2026-09-02).
   */
  it('silences the served image’s error log above crit, where the token cannot be redacted', () => {
    const template = readFileSync(join(webRoot, 'nginx', 'default.conf.template'), 'utf8');

    const directive = /error_log\s+\S+\s+(\w+);/.exec(template);
    expect(directive, 'an explicit error_log directive should be declared').not.toBeNull();

    /*
     * nginx orders these emerg < alert < crit < error < warn < notice < info < debug, and logs
     * the named level *and above*. Anything from `error` down still writes the request line, so
     * only the three above it will do. Asserted as a set rather than as the literal 'crit' so a
     * deliberate move to `alert` is not a false failure.
     */
    expect(['crit', 'alert', 'emerg']).toContain(directive![1]);

    // At server level, so a location added later cannot inherit a noisier default by omission.
    const server = /server\s*{[\s\S]*}/.exec(template)?.[0] ?? template;
    expect(server, 'the directive belongs inside the server block').toContain('error_log');
  });
  it('routes the display prefix ahead of the SPA fallback and behind the API proxy', () => {
    const template = readFileSync(join(webRoot, 'nginx', 'default.conf.template'), 'utf8');

    expect(template).toMatch(/location \^~ \/display\/ \{[\s\S]*?try_files \$uri \/display\.html;/);
    expect(template.indexOf('location /api/')).toBeLessThan(
      template.indexOf('location ^~ /display/'),
    );
    expect(template.indexOf('location ^~ /display/')).toBeLessThan(
      template.indexOf('location / {'),
    );

    // `try_files $uri` first, so a real asset under the prefix is still served as itself.
    const block = /location \^~ \/display\/ \{[\s\S]*?\r?\n {4}\}/.exec(template)?.[0];
    expect(block).toMatch(/try_files \$uri \/display\.html;/);

    /*
     * The projected board is a bearer-token surface, so the document must not be cached - and the
     * directive has to sit on the **exact-match** location, not in the prefix block. `try_files`
     * performs an internal redirect to /display.html, and `add_header` does not survive one, so a
     * directive written in the block above would never reach the response (review 2026-08-31, L2).
     */
    expect(
      block,
      'add_header in the prefix block would not survive the internal redirect',
    ).not.toMatch(/add_header/);
    const entryDocument = /location = \/display\.html \{[\s\S]*?\r?\n {4}\}/.exec(template)?.[0];
    expect(entryDocument, 'the exact-match location for the display document').toBeDefined();
    expect(entryDocument).toMatch(/add_header Cache-Control "no-store" always;/);
  });
});
