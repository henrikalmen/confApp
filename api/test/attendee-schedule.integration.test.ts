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
 * S06's two attendee endpoints, against the real PostgreSQL the composed stack runs.
 *
 * Every rule they carry is a storage-level or wire-level guarantee – which rows a `sub` can reach,
 * which lifecycle states are readable, what the envelope literally serializes to – and none of them
 * is provable against a fake that answers whatever the test wants. The verifier *is* stubbed,
 * because who the caller is was settled in the S02 suite and the subject here is what that caller
 * may read.
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
    '\n[integration] SKIPPED attendee schedule – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/** Ravi is the Attendee every scenario in the FIS is written around; Ida organizes. */
const RAVI = 'google-sub-ravi';
const IDA = 'google-sub-ida';

interface SessionSeed {
  title: string;
  kind?: string;
  day: string;
  startTime: string;
  endTime: string;
  location: string;
}

describe.skipIf(!reachable)('the attendee schedule endpoints', () => {
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
    for (const sub of [RAVI, IDA]) {
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

  /**
   * Seeds a Conference directly, so a scenario can state a lifecycle state and a join date rather
   * than driving it there through the Organizer endpoints. `joined_at` is written explicitly for
   * the same reason: "joined 2025-11-01" is part of the scenario, not something to wait for.
   */
  async function seedConference(options: {
    name: string;
    startDate: string;
    endDate: string;
    state?: string;
    members?: { sub: string; joinedAt?: string }[];
    admins?: string[];
    sessions?: SessionSeed[];
  }): Promise<string> {
    const rows = await client.query<{ id: string }>(
      `insert into conference (name, start_date, end_date, lifecycle_state, created_by_sub)
       values ($1, $2, $3, $4, $5) returning id`,
      [options.name, options.startDate, options.endDate, options.state ?? 'published', IDA],
    );
    const id = rows.rows[0]!.id;

    for (const member of options.members ?? []) {
      await client.query(
        `insert into membership (conference_id, user_sub, joined_at)
         values ($1, $2, coalesce($3::timestamptz, now()))`,
        [id, member.sub, member.joinedAt ?? null],
      );
    }
    for (const sub of options.admins ?? []) {
      await client.query(
        "insert into role_assignment (conference_id, user_sub, role) values ($1, $2, 'Admin')",
        [id, sub],
      );
    }
    for (const session of options.sessions ?? []) {
      await client.query(
        `insert into sessions (conference_id, title, kind, day, start_time, end_time, location)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          session.title,
          session.kind ?? 'Presentation',
          session.day,
          session.startTime,
          session.endTime,
          session.location,
        ],
      );
    }
    return id;
  }

  // ---------- TI01: Membership records when it was created ----------

  describe('the Membership joined timestamp', () => {
    /**
     * S03's migration already created `joined_at`, so this story adds none – it reads the column.
     * The assertion is that the column really is there in the shape "most recently joined" needs,
     * because the alternative to checking is discovering it in production.
     */
    it('is a non-null timestamptz on membership, created by S03', async () => {
      const columns = await client.query(
        `select data_type, is_nullable, column_default
           from information_schema.columns
          where table_name = 'membership' and column_name = 'joined_at'`,
      );
      expect(columns.rows).toHaveLength(1);
      expect(columns.rows[0].data_type).toBe('timestamp with time zone');
      expect(columns.rows[0].is_nullable).toBe('NO');
      expect(columns.rows[0].column_default).not.toBeNull();
    });

    it('survives a revert and re-apply of the migration that owns it', async () => {
      const steps = await stepsToRevertThrough(client, '20260817120000000_conference');
      await migrate('down', String(steps));

      const gone = await client.query(
        "select 1 from information_schema.tables where table_name = 'membership'",
      );
      expect(gone.rows, 'the down step should have dropped membership').toHaveLength(0);

      await migrate('up');
      const back = await client.query(
        `select data_type from information_schema.columns
          where table_name = 'membership' and column_name = 'joined_at'`,
      );
      expect(back.rows[0].data_type).toBe('timestamp with time zone');
    });

    it('orders two Memberships created in sequence for one user deterministically', async () => {
      const first = await seedConference({
        name: 'Retro 2025',
        startDate: '2025-11-18',
        endDate: '2025-11-20',
        members: [{ sub: RAVI }],
      });
      const second = await seedConference({
        name: 'Product Days',
        startDate: '2026-11-02',
        endDate: '2026-11-03',
        members: [{ sub: RAVI }],
      });

      const rows = await client.query<{ conference_id: string }>(
        `select conference_id from membership
          where user_sub = $1 order by joined_at desc, conference_id`,
        [RAVI],
      );
      expect(rows.rows.map((row) => row.conference_id)).toEqual([second, first]);
    });
  });

  // ---------- Acceptance Scenario S02 (TI01, TI02, TI10) ----------

  describe('GET /me/conferences', () => {
    /** The three Conferences Acceptance Scenario S02 names, with the join dates it states. */
    async function seedRavisThree(): Promise<Record<string, string>> {
      return {
        retro: await seedConference({
          name: 'Retro 2025',
          startDate: '2025-11-18',
          endDate: '2025-11-20',
          state: 'archived',
          members: [{ sub: RAVI, joinedAt: '2025-11-01T09:00:00Z' }],
        }),
        kickoff: await seedConference({
          name: 'Kickoff 2026',
          startDate: '2026-09-14',
          endDate: '2026-09-16',
          members: [{ sub: RAVI, joinedAt: '2026-08-01T09:00:00Z' }],
        }),
        productDays: await seedConference({
          name: 'Product Days',
          startDate: '2026-11-02',
          endDate: '2026-11-03',
          members: [{ sub: RAVI, joinedAt: '2026-09-10T09:00:00Z' }],
        }),
      };
    }

    it('defaults to the Conference running today and lists all three', async () => {
      const seeded = await seedRavisThree();
      const response = await appWith('2026-09-15').inject({
        method: 'GET',
        url: '/api/me/conferences',
        headers: as(RAVI),
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body.defaultConferenceId).toBe(seeded.kickoff);
      expect(new Set(body.conferences.map((c: { id: string }) => c.id))).toEqual(
        new Set(Object.values(seeded)),
      );
    });

    it('defaults to the most recently joined when none is running', async () => {
      const seeded = await seedRavisThree();
      const response = await appWith('2026-09-20').inject({
        method: 'GET',
        url: '/api/me/conferences',
        headers: as(RAVI),
      });

      expect(response.json().defaultConferenceId).toBe(seeded.productDays);
    });

    it('picks the most recently joined among several running at once', async () => {
      await seedConference({
        name: 'Kickoff 2026',
        startDate: '2026-09-14',
        endDate: '2026-09-16',
        members: [{ sub: RAVI, joinedAt: '2026-08-01T09:00:00Z' }],
      });
      const later = await seedConference({
        name: 'Parallel Offsite',
        startDate: '2026-09-15',
        endDate: '2026-09-15',
        members: [{ sub: RAVI, joinedAt: '2026-09-14T09:00:00Z' }],
      });

      const response = await appWith('2026-09-15').inject({
        method: 'GET',
        url: '/api/me/conferences',
        headers: as(RAVI),
      });
      expect(response.json().defaultConferenceId).toBe(later);
    });

    /**
     * The route split, asserted from both sides in one test: the same draft is absent from the
     * attendee list and present in the Organizer one, for the same caller in the same state. A
     * later "consolidation" of the two endpoints fails here.
     */
    it('omits a draft the caller admins, while GET /conferences still lists it', async () => {
      const draft = await seedConference({
        name: 'Draft Days',
        startDate: '2026-10-01',
        endDate: '2026-10-02',
        state: 'draft',
        members: [{ sub: RAVI }],
        admins: [RAVI],
      });

      const app = appWith();
      const attendee = await app.inject({
        method: 'GET',
        url: '/api/me/conferences',
        headers: as(RAVI),
      });
      expect(attendee.json().conferences).toEqual([]);
      expect(attendee.json().defaultConferenceId).toBeNull();

      const organizer = await app.inject({
        method: 'GET',
        url: '/api/conferences',
        headers: as(RAVI),
      });
      expect(organizer.json().conferences.map((c: { id: string }) => c.id)).toEqual([draft]);
    });

    it('includes an archived Conference, marked as archived', async () => {
      await seedConference({
        name: 'Retro 2025',
        startDate: '2025-11-18',
        endDate: '2025-11-20',
        state: 'archived',
        members: [{ sub: RAVI }],
      });

      const body = (
        await appWith().inject({
          method: 'GET',
          url: '/api/me/conferences',
          headers: as(RAVI),
        })
      ).json();
      expect(body.conferences).toHaveLength(1);
      expect(body.conferences[0].state).toBe('archived');
    });

    it('shows nothing for a Conference the caller has not joined', async () => {
      await seedConference({
        name: 'Private Offsite',
        startDate: '2026-09-14',
        endDate: '2026-09-16',
        members: [{ sub: IDA }],
      });

      const body = (
        await appWith().inject({
          method: 'GET',
          url: '/api/me/conferences',
          headers: as(RAVI),
        })
      ).json();
      expect(body.conferences).toEqual([]);
    });

    /**
     * `sub` is the identity join key end to end (FR5, ADR-002). A query that filtered on the
     * `app_user` surrogate id or on an email would still pass every test above, so the SQL itself
     * is asserted – emails change and are reissued, and surrogate ids are not stable across
     * environments.
     */
    it('joins membership on sub, never on a surrogate id or an email', async () => {
      const { createConferenceRepository } =
        await import('../src/conferences/conference-repository.ts');
      const issued: string[] = [];
      const recording = {
        async query<T extends pg.QueryResultRow>(text: string): Promise<T[]> {
          issued.push(text);
          return [] as T[];
        },
        transaction: db.transaction.bind(db),
        close: db.close.bind(db),
      };

      await createConferenceRepository(recording as unknown as Database).listJoinedAndReadable(
        RAVI,
      );

      expect(issued).toHaveLength(1);
      expect(issued[0]).toMatch(/m\.user_sub\s*=\s*\$1/);
      expect(issued[0]).not.toMatch(/user_id|\bemail\b/i);
    });
  });

  // ---------- Acceptance Scenarios S01, S03, S04 (TI03) ----------

  describe('GET /conferences/:id/schedule', () => {
    /** Acceptance Scenario S01's day, plus S04's concurrent pair. */
    const KICKOFF = {
      name: 'Kickoff 2026',
      startDate: '2026-09-14',
      endDate: '2026-09-16',
      members: [{ sub: RAVI }],
      sessions: [
        // Deliberately inserted out of order, so ascending output is the endpoint's doing.
        {
          title: 'Retrospective',
          kind: 'Workshop',
          day: '2026-09-15',
          startTime: '15:00',
          endTime: '16:00',
          location: 'Room B',
        },
        {
          title: 'Opening Keynote',
          day: '2026-09-15',
          startTime: '09:00',
          endTime: '10:30',
          location: 'Main Hall',
        },
        {
          title: 'Design Workshop',
          kind: 'Workshop',
          day: '2026-09-15',
          startTime: '10:00',
          endTime: '11:00',
          location: 'Room 2',
        },
        {
          title: 'Architecture Deep Dive',
          day: '2026-09-15',
          startTime: '10:00',
          endTime: '11:00',
          location: 'Room 3',
        },
        {
          title: 'Back To Back',
          day: '2026-09-14',
          startTime: '10:00',
          endTime: '11:00',
          location: 'Main Hall',
        },
        {
          title: 'Earlier',
          day: '2026-09-14',
          startTime: '09:00',
          endTime: '10:00',
          location: 'Main Hall',
        },
      ] satisfies SessionSeed[],
    };

    async function readKickoff(): Promise<{ id: string; body: Record<string, never> }> {
      const id = await seedConference(KICKOFF);
      const response = await appWith('2026-09-15', '09:40').inject({
        method: 'GET',
        url: `/api/conferences/${id}/schedule`,
        headers: as(RAVI),
      });
      expect(response.statusCode, response.body).toBe(200);
      return { id, body: response.json() };
    }

    it('returns every Conference Day of the span, numbered, including the empty one', async () => {
      const { body } = await readKickoff();
      expect(body.days.map((d: { date: string }) => d.date)).toEqual([
        '2026-09-14',
        '2026-09-15',
        '2026-09-16',
      ]);
      expect(body.days.map((d: { dayNumber: number }) => d.dayNumber)).toEqual([1, 2, 3]);
      expect(body.days[2].sessions).toEqual([]);
    });

    it('orders Sessions ascending by start time within each day', async () => {
      const { body } = await readKickoff();
      expect(body.days[1].sessions.map((s: { title: string }) => s.title)).toEqual([
        'Opening Keynote',
        'Architecture Deep Dive',
        'Design Workshop',
        'Retrospective',
      ]);
    });

    it('carries each Session with the fields the view renders', async () => {
      const { body } = await readKickoff();
      const keynote = body.days[1].sessions[0];
      expect(keynote).toMatchObject({
        title: 'Opening Keynote',
        kind: 'Presentation',
        startTime: '09:00',
        endTime: '10:30',
        location: 'Main Hall',
      });
    });

    /** Acceptance Scenario S04, including the boundary case that must *not* be concurrent. */
    it('marks concurrent Sessions symmetrically and leaves touching ones alone', async () => {
      const { body } = await readKickoff();
      const byTitle = new Map<string, { id: string; concurrentWith: string[] }>(
        body.days
          .flatMap((d: { sessions: { title: string }[] }) => d.sessions)
          .map((s: { title: string }) => [s.title, s]),
      );
      const idOf = (title: string): string => byTitle.get(title)!.id;
      const partners = (title: string): string[] =>
        byTitle
          .get(title)!
          .concurrentWith.slice()
          .sort((a, b) => (a < b ? -1 : 1));
      const sorted = (...titles: string[]): string[] =>
        titles.map(idOf).sort((a, b) => (a < b ? -1 : 1));

      expect(partners('Design Workshop')).toEqual(
        sorted('Architecture Deep Dive', 'Opening Keynote'),
      );
      expect(partners('Architecture Deep Dive')).toEqual(
        sorted('Design Workshop', 'Opening Keynote'),
      );
      expect(partners('Opening Keynote')).toEqual(
        sorted('Design Workshop', 'Architecture Deep Dive'),
      );
      expect(partners('Retrospective')).toEqual([]);

      // 09:00–10:00 and 10:00–11:00 touch but do not overlap – S04's half-open rule, reached by
      // calling S04's function rather than by restating it here.
      expect(partners('Earlier')).toEqual([]);
      expect(partners('Back To Back')).toEqual([]);
    });

    it('carries serverNow as both a UTC instant and a naive wall clock', async () => {
      const { body } = await readKickoff();
      expect(body.serverNow.day).toBe('2026-09-15');
      expect(body.serverNow.time).toBe('09:40');
      expect(body.serverNow.instant).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    });

    /**
     * S04's watermark, carried at full precision under the wire name the envelope pins. The
     * millisecond round trip is the failure being guarded: a value that had been through a JS
     * `Date` would compare equal to a different write.
     */
    it('carries the schedule watermark through unmodified and at full precision', async () => {
      const { id, body } = await readKickoff();
      const stored = await client.query<{ value: string }>(
        `select to_char(schedule_watermark_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                as value from conference where id = $1`,
        [id],
      );
      expect(body.conference.lastUpdatedAt).toBe(stored.rows[0]!.value);
      expect(new Date(body.conference.lastUpdatedAt).toISOString()).not.toBe(
        body.conference.lastUpdatedAt,
      );
    });

    /**
     * Asserted against the raw response body rather than a parsed object: a coerced value betrays
     * itself in the serialization, and a parsed one has already lost the evidence.
     */
    it('serializes no Session time as an instant or with an offset', async () => {
      const id = await seedConference(KICKOFF);
      const response = await appWith('2026-09-15', '09:40').inject({
        method: 'GET',
        url: `/api/conferences/${id}/schedule`,
        headers: as(RAVI),
      });

      expect(response.body).toContain('"startTime":"09:00"');
      expect(response.body).toContain('"endTime":"10:30"');
      expect(response.body).toContain('"date":"2026-09-15"');
      expect(response.body).not.toContain('09:00:00');
      expect(response.body).not.toContain('T09:00');

      // The only ISO instants in the payload are the two fields that genuinely are instants.
      const instants = response.body.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? [];
      expect(instants).toHaveLength(2);
    });

    /**
     * No per-day or per-Session round trip, whatever the span (TI03, and S12's budget).
     *
     * Counted across a **whole request**, against a database seam that records what the handler
     * actually issued. Asserting that `listForConference` runs one statement would prove nothing –
     * it does, by construction – while a handler that called it once per Conference Day would sail
     * through. Three days here, so a per-day loop shows up as three.
     */
    it('reads the Sessions of a three-day Conference in one query per request', async () => {
      const id = await seedConference(KICKOFF);

      const issued: string[] = [];
      const recording: Database = {
        async query<T extends pg.QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ): Promise<T[]> {
          issued.push(text);
          return db.query<T>(text, values);
        },
        transaction: db.transaction.bind(db),
        close: async () => {},
      };

      const app = buildApp({
        db: recording,
        auth: {
          verifier: subjectVerifier(),
          users: createUserRepository(recording),
          codeExchange: unusedCodeExchange(),
        },
        clock: fixedClock('2026-09-15', '09:40'),
      });
      apps.push(app);

      const response = await app.inject({
        method: 'GET',
        url: `/api/conferences/${id}/schedule`,
        headers: as(RAVI),
      });
      expect(response.statusCode, response.body).toBe(200);
      // The span really is three days, so a per-day loop would be visible as three reads.
      expect(response.json().days).toHaveLength(3);

      const sessionReads = issued.filter((text) => /from sessions\b/.test(text));
      expect(sessionReads, sessionReads.join('\n---\n')).toHaveLength(1);
    });
  });

  // ---------- Acceptance Scenario S06 (TI04) ----------

  describe('the refusals', () => {
    it('refuses a caller who has not joined, with its own machine code', async () => {
      const id = await seedConference({
        name: 'Private Offsite',
        startDate: '2026-09-14',
        endDate: '2026-09-16',
        members: [{ sub: IDA }],
        sessions: [
          {
            title: 'Secret Roadmap',
            day: '2026-09-15',
            startTime: '09:00',
            endTime: '10:00',
            location: 'Main Hall',
          },
        ],
      });

      const response = await appWith().inject({
        method: 'GET',
        url: `/api/conferences/${id}/schedule`,
        headers: as(RAVI),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('NOT_A_MEMBER');
      expect(response.json().error.message).toMatch(/join/i);
      expect(response.body, 'a refusal must disclose no session content').not.toContain(
        'Secret Roadmap',
      );
    });

    it('refuses a draft Conference even to its own Admin, naming that it is not published', async () => {
      const id = await seedConference({
        name: 'Draft Days',
        startDate: '2026-10-01',
        endDate: '2026-10-02',
        state: 'draft',
        members: [{ sub: RAVI }],
        admins: [RAVI],
        sessions: [
          {
            title: 'Unannounced Session',
            day: '2026-10-01',
            startTime: '09:00',
            endTime: '10:00',
            location: 'Main Hall',
          },
        ],
      });

      const response = await appWith().inject({
        method: 'GET',
        url: `/api/conferences/${id}/schedule`,
        headers: as(RAVI),
      });

      expect(response.json().error.code).toBe('CONFERENCE_NOT_READABLE');
      expect(response.json().error.message).toMatch(/published/i);
      expect(response.body).not.toContain('Unannounced Session');
    });

    /**
     * Membership is decided before the lifecycle state, so a stranger guessing a uuid learns
     * neither that the Conference exists nor what state it is in.
     */
    it('tells a non-member nothing about a draft, not even that it is a draft', async () => {
      const id = await seedConference({
        name: 'Draft Days',
        startDate: '2026-10-01',
        endDate: '2026-10-02',
        state: 'draft',
        members: [{ sub: IDA }],
      });

      const response = await appWith().inject({
        method: 'GET',
        url: `/api/conferences/${id}/schedule`,
        headers: as(RAVI),
      });
      expect(response.json().error.code).toBe('NOT_A_MEMBER');
      expect(response.body).not.toContain('Draft Days');
    });

    it('answers an unknown Conference exactly as it answers one the caller has not joined', async () => {
      const response = await appWith().inject({
        method: 'GET',
        url: '/api/conferences/11111111-1111-4111-8111-111111111111/schedule',
        headers: as(RAVI),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('NOT_A_MEMBER');
    });

    it('returns an archived Conference in full, marked as archived', async () => {
      const id = await seedConference({
        name: 'Retro 2025',
        startDate: '2025-11-18',
        endDate: '2025-11-20',
        state: 'archived',
        members: [{ sub: RAVI }],
        sessions: [
          {
            title: 'What We Learned',
            day: '2025-11-19',
            startTime: '13:00',
            endTime: '14:00',
            location: 'Main Hall',
          },
        ],
      });

      const response = await appWith().inject({
        method: 'GET',
        url: `/api/conferences/${id}/schedule`,
        headers: as(RAVI),
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body.conference.state).toBe('archived');
      expect(body.days[1].sessions[0].title).toBe('What We Learned');
    });

    it('refuses both attendee endpoints without a credential', async () => {
      const app = appWith();
      // A well-formed uuid, so the schema check cannot answer first and mask the auth refusal.
      for (const url of [
        '/api/me/conferences',
        '/api/conferences/11111111-1111-4111-8111-111111111111/schedule',
      ]) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(401);
      }
    });
  });
});
