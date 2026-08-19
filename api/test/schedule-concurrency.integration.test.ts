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
 * S09 TI04 and TI05 – two Admins editing at once, and a lifecycle transition landing mid-edit.
 *
 * Driven with two genuinely distinct base values throughout, never a stubbed comparison (FIS →
 * Testing Strategy). A test that mocked the version check would pass against an implementation that
 * re-parsed the timestamp through a `Date` and truncated it to milliseconds – which is exactly how
 * last-write-wins comes back for the two saves most likely to land in the same millisecond, the
 * concurrent ones. Here both values come from the real column at full precision.
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
    '\n[integration] SKIPPED schedule concurrency – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/** Ida and Björn are the two Admins every concurrency scenario in the FIS is written around. */
const IDA = 'google-sub-ida';
const BJORN = 'google-sub-bjorn';

const KEYNOTE = {
  title: 'Opening Keynote',
  description: null,
  kind: 'Presentation',
  day: '2026-09-15',
  startTime: '09:00',
  endTime: '10:30',
  location: 'Room A',
};

interface Wire {
  id: string;
  lastUpdatedAt: string;
  startTime: string;
  location: string;
}

describe.skipIf(!reachable)('live schedule editing', () => {
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

  function appWith(today = '2026-09-15'): FastifyInstance {
    const app = buildApp({
      db,
      auth: {
        verifier: subjectVerifier(),
        users: createUserRepository(db),
        codeExchange: unusedCodeExchange(),
      },
      clock: fixedClock(today, '09:40'),
    });
    apps.push(app);
    return app;
  }

  function as(sub: string): { authorization: string } {
    return { authorization: `Bearer ${tokenFor(sub)}` };
  }

  /**
   * "Autumn Offsite" with one Session, both Admins in it, in the requested lifecycle state.
   *
   * Seeded directly so a scenario can *state* that the Conference is published rather than driving
   * it there through three endpoints that are not what it is about.
   */
  async function seed(state = 'published'): Promise<{ conferenceId: string; sessionId: string }> {
    const conferences = await client.query<{ id: string }>(
      `insert into conference (name, start_date, end_date, lifecycle_state, created_by_sub)
       values ('Autumn Offsite', '2026-09-15', '2026-09-17', $1, $2) returning id`,
      [state, IDA],
    );
    const conferenceId = conferences.rows[0]!.id;

    for (const sub of [IDA, BJORN]) {
      await client.query('insert into membership (conference_id, user_sub) values ($1, $2)', [
        conferenceId,
        sub,
      ]);
      await client.query(
        "insert into role_assignment (conference_id, user_sub, role) values ($1, $2, 'Admin')",
        [conferenceId, sub],
      );
    }

    const sessions = await client.query<{ id: string }>(
      `insert into sessions (conference_id, title, kind, day, start_time, end_time, location)
       values ($1, 'Opening Keynote', 'Presentation', '2026-09-15', '09:00', '10:30', 'Room A'),
              ($1, 'Retrospective', 'Presentation', '2026-09-15', '15:00', '16:00', 'Room A')
       returning id`,
      [conferenceId],
    );
    return { conferenceId, sessionId: sessions.rows[0]!.id };
  }

  /** What an editor holds after opening a Session: its row version and the Conference's state. */
  async function openForEditing(
    conferenceId: string,
    sessionId: string,
  ): Promise<{ conferenceState: string; version: string }> {
    const rows = await client.query(
      `select to_char(s.last_updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as version,
              c.lifecycle_state as state
         from sessions s join conference c on c.id = s.conference_id
        where s.id = $1 and s.conference_id = $2`,
      [sessionId, conferenceId],
    );
    return { conferenceState: rows.rows[0].state, version: rows.rows[0].version };
  }

  function save(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    sub: string,
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'PATCH',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
      headers: as(sub),
      payload,
    });
  }

  async function sessionRow(sessionId: string): Promise<{ start_time: string; location: string }> {
    const rows = await client.query(
      `select to_char(start_time, 'HH24:MI') as start_time, location
         from sessions where id = $1`,
      [sessionId],
    );
    return rows.rows[0];
  }

  // ---------- Acceptance Scenario S03: two admins, one session ----------

  describe('saving a session against a base value that has moved', () => {
    it('is refused, persists nothing, and returns the version to re-apply onto', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await seed();

      // Both open the same Session, so both hold the identical base value.
      const idasBase = await openForEditing(conferenceId, sessionId);
      const bjornsBase = await openForEditing(conferenceId, sessionId);
      expect(bjornsBase.version).toBe(idasBase.version);

      // Ida saves first, moving the start time.
      const idaSaves = await save(app, conferenceId, sessionId, IDA, {
        ...KEYNOTE,
        startTime: '09:30',
        base: idasBase,
      });
      expect(idaSaves.statusCode, idaSaves.body).toBe(200);

      // Björn saves a location change against the base he opened with, which has since moved.
      const bjornSaves = await save(app, conferenceId, sessionId, BJORN, {
        ...KEYNOTE,
        location: 'Room C',
        base: bjornsBase,
      });

      expect(bjornSaves.statusCode).toBe(409);
      expect(bjornSaves.json().error.code).toBe('EDIT_VERSION_CONFLICT');
      // A displayable sentence, not a code the organizer has to look up.
      expect(bjornSaves.json().error.message).toMatch(/changed since you opened it/i);

      // Nothing of Björn's edit reached the row, and Ida's change stands untouched.
      const row = await sessionRow(sessionId);
      expect(row.start_time).toBe('09:30');
      expect(row.location).toBe('Room A');

      // The current version travels with the refusal, so the edit is re-applicable rather than
      // retypable: Björn is shown 09:30, which is what he must not overwrite.
      const current = bjornSaves.json().error.current as Wire;
      expect(current.startTime).toBe('09:30');
      expect(current.lastUpdatedAt).not.toBe(bjornsBase.version);

      // Re-applying "Room C" on top of the version he was handed succeeds, and keeps Ida's 09:30.
      const reapplied = await save(app, conferenceId, sessionId, BJORN, {
        ...KEYNOTE,
        startTime: '09:30',
        location: 'Room C',
        base: { conferenceState: bjornsBase.conferenceState, version: current.lastUpdatedAt },
      });
      expect(reapplied.statusCode, reapplied.body).toBe(200);

      const settled = await sessionRow(sessionId);
      expect(settled.start_time).toBe('09:30');
      expect(settled.location).toBe('Room C');
    });

    it('refuses a write carrying no base at all, rather than treating it as a force-write', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await seed();

      const response = await save(app, conferenceId, sessionId, IDA, {
        ...KEYNOTE,
        location: 'Room Z',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toMatch(/which version it was based on/i);

      // The absence of a base must not be a way to win: the row is untouched.
      expect((await sessionRow(sessionId)).location).toBe('Room A');
    });

    it('compares the base exactly, so two versions inside one millisecond stay distinct', async () => {
      const { conferenceId, sessionId } = await seed();

      const first = await openForEditing(conferenceId, sessionId);
      await client.query("update sessions set location = 'Room B' where id = $1", [sessionId]);
      const second = await openForEditing(conferenceId, sessionId);

      // The trigger advances by at least a microsecond, so two writes in quick succession differ
      // in digits a millisecond-precision `Date` round trip would discard. If the wire value ever
      // loses that precision, the two become equal here and this fails before the conflict check
      // can silently start passing stale saves.
      expect(second.version).not.toBe(first.version);
      expect(second.version).toMatch(/\.\d{6}Z$/);
    });
  });

  // ---------- Acceptance Scenario S04: a lifecycle transition wins ----------

  describe('a lifecycle transition landing under an in-flight edit', () => {
    it('refuses the edit naming the archived state, not as a version conflict', async () => {
      // Past the end date, so archiving is permitted.
      const app = appWith('2026-09-18');
      const { conferenceId, sessionId } = await seed();

      const idasBase = await openForEditing(conferenceId, sessionId);

      const archived = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/archive`,
        headers: as(BJORN),
      });
      expect(archived.statusCode, archived.body).toBe(200);

      const idaSaves = await save(app, conferenceId, sessionId, IDA, {
        ...KEYNOTE,
        location: 'Room C',
        base: idasBase,
      });

      expect(idaSaves.statusCode).toBe(409);
      expect(idaSaves.json().error.code).toBe('CONFERENCE_STATE_CHANGED');
      expect(idaSaves.json().error.code).not.toBe('EDIT_VERSION_CONFLICT');
      // The new state is named. "This conference changed" would leave Ida to find out which of two
      // very different things happened to it.
      expect(idaSaves.json().error.message).toMatch(/archived/i);

      expect((await sessionRow(sessionId)).location).toBe('Room A');
    });

    it('refuses the edit naming the published state after another admin publishes', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await seed('draft');

      // Ida opens the Session while the Conference is still a draft.
      const idasBase = await openForEditing(conferenceId, sessionId);
      expect(idasBase.conferenceState).toBe('draft');

      const published = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/publish`,
        headers: as(BJORN),
      });
      expect(published.statusCode, published.body).toBe(200);

      const idaSaves = await save(app, conferenceId, sessionId, IDA, {
        ...KEYNOTE,
        location: 'Room C',
        base: idasBase,
      });

      expect(idaSaves.statusCode).toBe(409);
      expect(idaSaves.json().error.code).toBe('CONFERENCE_STATE_CHANGED');
      expect(idaSaves.json().error.message).toMatch(/published/i);

      expect((await sessionRow(sessionId)).location).toBe('Room A');
    });

    it('is decided before the base version, so a doubly-stale edit still names the state', async () => {
      const app = appWith('2026-09-18');
      const { conferenceId, sessionId } = await seed();

      const idasBase = await openForEditing(conferenceId, sessionId);

      // Both things go wrong at once: the Session moves *and* the Conference is archived. The
      // check order is what decides which refusal Ida reads, and the state is the one that leaves
      // her with something true to act on – re-applying an edit to an archived conference cannot
      // work.
      await client.query("update sessions set location = 'Room B' where id = $1", [sessionId]);
      const archived = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/archive`,
        headers: as(BJORN),
      });
      expect(archived.statusCode, archived.body).toBe(200);

      const idaSaves = await save(app, conferenceId, sessionId, IDA, {
        ...KEYNOTE,
        location: 'Room C',
        base: idasBase,
      });

      expect(idaSaves.json().error.code).toBe('CONFERENCE_STATE_CHANGED');
    });

    it('gives the three S09 refusals three distinct machine codes', async () => {
      const app = appWith('2026-09-18');

      // Version conflict.
      const stale = await seed();
      const staleBase = await openForEditing(stale.conferenceId, stale.sessionId);
      await client.query("update sessions set location = 'Room B' where id = $1", [
        stale.sessionId,
      ]);
      const conflict = await save(app, stale.conferenceId, stale.sessionId, IDA, {
        ...KEYNOTE,
        base: staleBase,
      });

      // Lifecycle-state change.
      const raced = await seed();
      const racedBase = await openForEditing(raced.conferenceId, raced.sessionId);
      await app.inject({
        method: 'POST',
        url: `/api/conferences/${raced.conferenceId}/archive`,
        headers: as(BJORN),
      });
      const stateChange = await save(app, raced.conferenceId, raced.sessionId, IDA, {
        ...KEYNOTE,
        base: racedBase,
      });

      const codes = [conflict.json().error.code, stateChange.json().error.code];
      expect(codes).toEqual(['EDIT_VERSION_CONFLICT', 'CONFERENCE_STATE_CHANGED']);
      expect(new Set(codes).size).toBe(codes.length);

      // Both are S01's envelope: a displayable sentence and a code, never a bare status.
      for (const response of [conflict, stateChange]) {
        expect(response.json().error.message).toMatch(/[a-z]{4,}.*\./i);
        expect(response.json().error.code).toMatch(/^[A-Z_]+$/);
      }
    });
  });

  // ---------- Acceptance Scenario S05 / TI06, TI07: the conference's own fields ----------

  async function conferenceBase(
    app: FastifyInstance,
    conferenceId: string,
  ): Promise<{ conferenceState: string; version: string }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}`,
      headers: as(IDA),
    });
    const body = response.json();
    return { conferenceState: body.lifecycleState, version: body.updatedAt };
  }

  function editConference(
    app: FastifyInstance,
    conferenceId: string,
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'PATCH',
      url: `/api/conferences/${conferenceId}`,
      headers: as(IDA),
      payload,
    });
  }

  async function span(conferenceId: string): Promise<{ start: string; end: string; name: string }> {
    const rows = await client.query(
      `select name,
              to_char(start_date, 'YYYY-MM-DD') as start,
              to_char(end_date, 'YYYY-MM-DD') as "end"
         from conference where id = $1`,
      [conferenceId],
    );
    return rows.rows[0];
  }

  async function stamps(conferenceId: string): Promise<{ version: string; watermark: string }> {
    const rows = await client.query(
      `select to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as version,
              to_char(schedule_watermark_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as watermark
         from conference where id = $1`,
      [conferenceId],
    );
    return rows.rows[0];
  }

  describe("a published conference's name and dates", () => {
    it('are editable after publish, advancing both the row version and the watermark', async () => {
      const app = appWith();
      const { conferenceId } = await seed();

      const before = await stamps(conferenceId);

      const edited = await editConference(app, conferenceId, {
        name: 'Autumn Offsite 2026',
        startDate: '2026-09-15',
        endDate: '2026-09-16',
        base: await conferenceBase(app, conferenceId),
      });
      expect(edited.statusCode, edited.body).toBe(200);

      const after = await stamps(conferenceId);
      // The row's own version moves because this is a Conference write, and the watermark moves
      // because a name or date change is a schedule change every attendee's phone must notice.
      expect(after.version > before.version).toBe(true);
      expect(after.watermark > before.watermark).toBe(true);

      const current = await span(conferenceId);
      expect(current.name).toBe('Autumn Offsite 2026');
      expect(current.end).toBe('2026-09-16');
    });

    it('refuse an edit whose base version has moved', async () => {
      const app = appWith();
      const { conferenceId } = await seed();

      const stale = await conferenceBase(app, conferenceId);
      const first = await editConference(app, conferenceId, {
        name: 'Renamed once',
        startDate: '2026-09-15',
        endDate: '2026-09-17',
        base: stale,
      });
      expect(first.statusCode, first.body).toBe(200);

      const second = await editConference(app, conferenceId, {
        name: 'Renamed twice',
        startDate: '2026-09-15',
        endDate: '2026-09-17',
        base: stale,
      });

      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('EDIT_VERSION_CONFLICT');
      expect((await span(conferenceId)).name).toBe('Renamed once');
    });

    it("are still bound by S03's 1-4 day rule, which this story does not restate", async () => {
      const app = appWith();
      const { conferenceId } = await seed();

      const refused = await editConference(app, conferenceId, {
        name: 'Autumn Offsite',
        startDate: '2026-09-15',
        endDate: '2026-09-19',
        base: await conferenceBase(app, conferenceId),
      });

      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe('CONFERENCE_DATE_SPAN_INVALID');
    });

    /**
     * The reason the concurrency base here is `updated_at` and not the schedule watermark.
     *
     * An Admin opens the conference detail form; meanwhile the schedule is edited in every way it
     * can be. None of that conflicts with a rename, and a base taken from the watermark would
     * refuse all three - a conflict with nothing.
     */
    it('are unaffected by session inserts, updates and deletes between load and save', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await seed();

      const base = await conferenceBase(app, conferenceId);

      await client.query(
        `insert into sessions (conference_id, title, kind, day, start_time, end_time, location)
         values ($1, 'Lightning Talks', 'Presentation', '2026-09-15', '13:00', '14:00', 'Room A')`,
        [conferenceId],
      );
      await client.query("update sessions set location = 'Room B' where id = $1", [sessionId]);
      await client.query('delete from sessions where id = $1', [sessionId]);

      const saved = await editConference(app, conferenceId, {
        name: 'Autumn Offsite, renamed',
        startDate: '2026-09-15',
        endDate: '2026-09-17',
        base,
      });

      expect(saved.statusCode, saved.body).toBe(200);
    });
  });

  describe('shortening the date span past a session', () => {
    it('is refused, naming the session and its day, with the span unchanged', async () => {
      const app = appWith();
      const { conferenceId } = await seed();
      await client.query(
        `insert into sessions (conference_id, title, kind, day, start_time, end_time, location)
         values ($1, 'Retrospective Day 3', 'Presentation', '2026-09-17', '15:00', '16:00', 'Room A')`,
        [conferenceId],
      );

      const refused = await editConference(app, conferenceId, {
        name: 'Autumn Offsite',
        startDate: '2026-09-15',
        endDate: '2026-09-16',
        base: await conferenceBase(app, conferenceId),
      });

      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('CONFERENCE_SPAN_ORPHANS_SESSIONS');
      // Named, not counted: "one session would be orphaned" leaves the Organizer opening every day
      // of the schedule to find which.
      expect(refused.json().error.message).toContain('Retrospective Day 3');
      expect(refused.json().error.message).toContain('2026-09-17');

      const unchanged = await span(conferenceId);
      expect(unchanged.end).toBe('2026-09-17');
    });

    it('succeeds once the session has been moved inside the new span', async () => {
      const app = appWith();
      const { conferenceId } = await seed();
      const strays = await client.query<{ id: string }>(
        `insert into sessions (conference_id, title, kind, day, start_time, end_time, location)
         values ($1, 'Retrospective Day 3', 'Presentation', '2026-09-17', '15:00', '16:00', 'Room A')
         returning id`,
        [conferenceId],
      );

      await client.query("update sessions set day = '2026-09-16' where id = $1", [
        strays.rows[0]!.id,
      ]);

      const accepted = await editConference(app, conferenceId, {
        name: 'Autumn Offsite',
        startDate: '2026-09-15',
        endDate: '2026-09-16',
        base: await conferenceBase(app, conferenceId),
      });

      expect(accepted.statusCode, accepted.body).toBe(200);
      expect((await span(conferenceId)).end).toBe('2026-09-16');
    });

    it('does not stand in the way of widening, which strands nobody', async () => {
      const app = appWith();
      const { conferenceId } = await seed();

      const before = await client.query('select count(*)::int as count from sessions');

      const widened = await editConference(app, conferenceId, {
        name: 'Autumn Offsite',
        startDate: '2026-09-15',
        endDate: '2026-09-18',
        base: await conferenceBase(app, conferenceId),
      });

      expect(widened.statusCode, widened.body).toBe(200);
      expect((await span(conferenceId)).end).toBe('2026-09-18');
      const after = await client.query('select count(*)::int as count from sessions');
      expect(after.rows[0].count).toBe(before.rows[0].count);
    });
  });

  // ---------- TI09: one set of timestamps, read the same way by every consumer ----------

  describe('the timestamps a post-publish write records', () => {
    /**
     * The Organizer's re-apply flow, the attendee's staleness age and S10's later cache cursor all
     * read the same two values. If the write answered with one watermark and the poll served
     * another, an Admin's own edit would look to their client like somebody else's change - and
     * every save would trigger a refetch that found nothing new.
     */
    it('answers with the watermark the poll and the next envelope both serve', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await seed();

      const saved = await save(app, conferenceId, sessionId, IDA, {
        ...KEYNOTE,
        location: 'Room B',
        base: await openForEditing(conferenceId, sessionId),
      });
      expect(saved.statusCode, saved.body).toBe(200);

      const returned = saved.json().conference.lastUpdatedAt as string;

      const polled = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/schedule/watermark`,
        headers: as(IDA),
      });
      const envelope = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/schedule`,
        headers: as(IDA),
      });

      expect(polled.json().lastUpdatedAt).toBe(returned);
      expect(envelope.json().conference.lastUpdatedAt).toBe(returned);
    });

    /**
     * Without this the Organizer could not save twice in a row: the second save would carry the
     * base the form loaded with, which the first save has already moved, and would be refused as a
     * conflict with itself.
     */
    it('answers with a row version an immediate follow-up edit is accepted against', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await seed();

      const first = await save(app, conferenceId, sessionId, IDA, {
        ...KEYNOTE,
        location: 'Room B',
        base: await openForEditing(conferenceId, sessionId),
      });
      expect(first.statusCode, first.body).toBe(200);

      const second = await save(app, conferenceId, sessionId, IDA, {
        ...KEYNOTE,
        location: 'Room C',
        base: {
          conferenceState: 'published',
          version: first.json().session.lastUpdatedAt as string,
        },
      });

      expect(second.statusCode, second.body).toBe(200);
      expect((await sessionRow(sessionId)).location).toBe('Room C');
    });

    it('answers a conference edit with both its row version and the advanced watermark', async () => {
      const app = appWith();
      const { conferenceId } = await seed();

      const edited = await editConference(app, conferenceId, {
        name: 'Autumn Offsite, renamed',
        startDate: '2026-09-15',
        endDate: '2026-09-17',
        base: await conferenceBase(app, conferenceId),
      });
      expect(edited.statusCode, edited.body).toBe(200);

      const body = edited.json();
      // Two fields, deliberately named apart: the row's own version and the schedule watermark.
      expect(body.updatedAt).not.toBe(body.lastUpdatedAt);

      const polled = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/schedule/watermark`,
        headers: as(IDA),
      });
      expect(polled.json().lastUpdatedAt).toBe(body.lastUpdatedAt);

      // And the row version it answered with is the base a follow-up edit is accepted against.
      const again = await editConference(app, conferenceId, {
        name: 'Autumn Offsite, renamed twice',
        startDate: '2026-09-15',
        endDate: '2026-09-17',
        base: { conferenceState: 'published', version: body.updatedAt as string },
      });
      expect(again.statusCode, again.body).toBe(200);
    });

    it('advances the watermark on a delete too, and says so in the response', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await seed();

      const before = await stamps(conferenceId);
      const base = await openForEditing(conferenceId, sessionId);

      const deleted = await app.inject({
        method: 'DELETE',
        url:
          `/api/conferences/${conferenceId}/sessions/${sessionId}` +
          `?conferenceState=${base.conferenceState}&version=${encodeURIComponent(base.version)}`,
        headers: as(IDA),
      });
      expect(deleted.statusCode, deleted.body).toBe(200);

      const returned = deleted.json().conference.lastUpdatedAt as string;
      expect(returned > before.watermark).toBe(true);

      const polled = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/schedule/watermark`,
        headers: as(IDA),
      });
      expect(polled.json().lastUpdatedAt).toBe(returned);
    });
  });

  // ---------- Acceptance Scenario S06 / TI08: a session cannot leave the span ----------

  describe('moving a session outside the conference date span', () => {
    /**
     * Refused by S04's existing day-containment validator, reached from the post-publish path -
     * not by a second copy of the rule living in this story's handler. The message naming the
     * permitted days is that validator's, which is precisely the evidence that it is the one that
     * ran: a re-implementation here would have had to reproduce the sentence to pass.
     */
    it('is refused, naming the days the conference actually runs on', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await seed();

      // The conference runs 2026-09-15 to 2026-09-17; the 18th is not one of its days.
      const refused = await save(app, conferenceId, sessionId, IDA, {
        ...KEYNOTE,
        day: '2026-09-18',
        base: await openForEditing(conferenceId, sessionId),
      });

      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe('SESSION_DAY_OUT_OF_SPAN');
      expect(refused.json().error.message).toContain('2026-09-15');
      expect(refused.json().error.message).toContain('2026-09-17');
      expect(refused.json().error.message).toContain('2026-09-18');

      // Nothing persisted: the session is still on its own day.
      const rows = await client.query(
        "select to_char(day, 'YYYY-MM-DD') as day from sessions where id = $1",
        [sessionId],
      );
      expect(rows.rows[0].day).toBe('2026-09-15');
    });

    it('is permitted onto another day that is inside the span', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await seed();

      const moved = await save(app, conferenceId, sessionId, IDA, {
        ...KEYNOTE,
        day: '2026-09-16',
        base: await openForEditing(conferenceId, sessionId),
      });

      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().session.day).toBe('2026-09-16');
    });
  });

  // ---------- C1: the interleaved case the sequential tests cannot reach ----------

  describe('two saves that genuinely overlap', () => {
    /**
     * The regression guard for the defect this story shipped with.
     *
     * Every other test here issues its second save only after the first has fully resolved, which
     * proves the *serialized* case. It cannot see the one that matters: two requests in flight at
     * once, both reading the same version before either writes. Under the original check-then-act
     * implementation both passed the comparison and both wrote - reproducibly, roughly one run in
     * six - and the loser was told their save succeeded.
     *
     * Ten rounds, because the interleaving is timing-dependent: a single round passed against the
     * defect most of the time.
     */
    it('accept exactly one and refuse the other, ten rounds running', async () => {
      const app = appWith();

      for (let round = 0; round < 10; round += 1) {
        const { conferenceId, sessionId } = await seed();
        const base = await openForEditing(conferenceId, sessionId);

        const [first, second] = await Promise.all([
          save(app, conferenceId, sessionId, IDA, { ...KEYNOTE, startTime: '09:30', base }),
          save(app, conferenceId, sessionId, BJORN, { ...KEYNOTE, location: 'Room C', base }),
        ]);

        const statuses = [first.statusCode, second.statusCode].sort();
        expect(statuses, `round ${round}: ${first.body} | ${second.body}`).toEqual([200, 409]);

        // The refused one carries the version to re-apply onto, exactly as the sequential case does.
        const refused = first.statusCode === 409 ? first : second;
        expect(refused.json().error.code).toBe('EDIT_VERSION_CONFLICT');
        expect(refused.json().error.current.lastUpdatedAt).not.toBe(base.version);

        // And the winner's change is intact - not half of each.
        const row = await sessionRow(sessionId);
        // Exactly one of the two is 200 (asserted above), so this identifies the winner outright.
        const idaWon = first.statusCode === 200;
        expect(idaWon ? row.start_time === '09:30' : row.location === 'Room C').toBe(true);

        await client.query('delete from conference');
      }
    });

    /**
     * The delete path under genuine interleaving, not the sequential shape the first version used.
     *
     * A delete and an edit of the same Session take their locks in opposite orders - the delete
     * takes the Conference row first and the Session row second, the edit the reverse via the
     * watermark trigger - so PostgreSQL aborts one as a deadlock victim. That abort must surface as
     * this API's refusal, never as a 500: `db.transaction` retries the rolled-back transaction once,
     * and the retry then sees the committed state and answers properly.
     */
    it('answer a delete racing an edit with a refusal, never a 500, ten rounds running', async () => {
      const app = appWith();

      for (let round = 0; round < 10; round += 1) {
        const { conferenceId, sessionId } = await seed();
        const base = await openForEditing(conferenceId, sessionId);

        const [deleted, edited] = await Promise.all([
          app.inject({
            method: 'DELETE',
            url:
              `/api/conferences/${conferenceId}/sessions/${sessionId}` +
              `?conferenceState=${base.conferenceState}&version=${encodeURIComponent(base.version)}`,
            headers: as(IDA),
          }),
          save(app, conferenceId, sessionId, BJORN, {
            ...KEYNOTE,
            location: 'Room C',
            base,
          }),
        ]);

        for (const response of [deleted, edited]) {
          expect(response.statusCode, `round ${round}: ${response.body}`).not.toBe(500);
          expect([200, 404, 409]).toContain(response.statusCode);
        }
        // Exactly one may have won: both succeeding would mean an edit applied to a deleted row.
        const succeeded = [deleted, edited].filter((r) => r.statusCode === 200);
        expect(succeeded.length, `round ${round}`).toBe(1);

        await client.query('delete from conference');
      }
    });

    /** The sequential case, kept because it pins the refusal's shape rather than the race. */
    it('refuse a delete whose base has moved, leaving the session in place', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await seed();

      const stale = await openForEditing(conferenceId, sessionId);
      await client.query("update sessions set location = 'Room B' where id = $1", [sessionId]);

      const refused = await app.inject({
        method: 'DELETE',
        url:
          `/api/conferences/${conferenceId}/sessions/${sessionId}` +
          `?conferenceState=${stale.conferenceState}&version=${encodeURIComponent(stale.version)}`,
        headers: as(IDA),
      });

      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('EDIT_VERSION_CONFLICT');

      // Not merely reported as refused - the row is still there.
      const rows = await client.query('select count(*)::int as count from sessions where id = $1', [
        sessionId,
      ]);
      expect(rows.rows[0].count).toBe(1);
    });

    it('refuse a delete carrying no base at all', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await seed();

      const refused = await app.inject({
        method: 'DELETE',
        url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
        headers: as(IDA),
      });

      expect(refused.statusCode).toBe(400);
      const rows = await client.query('select count(*)::int as count from sessions where id = $1', [
        sessionId,
      ]);
      expect(rows.rows[0].count).toBe(1);
    });

    /**
     * `updated_at` must be strictly increasing per write, like `session.last_updated_at` already is.
     * `now()` returns transaction-start time, so two edits could share a version and let a stale
     * base compare equal to a moved row.
     */
    /**
     * Two concurrent detail edits from one base: exactly one writes, and its new version is strictly
     * past the base both started from.
     *
     * This pins the *conflict* guarantee, not monotonicity - the version predicate lets only one of
     * the pair through, and a single write can demonstrate no ordering property at all. The test
     * below is the one that pins the column's monotonicity, and it took a held row lock to do it.
     */
    it('let exactly one of two concurrent edits write, past the base both started from', async () => {
      const app = appWith();

      for (let round = 0; round < 5; round += 1) {
        const { conferenceId } = await seed();
        const base = await conferenceBase(app, conferenceId);

        const [first, second] = await Promise.all([
          editConference(app, conferenceId, {
            name: 'Renamed by Ida',
            startDate: '2026-09-15',
            endDate: '2026-09-17',
            base,
          }),
          editConference(app, conferenceId, {
            name: 'Renamed by Björn',
            startDate: '2026-09-15',
            endDate: '2026-09-17',
            base,
          }),
        ]);

        expect([first.statusCode, second.statusCode].sort(), `round ${round}`).toEqual([200, 409]);

        const winner = first.statusCode === 200 ? first : second;
        // Strictly greater than the base both started from - never equal to it.
        expect(winner.json().updatedAt > base.version, `round ${round}`).toBe(true);

        await client.query('delete from conference');
      }
    });

    /**
     * The property under a **held row lock**, which is the only place it was ever at risk.
     *
     * Two earlier versions of this test could not fail. Three sequential edits cannot: each is a
     * separate round trip, so `now()` and `clock_timestamp()` are indistinguishable. Two concurrent
     * edits cannot either: the version predicate lets exactly one of them write, and one write
     * demonstrates nothing about ordering. `now()` is *transaction start* time, so the way to
     * expose it is to make a transaction start, then wait, then write - which is what waiting for
     * somebody else's row lock does.
     *
     * The sequence: a transaction takes the row lock; a publish begins and blocks on it, capturing
     * its `now()` **before** the wait; the lock holder then stamps a later `updated_at` and commits;
     * the publish proceeds. Stamped with `now()` it writes the value it captured before the wait and
     * the column moves **backwards** - a base read in between compares equal again afterwards, and
     * the stale save that should be refused is accepted. Stamped through `ADVANCE_UPDATED_AT` it
     * cannot.
     */
    it('advance the conference row version even when the write waited on somebody elses lock', async () => {
      const app = appWith();
      const { conferenceId } = await seed('draft');

      const holder = new pg.Client({ connectionString: url });
      await holder.connect();
      let publishing: Promise<unknown>;
      let stamped: string;
      try {
        await holder.query('begin');
        await holder.query('select id from conference where id = $1 for update', [conferenceId]);

        // Blocks on the lock above. Its transaction timestamp is taken here, before the wait.
        publishing = app.inject({
          method: 'POST',
          url: `/api/conferences/${conferenceId}/publish`,
          headers: as(IDA),
        });

        // Long enough that the publish is genuinely queued behind the lock rather than racing it,
        // and long enough that the two timestamps are far apart in microseconds.
        await new Promise((resolve) => setTimeout(resolve, 100));

        const held = await holder.query<{ stamped: string }>(
          `update conference set updated_at = clock_timestamp() where id = $1
           returning to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as stamped`,
          [conferenceId],
        );
        stamped = held.rows[0]!.stamped;
        await holder.query('commit');
      } finally {
        await holder.end();
      }

      const published = (await publishing) as { statusCode: number; body: string };
      expect(published.statusCode, published.body).toBe(200);

      const after = await client.query<{ version: string }>(
        `select to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as version
           from conference where id = $1`,
        [conferenceId],
      );
      // Strictly later than the value that was committed while this write was waiting.
      expect(after.rows[0]!.version > stamped, `${after.rows[0]!.version} vs ${stamped}`).toBe(
        true,
      );
    });

    /** A malformed version can match no row, so it is refused as a conflict rather than a 500. */
    it.each([
      ['not a timestamp at all', 'not-a-timestamp'],
      // Shape-valid to the digit, and not an instant that exists. It used to pass the regex, reach
      // `$n::timestamptz` and raise SQLSTATE 22008 - a 500 for a value no row could ever hold.
      ['a date that is not on the calendar', '2026-13-45T25:61:61.000000Z'],
      ['31 February, which only a day-count check catches', '2026-02-31T09:00:00.000000Z'],
    ])('refuse %s as a conflict, not an internal error', async (_name, version) => {
      const app = appWith();
      const { conferenceId, sessionId } = await seed();

      const refused = await save(app, conferenceId, sessionId, IDA, {
        ...KEYNOTE,
        location: 'Room Z',
        base: { conferenceState: 'published', version },
      });

      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe('EDIT_VERSION_CONFLICT');
      expect((await sessionRow(sessionId)).location).toBe('Room A');
    });
  });
});
