import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { fakeDatabase } from './fake-db.ts';
import { fakeAuth } from './fake-auth.ts';

/**
 * The Structural Criteria that are properties of the source itself rather than of a request.
 *
 * They read the files on disk on purpose. Each one guards a decision that a later story could
 * undo by writing perfectly working code – an inline role check, a second joinability rule, a
 * "tidied" pair of timestamp columns – and none of those would fail a behavioural test.
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

/**
 * The same, for SQL. The migration's comments discuss the very things these assertions forbid –
 * the watermark column S04 adds, why there is no email key – so matching the raw file would
 * report a violation for explaining the rule.
 */
function withoutSqlComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, '');
}

describe('the authorization helper is the only authorization path (TI04)', () => {
  const handlers = read(apiSrc, 'routes', 'conferences.ts');
  const code = withoutComments(handlers);

  /**
   * The exact inline comparison the FIS forbids. S07 replaces one helper body; it cannot replace
   * a comparison that a handler grew for itself.
   */
  it('makes no inline creator or role comparison in the handler module', () => {
    expect(code).not.toMatch(/createdBySub\s*===/);
    expect(code).not.toMatch(/===\s*caller\.sub/);
    expect(code).not.toMatch(/caller\.sub\s*===/);
    expect(code).not.toMatch(/\.role\s*===/);
    expect(code).not.toMatch(/lifecycleState\s*===/);
  });

  it('routes every per-conference check through requireConferenceRole', () => {
    expect(code).toContain('requireConferenceRole');
    // The handler module reaches the role tables only through the helper, never directly.
    expect(code).not.toMatch(/role_assignment|membership/);
  });

  it('keeps the helper signature S07 will generalize, options and all', () => {
    const helper = read(apiSrc, 'conferences', 'authorization.ts');
    expect(helper).toMatch(/requireConferenceRole\(/);
    expect(helper).toMatch(/sessionId\?: string/);
    // Presenter/Facilitator is one role, not two.
    expect(helper).toContain("'Admin', 'PresenterFacilitator', 'Attendee'");
    expect(helper).not.toMatch(/'Presenter'|'Facilitator'/);
  });
});

describe('one definition of joinable, not two', () => {
  /**
   * Exactly one joinability predicate exists in the codebase, exported from the lifecycle module.
   * S05 consumes it; the moment a second appears the invariant has two homes and they drift.
   */
  it('defines isJoinable once, in the lifecycle module', () => {
    const sources: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) sources.push(path);
      }
    };
    walk(apiSrc);

    const definitions = sources.filter((path) =>
      /function isJoinable\b/.test(withoutComments(readFileSync(path, 'utf8'))),
    );

    expect(definitions.map((path) => path.replace(apiSrc, '').replace(/\\/g, '/'))).toEqual([
      '/conferences/lifecycle.ts',
    ]);
  });

  it('exports both guards for S05 and S09 to import from outside the module (TI10)', async () => {
    const lifecycle = await import('../src/conferences/lifecycle.ts');

    expect(typeof lifecycle.isJoinable).toBe('function');
    expect(typeof lifecycle.isEditable).toBe('function');
    expect(typeof lifecycle.assertEditable).toBe('function');
    expect(typeof lifecycle.earliestArchiveDate).toBe('function');
  });

  /** The end-date half is inside the predicate, so a consumer cannot get state-only semantics. */
  it('tests state and end date in the one predicate', async () => {
    const { isJoinable } = await import('../src/conferences/lifecycle.ts');
    const published = { lifecycleState: 'published' as const, endDate: '2026-09-16' };

    expect(isJoinable(published, '2026-09-16')).toBe(true);
    expect(isJoinable(published, '2026-09-17')).toBe(false);
  });
});

describe('the migration (TI01)', () => {
  const migrations = join(repoRoot, 'db', 'migrations');
  const raw = read(migrations, '20260817120000000_conference.sql');
  const sql = withoutSqlComments(raw);

  /** Plain PostgreSQL only – portability is why PostgreSQL was chosen (ADR-003). */
  it('uses no extension and no provider-specific feature', () => {
    expect(sql).not.toMatch(/create\s+extension/i);
    expect(sql).not.toMatch(/pgcrypto|uuid-ossp|azure|citus|timescale/i);
  });

  it('is reversible – every table it creates is dropped again', () => {
    // Split on the raw file: the direction markers are themselves SQL comments.
    const [up, down] = raw.split(/^-- Down Migration$/m) as [string, string];

    const created = [...up.matchAll(/create table (\w+)/gi)].map((match) => match[1]);
    const dropped = [...down.matchAll(/drop table (\w+)/gi)].map((match) => match[1]);

    expect(created).toEqual(['conference', 'membership', 'role_assignment']);
    expect(new Set(dropped)).toEqual(new Set(created));
  });

  /**
   * Two Conference timestamp columns are coming and they mean different things. This story
   * creates `updated_at` – the row's own version – and must not create the watermark, which is
   * S04's and is deliberately named differently so the two stay distinguishable at a glance.
   */
  it('creates updated_at and not the schedule watermark', () => {
    expect(sql).toMatch(/updated_at\s+timestamptz/);
    expect(sql).not.toMatch(/schedule_watermark_at|last_updated_at/);
  });

  /** Calendar days, not instants: a `timestamptz` here is the day-boundary shift waiting to happen. */
  it('stores the conference dates as plain date columns', () => {
    expect(sql).toMatch(/start_date\s+date\s+NOT NULL/);
    expect(sql).toMatch(/end_date\s+date\s+NOT NULL/);
    expect(sql).not.toMatch(/start_date\s+timestamp|end_date\s+timestamp/i);
  });

  /** Keyed on `sub`, never on email – addresses change and are reissued. */
  it('keys membership and role assignment on the sub claim alone', () => {
    expect(sql).toMatch(/user_sub\s+text\s+NOT NULL REFERENCES app_user \(sub\)/);
    expect(sql).not.toMatch(/email/i);
  });

  /** Three roles. Presenter/Facilitator is one role, and splitting it later costs a migration. */
  it('constrains the role set to the three canonical roles', () => {
    expect(sql).toMatch(/role IN \('Admin', 'PresenterFacilitator', 'Attendee'\)/);
  });

  it('constrains the lifecycle state set in the database', () => {
    expect(sql).toMatch(/lifecycle_state IN \('draft', 'published', 'archived'\)/);
  });

  /**
   * Nothing enforces a single active conference. FR1 expects one at a time in practice but says
   * explicitly that it is not enforced, so a partial unique index here would be a defect.
   */
  it('places no constraint limiting how many conferences may be published', () => {
    expect(sql).not.toMatch(/unique.*lifecycle_state|lifecycle_state.*unique/i);
  });
});

describe('the conference routes are authenticated (TI04)', () => {
  /**
   * S02's route audit refuses startup for any route that is neither wrapped nor on the written
   * anonymous allow-list. Building the app is therefore itself the assertion – but the table it
   * records is checked too, so a route added later cannot be unauthenticated *and* invisible.
   */
  it('registers every conference route through withAuth', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const conferenceRoutes = app.confappRoutes.filter((route) =>
        route.url.startsWith('/api/conferences'),
      );

      expect(conferenceRoutes.length).toBeGreaterThan(0);
      for (const route of conferenceRoutes) {
        expect(route.authenticated, `${route.method} ${route.url}`).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  it('registers the organizer list and leaves /api/me/conferences to S06', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const urls = app.confappRoutes.map((route) => `${route.method} ${route.url}`);

      expect(urls).toContain('POST /api/conferences');
      expect(urls).toContain('GET /api/conferences');
      expect(urls).toContain('GET /api/conferences/:conferenceId');
      expect(urls).toContain('PATCH /api/conferences/:conferenceId');
      expect(urls).toContain('POST /api/conferences/:conferenceId/publish');
      expect(urls).toContain('POST /api/conferences/:conferenceId/archive');

      // The attendee list is a different result set and a different story.
      expect(urls.some((url) => url.includes('/api/me/conferences'))).toBe(false);
    } finally {
      await app.close();
    }
  });
});
