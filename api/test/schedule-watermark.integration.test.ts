import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDatabase, type Database } from '../src/db.ts';
import { createUserRepository } from '../src/auth/users.ts';
import { fixedClock } from '../src/conferences/calendar-date.ts';
import { subjectVerifier, tokenFor, unusedCodeExchange } from './fake-auth.ts';

/**
 * S09 TI01 – the watermark poll, against the real PostgreSQL the composed stack runs.
 *
 * Every property this endpoint carries is a storage-level guarantee: that the value advances on a
 * Session **delete** as well as an update, that it does so with no other write to the Conference,
 * and that it is the schedule watermark rather than the Conference row's own version. None of those
 * is provable against a fake, which would simply answer whatever the test wanted. The verifier is
 * stubbed – who the caller is was settled in the S02 suite.
 */

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
  console.warn(
    '\n[integration] SKIPPED schedule watermark – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/** Björn is the Attendee every S09 scenario is written around; Ida organizes. */
const BJORN = 'google-sub-bjorn';
const IDA = 'google-sub-ida';
/** A signed-in employee who joined nothing – the non-member the endpoint must refuse. */
const OUTSIDER = 'google-sub-outsider';

describe.skipIf(!reachable)('the schedule watermark endpoint', () => {
  const url = testDatabaseUrl!;
  let db: Database;
  let client: pg.Client;

  beforeAll(async () => {
    await migrate('up');
    db = createDatabase(url, { error: () => {} });
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  const apps: FastifyInstance[] = [];

  afterAll(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await client.end();
    await db.close();
  });

  beforeEach(async () => {
    await client.query('delete from conference');
    await client.query('delete from app_user');

    const users = createUserRepository(db);
    for (const sub of [BJORN, IDA, OUTSIDER]) {
      await users.upsertFromClaims({
        sub,
        hd: 'ourcompany.example',
        email: `${sub}@ourcompany.example`,
        displayName: sub,
        nonce: undefined,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
    }
  });

  function appWith(today = '2026-09-15', time = '09:40'): FastifyInstance {
    const app = buildApp({
      db,
      auth: {
        verifier: subjectVerifier(),
        users: createUserRepository(db),
        codeExchange: unusedCodeExchange(),
      },
      clock: fixedClock(today, time),
    });
    apps.push(app);
    return app;
  }

  function as(sub: string): { authorization: string } {
    return { authorization: `Bearer ${tokenFor(sub)}` };
  }

  /** "Autumn Offsite", published, with Björn in it and two Sessions on the opening day. */
  async function seedOffsite(state = 'published'): Promise<{ id: string; sessionId: string }> {
    const conferences = await client.query<{ id: string }>(
      `insert into conference (name, start_date, end_date, lifecycle_state, created_by_sub)
       values ('Autumn Offsite', '2026-09-15', '2026-09-17', $1, $2) returning id`,
      [state, IDA],
    );
    const id = conferences.rows[0]!.id;

    for (const sub of [BJORN, IDA]) {
      await client.query('insert into membership (conference_id, user_sub) values ($1, $2)', [
        id,
        sub,
      ]);
    }
    await client.query(
      "insert into role_assignment (conference_id, user_sub, role) values ($1, $2, 'Admin')",
      [id, IDA],
    );

    const sessions = await client.query<{ id: string }>(
      `insert into sessions (conference_id, title, kind, day, start_time, end_time, location)
       values ($1, 'Opening Keynote', 'Presentation', '2026-09-15', '09:00', '10:30', 'Room A'),
              ($1, 'Retrospective', 'Presentation', '2026-09-15', '15:00', '16:00', 'Room A')
       returning id`,
      [id],
    );
    return { id, sessionId: sessions.rows[0]!.id };
  }

  async function watermarkOf(
    app: FastifyInstance,
    conferenceId: string,
    sub = BJORN,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/schedule/watermark`,
      headers: as(sub),
    });
    return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
  }

  // ---------- the response carries two scalars and nothing else ----------

  it('answers with the watermark and the lifecycle state, and no other field', async () => {
    const { id } = await seedOffsite();
    const app = appWith();

    const { statusCode, body } = await watermarkOf(app, id);

    expect(statusCode).toBe(200);
    // An exact key set, not a subset match. The whole point of this endpoint is that it is cheap:
    // a Session list arriving here would make the poll as expensive as the refetch it exists to
    // avoid, and a subset assertion would never notice.
    expect(Object.keys(body).sort()).toEqual(['lastUpdatedAt', 'state']);
    expect(body.state).toBe('published');
    expect(typeof body.lastUpdatedAt).toBe('string');
  });

  it('serves the same value the attendee schedule envelope carries', async () => {
    const { id } = await seedOffsite();
    const app = appWith();

    const envelope = await app.inject({
      method: 'GET',
      url: `/api/conferences/${id}/schedule`,
      headers: as(BJORN),
    });
    const { body } = await watermarkOf(app, id);

    // One watermark, two surfaces. A client compares the polled value against the one on the
    // envelope it is rendering, so a difference in serialization between the two would make every
    // poll look like a change and refetch the schedule forever.
    expect(body.lastUpdatedAt).toBe(
      (envelope.json() as { conference: { lastUpdatedAt: string } }).conference.lastUpdatedAt,
    );
  });

  // ---------- who may poll ----------

  it('refuses a signed-in employee who has not joined the conference', async () => {
    const { id } = await seedOffsite();
    const app = appWith();

    const { statusCode, body } = await watermarkOf(app, id, OUTSIDER);

    expect(statusCode).toBe(403);
    expect((body as unknown as { error: { code: string } }).error.code).toBe('NOT_A_MEMBER');
    // The refusal discloses no watermark: a non-member must not learn that the schedule changed.
    expect(body).not.toHaveProperty('lastUpdatedAt');
  });

  it('refuses a draft exactly as the schedule read does, so the poll cannot outlive its refetch', async () => {
    const { id } = await seedOffsite('draft');
    const app = appWith();

    const polled = await watermarkOf(app, id);
    const read = await app.inject({
      method: 'GET',
      url: `/api/conferences/${id}/schedule`,
      headers: as(BJORN),
    });

    expect(polled.statusCode).toBe(read.statusCode);
    expect((polled.body as unknown as { error: { code: string } }).error.code).toBe(
      (read.json() as { error: { code: string } }).error.code,
    );
  });

  // ---------- the value advances on every kind of schedule change ----------

  it('advances after a Session update, with no other write', async () => {
    const { id, sessionId } = await seedOffsite();
    const app = appWith();

    const before = await watermarkOf(app, id);

    // Written straight to the table: the subject is the column's own behaviour, not the endpoint
    // that happens to change it.
    await client.query("update sessions set location = 'Room B' where id = $1", [sessionId]);

    const after = await watermarkOf(app, id);
    expect((after.body.lastUpdatedAt as string) > (before.body.lastUpdatedAt as string)).toBe(true);
  });

  it('advances after a Session delete, with no other write', async () => {
    const { id, sessionId } = await seedOffsite();
    const app = appWith();

    const before = await watermarkOf(app, id);

    // The delete is the case that matters most and is the easiest to get wrong: it leaves no row
    // behind for a client to notice, so if the watermark did not move, a removed Session would stay
    // on every open Schedule in the room until someone reloaded.
    await client.query('delete from sessions where id = $1', [sessionId]);

    const after = await watermarkOf(app, id);
    expect((after.body.lastUpdatedAt as string) > (before.body.lastUpdatedAt as string)).toBe(true);
  });

  it('is the schedule watermark, not the Conference row version', async () => {
    const { id, sessionId } = await seedOffsite();
    const app = appWith();

    const versionBefore = await client.query<{ updated_at: Date }>(
      'select updated_at from conference where id = $1',
      [id],
    );
    const before = await watermarkOf(app, id);

    await client.query("update sessions set location = 'Room B' where id = $1", [sessionId]);

    const versionAfter = await client.query<{ updated_at: Date }>(
      'select updated_at from conference where id = $1',
      [id],
    );
    const after = await watermarkOf(app, id);

    // The two columns move independently and that is the whole reason there are two of them. A
    // Session write advances the watermark and leaves `updated_at` alone – so polling `updated_at`
    // would miss every schedule change, and using the watermark as an edit precondition would
    // refuse Conference edits that conflict with nothing.
    expect((after.body.lastUpdatedAt as string) > (before.body.lastUpdatedAt as string)).toBe(true);
    expect(versionAfter.rows[0]!.updated_at.toISOString()).toBe(
      versionBefore.rows[0]!.updated_at.toISOString(),
    );
  });
});
