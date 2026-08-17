import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { createDatabase } from '../src/db.ts';
import { createUserRepository } from '../src/auth/users.ts';
import { fakeAuth } from './fake-auth.ts';
import type { VerifiedClaims } from '../src/auth/verify-id-token.ts';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * These run against the composed PostgreSQL, in a database of their own. The migrate-down half
 * of Acceptance Scenario S06 destroys everything it touches, so it must never point at the
 * development database – and never at the volume S08 uses to prove durability.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

async function serverReachable(url: string): Promise<boolean> {
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const reachable = testDatabaseUrl !== undefined && (await serverReachable(testDatabaseUrl));

if (!reachable) {
  // Loud on purpose: a silent skip would look like passing coverage.
  console.warn(
    '\n[integration] SKIPPED – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

/** Runs the real documented migrate command, so the test covers the command, not a copy of it. */
async function migrate(...args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
  return stdout;
}

/** Connects to the server's default database, so the test database itself can be created. */
async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const admin = new URL(testDatabaseUrl!);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

describe.skipIf(!reachable)('migrations against a real PostgreSQL', () => {
  const url = testDatabaseUrl!;

  beforeAll(async () => {
    const name = databaseNameOf(url);
    await withAdmin(async (client) => {
      const existing = await client.query('select 1 from pg_database where datname = $1', [name]);
      if (existing.rowCount === 0) {
        // Identifier cannot be parameterised; the name comes from our own .env, not a request.
        await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      }
    });
    // Start from a known-empty schema regardless of what a previous run left behind.
    await migrate('down', 'all');
  });

  afterAll(async () => {
    await migrate('down', 'all').catch(() => undefined);
  });

  /**
   * Acceptance Scenario S06 – migrations are reversible and leave a working schema after a
   * full down/up cycle.
   */
  it('creates app_meta with the seeded row, reverts it completely, and re-applies', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await migrate('up');
      const seeded = await client.query("select value from app_meta where key = 'schema_version'");
      expect(seeded.rows[0]?.value).toBe('1');

      await migrate('down', 'all');
      const gone = await client.query('select to_regclass($1) as table', ['public.app_meta']);
      expect(gone.rows[0]?.table).toBeNull();

      await migrate('up');
      const again = await client.query("select value from app_meta where key = 'schema_version'");
      expect(again.rows[0]?.value).toBe('1');
    } finally {
      await client.end();
    }
  });

  /**
   * Acceptance Scenario S08 (migration half) – after the first run this is the normal case: a
   * recreated container starts against a volume that already holds the schema. migrate-up must
   * consult the applied-migration record and skip, not fail with a duplicate-object error.
   */
  it('is a no-op against an already-migrated database and leaves existing rows untouched', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await migrate('up');
      await client.query(
        "insert into app_meta (key, value) values ('durability_probe', 'written-before') " +
          'on conflict (key) do update set value = excluded.value',
      );

      const output = await migrate('up');
      expect(output).toMatch(/Nothing to up/i);

      const probe = await client.query("select value from app_meta where key = 'durability_probe'");
      expect(probe.rows[0]?.value).toBe('written-before');
    } finally {
      await client.end();
    }
  });

  /**
   * Acceptance Scenario S01 (data half) – the value the handler returns is the row the
   * migration seeded, read through the real pooled data-access module.
   */
  it('serves GET /api/health from the real database through the real pool', async () => {
    await migrate('up');
    const db = createDatabase(url, { error: () => {} });
    const app = buildApp({ db, auth: fakeAuth() });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json().schemaVersion).toBe('1');
    } finally {
      await app.close();
      await db.close();
    }
  });

  /** Structural Criterion – plain PostgreSQL only, so a pg_dump/restore move stays possible. */
  it('records applied migrations in the database itself', async () => {
    await migrate('up');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const applied = await client.query('select name from pgmigrations order by id');
      expect(applied.rows.map((r) => r.name)).toContain('20260816120000000_app-meta');
      expect(applied.rows.map((r) => r.name)).toContain('20260817090000000_app-user');
    } finally {
      await client.end();
    }
  });

  // ---------- S02: the app_user table (TI02) and the sign-in upsert (TI06) ----------

  function claimsFor(overrides: Partial<VerifiedClaims> = {}): VerifiedClaims {
    return {
      sub: 'google-sub-anna',
      hd: 'ourcompany.example',
      email: 'anna.smith@ourcompany.example',
      displayName: 'Anna Smith',
      nonce: undefined,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    };
  }

  /**
   * TI02 – the constraints are what make `sub` the identity. The unique index on `sub` is the
   * storage-level guarantee; the *absence* of one on email is equally load-bearing and is
   * asserted here so a later story cannot "tidy up" by adding it.
   */
  it('constrains app_user on sub alone, never on email', async () => {
    await migrate('up');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('delete from app_user');

      await client.query('insert into app_user (sub, email, display_name) values ($1, $2, $3)', [
        'sub-one',
        'shared@ourcompany.example',
        'First Person',
      ]);

      // A second row with the same sub is rejected by the database itself.
      await expect(
        client.query('insert into app_user (sub, email, display_name) values ($1, $2, $3)', [
          'sub-one',
          'other@ourcompany.example',
          'Impostor',
        ]),
      ).rejects.toMatchObject({ code: '23505' });

      // Two distinct people who have at some point shared an address both insert. A unique
      // index on email would collide them, which is why there is none.
      await client.query('insert into app_user (sub, email, display_name) values ($1, $2, $3)', [
        'sub-two',
        'shared@ourcompany.example',
        'Second Person',
      ]);

      const both = await client.query('select sub from app_user order by sub');
      expect(both.rows.map((r) => r.sub)).toEqual(['sub-one', 'sub-two']);
    } finally {
      await client.end();
    }
  });

  it('reverts the app_user migration cleanly and re-applies', async () => {
    await migrate('up');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const present = await client.query('select to_regclass($1) as table', ['public.app_user']);
      expect(present.rows[0]?.table).not.toBeNull();

      await migrate('down', '1');
      const gone = await client.query('select to_regclass($1) as table', ['public.app_user']);
      expect(gone.rows[0]?.table).toBeNull();

      await migrate('up');
      const back = await client.query('select to_regclass($1) as table', ['public.app_user']);
      expect(back.rows[0]?.table).not.toBeNull();
    } finally {
      await client.end();
    }
  });

  /**
   * Acceptance Scenario S04 – identity is keyed on `sub`, so a changed email keeps one user,
   * and a different `sub` carrying a recycled address is a different person.
   */
  it('keeps one row when an email changes, and separates a recycled address', async () => {
    await migrate('up');
    const db = createDatabase(url, { error: () => {} });
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('delete from app_user');
      const users = createUserRepository(db);

      const first = await users.upsertFromClaims(claimsFor());
      const renamed = await users.upsertFromClaims(
        claimsFor({ email: 'anna.jones@ourcompany.example', displayName: 'Anna Jones' }),
      );

      // Same row – the surrogate id did not change – with refreshed display data.
      expect(renamed.id).toBe(first.id);
      expect(renamed.email).toBe('anna.jones@ourcompany.example');
      expect(renamed.displayName).toBe('Anna Jones');

      // A different employee whose token carries a different sub but the *old* address.
      const other = await users.upsertFromClaims(
        claimsFor({ sub: 'google-sub-bjorn', email: 'anna.smith@ourcompany.example' }),
      );
      expect(other.id).not.toBe(first.id);

      const rows = await client.query('select sub, email from app_user order by sub');
      expect(rows.rows).toEqual([
        { sub: 'google-sub-anna', email: 'anna.jones@ourcompany.example' },
        { sub: 'google-sub-bjorn', email: 'anna.smith@ourcompany.example' },
      ]);
    } finally {
      await client.end();
      await db.close();
    }
  });

  it('advances last_seen_at on a repeat sign-in without moving created_at', async () => {
    await migrate('up');
    const db = createDatabase(url, { error: () => {} });
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('delete from app_user');
      const users = createUserRepository(db);

      await users.upsertFromClaims(claimsFor());
      const before = await client.query(
        'select created_at, last_seen_at from app_user where sub = $1',
        ['google-sub-anna'],
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      await users.upsertFromClaims(claimsFor());

      const after = await client.query(
        'select created_at, last_seen_at from app_user where sub = $1',
        ['google-sub-anna'],
      );

      expect(after.rows[0].created_at).toEqual(before.rows[0].created_at);
      expect(after.rows[0].last_seen_at.getTime()).toBeGreaterThan(
        before.rows[0].last_seen_at.getTime(),
      );
    } finally {
      await client.end();
      await db.close();
    }
  });
});
