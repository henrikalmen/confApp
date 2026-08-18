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
import { stepsToRevertThrough } from './migration-depth.ts';

/**
 * S04's schedule composition, against the real PostgreSQL the composed stack runs.
 *
 * Every rule proved here is a storage-level guarantee – ordering, the delete invariant, the
 * watermark, the publish gate bound to a real count – and none is provable against a fake that
 * answers whatever the test wants. **The schedule gate is never stubbed in this file**: the whole
 * point of TI11 is that the production binding now counts real Sessions, and a stub would put the
 * one thing under test back behind a fixture.
 *
 * The verifier *is* stubbed, because who the caller is was settled in the S02 suite and the
 * subject here is what that caller may do.
 *
 * Like the other integration suites this runs in a database of its own, never the development one.
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
    '\n[integration] SKIPPED schedule composition – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/** The two employees every scenario is written around, and a third who holds no Admin role. */
const IDA = 'google-sub-ida';
const BJORN = 'google-sub-bjorn';
const CARL = 'google-sub-carl';

/** "Autumn Offsite" spans 2026-09-15 to 2026-09-16 – the Conference the FIS scenarios name. */
const AUTUMN = { name: 'Autumn Offsite', startDate: '2026-09-15', endDate: '2026-09-16' };

const KEYNOTE = {
  title: 'Opening Keynote',
  description: 'How the year went.',
  kind: 'Presentation',
  day: '2026-09-16',
  startTime: '09:00',
  endTime: '10:30',
  location: 'Main Hall',
};

const RETROSPECTIVE = {
  title: 'Retrospective',
  kind: 'Workshop',
  day: '2026-09-16',
  startTime: '15:00',
  endTime: '16:00',
  location: 'Room 2',
};

interface Wire {
  [key: string]: never;
}

describe.skipIf(!reachable)('schedule composition against a real PostgreSQL', () => {
  const url = testDatabaseUrl!;
  let db: Database;
  let client: pg.Client;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    await migrate('up');
    db = createDatabase(url, { error: () => {} });
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await client.end();
    await db.close();
  });

  beforeEach(async () => {
    // Conference rows cascade to sessions, memberships and role assignments.
    await client.query('delete from conference');
    await client.query('delete from app_user');

    const users = createUserRepository(db);
    for (const sub of [IDA, BJORN, CARL]) {
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

  /**
   * The app under test, with the **production** schedule gate. Nothing about the publish path is
   * stubbed anywhere in this file.
   */
  function appWith(today = '2026-09-15'): FastifyInstance {
    const app = buildApp({
      db,
      auth: {
        verifier: subjectVerifier(),
        users: createUserRepository(db),
        codeExchange: unusedCodeExchange(),
      },
      clock: fixedClock(today),
    });
    apps.push(app);
    return app;
  }

  function as(sub: string): { authorization: string } {
    return { authorization: `Bearer ${tokenFor(sub)}` };
  }

  async function createConference(
    app: FastifyInstance,
    details = AUTUMN,
    sub = IDA,
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

  async function addSession(
    app: FastifyInstance,
    conferenceId: string,
    session: Record<string, unknown>,
    sub = IDA,
  ): Promise<Record<string, Wire>> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions`,
      headers: as(sub),
      payload: session,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  /**
   * The base an S09 write carries: the row version the editor loaded, and the Conference's
   * lifecycle state at that moment.
   *
   * Read from the database here rather than threaded through every call site, because these
   * scenarios are about S04's composition rules – the concurrency contract those two values exist
   * for has its own suite, where the *stale* base is the point.
   */
  /**
   * The base a Conference edit carries (S09 TI06): the row's own version and its lifecycle state,
   * read the way a client reads them – from the Conference endpoint itself.
   */
  async function conferenceBase(
    app: FastifyInstance,
    conferenceId: string,
    sub: string,
  ): Promise<{ conferenceState: string; version: string }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}`,
      headers: as(sub),
    });
    const body = response.json();
    return { conferenceState: body.lifecycleState, version: body.updatedAt };
  }

  async function baseFor(sessionId: string): Promise<{ conferenceState: string; version: string }> {
    const rows = await client.query(
      `select to_char(s.last_updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as version,
              c.lifecycle_state as state
         from sessions s join conference c on c.id = s.conference_id
        where s.id = $1`,
      [sessionId],
    );
    return { conferenceState: rows.rows[0].state, version: rows.rows[0].version };
  }

  /** A DELETE carrying the current base, for the scenarios whose subject is not concurrency. */
  async function deleteSession(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    sub = IDA,
  ) {
    const base = await baseFor(sessionId);
    return app.inject({
      method: 'DELETE',
      url:
        `/api/conferences/${conferenceId}/sessions/${sessionId}` +
        `?conferenceState=${base.conferenceState}&version=${encodeURIComponent(base.version)}`,
      headers: as(sub),
    });
  }

  async function organizerSchedule(
    app: FastifyInstance,
    conferenceId: string,
    sub = IDA,
  ): Promise<Record<string, Wire>> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/schedule/organizer`,
      headers: as(sub),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  /** Titles on one day, in the order the payload returned them. */
  function titlesOn(schedule: Record<string, Wire>, day: string): string[] {
    const days = schedule.days as unknown as { day: string; sessions: { title: string }[] }[];
    const found = days.find((entry) => entry.day === day);
    expect(found, `day ${day} should be present in the payload`).toBeDefined();
    return found!.sessions.map((session) => session.title);
  }

  // ---------- Acceptance Scenario S01 (TI01, TI03, TI06, TI09) ----------

  describe('sessions added out of order', () => {
    it('render in start-time order within their conference day, with empty days still present', async () => {
      const app = appWith();
      const conference = await createConference(app);

      // Deliberately the later session first: ordering is derived from the start time, never from
      // insertion order or a hand-set position (FR2).
      await addSession(app, conference.id!, RETROSPECTIVE);
      await addSession(app, conference.id!, KEYNOTE);

      const schedule = await organizerSchedule(app, conference.id!);

      expect(titlesOn(schedule, '2026-09-16')).toEqual(['Opening Keynote', 'Retrospective']);
      // A Conference Day is derived from the span, so the unfilled day is present and empty
      // rather than missing – an Organizer has to see the day they have not composed yet.
      expect(titlesOn(schedule, '2026-09-15')).toEqual([]);

      const days = schedule.days as unknown as { day: string }[];
      expect(days.map((entry) => entry.day)).toEqual(['2026-09-15', '2026-09-16']);
    });

    it('orders by start time across a whole day, not by title or insertion', async () => {
      const app = appWith();
      const conference = await createConference(app);

      for (const startTime of ['15:00', '09:00', '11:30']) {
        await addSession(app, conference.id!, {
          ...KEYNOTE,
          title: `Session at ${startTime}`,
          startTime,
          endTime: '23:00',
        });
      }

      expect(titlesOn(await organizerSchedule(app, conference.id!), '2026-09-16')).toEqual([
        'Session at 09:00',
        'Session at 11:30',
        'Session at 15:00',
      ]);
    });
  });

  /**
   * Discovered Requirement (see the FIS's Implementation Observations): a Session can end up
   * outside the Conference's current span. It still exists and still counts, so hiding it from the
   * Organizer would remove the only surface that could move or delete it.
   *
   * **The way in has since closed.** S03 left the dates shortenable past a Session and handed
   * refusing it to S09, which now does (S09 TI07) – so the span is shortened here by writing the
   * column directly rather than through the endpoint, which would be refused. The Organizer view's
   * tolerance of the state is what this asserts, and it stays worth asserting: the rows can still
   * be reached this way, and a view that dropped them would strand them permanently.
   */
  it('still lists a session whose day falls outside the shortened conference span', async () => {
    const app = appWith();
    const conference = await createConference(app, {
      name: 'Autumn Offsite',
      startDate: '2026-09-15',
      endDate: '2026-09-18',
    });
    await addSession(app, conference.id!, { ...KEYNOTE, day: '2026-09-18' });

    await client.query("update conference set end_date = '2026-09-16' where id = $1", [
      conference.id,
    ]);

    const schedule = await organizerSchedule(app, conference.id!);
    const days = schedule.days as unknown as { day: string; sessions: { title: string }[] }[];

    // Both days of the new span are present, and so is the orphaned one – in date order.
    expect(days.map((entry) => entry.day)).toEqual(['2026-09-15', '2026-09-16', '2026-09-18']);
    expect(titlesOn(schedule, '2026-09-18')).toEqual(['Opening Keynote']);

    // And it is still a real session: the publish gate counts it.
    const published = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conference.id}/publish`,
      headers: as(IDA),
    });
    expect(published.statusCode, published.body).toBe(200);
  });

  // ---------- Acceptance Scenario S02 (TI03, TI04, TI06, TI09) ----------

  it('moves an edited session to another conference day and re-sorts it there', async () => {
    const app = appWith();
    const conference = await createConference(app);

    await addSession(app, conference.id!, KEYNOTE);
    const retro = await addSession(app, conference.id!, RETROSPECTIVE);
    const retroId = (retro.session as unknown as { id: string }).id;

    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/conferences/${conference.id}/sessions/${retroId}`,
      headers: as(IDA),
      payload: {
        ...RETROSPECTIVE,
        day: '2026-09-15',
        startTime: '08:00',
        endTime: '09:00',
        base: await baseFor(retroId),
      },
    });
    expect(moved.statusCode, moved.body).toBe(200);

    const schedule = await organizerSchedule(app, conference.id!);
    expect(titlesOn(schedule, '2026-09-15')).toEqual(['Retrospective']);
    expect(titlesOn(schedule, '2026-09-16')).toEqual(['Opening Keynote']);
  });

  // ---------- Acceptance Scenario S03 (TI05) ----------

  describe('deleting the last remaining session of a published conference', () => {
    /** Publishing needs a real Session now, so this helper also proves TI11 incidentally. */
    async function publishedWithKeynote(
      app: FastifyInstance,
    ): Promise<{ conferenceId: string; sessionId: string }> {
      const conference = await createConference(app);
      const created = await addSession(app, conference.id!, KEYNOTE);

      const published = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conference.id}/publish`,
        headers: as(IDA),
      });
      expect(published.statusCode, published.body).toBe(200);

      return {
        conferenceId: conference.id!,
        sessionId: (created.session as unknown as { id: string }).id,
      };
    }

    it('is refused, the session survives, and the same delete succeeds once a second exists', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await publishedWithKeynote(app);

      const refused = await deleteSession(app, conferenceId, sessionId);

      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('SESSION_LAST_IN_PUBLISHED_CONFERENCE');
      expect(refused.json().error.message).toMatch(/at least one session/i);

      // Not merely reported as refused – the row is still there.
      const surviving = await client.query('select count(*)::int as count from sessions');
      expect(surviving.rows[0].count).toBe(1);

      await addSession(app, conferenceId, RETROSPECTIVE);

      const accepted = await deleteSession(app, conferenceId, sessionId);
      expect(accepted.statusCode, accepted.body).toBe(200);

      const remaining = await client.query('select title from sessions');
      expect(remaining.rows.map((row) => row.title)).toEqual(['Retrospective']);
    });

    /** A draft has no attendees to leave without a schedule; it is gated at publish instead. */
    it('is permitted for the sole session of a draft conference', async () => {
      const app = appWith();
      const conference = await createConference(app);
      const created = await addSession(app, conference.id!, KEYNOTE);
      const sessionId = (created.session as unknown as { id: string }).id;

      const response = await deleteSession(app, conference.id!, sessionId);

      expect(response.statusCode, response.body).toBe(200);
      const rows = await client.query('select count(*)::int as count from sessions');
      expect(rows.rows[0].count).toBe(0);
    });

    /**
     * The invariant TI11 depends on, stated end to end: a published Conference cannot be emptied,
     * so it can never fail the gate it already passed.
     */
    it('keeps a published conference publishable-by-construction – it can never reach zero', async () => {
      const app = appWith();
      const { conferenceId } = await publishedWithKeynote(app);

      const sessions = await client.query('select id from sessions where conference_id = $1', [
        conferenceId,
      ]);
      for (const row of sessions.rows) {
        await deleteSession(app, conferenceId, row.id);
      }

      const remaining = await client.query(
        'select count(*)::int as count from sessions where conference_id = $1',
        [conferenceId],
      );
      expect(remaining.rows[0].count).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------- Acceptance Scenario S04 (TI01, TI04) ----------

  describe('a session whose end time is not after its start time', () => {
    it('is refused for a midnight-spanning session and for a zero-length one, persisting nothing', async () => {
      const app = appWith();
      const conference = await createConference(app);

      for (const times of [
        { day: '2026-09-15', startTime: '23:15', endTime: '00:45' },
        { day: '2026-09-15', startTime: '10:00', endTime: '10:00' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/conferences/${conference.id}/sessions`,
          headers: as(IDA),
          payload: { ...KEYNOTE, ...times },
        });

        expect(response.statusCode, JSON.stringify(times)).toBe(400);
        expect(response.json().error.code).toBe('SESSION_TIME_RANGE_INVALID');
        expect(response.json().error.message).toMatch(
          /after its start time on the same conference day/i,
        );
      }

      const rows = await client.query('select count(*)::int as count from sessions');
      expect(rows.rows[0].count).toBe(0);
    });

    /** The storage-level backstop under the API's rule. */
    it('is rejected by the database even when written directly', async () => {
      const app = appWith();
      const conference = await createConference(app);

      await expect(
        client.query(
          `insert into sessions (conference_id, title, kind, day, start_time, end_time, location)
           values ($1, 'Direct', 'Presentation', '2026-09-15', '10:00', '10:00', 'Main Hall')`,
          [conference.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  // ---------- Acceptance Scenario S05 (TI04) ----------

  it('refuses a session placed outside the conference date span, naming the valid days', async () => {
    const app = appWith();
    const conference = await createConference(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conference.id}/sessions`,
      headers: as(IDA),
      payload: { ...KEYNOTE, day: '2026-09-17' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('SESSION_DAY_OUT_OF_SPAN');
    expect(response.json().error.message).toContain('2026-09-15');
    expect(response.json().error.message).toContain('2026-09-16');
    // The envelope carries the field too, so the form can attach it to the day input.
    expect(response.json().error.details).toEqual([
      { field: 'day', message: response.json().error.message },
    ]);

    const rows = await client.query('select count(*)::int as count from sessions');
    expect(rows.rows[0].count).toBe(0);
  });

  // ---------- Acceptance Scenario S07 (TI07, TI09) ----------

  describe('overlapping sessions', () => {
    it('save successfully with a non-blocking warning, and stay marked on a fresh read by another admin', async () => {
      const app = appWith();
      const conference = await createConference(app);

      // Björn is made an Admin too, so the reload can genuinely be "a different Admin".
      await client.query(
        "insert into role_assignment (conference_id, user_sub, role) values ($1, $2, 'Admin')",
        [conference.id, BJORN],
      );
      await client.query('insert into membership (conference_id, user_sub) values ($1, $2)', [
        conference.id,
        BJORN,
      ]);

      const keynote = await addSession(app, conference.id!, { ...KEYNOTE, day: '2026-09-15' });

      const workshop = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conference.id}/sessions`,
        headers: as(IDA),
        payload: {
          title: 'Design Workshop',
          kind: 'Workshop',
          day: '2026-09-15',
          startTime: '10:00',
          endTime: '11:00',
          location: 'Room 2',
        },
      });

      // Saved, not refused – Parallel Tracks are a supported option.
      expect(workshop.statusCode, workshop.body).toBe(200);
      const warning = workshop.json().overlapWarning;
      expect(warning).not.toBeNull();
      expect(warning.message).toContain('Opening Keynote');
      expect(warning.sessions.map((session: { title: string }) => session.title)).toEqual([
        'Opening Keynote',
      ]);

      const keynoteId = (keynote.session as unknown as { id: string }).id;
      const workshopId = workshop.json().session.id;

      /*
       * The persistent indicator: a fresh read, by a different Admin, with no prior save in that
       * caller's session. A save-time toast alone would not survive this, and the pre-publish
       * "review overlap warnings" step depends on it doing so.
       */
      const reloaded = await organizerSchedule(app, conference.id!, BJORN);
      const pairs = reloaded.overlaps as unknown as { sessionIds: [string, string] }[];

      expect(pairs).toHaveLength(1);
      expect(new Set(pairs[0]!.sessionIds)).toEqual(new Set([keynoteId, workshopId]));
    });

    it('reports no pair for back-to-back sessions', async () => {
      const app = appWith();
      const conference = await createConference(app);

      await addSession(app, conference.id!, {
        ...KEYNOTE,
        day: '2026-09-15',
        startTime: '09:00',
        endTime: '10:00',
      });
      const second = await addSession(app, conference.id!, {
        ...RETROSPECTIVE,
        day: '2026-09-15',
        startTime: '10:00',
        endTime: '11:00',
      });

      expect(second.overlapWarning).toBeNull();
      expect((await organizerSchedule(app, conference.id!)).overlaps).toEqual([]);
    });
  });

  // ---------- Acceptance Scenario S08 (TI11): the publish gate, unstubbed ----------

  describe("S03's publish gate, bound to the real session count", () => {
    it('refuses a draft with no sessions, then publishes it once it has a real one', async () => {
      const app = appWith();
      const conference = await createConference(app);

      const refused = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conference.id}/publish`,
        headers: as(IDA),
      });

      // S03's message and S03's code, unchanged – only the implementation behind the port is new.
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('CONFERENCE_SCHEDULE_REQUIRED');
      expect(refused.json().error.message).toMatch(/schedule is empty/i);

      const stillDraft = await client.query(
        'select lifecycle_state from conference where id = $1',
        [conference.id],
      );
      expect(stillDraft.rows[0].lifecycle_state).toBe('draft');

      await addSession(app, conference.id!, { ...KEYNOTE, day: '2026-09-15' });

      const published = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conference.id}/publish`,
        headers: as(IDA),
      });

      expect(published.statusCode, published.body).toBe(200);
      expect(published.json().lifecycleState).toBe('published');

      const state = await client.query('select lifecycle_state from conference where id = $1', [
        conference.id,
      ]);
      expect(state.rows[0].lifecycle_state).toBe('published');
    });

    /** The gate counts *this* Conference's sessions, not any session anywhere. */
    it("is not satisfied by another conference's sessions", async () => {
      const app = appWith();
      const withSessions = await createConference(app);
      await addSession(app, withSessions.id!, { ...KEYNOTE, day: '2026-09-15' });

      const empty = await createConference(app, { ...AUTUMN, name: 'Spring Offsite' });
      const response = await app.inject({
        method: 'POST',
        url: `/api/conferences/${empty.id}/publish`,
        headers: as(IDA),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFERENCE_SCHEDULE_REQUIRED');
    });
  });

  // ---------- Acceptance Scenario S09 (TI02): the watermark and the row version ----------

  describe('the schedule watermark and the conference row version', () => {
    const STAMPS = `
      select to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
             to_char(schedule_watermark_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as watermark
        from conference where id = $1
    `;

    async function stamps(
      conferenceId: string,
    ): Promise<{ updated_at: string; watermark: string }> {
      const rows = await client.query(STAMPS, [conferenceId]);
      return rows.rows[0];
    }

    /**
     * Read straight from the columns rather than inferred from a payload: `updated_at` is S03's
     * field and is deliberately not on this story's wire shape, so an API-level assertion could
     * not see it move (FIS → Testing Strategy).
     */
    it('advances the watermark on every session write – insert, update and delete alike', async () => {
      const app = appWith();
      const conference = await createConference(app);
      const created = await addSession(app, conference.id!, KEYNOTE);
      const sessionId = (created.session as unknown as { id: string }).id;

      const afterInsert = await stamps(conference.id!);

      await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${conference.id}/sessions/${sessionId}`,
        headers: as(IDA),
        payload: {
          ...KEYNOTE,
          title: 'Opening Keynote, revised',
          base: await baseFor(sessionId),
        },
      });
      const afterUpdate = await stamps(conference.id!);
      expect(afterUpdate.watermark > afterInsert.watermark).toBe(true);

      // The delete is the one that gets forgotten, and the one S10's offline diff needs most:
      // without it a removed Session lingers in a cache forever.
      await deleteSession(app, conference.id!, sessionId);
      const afterDelete = await stamps(conference.id!);
      expect(afterDelete.watermark > afterUpdate.watermark).toBe(true);
    });

    /** The assertion that fails if a session write bumps S03's row version. */
    it('leaves conference.updated_at byte-identical across every session write', async () => {
      const app = appWith();
      const conference = await createConference(app);

      const before = await stamps(conference.id!);

      const created = await addSession(app, conference.id!, KEYNOTE);
      const sessionId = (created.session as unknown as { id: string }).id;
      await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${conference.id}/sessions/${sessionId}`,
        headers: as(IDA),
        payload: { ...KEYNOTE, title: 'Opening Keynote, revised' },
      });
      await app.inject({
        method: 'DELETE',
        url: `/api/conferences/${conference.id}/sessions/${sessionId}`,
        headers: as(IDA),
      });

      const after = await stamps(conference.id!);
      expect(after.updated_at).toBe(before.updated_at);
      // …while the watermark did move, so the two are demonstrably independent.
      expect(after.watermark > before.watermark).toBe(true);
    });

    it('advances updated_at only when a conference field itself changes', async () => {
      const app = appWith();
      const conference = await createConference(app);
      await addSession(app, conference.id!, KEYNOTE);

      const beforeRename = await stamps(conference.id!);

      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${conference.id}`,
        headers: as(IDA),
        payload: {
          ...AUTUMN,
          name: 'Autumn Offsite – revised',
          base: await conferenceBase(app, conference.id!, IDA),
        },
      });
      expect(renamed.statusCode, renamed.body).toBe(200);

      const afterRename = await stamps(conference.id!);
      expect(afterRename.updated_at > beforeRename.updated_at).toBe(true);
      // A conference-field change is a schedule change too, so the watermark advances as well.
      expect(afterRename.watermark > beforeRename.watermark).toBe(true);
    });
  });

  // ---------- TI03: authentication, authorization and the lifecycle guard ----------

  describe('the session write endpoints', () => {
    async function conferenceWithSession(
      app: FastifyInstance,
    ): Promise<{ conferenceId: string; sessionId: string }> {
      const conference = await createConference(app);
      const created = await addSession(app, conference.id!, KEYNOTE);
      return {
        conferenceId: conference.id!,
        sessionId: (created.session as unknown as { id: string }).id,
      };
    }

    it('reject an unauthenticated request before any handler logic runs', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await conferenceWithSession(app);

      for (const request of [
        {
          method: 'POST' as const,
          url: `/api/conferences/${conferenceId}/sessions`,
          payload: KEYNOTE,
        },
        {
          method: 'PATCH' as const,
          url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
          payload: KEYNOTE,
        },
        {
          method: 'DELETE' as const,
          url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
        },
        {
          method: 'GET' as const,
          url: `/api/conferences/${conferenceId}/schedule/organizer`,
        },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(401);
        expect(response.json().error.code).toBe('AUTH_CREDENTIAL_MISSING');
      }

      // Nothing was written by any of them.
      const rows = await client.query('select count(*)::int as count from sessions');
      expect(rows.rows[0].count).toBe(1);
    });

    it('refuse a signed-in employee who holds no role in the conference', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await conferenceWithSession(app);

      for (const request of [
        {
          method: 'POST' as const,
          url: `/api/conferences/${conferenceId}/sessions`,
          payload: RETROSPECTIVE,
        },
        {
          method: 'PATCH' as const,
          url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
          payload: KEYNOTE,
        },
        {
          method: 'DELETE' as const,
          url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
        },
        { method: 'GET' as const, url: `/api/conferences/${conferenceId}/schedule/organizer` },
      ]) {
        const response = await app.inject({ ...request, headers: as(BJORN) });
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
        expect(response.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');
      }
    });

    /** TI06: the organizer route is Admin-only – a member without that role is refused too. */
    it('refuse a member of the conference who is not an Admin on the organizer route', async () => {
      const app = appWith();
      const { conferenceId } = await conferenceWithSession(app);

      // Carl is a member and an Attendee – in the conference, but not composing its schedule.
      await client.query('insert into membership (conference_id, user_sub) values ($1, $2)', [
        conferenceId,
        CARL,
      ]);

      const response = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/schedule/organizer`,
        headers: as(CARL),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');
    });

    it('refuse every write on an archived conference, naming the reason, but still serve the read', async () => {
      const app = appWith('2026-09-17');
      const { conferenceId, sessionId } = await conferenceWithSession(app);

      for (const action of ['publish', 'archive']) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/conferences/${conferenceId}/${action}`,
          headers: as(IDA),
        });
        expect(response.statusCode, action).toBe(200);
      }

      /*
       * Each write carries a *current* base, so what refuses it is the archived guard and not a
       * stale-version or missing-base check. The point of this scenario is that an archived
       * conference is closed to writes even when the caller's view of it is perfectly fresh.
       */
      const base = await baseFor(sessionId);

      for (const request of [
        {
          method: 'POST' as const,
          url: `/api/conferences/${conferenceId}/sessions`,
          payload: RETROSPECTIVE,
        },
        {
          method: 'PATCH' as const,
          url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
          payload: { ...KEYNOTE, base },
        },
        {
          method: 'DELETE' as const,
          url:
            `/api/conferences/${conferenceId}/sessions/${sessionId}` +
            `?conferenceState=${base.conferenceState}&version=${encodeURIComponent(base.version)}`,
        },
      ]) {
        const response = await app.inject({ ...request, headers: as(IDA) });
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(409);
        expect(response.json().error.code).toBe('CONFERENCE_NOT_EDITABLE');
        expect(response.json().error.message).toMatch(/archived/i);
      }

      // Archiving makes a conference read-only, not invisible (FR9).
      const schedule = await organizerSchedule(app, conferenceId);
      expect(titlesOn(schedule, '2026-09-16')).toEqual(['Opening Keynote']);
    });

    /**
     * A session id that does not exist is answered as such, even when the conference is published
     * and holds exactly one session. Answering the sole-session refusal instead would be a
     * refusal about a different session, with advice that would not help.
     */
    it('answer SESSION_NOT_FOUND for an unknown session before the last-session rule', async () => {
      const app = appWith();
      const conference = await createConference(app);
      await addSession(app, conference.id!, { ...KEYNOTE, day: '2026-09-15' });
      const published = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conference.id}/publish`,
        headers: as(IDA),
      });
      expect(published.statusCode, published.body).toBe(200);

      // A base is carried so the refusal is about the session id, not about a missing base.
      const response = await app.inject({
        method: 'DELETE',
        url:
          `/api/conferences/${conference.id}/sessions/00000000-0000-4000-8000-000000000000` +
          '?conferenceState=published&version=2026-09-15T09:00:00.000000Z',
        headers: as(IDA),
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('SESSION_NOT_FOUND');
    });

    it("refuse to edit a session through another conference's route", async () => {
      const app = appWith();
      const { sessionId } = await conferenceWithSession(app);
      const other = await createConference(app, { ...AUTUMN, name: 'Spring Offsite' });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${other.id}/sessions/${sessionId}`,
        headers: as(IDA),
        payload: { ...KEYNOTE, base: await baseFor(sessionId) },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('SESSION_NOT_FOUND');
    });
  });

  // ---------- TI08 / TI02: the two wire representations, at the boundary ----------

  describe('the payload the organizer route returns', () => {
    /**
     * Structural Criterion: the driver hands `date` and `time` back as strings, never as JS
     * `Date`s. Asserted against a raw driver read rather than the API's own projection, because
     * the projection casts the values anyway – it is the *driver default* that has to be right,
     * or the next story's plain `select *` reintroduces the coercion.
     */
    it('reads day and time columns out of the driver as strings, not Date objects', async () => {
      const app = appWith();
      const conference = await createConference(app);
      await addSession(app, conference.id!, KEYNOTE);

      const rows = await db.query<Record<string, unknown>>(
        'select day, start_time, end_time from sessions where conference_id = $1',
        [conference.id],
      );
      const row = rows[0]!;

      for (const column of ['day', 'start_time', 'end_time']) {
        expect(typeof row[column], column).toBe('string');
        expect(row[column] instanceof Date, `${column} arrived as a Date`).toBe(false);
      }
      expect(row.day).toBe('2026-09-16');
      expect(row.start_time).toBe('09:00:00');
    });

    /**
     * Structural Criterion: `conference.lastUpdatedAt` on the wire is the **watermark**, not S03's
     * row version. The two are asserted to differ, so the test would fail if someone serialized
     * the wrong column – which is exactly the mistake two near-identically-purposed timestamps
     * invite, and the reason they were given unalike names.
     */
    it('serializes conference.lastUpdatedAt from the watermark and never from updated_at', async () => {
      const app = appWith();
      const conference = await createConference(app);
      await addSession(app, conference.id!, KEYNOTE);

      const stored = await client.query(
        `select to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
                to_char(schedule_watermark_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as watermark
           from conference where id = $1`,
        [conference.id],
      );
      const { updated_at: updatedAt, watermark } = stored.rows[0];

      // The session insert moved one and not the other, so they are distinguishable here.
      expect(watermark).not.toBe(updatedAt);

      const schedule = await organizerSchedule(app, conference.id!);
      const wire = schedule.conference as unknown as { lastUpdatedAt: string };

      expect(wire.lastUpdatedAt).toBe(watermark);
      expect(wire.lastUpdatedAt).not.toBe(updatedAt);
    });

    /** Each Session carries its own row version, at full precision, for S09 to base an edit on. */
    it("carries each session's own lastUpdatedAt at microsecond precision", async () => {
      const app = appWith();
      const conference = await createConference(app);
      await addSession(app, conference.id!, KEYNOTE);

      const schedule = await organizerSchedule(app, conference.id!);
      const days = schedule.days as unknown as { sessions: { lastUpdatedAt: string }[] }[];
      const session = days.flatMap((entry) => entry.sessions)[0]!;

      expect(session.lastUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    });
  });

  // ---------- TI01: reversibility ----------

  it('reverts the session migration cleanly and re-applies', async () => {
    const present = await client.query("select to_regclass('public.sessions') as table");
    expect(present.rows[0].table).not.toBeNull();

    const steps = await stepsToRevertThrough(client, '20260817150000000_session');
    await migrate('down', String(steps));

    const gone = await client.query("select to_regclass('public.sessions') as table");
    expect(gone.rows[0].table).toBeNull();

    // The watermark column and the triggers go with it – a down step that left them would leave
    // the conference table carrying half of S04.
    const columns = await client.query(
      "select column_name from information_schema.columns where table_name = 'conference'",
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('schedule_watermark_at');

    await migrate('up');

    const back = await client.query("select to_regclass('public.sessions') as table");
    expect(back.rows[0].table).not.toBeNull();
  });
});
