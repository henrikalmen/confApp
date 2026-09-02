import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * What the projected surface is **structurally incapable of** (S07 TI06, TI08).
 *
 * The behavioural half of every guard here is in `ProjectedBoardView.test.tsx`, and both halves are
 * needed: a file-list guard is only as good as its longest omission
 * (`docs/LEARNINGS.md#testing`), and a behavioural assertion cannot see a module that is merely
 * *reachable* rather than reached. So these read the module graph, and the ones that read text read
 * it with the comments stripped - the comments explain the rules, and matching them would make
 * these tests assert their own prose.
 *
 * The register is `api/test/post-it-structure.test.ts`'s: an explicit written allow-list, so a
 * later edit that widens the graph fails here rather than quietly widening what a room machine
 * downloads.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const webSrc = join(webRoot, 'src');
const displaySrc = join(webSrc, 'display');
const repoRoot = join(webRoot, '..');

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

/** Comments explain the rules; matching them would make these tests assert their own prose. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function relativeTo(root: string, path: string): string {
  return path.replace(root, '').replace(/\\/g, '/');
}

/** Every `.ts`/`.tsx` source under a root, recursively. */
function sourcesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

/** Every source under `web/src/display/`, whatever it is called. */
function displaySources(): string[] {
  return readdirSync(displaySrc)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => join(displaySrc, name))
    .sort();
}

/**
 * Every module reachable from the display entry point, following relative imports transitively.
 *
 * The same walk `api/test/display-link-structure.test.ts` performs over the anonymous route, for
 * the same reason: the claim is about the closure, not about the four files somebody remembered.
 */
function reachableFromDisplayEntry(): string[] {
  const seen = new Set<string>();
  const queue = [join(displaySrc, 'main-display.tsx')];

  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    if (!/\.tsx?$/.test(path)) continue;

    const source = readFileSync(path, 'utf8');
    // Both quote styles. Prettier settles on single quotes here, but a walk that only understands
    // the formatted form is a closure guard with a hole in it - and the hole would be invisible.
    for (const match of source.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)) {
      queue.push(join(dirname(path), match[1]!));
    }
  }
  return [...seen].sort();
}

// ---------- TI08: the display bundle's closure ----------

describe('the display entry point reaches only what it is allowed to', () => {
  /**
   * **The written allow-list.** Every entry is here because the projected surface genuinely needs
   * it, and the list is short on purpose - it is the whole of what a room machine downloads and
   * runs. A fifth `web/src` subsystem appearing here is the review, not a detail.
   */
  const ALLOWED = new Set([
    '/display/main-display.tsx',
    '/display/DisplayBoardView.tsx',
    '/display/display-token.ts',
    '/display/board-layout.ts',
    '/display/display.css',
    /*
     * The transport and the Board projection, and **not** `api/client.ts` - which carries
     * `castVote`, the Join Code helpers and every other authenticated endpoint. Importing it for
     * one anonymous GET put all of them into the chunk a room machine downloads, and a guard
     * reading file names could not see it (S07, 2026-08-31, review H2).
     */
    '/api/request.ts',
    '/api/board.ts',
    '/config.ts',
    // A type-only import of `EffectiveClock`, reached through `attendee/staleness.ts`. The
    // projected surface constructs no clock: its age is elapsed time on one machine.
    '/clock/effective-clock.ts',
    // The one cadence loop, and the seam the staleness indicator re-renders on.
    '/poll/use-watermark-poll.ts',
    '/tick/foreground-tick.ts',
    // The staleness sentence, taking an age in milliseconds and no clock.
    '/attendee/staleness.ts',
    // Tokens and the light/dark blocks the projection styles map onto - not its layout.
    '/styles.css',
  ]);

  it('imports nothing outside the written allow-list', () => {
    const reached = reachableFromDisplayEntry().map((path) => relativeTo(webSrc, path));
    expect(reached.length).toBeGreaterThan(5);
    for (const name of reached) {
      expect(ALLOWED, `${name} is reachable from the display entry point`).toContain(name);
    }
    // And the list is not stale in the other direction either.
    for (const name of ALLOWED) {
      expect(reached, `${name} is listed but no longer reached`).toContain(name);
    }
  });

  /**
   * No auth, no sign-in, no service worker, no offline queue, no schedule cache - stated over the
   * closure rather than over the four files this story wrote. A room machine has no Workspace
   * session and must not acquire one on shared hardware, and the offline scope confApp supports is
   * schedule reads and Post-it queueing, widened by nothing here.
   */
  it('reaches no auth provider, sign-in, service worker, offline queue or schedule cache', () => {
    for (const path of reachableFromDisplayEntry()) {
      const name = relativeTo(webSrc, path);
      expect(name, name).not.toMatch(/auth|session|sign-in|offline|queue|schedule|sw\b/i);
      if (!/\.tsx?$/.test(path)) continue;
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, name).not.toMatch(/AuthProvider|useAuth|serviceWorker|code_challenge/);
      expect(source, name).not.toMatch(/indexedDB|caches\.|CacheStorage/);
    }
  });

  /**
   * **One resolution path and one entry point** (S04, consumed unchanged). A second of either would
   * be a second thing to keep in step with revocation, and revocation is the property the whole
   * surface turns on.
   */
  it('resolves the board one way, through one document', () => {
    const board = withoutComments(read(displaySrc, 'DisplayBoardView.tsx'));
    expect(board.match(/fetchDisplayBoard\(/g)).toHaveLength(1);
    for (const path of displaySources()) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      // No source here builds a request of its own: the one call shape lives in `api/client.ts`.
      expect(source, relativeTo(webSrc, path)).not.toMatch(/\bfetch\(|XMLHttpRequest|EventSource/);
      expect(source, relativeTo(webSrc, path)).not.toMatch(/WebSocket/);
    }

    const boardModule = withoutComments(read(webSrc, 'api', 'board.ts'));
    expect(boardModule.match(/`\/display\/\$\{encodeURIComponent\(token\)\}`/g)).toHaveLength(1);
    /*
     * `client.ts` still builds the *link* a Facilitator copies (`displayLinkUrl`), which is a
     * different thing from reading the Board. What must be singular is the **request**: exactly one
     * place in `web/src` asks the API for `/display/<token>`.
     */
    const asked = sourcesUnder(webSrc).filter((path) =>
      /apiRequest<[^>]*>\(\s*`\/display\//.test(withoutComments(readFileSync(path, 'utf8'))),
    );
    expect(asked.map((path) => relativeTo(webSrc, path))).toEqual(['/api/board.ts']);

    // One document, naming one entry module. `index.html` names the other and neither names both.
    const display = read(webRoot, 'display.html');
    const app = read(webRoot, 'index.html');
    expect(display).toContain('/src/display/main-display.tsx');
    expect(display).not.toContain('/src/main.tsx');
    expect(app).not.toContain('/src/display/');

    // Two Rollup inputs, and still two.
    const vite = withoutComments(read(webRoot, 'vite.config.ts'));
    const inputs = /input:\s*\{([\s\S]*?)\}/.exec(vite)?.[1] ?? '';
    expect(inputs).toContain('display.html');
    expect(inputs.match(/fileURLToPath/g)).toHaveLength(2);
  });

  /** No routing dependency: a route of the app is how every one of those subsystems arrives. */
  it('adds no routing dependency to the web workspace', () => {
    const manifest = JSON.parse(read(webRoot, 'package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const named = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    for (const name of named) {
      expect(name).not.toMatch(/router|routing|wouter|navigo/i);
    }
  });

  /**
   * `ANONYMOUS_ROUTES` is S04's and is **unchanged by this story**. The app refuses to start if any
   * route is registered unauthenticated and off this exact-match list, so widening it here would be
   * the one way this surface could quietly reach something else.
   */
  it('leaves the anonymous allow-list exactly as S04 left it', () => {
    const withAuth = read(repoRoot, 'api', 'src', 'auth', 'with-auth.ts');
    const list = /export const ANONYMOUS_ROUTES[\s\S]*?\n\];/.exec(withAuth)?.[0] ?? '';
    expect(list, 'the anonymous allow-list should be found').not.toBe('');
    expect(list.match(/url: '/g)).toHaveLength(3);
    expect(list).toContain("url: '/api/health'");
    expect(list).toContain("url: '/api/auth/token'");
    expect(list).toContain("url: '/api/display/:token'");
  });

  /** S04 TI12's service-worker exclusion is intact - nothing here re-caches a projected page. */
  it('keeps the projected path out of the service worker', () => {
    const worker = read(webRoot, 'public', 'sw.js');
    expect(worker).toMatch(/\/display\//);
  });
});

// ---------- TI04, TI06, TI07, TI10: what the display sources may not contain ----------

describe('what no source under web/src/display may do', () => {
  /**
   * **No timer of its own.** The staleness label re-renders on the one loop's tick
   * (`tick/foreground-tick.ts`); a `setInterval` here would be the second cadence this story's
   * scope forbids, and would keep running on a wall whose loop had stopped.
   */
  it('owns no interval, timeout or animation frame', () => {
    for (const path of displaySources()) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(webSrc, path)).not.toMatch(
        /setInterval|setTimeout|requestAnimationFrame/,
      );
    }
    // And it does subscribe to the one that exists, rather than doing without a re-render source.
    expect(withoutComments(read(displaySrc, 'DisplayBoardView.tsx'))).toContain(
      'onForegroundTick(',
    );
  });

  /**
   * **Nothing is filtered here.** A discarded Post-it is excluded by S05's anti-join inside the
   * read's own statement and a permanently removed one by S06 deleting the row; this surface adds
   * no second filtering site, and shows no marker, badge or notification for either.
   */
  it('filters no post-it out of a result set and renders no discarded state', () => {
    for (const path of displaySources()) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      const name = relativeTo(webSrc, path);
      expect(source, name).not.toMatch(/\.filter\(/);
      expect(source, name).not.toMatch(/discard|setAside|set aside|removedAt|deletedAt/i);
    }
  });

  /**
   * **No count is re-derived.** S02 computes them server-side precisely so no surface has a second
   * opinion, and a `postIts.length` here would drift the moment the projection rendered a subset.
   */
  it('renders the server counts rather than measuring the arrays', () => {
    const source = withoutComments(read(displaySrc, 'DisplayBoardView.tsx'));
    expect(source).toContain('postItCount');
    /*
     * No **rendered** count comes from an array's length. `postIts.length` is still allowed where
     * it is a statement about the rows being laid out rather than about what the Category holds -
     * the empty-region branch, and the `--display-rows` the fit rule divides the tile's height by -
     * so the guard is on interpolating it into the tree, not on the expression existing.
     */
    expect(source).not.toMatch(/\{\s*\w+\.postIts\.length\s*\}|\{\s*postIts\.length\s*\}/);
    expect(source).not.toMatch(/countWord\([^)]*\.length\)/);
  });

  /** **No Session-kind branch.** The projection is of a Board, and a Board is a Board either way. */
  it('reads no session kind', () => {
    for (const path of displaySources()) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(webSrc, path)).not.toMatch(
        /sessionKind|isWorkshop|Presentation|Workshop/,
      );
    }
  });

  /**
   * **Nothing vote-shaped, and nothing that could become one** (ADR-006, Binding Constraint FR8).
   * The route this reads cannot produce vote data; this is the other end of the same guarantee.
   */
  it('names no vote, ballot, tally or option', () => {
    for (const path of displaySources()) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(webSrc, path)).not.toMatch(
        /\bvotes?\b|ballot|voter|hasVoted|tally|optionId|OptionTally|castBallot/i,
      );
    }
  });

  /**
   * **Nothing is cached, at any layer.** `Cache-Control: no-store` and the service worker's
   * `/display/` exclusion are what make revocation land at the next poll; a response cache or a TTL
   * here would reintroduce exactly the staleness those two exist to prevent.
   */
  it('caches no response and persists nothing on the room machine', () => {
    for (const path of displaySources()) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      const name = relativeTo(webSrc, path);
      expect(source, name).not.toMatch(/localStorage|sessionStorage|indexedDB|caches\./);
      expect(source, name).not.toMatch(/useMemo\(|cacheKey|ttl|maxAge/i);
    }
  });

  /**
   * **`navigator.onLine` decides nothing here.** It stays `true` on dead venue wifi and behind
   * captive portals, which is exactly the venue condition this story is written for; what decides
   * whether the screen is stale is whether the *request* succeeded.
   */
  it('never consults navigator.onLine', () => {
    for (const path of displaySources()) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(webSrc, path)).not.toMatch(/navigator\.onLine|useOnline/);
    }
  });

  /**
   * Terminology follows `docs/UBIQUITOUS_LANGUAGE.md#output` in class names, testids and copy as
   * well as in prose - the registered synonyms are avoided everywhere a maintainer would read them.
   */
  it('uses the canonical vocabulary and none of the registered synonyms', () => {
    const sources = [
      ...displaySources().map((path) => readFileSync(path, 'utf8')),
      read(displaySrc, 'display.css'),
    ];
    for (const source of sources) {
      expect(source).not.toMatch(
        /projector mode|big screen|presenter view|TV mode|share link|public link|inbox|unsorted category|default column|backlog/i,
      );
    }
    expect(read(displaySrc, 'DisplayBoardView.tsx')).toContain('Uncategorised');
  });
});
