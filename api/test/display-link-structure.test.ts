import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { ANONYMOUS_ROUTES } from '../src/auth/with-auth.ts';
import { fixedClock } from '../src/conferences/calendar-date.ts';
import {
  DISPLAY_TOKEN_BYTES,
  DISPLAY_TOKEN_LENGTH,
  isCanonicalDisplayToken,
  mintDisplayToken,
  resolveDisplayLink,
  type DisplayLinkCandidate,
} from '../src/rounds/display-link.ts';
import { redactDisplayToken } from '../src/routes/display.ts';
import { fakeDatabase } from './fake-db.ts';
import { fakeAuth } from './fake-auth.ts';

/**
 * S04's Structural Criteria, plus the two units whose whole behaviour is decidable without a
 * database: the minter (TI02) and the resolvability predicate (TI04).
 *
 * These read the files on disk on purpose. Each guards a decision a later story could undo **by
 * writing perfectly working code**: a fourth anonymous route added without a written reason, a
 * `pattern` put on the token parameter "for validation", a vote join added to the resolution path, a
 * memoized token, a `revoked_at` reset written as a fix, the token logged in a request line.
 *
 * Every file-list assertion here is paid for behaviourally in `display-link.integration.test.ts`,
 * because a file list is only as good as its longest omission
 * (`docs/LEARNINGS.md#testing`) - and this file's own no-vote-data assertion is deliberately written
 * twice for exactly that reason: once over the module graph here, once against real responses over a
 * Session that genuinely holds a Poll with cast ballots there.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, '..', 'src');
const repoRoot = join(here, '..', '..');
const webSrc = join(repoRoot, 'web', 'src');

const MIGRATION = '20260903090000000_display-link.sql';

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

/** Comments explain the rules; matching them would make these tests assert their own prose. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function withoutSqlComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');
}

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
  return found;
}

function relativeTo(root: string, path: string): string {
  return path.replace(root, '').replace(/\\/g, '/');
}

/** The modules this story introduced on the API side. */
const DISPLAY_MODULES = [
  join(apiSrc, 'rounds', 'display-link.ts'),
  join(apiSrc, 'rounds', 'display-link-repository.ts'),
  join(apiSrc, 'routes', 'display.ts'),
  join(apiSrc, 'rounds', 'board-wire.ts'),
];

// ---------- the migration (TI01) ----------

describe('the display link migration', () => {
  const raw = read(repoRoot, 'db', 'migrations', MIGRATION);
  const [up, down] = raw.split(/^-- Down Migration$/m) as [string, string];
  const upSql = withoutSqlComments(up);
  const downSql = withoutSqlComments(down);

  /** Plain PostgreSQL only – portability is why PostgreSQL was chosen (ADR-003). */
  it('uses plain PostgreSQL with no extension and no provider-proprietary feature', () => {
    expect(upSql).not.toMatch(/CREATE\s+EXTENSION/i);
    expect(upSql).not.toMatch(/pgcrypto|citext|pg_trgm|uuid-ossp/i);
    expect(upSql).not.toMatch(/azure|cosmos|aurora|cloudsql|rds_/i);
    // gen_random_uuid is core PostgreSQL 13+, which is why no extension is needed for it.
    expect(upSql).toMatch(/gen_random_uuid\(\)/);
  });

  /**
   * The composite foreign key, so a link for a **Voting Round** or for a Round in another
   * Conference is unwritable rather than merely unwritten - the same idiom `post_it` and `category`
   * use.
   */
  it('hangs the link off the round through the composite key, not off a bare round_id', () => {
    expect(upSql).toMatch(
      /FOREIGN KEY \(round_id, round_kind, conference_id\)\s*REFERENCES round \(id, kind, conference_id\)/i,
    );
    expect(upSql).toMatch(/ON DELETE CASCADE/i);
    expect(upSql).toMatch(/CHECK \(round_kind = 'PostItRound'\)/i);
  });

  /** At most one live link per Round, as storage rather than as an application count. */
  it('enforces one live link per round with a partial unique index', () => {
    expect(upSql).toMatch(
      /CREATE UNIQUE INDEX display_link_one_live_per_round\s*ON display_link \(round_id\) WHERE revoked_at IS NULL/i,
    );
    // And the token is globally unique, which is what makes "never reissued" a table property.
    expect(upSql).toMatch(/token\s+text\s+NOT NULL UNIQUE/i);
  });

  /**
   * What the table deliberately does not carry. Every one of these would be a working column and a
   * lost property: an expiry would kill a link mid-activity, a viewer column would attribute an
   * anonymous read, and anything vote-shaped would breach ADR-006.
   */
  it('carries no expiry, no viewer, no address and nothing vote-derived', () => {
    expect(upSql).not.toMatch(/expires_at|expiry|ttl|valid_until/i);
    expect(upSql).not.toMatch(/ip_address|remote_addr|user_agent|viewed_at|hit_count|opened_by/i);
    expect(upSql).not.toMatch(/\bvote\b|ballot|voter|tally/i);
    // No email anywhere: the issuer is the OIDC subject claim (ADR-002).
    expect(upSql).not.toMatch(/email/i);
    // And no watermark trigger: issuing must not tell the room that a board is being projected.
    expect(upSql).not.toMatch(/advance_round_activity_watermark|CREATE TRIGGER/i);
  });

  /** The canonical shape is a backstop on the column, pinned to the module that defines it. */
  it('states the canonical token shape, matching the minter exactly', () => {
    expect(upSql).toMatch(new RegExp(`\\^\\[A-Za-z0-9_-\\]\\{${DISPLAY_TOKEN_LENGTH}\\}\\$`));
  });

  it('is reversible and drops what it created', () => {
    expect(downSql).toMatch(/DROP INDEX display_link_one_live_per_round/i);
    expect(downSql).toMatch(/DROP TABLE display_link/i);
  });
});

// ---------- minting (TI02) ----------

describe('minting a display link value', () => {
  it('produces 43 base64url characters from 32 bytes of CSPRNG output', () => {
    expect(DISPLAY_TOKEN_BYTES).toBe(32);
    expect(DISPLAY_TOKEN_LENGTH).toBe(43);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const token = mintDisplayToken();
      expect(token).toHaveLength(DISPLAY_TOKEN_LENGTH);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(isCanonicalDisplayToken(token)).toBe(true);
    }
  });

  it('never repeats a value across many mints', () => {
    const minted = new Set<string>();
    for (let attempt = 0; attempt < 5000; attempt += 1) minted.add(mintDisplayToken());
    expect(minted.size).toBe(5000);
  });

  /**
   * **Not derivable from any identifier**, and the strongest available statement of that is
   * structural: the minter takes no argument, so there is no Conference, Session, Round or Post-it
   * id that could reach it. A test that mints "for a round" and compares would only prove that one
   * derivation was not used.
   */
  it('takes no identifier of any kind – there is no parameter one could arrive through', () => {
    expect(mintDisplayToken.length).toBe(0);

    const source = withoutComments(read(apiSrc, 'rounds', 'display-link.ts'));
    // The minter's body reaches the CSPRNG and nothing else.
    const minter = /export function mintDisplayToken\(\)[\s\S]*?\n\}/.exec(source)?.[0];
    expect(minter, 'the minter should be found').toBeDefined();
    expect(minter).toMatch(/randomBytes\(DISPLAY_TOKEN_BYTES\)/);
    expect(minter).not.toMatch(/round|session|conference|postIt|post_it|id\b/i);

    // And no hashing or HMAC of an identifier anywhere in the module – that is derivation too.
    expect(source).not.toMatch(/createHash|createHmac|digest\(/);
    // Math.random is not a CSPRNG. The Join Code's randomInt is justified by its NOT being a
    // boundary; this one is the whole boundary.
    expect(source).not.toMatch(/Math\.random|randomInt/);
  });
});

// ---------- the one predicate (TI04) ----------

describe('whether a token resolves', () => {
  const LIVE: DisplayLinkCandidate = {
    roundId: 'round-1',
    conferenceId: 'conference-1',
    sessionId: 'session-1',
    sessionDay: '2026-09-15',
    lifecycleState: 'published',
    revokedAt: null,
  };

  it('resolves before, on, and not after the round’s session day', () => {
    expect(resolveDisplayLink(LIVE, fixedClock('2026-09-10')).resolved).toBe(true);
    expect(resolveDisplayLink(LIVE, fixedClock('2026-09-15')).resolved).toBe(true);
    expect(resolveDisplayLink(LIVE, fixedClock('2026-09-16')).resolved).toBe(false);
  });

  it('refuses a revoked link, a draft conference, and an unknown token alike', () => {
    const clock = fixedClock('2026-09-15');
    expect(
      resolveDisplayLink({ ...LIVE, revokedAt: '2026-09-15T09:00:00.000000Z' }, clock),
    ).toEqual(resolveDisplayLink(null, clock));
    expect(resolveDisplayLink({ ...LIVE, lifecycleState: 'draft' }, clock)).toEqual(
      resolveDisplayLink(null, clock),
    );
    expect(resolveDisplayLink({ ...LIVE, sessionDay: '2026-09-01' }, clock)).toEqual(
      resolveDisplayLink(null, clock),
    );
  });

  /**
   * **The failure result carries no discriminator at all** – not a code, not an enum, not a boolean
   * pair. A caller that cannot tell the reasons apart cannot leak them, however the handler is later
   * edited, which is why this is asserted on the shape rather than on the handler's behaviour.
   */
  it('exposes no field distinguishing why a token did not resolve', () => {
    const clock = fixedClock('2026-09-16');
    const failures = [
      resolveDisplayLink(null, clock),
      resolveDisplayLink({ ...LIVE, revokedAt: '2026-09-15T09:00:00.000000Z' }, clock),
      resolveDisplayLink({ ...LIVE, lifecycleState: 'draft' }, clock),
      resolveDisplayLink(LIVE, clock),
    ];
    for (const failure of failures) {
      expect(Object.keys(failure)).toEqual(['resolved']);
      expect(failure).toEqual({ resolved: false });
    }
  });

  /** A Draft Conference starts working on its own, with no reissue (prd.md#edge-cases). */
  it('starts resolving once the conference is published, with no reissue', () => {
    const clock = fixedClock('2026-09-15');
    expect(resolveDisplayLink({ ...LIVE, lifecycleState: 'draft' }, clock).resolved).toBe(false);
    expect(resolveDisplayLink(LIVE, clock).resolved).toBe(true);
  });

  /** The comparison is a calendar-date one, never a Date, an instant or an elapsed interval. */
  it('decides against sessions.day as a calendar date and against nothing else', () => {
    const source = withoutComments(read(apiSrc, 'rounds', 'display-link.ts'));
    expect(source).toMatch(/compareDates\(clock\.today\(\), candidate\.sessionDay\) > 0/);
    expect(source).not.toMatch(/new Date|Date\.now|getTime\(|setHours|toISOString/);
    expect(source).not.toMatch(/issuedAt|issued_at/);
  });
});

// ---------- the anonymous surface (TI05) ----------

describe('the anonymous surface', () => {
  it('holds exactly three entries, each with a written reason', async () => {
    expect(ANONYMOUS_ROUTES.map((route) => `${route.method} ${route.url}`).sort()).toEqual([
      'GET /api/display/:token',
      'GET /api/health',
      'POST /api/auth/token',
    ]);
    for (const route of ANONYMOUS_ROUTES) expect(route.because.length).toBeGreaterThan(40);

    // The new entry names why it is allowed to answer without a credential, in the existing shape.
    const display = ANONYMOUS_ROUTES.find((route) => route.url === '/api/display/:token');
    expect(display?.because).toMatch(/room machine|shared hardware/i);
  });

  /** Every other route this story added goes through the wrapper. */
  it('wraps the issue, revoke and read routes and leaves only the resolution route open', async () => {
    const app = buildApp({
      db: fakeDatabase(),
      auth: fakeAuth(),
      clock: fixedClock('2026-09-15'),
    });
    await app.ready();
    try {
      const displayLinkRoutes = app.confappRoutes.filter((route) =>
        /display-link$/.test(route.url),
      );
      expect(displayLinkRoutes.length).toBeGreaterThanOrEqual(3);
      for (const route of displayLinkRoutes) {
        expect(route.authenticated, `${route.method} ${route.url}`).toBe(true);
      }

      // And the resolution route exists exactly once, on GET only – no write verb is registered.
      const resolution = app.confappRoutes.filter(
        (route) => route.url === '/api/display/:token' && route.method !== 'HEAD',
      );
      expect(resolution.map((route) => route.method)).toEqual(['GET']);
    } finally {
      await app.close();
    }
  });

  /**
   * **No shape schema on the token parameter.** A `pattern` or `minLength` there would answer a
   * wrong-shaped value with VALIDATION_FAILED while a real-but-dead token answered the neutral
   * refusal - an oracle telling "not even a token" from "not a live token".
   */
  it('carries no shape-validating schema on the token parameter', () => {
    const source = withoutComments(read(apiSrc, 'routes', 'display.ts'));
    expect(source).not.toMatch(/pattern|minLength|maxLength|format:/);
    expect(source).not.toMatch(/isCanonicalDisplayToken/);
    expect(source).toMatch(/cache-control['"]?,\s*['"]no-store/i);
  });

  /** The token never reaches a log line. Fastify's default serializer records `req.url`. */
  it('keeps the token out of the request line, and out of every refusal', () => {
    expect(redactDisplayToken('/api/display/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')).toBe(
      '/api/display/<token>',
    );
    expect(redactDisplayToken('/api/health')).toBe('/api/health');

    const app = withoutComments(read(apiSrc, 'app.ts'));
    expect(app).toMatch(/url: redactDisplayToken\(request\.url\)/);

    // No source on this path logs, echoes or embeds the token in a message.
    for (const path of DISPLAY_MODULES) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(apiSrc, path)).not.toMatch(/log\.(info|warn|error|debug)/);
      expect(source, relativeTo(apiSrc, path)).not.toMatch(/console\./);
      expect(source, relativeTo(apiSrc, path)).not.toMatch(/\$\{token\}|\+ token\b/);
    }
  });
});

// ---------- vote anonymity is untouched (TI07, Binding Constraint FR8) ----------

describe('the display link reaches no vote data', () => {
  /**
   * The module-graph half. The behavioural half - a real Session holding a Poll with cast ballots,
   * read through a live link - is in `display-link.integration.test.ts`, and both are needed: a
   * file-list guard alone is only as good as its longest omission.
   */
  it('names no vote table, ballot or per-voter fact in any module on the resolution path', () => {
    for (const path of DISPLAY_MODULES) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(apiSrc, path)).not.toMatch(
        /\bvotes?\b|ballot|voter|has_voted|tally|poll/i,
      );
    }
  });

  /**
   * And the graph is closed, not merely clean: the modules the display route imports import nothing
   * that reaches a vote repository. This is why the Board projection was lifted out of
   * `routes/rounds.ts` - that module legitimately imports the vote repository for the Poll surface.
   */
  /** Every module reachable from the display route, following relative imports transitively. */
  function reachableFromDisplayRoute(): string[] {
    const seen = new Set<string>();
    const queue = [join(apiSrc, 'routes', 'display.ts')];

    while (queue.length > 0) {
      const path = queue.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);

      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/from '(\.[^']+\.ts)'/g)) {
        queue.push(join(dirname(path), match[1]!));
      }
    }
    return [...seen].sort();
  }

  it('imports nothing that reaches the vote modules', () => {
    const reached = reachableFromDisplayRoute().map((path) => relativeTo(apiSrc, path));
    expect(reached.length).toBeGreaterThan(5);
    for (const name of reached) {
      expect(name, `${name} is reachable from the display route`).not.toMatch(/vote|ballot|poll/i);
    }
    // The Board projection is reached, and `routes/rounds.ts` is not.
    expect(reached).toContain('/rounds/board-wire.ts');
    expect(reached).not.toContain('/routes/rounds.ts');
  });

  /**
   * **The tables, not the filenames.**
   *
   * The assertion above filters the reachable set by *name*, and a review found exactly what that
   * misses: `round-repository.ts` passes a `/vote|ballot|poll/` filename filter while querying
   * `round_option`, the Poll's option set, on every request (2026-08-31, M2). That is the trap the
   * FIS cites from `docs/LEARNINGS.md#testing` - "a file-list grep is only as good as its longest
   * omission" - firing inside the guard written to honour it.
   *
   * So this reads the SQL instead: every table named by every module reachable from the route,
   * checked against a written allow-list. A ninth table fails here rather than quietly widening the
   * closure `api/src/routes/display.ts` states about itself.
   */
  it('names no table outside the written allow-list, across every module it can reach', () => {
    const ALLOWED = new Set([
      'display_link',
      'round',
      'sessions',
      'conference',
      'category',
      'post_it',
      'post_it_delivery',
      /*
       * S05's Discard trace. It is on this closure because the Board reads **exclude** it: the
       * projected screen must not show a Post-it a Facilitator has taken off the board, and the
       * exclusion is an anti-join inside `listForRound`'s own statement rather than a filter applied
       * afterwards (ADR-008). It is a fact about a Post-it and reaches no Vote data of any kind -
       * asserted directly in `discard-structure.test.ts`.
       */
      'post_it_discard',
      'app_user',
    ]);

    /*
     * Every string literal, not only backticked ones.
     *
     * The docblock used to say template literals are "where every statement in this codebase is
     * written", and that was never true: `category-repository.ts` - on this route's own reachable
     * graph - carries single-quoted statements, so a `from vote` added in one of them passed this
     * guard untouched (gap review 2026-09-02, G31). `docs/LEARNINGS.md` already records this exact
     * trap, and the correct extractor was already sitting in `discard-structure.test.ts`. Widened
     * rather than reimplemented, and pinned by the self-test below so the claim and the code cannot
     * drift apart again.
     */
    const backticked = (source: string): string[] =>
      [...source.matchAll(/`([^`]*)`/g)].map((m) => m[1]!);

    /*
     * A quoted string counts as SQL when it **references a table**, which is precisely what this
     * guard is looking for.
     *
     * The first attempt required a leading statement verb. That excluded the prose it was written
     * to exclude, and also every SQL *fragment* - including the codebase's own `NOT_DISCARDED`
     * in `post-it-discard-repository.ts`, a single-quoted `not exists (select 1 from
     * post_it_discard ...)` sitting on this route's reachable closure. A guard blind to the
     * fragments its own modules are built from is worse than no guard, because it reads as one
     * (gap re-review 2026-09-02, G31).
     *
     * The match is deliberately **case-sensitive**: SQL identifiers in this codebase are lower
     * snake_case, while prose capitalises its nouns. That is what separates `from post_it_discard`
     * from `errors.ts`'s "Your sign-in did not come from Google." without needing an exception.
     */
    const REFERENCES_A_TABLE = /\b(from|join|into|update)\s+[a-z_][a-z0-9_]*\b/;
    const quotedSql = (source: string): string[] =>
      [...source.matchAll(/'([^'\n]*)'/g), ...source.matchAll(/"([^"\n]*)"/g)]
        .map((m) => m[1]!)
        .filter((text) => REFERENCES_A_TABLE.test(text));
    const statementsIn = (source: string): string[] => [
      ...backticked(source),
      ...quotedSql(source),
    ];

    /*
     * The quoted extractor's own self-test, asserted against `quotedSql` and never against the
     * combined `statementsIn`.
     *
     * The previous version asked whether `statementsIn` could see `from category` in
     * `category-repository.ts`. It could - from seven *backticked* statements in the same file -
     * so deleting the entire quoted half, a complete revert of the fix this test exists to
     * protect, left it green. A self-test that passes without the thing it tests is worse than
     * none (gap re-review 2026-09-02, G31).
     *
     * Both shapes are pinned: a single-quoted whole statement, and a single-quoted *fragment*
     * with no leading verb, which is the case the first fix was blind to.
     */
    const categoryRepository = withoutComments(
      readFileSync(join(apiSrc, 'rounds', 'category-repository.ts'), 'utf8'),
    );
    const discardRepository = withoutComments(
      readFileSync(join(apiSrc, 'rounds', 'post-it-discard-repository.ts'), 'utf8'),
    );
    expect(
      quotedSql(categoryRepository).some((sql) => /from category/.test(sql)),
      'the quoted extractor must see a single-quoted statement',
    ).toBe(true);
    /*
     * Asserted through `statementsIn`, not `quotedSql`, and that distinction is the point: a test
     * that only exercises the quoted extractor still passes when nothing calls it. This string
     * exists in the codebase exactly once, single-quoted, and in no backticked statement - so it
     * can only be found if the quoted half is actually wired into the combined extractor.
     */
    const quotedOnly = 'not exists (select 1 from post_it_discard';
    expect(
      statementsIn(discardRepository).some((sql) => sql.includes(quotedOnly)),
      'the quoted extractor must be wired in, and must see a fragment with no leading verb',
    ).toBe(true);
    const named = new Map<string, string>();
    for (const path of reachableFromDisplayRoute()) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      for (const sql of statementsIn(source)) {
        /*
         * CTE names read exactly like table names at the point of use (`from live`), so they are
         * collected from their own declarations and subtracted. Without this the guard reports
         * `live` and `ranked` from the category repository's reorder as unknown tables, and a
         * reviewer learns to ignore it - which is how a guard stops guarding.
         */
        const ctes = new Set(
          [...sql.matchAll(/(?:\bwith\b|,)\s*([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].map((m) =>
            m[1]!.toLowerCase(),
          ),
        );
        for (const match of sql.matchAll(
          /\b(?:from|join|into|update|delete\s+from)\s+([a-z_][a-z0-9_]*)/gi,
        )) {
          const table = match[1]!.toLowerCase();
          if (ctes.has(table)) continue;
          // Keywords that legally follow the same words.
          if (['select', 'unnest', 'lateral', 'only', 'values', 'set'].includes(table)) continue;
          if (!named.has(table)) named.set(table, relativeTo(apiSrc, path));
        }
      }
    }

    // The guard has to be able to see something, or it passes vacuously.
    expect(named.has('display_link')).toBe(true);
    expect(named.has('post_it')).toBe(true);
    expect(named.has('sessions')).toBe(true);

    const offenders = [...named].filter(([table]) => !ALLOWED.has(table));
    expect(
      offenders.map(([table, path]) => `${table} (${path})`),
      'a table outside the allow-list is reachable from the anonymous display route',
    ).toEqual([]);

    // `round_option` is the one that used to be reachable and is not any more: the Round's prompt
    // now rides `findByToken`'s own statement rather than a `RoundRepository` hydration.
    expect(ALLOWED.has('round_option')).toBe(false);
    expect(named.has('round_option')).toBe(false);
  });
});

// ---------- nothing is held between requests (Binding Constraint FR1, ADR-004) ----------

describe('display link state lives only in PostgreSQL', () => {
  it.each(DISPLAY_MODULES.map((path) => [relativeTo(apiSrc, path), path] as const))(
    '%s holds no map, cache, counter or memoized token between requests',
    (_name, path) => {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, 'a module-level let is request state waiting to happen').not.toMatch(
        /^(let|var)\s/m,
      );
      expect(source, 'a module-level Map/Set is a cache').not.toMatch(
        /^const\s+\w+\s*=\s*new (Map|Set|WeakMap|WeakSet)\b/m,
      );
      // `cache-control: no-store` is the header this route must send, not a cache it keeps.
      expect(
        source.replace(/cache-control/gi, ''),
        'a memo is a cache with better manners',
      ).not.toMatch(/memo|cache/i);
    },
  );

  /** No path clears `revoked_at`. There is no update anywhere that could. */
  it('has no operation that moves a link from revoked back to live', () => {
    const repository = withoutComments(read(apiSrc, 'rounds', 'display-link-repository.ts'));
    expect(repository).not.toMatch(/revoked_at\s*=\s*(null|NULL)/);
    // The one statement touching the column stamps it, guarded on it already being null.
    const stamps = [...repository.matchAll(/set\s+revoked_at\s*=\s*([^\n]+)/gi)].map(
      (match) => match[1]!,
    );
    expect(stamps.length).toBe(1);
    expect(stamps[0]).toMatch(/clock_timestamp\(\)/);
    expect(repository).toMatch(/dl\.revoked_at is null/);
  });

  /** The display link table is reached from the rounds modules and from nowhere else. */
  it('reaches the display_link table only from its own repository', () => {
    const offenders = sourcesUnder(apiSrc)
      .filter((path) => /\bdisplay_link\b/.test(withoutComments(readFileSync(path, 'utf8'))))
      .map((path) => relativeTo(apiSrc, path));
    expect(offenders).toEqual(['/rounds/display-link-repository.ts']);
  });
});

// ---------- the neutral refusal (TI06) ----------

describe('the single neutral refusal', () => {
  it('is declared once, with the exception to one-code-per-reason written down', () => {
    const errors = read(apiSrc, 'errors.ts');
    expect(errors).toMatch(/DISPLAY_LINK_UNAVAILABLE: 'DISPLAY_LINK_UNAVAILABLE'/);
    // The comment states that this is deliberately the exception, and why.
    const declaration = /\/\*\*[\s\S]*?DISPLAY_LINK_UNAVAILABLE: 'DISPLAY_LINK_UNAVAILABLE'/.exec(
      errors,
    )?.[0];
    expect(declaration).toMatch(/exception/i);

    // One message, no details, and nothing derived from the reason.
    const source = withoutComments(read(apiSrc, 'rounds', 'display-link.ts'));
    const refusal = /export function displayLinkUnavailable\(\)[\s\S]*?\n\}/.exec(source)?.[0];
    expect(refusal).toMatch(/'This board is no longer available\.'/);
    expect(refusal).not.toMatch(/details|current|reason|because/i);

    // And exactly one code is used on the whole resolution path.
    const route = withoutComments(read(apiSrc, 'routes', 'display.ts'));
    expect(route.match(/displayLinkUnavailable\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(route).not.toMatch(/ERROR_CODES\./);
  });
});

// ---------- the second entry point, on all three serving surfaces (TI09–TI12) ----------

describe('the projected URL reaches its own entry point', () => {
  it('builds a second document from its own Rollup input', () => {
    const config = read(repoRoot, 'web', 'vite.config.ts');
    expect(config).toMatch(/rollupOptions/);
    expect(config).toMatch(/display\.html/);
    expect(config).toMatch(/index\.html/);
    // And the dev server answers the token URL with that document rather than the app's.
    expect(config).toMatch(/request\.url = '\/display\.html'/);
  });

  it('routes /display/ ahead of the SPA fallback in the served image', () => {
    const nginx = read(repoRoot, 'web', 'nginx', 'default.conf.template');
    expect(nginx).toMatch(/location \^~ \/display\/ \{/);
    expect(nginx).toMatch(/try_files \$uri \/display\.html;/);
    // The no-store directive lives on the exact-match location the internal redirect lands in.
    expect(nginx).toMatch(/location = \/display\.html \{/);
    // Ahead of `location /`, and behind `location /api/` so it cannot shadow the proxy.
    expect(nginx.indexOf('location /api/')).toBeLessThan(nginx.indexOf('location ^~ /display/'));
    expect(nginx.indexOf('location ^~ /display/')).toBeLessThan(nginx.indexOf('location / {'));
  });

  /**
   * The token is a path segment, so this page's own URL is a bearer credential - and a `Referer`
   * header is how a URL leaves the page that holds it.
   */
  it('tells the browser never to send a referrer from the projected page', () => {
    const document = read(repoRoot, 'web', 'display.html');
    expect(document).toMatch(/<meta name="referrer" content="no-referrer" \/>/);
  });

  /** The display bundle mounts no auth provider and registers no service worker. */
  it('mounts no auth provider and registers no service worker', () => {
    // Comments explain what this entry deliberately does *not* do, and name those things.
    const bootstrap = withoutComments(read(webSrc, 'display', 'main-display.tsx'));
    expect(bootstrap).not.toMatch(/AuthProvider|serviceWorker\.register|navigator\.serviceWorker/);

    // Nothing reachable from the display entry reaches the auth or offline modules either.
    const seen = new Set<string>();
    const queue = [join(webSrc, 'display', 'main-display.tsx')];
    while (queue.length > 0) {
      const path = queue.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/from '(\.[^']+\.tsx?)'/g)) {
        queue.push(join(dirname(path), match[1]!));
      }
    }
    const reached = [...seen].map((path) => relativeTo(webSrc, path));
    for (const name of reached) {
      expect(name, `${name} is reachable from the display entry`).not.toMatch(
        /\/auth\/|\/offline\/|AuthProvider|service-worker/i,
      );
    }
  });

  /** The service worker neither stores nor answers a `/display/` navigation. */
  it('excludes /display/ from the service worker, ahead of the navigation clause', () => {
    const worker = read(repoRoot, 'web', 'public', 'sw.js');
    expect(worker).toMatch(/const DISPLAY_PREFIX = '\/display\/';/);
    const cacheable = /function isCacheableAsset\([\s\S]*?\n\}/.exec(worker)?.[0];
    expect(cacheable, 'isCacheableAsset should be found').toBeDefined();
    expect(cacheable).toMatch(/startsWith\(DISPLAY_PREFIX\)/);
    // And the bare entry document, which the prefix does not cover (review 2026-08-31, L1).
    expect(worker).toMatch(/const DISPLAY_DOCUMENT = '\/display\.html';/);
    expect(cacheable).toMatch(/url\.pathname === DISPLAY_DOCUMENT\) return false/);
    // Before the navigate clause, which would otherwise claim it like any other deep link.
    expect(cacheable!.indexOf('DISPLAY_PREFIX')).toBeLessThan(
      cacheable!.indexOf("request.mode === 'navigate'"),
    );
  });

  /** No routing dependency entered the SPA (FIS -> What We're NOT Doing). */
  it('adds no client-side router', () => {
    const manifest = JSON.parse(read(repoRoot, 'web', 'package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const named = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    for (const name of named) expect(name).not.toMatch(/router|wouter|navigo|reach/i);
  });
});
