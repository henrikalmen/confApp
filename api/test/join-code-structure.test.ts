import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { fakeDatabase } from './fake-db.ts';
import { fakeAuth } from './fake-auth.ts';

/**
 * S05's Structural Criteria – the ones that are properties of the source rather than of a request.
 *
 * Every assertion here guards a decision a later story could undo by writing code that works
 * perfectly and passes every behavioural test: a second joinability rule that agrees with the first
 * until one is edited, an inline role comparison at a join-code endpoint, a module-level attempt
 * counter that enforces nothing across replicas, a partial unique index that quietly permits a code
 * to be reissued. None of those fails a test of the feature.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, '..', 'src');
const repoRoot = join(here, '..', '..');

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

/** Comments explain the rules; matching them would make these tests assert their own prose. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function withoutSqlComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, '');
}

/** Every TypeScript file under `api/src`, so a criterion can be asserted about the whole surface. */
function apiSources(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) found.push(path);
    }
  };
  walk(apiSrc);
  return found;
}

/** The modules S05 introduced – the ones the "no second rule here" criteria are about. */
const S05_MODULES = [
  ['routes', 'join-code.ts'],
  ['conferences', 'join-code.ts'],
  ['conferences', 'failed-join-attempts.ts'],
] as const;

describe('joinability still has exactly one definition', () => {
  /**
   * The rule lives in S03's lifecycle module and S05 consumes it. The FIS is explicit that if the
   * predicate needed the reason as well, it was to be extended *in place* rather than paired with a
   * local check – so the reason function belongs to the same module and to no other.
   */
  it('defines the predicate and its reason only in the lifecycle module', () => {
    for (const pattern of [/function isJoinable\b/, /function joinRefusalReason\b/, /function assertJoinable\b/]) {
      const definitions = apiSources().filter((path) =>
        pattern.test(withoutComments(readFileSync(path, 'utf8'))),
      );
      expect(
        definitions.map((path) => path.replace(apiSrc, '').replace(/\\/g, '/')),
        String(pattern),
      ).toEqual(['/conferences/lifecycle.ts']);
    }
  });

  /**
   * The grep-level half of TI05. A duplicated lifecycle or end-date test passes every behavioural
   * test in this suite until the two copies drift, which is why it is asserted by inspection.
   */
  it('makes no lifecycle-state or end-date comparison in any S05 module', () => {
    for (const parts of S05_MODULES) {
      const code = withoutComments(read(apiSrc, ...parts));
      const where = parts.join('/');

      expect(code, where).not.toMatch(/lifecycleState\s*[=!]==/);
      expect(code, where).not.toMatch(/[=!]==\s*'(draft|published|archived)'/);
      expect(code, where).not.toMatch(/'(draft|published|archived)'\s*[=!]==/);
      // No end-date arithmetic or comparison either – that half of the rule is the one that gets
      // forgotten, so a local copy of it is the likelier defect.
      expect(code, where).not.toMatch(/endDate\s*[<>]/);
      expect(code, where).not.toMatch(/compareDates|addDays|daySpan/);
    }
  });

  it('reaches the rule only through the exported guard', () => {
    const handlers = withoutComments(read(apiSrc, 'routes', 'join-code.ts'));
    expect(handlers).toContain('assertJoinable');
  });
});

describe('the authorization helper is the only authorization path at the join-code endpoints', () => {
  const code = withoutComments(read(apiSrc, 'routes', 'join-code.ts'));

  it('makes no inline creator or role comparison', () => {
    expect(code).not.toMatch(/createdBySub\s*===/);
    expect(code).not.toMatch(/===\s*caller\.sub/);
    expect(code).not.toMatch(/caller\.sub\s*===/);
    expect(code).not.toMatch(/\.role\s*===/);
  });

  it('routes every check through requireConferenceRole and reads no role table directly', () => {
    expect(code).toContain('requireConferenceRole');
    expect(code).not.toMatch(/role_assignment/);
    // The one membership write goes through the repository seam, never as SQL in a handler.
    expect(code).not.toMatch(/insert into|select .* from/i);
  });
});

describe('the limiter keeps nothing in process and never reads an address', () => {
  const source = read(apiSrc, 'conferences', 'failed-join-attempts.ts');
  const code = withoutComments(source);

  /**
   * The API scales horizontally with no request affinity (ADR-004), so a counter in module scope is
   * per-replica and enforces nothing. A module-level `Map`, `Set`, array or mutable `let` is the
   * shape that defect takes.
   */
  it('declares no module-level mutable state', () => {
    // Anchored to column 0: a `let` inside a function is a local, and locals do not survive a
    // request. What must not exist is a binding at module scope that does.
    expect(code).not.toMatch(/^(let|var)\s/m);
    expect(code).not.toMatch(/new (Map|Set|WeakMap|WeakRef)\b/);
    expect(code).not.toMatch(/\bstatic\b/);
  });

  /** Not "does not use the IP" as a convention – there is no way to reach one from here. */
  it('takes no request and reads no address of any kind', () => {
    expect(code).not.toMatch(/request|reply|headers|socket|remoteAddress|x-forwarded-for|\bip\b/i);
  });

  /** Counting is a read; recording is a single append. A read-then-write over a counter is not. */
  it('records with one statement and never updates a counter', () => {
    expect(code).toMatch(/insert into failed_join_attempt/);
    expect(code).not.toMatch(/update failed_join_attempt/i);
    expect(code).not.toMatch(/count\s*=\s*count\s*\+/i);
  });

  /** Retention rides along with the write, so it needs no schedule and no operator. */
  it('prunes inside the recording statement', () => {
    expect(code).toMatch(/delete from failed_join_attempt/);
    expect(code).toMatch(/attempted_at\s*<\s*clock_timestamp\(\)/);
  });

  /** Plain PostgreSQL only – no cache service, no extension-backed structure (ADR-003). */
  it('introduces no managed cache or extension', () => {
    expect(code).not.toMatch(/redis|memcach|valkey|elasticache|azure.?cache/i);
  });
});

describe('no S05 module holds join or rate-limit state between requests', () => {
  it('declares no module-level mutable state in any of them', () => {
    for (const parts of S05_MODULES) {
      const code = withoutComments(read(apiSrc, ...parts));
      const where = parts.join('/');
      // Column 0 only – see the note above; a function-local `let` is not state between requests.
      expect(code, where).not.toMatch(/^(let|var)\s/m);
      expect(code, where).not.toMatch(/^const\s+\w+\s*=\s*new (Map|Set|WeakMap)/m);
    }
  });
});

describe('the migration (TI01, TI06, TI11)', () => {
  const migrations = join(repoRoot, 'db', 'migrations');
  const raw = read(migrations, '20260817180000000_join-code.sql');
  const sql = withoutSqlComments(raw);

  /** Plain PostgreSQL only – portability is why PostgreSQL was chosen (ADR-003). */
  it('uses no extension and no provider-specific feature', () => {
    expect(sql).not.toMatch(/create\s+extension/i);
    expect(sql).not.toMatch(/pgcrypto|uuid-ossp|azure|citus|timescale|pg_cron/i);
  });

  /**
   * The absence of a WHERE clause is the criterion. A predicate here – on lifecycle state or on
   * anything else – would let a code circulated for a past conference be reissued, and the employee
   * holding the old slide would land somewhere else entirely (FR3 → Validation).
   */
  it('makes the join code unique across every row, with no predicate', () => {
    const index = /create unique index conference_join_code_unique on conference \(join_code\)\s*;/i;
    expect(sql).toMatch(index);

    const statement = index.exec(sql)?.[0] ?? '';
    expect(statement.toLowerCase()).not.toContain('where');
    expect(statement.toLowerCase()).not.toContain('lifecycle_state');
  });

  /** The alphabet is a storage-level guarantee, not only a generator convention. */
  it('constrains the stored code to the ambiguity-free alphabet', () => {
    expect(sql).toMatch(/\[23456789ABCDEFGHJKMNPQRSTVWXYZ\]\{6\}/);
    expect(sql).toMatch(/join_code IS NULL OR/i);
  });

  /** Absent until published, so the column has to be nullable. */
  it('adds the column nullable', () => {
    expect(sql).toMatch(/ADD COLUMN join_code text\s*;/i);
    expect(sql).not.toMatch(/join_code text NOT NULL/i);
  });

  /**
   * S03 owns the Membership table and its creator seed. S05 writes rows into it and must not
   * redefine its shape – two definitions of one table is a migration that cannot be applied twice.
   */
  it('creates no table other than the failed-attempt store', () => {
    const [up] = raw.split(/^-- Down Migration$/m) as [string, string];
    const created = [...up.matchAll(/create table (\w+)/gi)].map((match) => match[1]);
    expect(created).toEqual(['failed_join_attempt']);
    expect(sql).not.toMatch(/create table membership|create table role_assignment/i);
  });

  it('is reversible – the table and the column both go away again', () => {
    const [, down] = raw.split(/^-- Down Migration$/m) as [string, string];
    expect(down).toMatch(/drop table failed_join_attempt/i);
    expect(down).toMatch(/alter table conference drop column join_code/i);
  });

  /** No column for a client address exists, so an IP-keyed limiter is unrepresentable. */
  it('keys the failed-attempt store on the sub claim and on nothing else', () => {
    expect(sql).toMatch(/user_sub\s+text\s+NOT NULL REFERENCES app_user \(sub\)/);
    expect(sql).not.toMatch(/ip|address|forwarded|email/i);
  });
});

describe('every S05 refusal leaves through the shared envelope', () => {
  /**
   * The codes exist as codes, and the endpoint modules build refusals only as `AppError` – never as
   * a reply with a hand-rolled body, which is how an endpoint-local error shape appears.
   */
  it('names each refusal in the shared code list', async () => {
    const { ERROR_CODES } = await import('../src/errors.ts');
    for (const code of [
      'JOIN_CODE_UNKNOWN',
      'JOIN_CONFERENCE_NOT_PUBLISHED',
      'JOIN_CONFERENCE_ARCHIVED',
      'JOIN_CONFERENCE_ENDED',
      'JOIN_ATTEMPTS_RATE_LIMITED',
    ]) {
      expect(ERROR_CODES, code).toHaveProperty(code, code);
    }
  });

  it('builds every refusal as an AppError, with no reply-level error shape', () => {
    for (const parts of S05_MODULES) {
      const code = withoutComments(read(apiSrc, ...parts));
      const where = parts.join('/');
      expect(code, where).not.toMatch(/reply\.(status|code|send)/);
      expect(code, where).not.toMatch(/error:\s*\{/);
    }
  });
});

describe('the join-code routes are authenticated and registered', () => {
  it('registers all three through withAuth', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const urls = app.confappRoutes.map((route) => `${route.method} ${route.url}`);

      expect(urls).toContain('POST /api/join');
      expect(urls).toContain('GET /api/conferences/:conferenceId/join-code');
      expect(urls).toContain('POST /api/conferences/:conferenceId/join-code/regenerate');

      for (const route of app.confappRoutes) {
        if (route.url === '/api/join' || route.url.includes('join-code')) {
          expect(route.authenticated, `${route.method} ${route.url}`).toBe(true);
        }
      }
    } finally {
      await app.close();
    }
  });

  /** Leaving and Admin removal are S08's; this story only ever creates a Membership. */
  it('adds no endpoint that revokes a membership', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const urls = app.confappRoutes.map((route) => `${route.method} ${route.url}`);
      expect(urls.some((url) => url.startsWith('DELETE') && url.includes('member'))).toBe(false);
      expect(urls).not.toContain('POST /api/leave');
    } finally {
      await app.close();
    }
  });
});
