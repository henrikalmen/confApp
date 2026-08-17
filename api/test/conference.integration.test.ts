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
import type { ScheduleGate } from '../src/conferences/schedule-gate.ts';
import { subjectVerifier, tokenFor, unusedCodeExchange } from './fake-auth.ts';
import { stepsToRevertThrough } from './migration-depth.ts';

/**
 * S03's endpoints, against the real PostgreSQL the composed stack runs.
 *
 * The rules these prove are storage-level guarantees – atomic seeding, a date that survives the
 * round trip unchanged, refusals a client cannot bypass – and none of them is provable against a
 * fake that answers whatever the test wants. The verifier *is* stubbed, because who the caller is
 * has already been settled in the S02 suite and the subject here is what that caller may do.
 *
 * Like the other integration suite this runs in a database of its own, never the development one.
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
    '\n[integration] SKIPPED conference lifecycle – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/** The two employees every scenario is written around. */
const IDA = 'google-sub-ida';
const BJORN = 'google-sub-bjorn';

const DETAILS = { name: 'Autumn Kickoff 2026', startDate: '2026-09-14', endDate: '2026-09-16' };

/** A gate whose answer the test states, standing in for S04's Session count. */
function gateReporting(hasSession: boolean): ScheduleGate {
  return {
    async hasAtLeastOneSession() {
      return hasSession;
    },
  };
}

describe.skipIf(!reachable)('conference lifecycle against a real PostgreSQL', () => {
  const url = testDatabaseUrl!;
  let db: Database;
  let client: pg.Client;

  beforeAll(async () => {
    await migrate('up');
    db = createDatabase(url, { error: () => {} });
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await db.close();
  });

  beforeEach(async () => {
    // Conference rows cascade to their memberships and role assignments; app_user rows are
    // recreated by the sign-in upsert on the next request.
    await client.query('delete from conference');
    await client.query('delete from app_user');

    // Both employees have signed in at least once, which is what puts a row in app_user for the
    // foreign keys to reference.
    const users = createUserRepository(db);
    for (const sub of [IDA, BJORN]) {
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

  const apps: FastifyInstance[] = [];

  afterAll(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function appWith(options: { hasSession?: boolean; today?: string } = {}): FastifyInstance {
    const app = buildApp({
      db,
      auth: {
        verifier: subjectVerifier(),
        users: createUserRepository(db),
        codeExchange: unusedCodeExchange(),
      },
      scheduleGate: gateReporting(options.hasSession ?? false),
      clock: fixedClock(options.today ?? '2026-09-15'),
    });
    apps.push(app);
    return app;
  }

  function as(sub: string): { authorization: string } {
    return { authorization: `Bearer ${tokenFor(sub)}` };
  }

  async function createConference(
    app: FastifyInstance,
    sub = IDA,
    details = DETAILS,
  ): Promise<Record<string, string>> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/conferences',
      headers: as(sub),
      payload: details,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  // ---------- Acceptance Scenario S01 (TI01, TI05, TI06) ----------

  describe('creating a conference', () => {
    it('persists it in draft and seeds the creator a Membership and an Admin Role Assignment', async () => {
      const app = appWith();
      const created = await createConference(app);

      expect(created.lifecycleState).toBe('draft');
      expect(created.name).toBe('Autumn Kickoff 2026');

      // Both rows, each keyed on the sub – the creator is a member by a Membership row, never by
      // implication of holding a role.
      const membership = await client.query(
        'select user_sub from membership where conference_id = $1',
        [created.id],
      );
      expect(membership.rows).toEqual([{ user_sub: IDA }]);

      const roles = await client.query(
        'select user_sub, role from role_assignment where conference_id = $1',
        [created.id],
      );
      expect(roles.rows).toEqual([{ user_sub: IDA, role: 'Admin' }]);
    });

    /**
     * The Structural Criterion, checked against the columns themselves: no value anywhere in the
     * three tables is an email address, however convenient it would have been.
     */
    it('writes no email into either key', async () => {
      const app = appWith();
      const created = await createConference(app);

      for (const table of ['membership', 'role_assignment']) {
        const columns = await client.query(
          'select column_name from information_schema.columns where table_name = $1',
          [table],
        );
        expect(columns.rows.map((row) => row.column_name)).not.toContain('email');
      }

      const conference = await client.query('select created_by_sub from conference where id = $1', [
        created.id,
      ]);
      expect(conference.rows[0].created_by_sub).toBe(IDA);
      expect(conference.rows[0].created_by_sub).not.toContain('@');
    });

    /** All three rows or none: a Conference whose creator is not its Admin cannot be administered. */
    it('leaves none of the three rows behind when validation fails', async () => {
      const app = appWith();

      const response = await app.inject({
        method: 'POST',
        url: '/api/conferences',
        headers: as(IDA),
        payload: { ...DETAILS, endDate: '2026-09-18' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('CONFERENCE_DATE_SPAN_INVALID');

      for (const table of ['conference', 'membership', 'role_assignment']) {
        const rows = await client.query(`select count(*)::int as count from ${table}`);
        expect(rows.rows[0].count, table).toBe(0);
      }
    });

    it('lets any signed-in employee create one – no instance permission is consulted', async () => {
      const app = appWith();
      const bjorns = await createConference(app, BJORN, { ...DETAILS, name: 'Bjorn Offsite' });
      expect(bjorns.lifecycleState).toBe('draft');
    });
  });

  // ---------- the date round trip (TI01, Structural Criterion) ----------

  it('round-trips the conference dates through database, API and JSON unchanged', async () => {
    const app = appWith();
    const created = await createConference(app);

    // 1. What the column holds.
    const stored = await client.query(
      'select start_date::text as start_date, end_date::text as end_date from conference where id = $1',
      [created.id],
    );
    expect(stored.rows[0]).toEqual({ start_date: '2026-09-14', end_date: '2026-09-16' });

    // 2. What the create response carried.
    expect(created.startDate).toBe('2026-09-14');
    expect(created.endDate).toBe('2026-09-16');

    // 3. What a later read carries – the boundary where a Date would betray itself, since a
    //    coerced value serialises to an instant rather than to the day it names.
    const read = await app.inject({
      method: 'GET',
      url: `/api/conferences/${created.id}`,
      headers: as(IDA),
    });
    const body = read.json();
    expect(body.startDate).toBe('2026-09-14');
    expect(body.endDate).toBe('2026-09-16');
    expect(JSON.stringify(body)).not.toContain('T00:00:00');
  });

  // ---------- Acceptance Scenario S01 / TI06: the organizer list ----------

  describe('GET /conferences – the organizer list', () => {
    it("includes the creator's own draft and omits another employee's", async () => {
      const app = appWith();
      const idas = await createConference(app);

      const hers = await app.inject({ method: 'GET', url: '/api/conferences', headers: as(IDA) });
      expect(hers.json().conferences.map((c: { id: string }) => c.id)).toEqual([idas.id]);
      expect(hers.json().conferences[0].lifecycleState).toBe('draft');

      // Björn holds no role for it, so it does not appear – and he sees nothing at all.
      const his = await app.inject({ method: 'GET', url: '/api/conferences', headers: as(BJORN) });
      expect(his.json().conferences).toEqual([]);
    });

    it('carries the lifecycle state on every entry so the client can mark archived ones', async () => {
      const app = appWith({ today: '2026-09-17', hasSession: true });
      const conference = await createConference(app);

      const published = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conference.id}/publish`,
        headers: as(IDA),
      });
      expect(published.statusCode).toBe(200);

      const listed = await app.inject({ method: 'GET', url: '/api/conferences', headers: as(IDA) });
      expect(listed.json().conferences[0].lifecycleState).toBe('published');
    });

    /** More than one conference may be published at a time – FR1 says so explicitly. */
    it('allows two conferences to be published concurrently', async () => {
      const app = appWith({ hasSession: true });
      const first = await createConference(app);
      const second = await createConference(app, IDA, { ...DETAILS, name: 'Spring Kickoff 2027' });

      for (const conference of [first, second]) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/conferences/${conference.id}/publish`,
          headers: as(IDA),
        });
        expect(response.statusCode, response.body).toBe(200);
      }

      const states = await client.query('select lifecycle_state from conference');
      expect(states.rows.map((row) => row.lifecycle_state)).toEqual(['published', 'published']);
    });
  });

  // ---------- TI06 / TI07: the row version ----------

  describe('the updatedAt row version', () => {
    it('is returned on the single-conference read, with no watermark field', async () => {
      const app = appWith();
      const created = await createConference(app);

      const read = await app.inject({
        method: 'GET',
        url: `/api/conferences/${created.id}`,
        headers: as(IDA),
      });
      const body = read.json();

      // S09 cannot base an edit on a version it was never sent.
      expect(typeof body.updatedAt).toBe('string');
      expect(body.lastUpdatedAt).toBeUndefined();
      expect(body.scheduleWatermarkAt).toBeUndefined();
    });

    it('advances when the conference is renamed', async () => {
      const app = appWith();
      const created = await createConference(app);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${created.id}`,
        headers: as(IDA),
        payload: { ...DETAILS, name: 'Autumn Kickoff 2026 – revised' },
      });

      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(new Date(renamed.json().updatedAt).getTime()).toBeGreaterThan(
        new Date(created.updatedAt!).getTime(),
      );
    });

    /**
     * The schema half of the "three fields, four consumers" decision: exactly one timestamp
     * column that is a row version, and no watermark. S04 adds the second one, separately named.
     */
    it("is the conference table's only version column – the watermark is S04's", async () => {
      const columns = await client.query(
        "select column_name from information_schema.columns where table_name = 'conference'",
      );
      const names = columns.rows.map((row) => row.column_name);

      expect(names).toContain('updated_at');
      expect(names).not.toContain('schedule_watermark_at');
      expect(names).not.toContain('last_updated_at');
    });
  });

  // ---------- Acceptance Scenario S03 (TI08): the publish gate ----------

  describe('publishing', () => {
    it('is refused while the schedule gate reports zero sessions, and stays draft', async () => {
      const app = appWith({ hasSession: false });
      const created = await createConference(app);

      const response = await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/publish`,
        headers: as(IDA),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFERENCE_SCHEDULE_REQUIRED');
      expect(response.json().error.message).toMatch(/session/i);

      const state = await client.query('select lifecycle_state from conference where id = $1', [
        created.id,
      ]);
      expect(state.rows[0].lifecycle_state).toBe('draft');
    });

    /** The success path, proved against a stubbed gate until S04 binds a real Session count. */
    it('moves the conference to published once the gate reports a session', async () => {
      const app = appWith({ hasSession: true });
      const created = await createConference(app);

      const response = await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/publish`,
        headers: as(IDA),
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().lifecycleState).toBe('published');
    });

    /**
     * The production binding, unstubbed. It answers `false` truthfully – no Session can exist
     * until S04 – so the refusal path holds against the real wiring, not only against a stub.
     */
    it('is refused by the production schedule gate, which reports no session until S04', async () => {
      const app = buildApp({
        db,
        auth: {
          verifier: subjectVerifier(),
          users: createUserRepository(db),
          codeExchange: unusedCodeExchange(),
        },
      });
      apps.push(app);

      const created = await createConference(app);
      const response = await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/publish`,
        headers: as(IDA),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFERENCE_SCHEDULE_REQUIRED');
    });
  });

  // ---------- Acceptance Scenario S04: transitions run one way ----------

  describe('lifecycle transitions', () => {
    it('refuses a return to draft, naming the current and requested states', async () => {
      const app = appWith({ hasSession: true });
      const created = await createConference(app);
      await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/publish`,
        headers: as(IDA),
      });

      // There is no endpoint that moves a conference back to draft, which is the first half of
      // the guarantee: the transition is not merely refused, it is not offered.
      const response = await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/draft`,
        headers: as(IDA),
      });
      expect(response.statusCode).toBe(404);

      // And the second half: publishing again is refused with both states named, so the state
      // machine – not a missing route – is what forbids it.
      const republish = await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/publish`,
        headers: as(IDA),
      });
      expect(republish.statusCode).toBe(409);
      expect(republish.json().error.code).toBe('CONFERENCE_TRANSITION_NOT_PERMITTED');
      expect(republish.json().error.message).toContain('published');

      const state = await client.query('select lifecycle_state from conference where id = $1', [
        created.id,
      ]);
      expect(state.rows[0].lifecycle_state).toBe('published');
    });

    it('refuses every transition out of archived – archived is terminal', async () => {
      const app = appWith({ hasSession: true, today: '2026-09-17' });
      const created = await createConference(app);
      await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/publish`,
        headers: as(IDA),
      });
      await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/archive`,
        headers: as(IDA),
      });

      for (const action of ['publish', 'archive']) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/conferences/${created.id}/${action}`,
          headers: as(IDA),
        });
        expect(response.statusCode, action).toBe(409);
        expect(response.json().error.code).toBe('CONFERENCE_TRANSITION_NOT_PERMITTED');
      }
    });
  });

  // ---------- Acceptance Scenario S05 (TI09): the archive guard ----------

  describe('archiving', () => {
    async function publishedConference(app: FastifyInstance): Promise<Record<string, string>> {
      const created = await createConference(app);
      const published = await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/publish`,
        headers: as(IDA),
      });
      expect(published.statusCode, published.body).toBe(200);
      return created;
    }

    it('is refused before the end date, stating the earliest permitted date', async () => {
      const app = appWith({ hasSession: true, today: '2026-09-15' });
      const created = await publishedConference(app);

      const response = await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/archive`,
        headers: as(IDA),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFERENCE_ARCHIVE_TOO_EARLY');
      expect(response.json().error.message).toContain('2026-09-17');
    });

    it('is refused on the end date itself, because "after" means strictly after', async () => {
      const app = appWith({ hasSession: true, today: '2026-09-16' });
      const created = await publishedConference(app);

      const response = await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/archive`,
        headers: as(IDA),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFERENCE_ARCHIVE_TOO_EARLY');
    });

    it('is refused for a draft whatever the date', async () => {
      const app = appWith({ today: '2027-01-01' });
      const created = await createConference(app);

      const response = await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/archive`,
        headers: as(IDA),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFERENCE_TRANSITION_NOT_PERMITTED');
    });

    it('succeeds the day after the end date', async () => {
      const app = appWith({ hasSession: true, today: '2026-09-17' });
      const created = await publishedConference(app);

      const response = await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/archive`,
        headers: as(IDA),
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().lifecycleState).toBe('archived');
    });
  });

  // ---------- Acceptance Scenario S06: an archived conference stays readable ----------

  describe('an archived conference', () => {
    async function archived(app: FastifyInstance): Promise<Record<string, string>> {
      const created = await createConference(app);
      await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/publish`,
        headers: as(IDA),
      });
      const response = await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/archive`,
        headers: as(IDA),
      });
      expect(response.statusCode, response.body).toBe(200);
      return created;
    }

    it('stays readable and refuses a rename, naming the archived state', async () => {
      const app = appWith({ hasSession: true, today: '2026-09-17' });
      const created = await archived(app);

      const read = await app.inject({
        method: 'GET',
        url: `/api/conferences/${created.id}`,
        headers: as(IDA),
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().lifecycleState).toBe('archived');

      const rename = await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${created.id}`,
        headers: as(IDA),
        payload: { ...DETAILS, name: 'Renamed after the fact' },
      });

      expect(rename.statusCode).toBe(409);
      expect(rename.json().error.code).toBe('CONFERENCE_NOT_EDITABLE');
      expect(rename.json().error.message).toMatch(/archived/i);
    });

    /** Archiving deletes nothing – FR9. The name, the dates and both child rows are untouched. */
    it('keeps its name, dates, memberships and role assignments unchanged', async () => {
      const app = appWith({ hasSession: true, today: '2026-09-17' });
      const created = await archived(app);

      await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${created.id}`,
        headers: as(IDA),
        payload: { ...DETAILS, name: 'Renamed after the fact' },
      });

      const row = await client.query(
        'select name, start_date::text as start_date, end_date::text as end_date, updated_at from conference where id = $1',
        [created.id],
      );
      expect(row.rows[0].name).toBe('Autumn Kickoff 2026');
      expect(row.rows[0].start_date).toBe('2026-09-14');
      expect(row.rows[0].end_date).toBe('2026-09-16');

      const membership = await client.query(
        'select count(*)::int as count from membership where conference_id = $1',
        [created.id],
      );
      expect(membership.rows[0].count).toBe(1);

      const roles = await client.query(
        'select count(*)::int as count from role_assignment where conference_id = $1',
        [created.id],
      );
      expect(roles.rows[0].count).toBe(1);
    });

    /** A refused edit is not a write, so the row version must not move either. */
    it('leaves updatedAt where it was when an edit is refused', async () => {
      const app = appWith({ hasSession: true, today: '2026-09-17' });
      const created = await archived(app);

      const before = await client.query('select updated_at from conference where id = $1', [
        created.id,
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));
      await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${created.id}`,
        headers: as(IDA),
        payload: { ...DETAILS, name: 'Renamed after the fact' },
      });

      const after = await client.query('select updated_at from conference where id = $1', [
        created.id,
      ]);
      expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at);
    });

    /**
     * The joinability guard S05 will consume, asked about the real stored row. Archived is not
     * the only non-joinable state – a published conference that has ended is closed too.
     */
    it('reports as not joinable, as does a published conference past its end date', async () => {
      const { isJoinable } = await import('../src/conferences/lifecycle.ts');
      const app = appWith({ hasSession: true, today: '2026-09-17' });
      const created = await archived(app);

      const row = await client.query(
        'select lifecycle_state, end_date from conference where id = $1',
        [created.id],
      );
      const stored = {
        lifecycleState: row.rows[0].lifecycle_state,
        endDate: row.rows[0].end_date,
      };

      expect(isJoinable(stored, '2026-09-17')).toBe(false);
      // The same conference had it never been archived: still published, but finished.
      expect(isJoinable({ ...stored, lifecycleState: 'published' }, '2026-09-17')).toBe(false);
      expect(isJoinable({ ...stored, lifecycleState: 'published' }, '2026-09-16')).toBe(true);
    });
  });

  // ---------- Acceptance Scenario S07 (TI04): a non-Admin is refused by the server ----------

  describe('a signed-in employee with no role for the conference', () => {
    const ENDPOINTS = [
      { method: 'PATCH' as const, path: '', payload: { ...DETAILS, name: 'Hijacked' } },
      { method: 'POST' as const, path: '/publish' },
      { method: 'POST' as const, path: '/archive' },
    ];

    it('is refused on rename, publish and archive, with no state change', async () => {
      const app = appWith({ hasSession: true, today: '2026-09-17' });
      const created = await createConference(app);

      for (const endpoint of ENDPOINTS) {
        const response = await app.inject({
          method: endpoint.method,
          url: `/api/conferences/${created.id}${endpoint.path}`,
          headers: as(BJORN),
          ...(endpoint.payload ? { payload: endpoint.payload } : {}),
        });

        expect(response.statusCode, `${endpoint.method} ${endpoint.path}`).toBe(403);
        expect(response.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');
      }

      const row = await client.query('select name, lifecycle_state from conference where id = $1', [
        created.id,
      ]);
      expect(row.rows[0]).toEqual({
        name: 'Autumn Kickoff 2026',
        lifecycle_state: 'draft',
      });
    });

    /** The refusal discloses nothing – not the name, not the state, not that the id is real. */
    it('is told nothing about the conference it may not touch', async () => {
      const app = appWith();
      const created = await createConference(app);

      const response = await app.inject({
        method: 'GET',
        url: `/api/conferences/${created.id}`,
        headers: as(BJORN),
      });

      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('Autumn Kickoff 2026');
      expect(response.body).not.toContain('draft');
      expect(response.body).not.toContain('2026-09-14');
    });

    /**
     * An unknown id and someone else's conference answer identically, so the endpoint cannot be
     * used to discover which conferences exist.
     */
    it('cannot tell an unknown conference from one that is not theirs', async () => {
      const app = appWith();
      const created = await createConference(app);
      const unknown = '00000000-0000-4000-8000-000000000000';

      const theirs = await app.inject({
        method: 'GET',
        url: `/api/conferences/${created.id}`,
        headers: as(BJORN),
      });
      const missing = await app.inject({
        method: 'GET',
        url: `/api/conferences/${unknown}`,
        headers: as(BJORN),
      });

      expect(missing.statusCode).toBe(theirs.statusCode);
      expect(missing.json()).toEqual(theirs.json());
    });

    /** S02's wrapper refuses before any handler code runs – no credential, no conference logic. */
    it('is refused before the handler when unauthenticated', async () => {
      const app = appWith();
      const created = await createConference(app);

      const response = await app.inject({
        method: 'POST',
        url: `/api/conferences/${created.id}/publish`,
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('AUTH_CREDENTIAL_MISSING');
    });
  });

  // ---------- TI01: the constraints themselves ----------

  describe('the schema constraints', () => {
    async function conferenceId(): Promise<string> {
      const app = appWith();
      return (await createConference(app)).id!;
    }

    it('rejects a lifecycle state outside the permitted set', async () => {
      const id = await conferenceId();
      await expect(
        client.query('update conference set lifecycle_state = $2 where id = $1', [id, 'cancelled']),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('rejects a role outside the permitted set', async () => {
      const id = await conferenceId();
      await expect(
        client.query(
          'insert into role_assignment (conference_id, user_sub, role) values ($1, $2, $3)',
          [id, BJORN, 'Presenter'],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('rejects a second membership for the same conference and sub', async () => {
      const id = await conferenceId();
      await expect(
        client.query('insert into membership (conference_id, user_sub) values ($1, $2)', [id, IDA]),
      ).rejects.toMatchObject({ code: '23505' });
    });

    /** The storage-level backstop under the API's span validation. */
    it('rejects a span longer than four days written directly', async () => {
      await expect(
        client.query(
          'insert into conference (name, start_date, end_date, created_by_sub) values ($1, $2, $3, $4)',
          ['Too long', '2026-09-14', '2026-09-18', IDA],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('rejects a blank name written directly', async () => {
      await expect(
        client.query(
          'insert into conference (name, start_date, end_date, created_by_sub) values ($1, $2, $3, $4)',
          ['   ', '2026-09-14', '2026-09-16', IDA],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  /** Reversible in both directions, and re-applying leaves a working schema. */
  it('reverts the conference migration cleanly and re-applies', async () => {
    for (const table of ['conference', 'membership', 'role_assignment']) {
      const present = await client.query('select to_regclass($1) as table', [`public.${table}`]);
      expect(present.rows[0].table, table).not.toBeNull();
    }

    const steps = await stepsToRevertThrough(client, '20260817120000000_conference');
    await migrate('down', String(steps));

    for (const table of ['conference', 'membership', 'role_assignment']) {
      const gone = await client.query('select to_regclass($1) as table', [`public.${table}`]);
      expect(gone.rows[0].table, table).toBeNull();
    }

    await migrate('up');

    for (const table of ['conference', 'membership', 'role_assignment']) {
      const back = await client.query('select to_regclass($1) as table', [`public.${table}`]);
      expect(back.rows[0].table, table).not.toBeNull();
    }
  });
});
