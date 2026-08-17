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
import {
  FAILED_ATTEMPT_LIMIT,
  FAILED_ATTEMPT_WINDOW_MINUTES,
  createFailedJoinAttempts,
} from '../src/conferences/failed-join-attempts.ts';
import type { ScheduleGate } from '../src/conferences/schedule-gate.ts';
import { subjectVerifier, tokenFor, unusedCodeExchange } from './fake-auth.ts';
import { stepsToRevertThrough } from './migration-depth.ts';

/**
 * S05's endpoints, against the real PostgreSQL the composed stack runs.
 *
 * Almost nothing here is provable against a fake. Uniqueness across archived rows is a database
 * constraint; "no increment is lost" is a property of concurrent statements against one server;
 * "the counter is not in process" is only visible when a second process reads the same total. The
 * verifier *is* stubbed – who the caller is was settled in the S02 suite, and the subject here is
 * what that caller may do.
 *
 * Like the other integration suites this runs in a database of its own, never the development one.
 */

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
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
    '\n[integration] SKIPPED join code access – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/** The Organizer, the two employees, and the crowd the venue puts behind one address. */
const PRIYA = 'google-sub-priya';
const NADIA = 'google-sub-nadia';
const OSCAR = 'google-sub-oscar';
const CROWD = Array.from({ length: 20 }, (_, index) => `google-sub-crowd-${index}`);

const KICKOFF = { name: 'Kickoff 2026', startDate: '2026-09-14', endDate: '2026-09-16' };

/** A gate that always reports a session, so publishing is about the code rather than the schedule. */
const HAS_SESSION: ScheduleGate = {
  async hasAtLeastOneSession() {
    return true;
  },
};

describe.skipIf(!reachable)('join code access against a real PostgreSQL', () => {
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
    // Conference rows cascade to their memberships; app_user rows cascade to failed attempts.
    await client.query('delete from conference');
    await client.query('delete from app_user');

    const users = createUserRepository(db);
    for (const sub of [PRIYA, NADIA, OSCAR, ...CROWD]) {
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
   * An app whose minted codes are stated by the test, so a scenario can name the code an employee
   * types. The generator itself – that codes are drawn from the ambiguity-free alphabet – is proved
   * in `join-code.test.ts` and again below against the unstubbed default.
   */
  function appWith(options: { today?: string; codes?: readonly string[] } = {}): FastifyInstance {
    const queue = [...(options.codes ?? [])];
    const app = buildApp({
      db,
      auth: {
        verifier: subjectVerifier(),
        users: createUserRepository(db),
        codeExchange: unusedCodeExchange(),
      },
      scheduleGate: HAS_SESSION,
      clock: fixedClock(options.today ?? '2026-09-15'),
      ...(options.codes
        ? {
            mintJoinCode: () => {
              const next = queue.shift();
              if (next === undefined) throw new Error('The test ran out of pinned join codes.');
              return next;
            },
          }
        : {}),
    });
    apps.push(app);
    return app;
  }

  function as(sub: string): { authorization: string } {
    return { authorization: `Bearer ${tokenFor(sub)}` };
  }

  async function createConference(
    app: FastifyInstance,
    details = KICKOFF,
    sub = PRIYA,
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/conferences',
      headers: as(sub),
      payload: details,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().id as string;
  }

  async function publish(app: FastifyInstance, conferenceId: string, sub = PRIYA): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/publish`,
      headers: as(sub),
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function archive(app: FastifyInstance, conferenceId: string): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/archive`,
      headers: as(PRIYA),
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  /**
   * A published Conference with the code this test wants it to have. `nextCodes` pins what a later
   * regeneration in the same test will mint, so a scenario can name both codes it talks about.
   */
  async function publishedWithCode(
    code: string,
    options: { today?: string; details?: typeof KICKOFF; nextCodes?: readonly string[] } = {},
  ): Promise<{ app: FastifyInstance; conferenceId: string }> {
    const app = appWith({
      codes: [code, ...(options.nextCodes ?? [])],
      ...(options.today ? { today: options.today } : {}),
    });
    const conferenceId = await createConference(app, options.details ?? KICKOFF);
    await publish(app, conferenceId);
    return { app, conferenceId };
  }

  /** Named `submit` rather than `join`, which is `node:path`'s in this module. */
  function submit(app: FastifyInstance, sub: string, code: string) {
    return app.inject({ method: 'POST', url: '/api/join', headers: as(sub), payload: { code } });
  }

  async function membershipCount(conferenceId: string, sub?: string): Promise<number> {
    const rows =
      sub === undefined
        ? await client.query(
            'select count(*)::int as count from membership where conference_id = $1',
            [conferenceId],
          )
        : await client.query(
            'select count(*)::int as count from membership where conference_id = $1 and user_sub = $2',
            [conferenceId, sub],
          );
    return rows.rows[0].count as number;
  }

  // ---------- Acceptance Scenario S01 (TI02, TI03, TI04) ----------

  describe('an employee joins a running published conference', () => {
    it('accepts the code typed in lowercase with surrounding whitespace', async () => {
      const { app, conferenceId } = await publishedWithCode('K7RM4P');

      // Nadia is not yet a member of anything.
      expect(await membershipCount(conferenceId, NADIA)).toBe(0);

      const response = await submit(app, NADIA, ' k7rm4p ');

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().conference.name).toBe('Kickoff 2026');
      expect(response.json().conference.id).toBe(conferenceId);

      // An Attendee Membership linking Nadia's sub to this conference, and nothing keyed on email.
      const membership = await client.query(
        'select user_sub from membership where conference_id = $1 and user_sub = $2',
        [conferenceId, NADIA],
      );
      expect(membership.rows).toEqual([{ user_sub: NADIA }]);
      expect(response.body).not.toContain('@');
    });

    /** The Attendee role *is* Membership – no Role Assignment is written for it. */
    it('writes a Membership and no Role Assignment', async () => {
      const { app, conferenceId } = await publishedWithCode('K7RM4P');
      await submit(app, NADIA, 'K7RM4P');

      const roles = await client.query(
        'select user_sub, role from role_assignment where conference_id = $1',
        [conferenceId],
      );
      // Only the creator's seeded Admin grant.
      expect(roles.rows).toEqual([{ user_sub: PRIYA, role: 'Admin' }]);
    });

    it('resolves every incidental spelling of the code to the same conference', async () => {
      const { app, conferenceId } = await publishedWithCode('K7RM4P');

      for (const [index, spelling] of [' k7rm4p ', 'k7rm4p', 'K7RM-4P', 'K7RM4P'].entries()) {
        const response = await submit(app, CROWD[index]!, spelling);
        expect(response.statusCode, `${spelling}: ${response.body}`).toBe(200);
        expect(response.json().conference.id).toBe(conferenceId);
      }
    });
  });

  // ---------- Acceptance Scenario S02 (TI04) ----------

  describe('re-entering an already-joined code', () => {
    it('succeeds and leaves exactly one Membership', async () => {
      const { app, conferenceId } = await publishedWithCode('K7RM4P');

      const first = await submit(app, NADIA, 'K7RM4P');
      expect(first.statusCode, first.body).toBe(200);
      expect(await membershipCount(conferenceId, NADIA)).toBe(1);

      const again = await submit(app, NADIA, 'K7RM4P');
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().conference.name).toBe('Kickoff 2026');
      expect(await membershipCount(conferenceId, NADIA)).toBe(1);
    });

    /** The creator already holds a Membership from S03's seed; their own code must be a no-op. */
    it('is a no-op for the creator, who is already a member of their own conference', async () => {
      const { app, conferenceId } = await publishedWithCode('K7RM4P');
      expect(await membershipCount(conferenceId, PRIYA)).toBe(1);

      const response = await submit(app, PRIYA, 'K7RM4P');

      expect(response.statusCode, response.body).toBe(200);
      expect(await membershipCount(conferenceId, PRIYA)).toBe(1);
      expect(await membershipCount(conferenceId)).toBe(1);
    });

    /** Two simultaneous submissions of the same code are one fact, not a constraint violation. */
    it('survives the same code submitted twice concurrently', async () => {
      const { app, conferenceId } = await publishedWithCode('K7RM4P');

      const responses = await Promise.all([
        submit(app, NADIA, 'K7RM4P'),
        submit(app, NADIA, 'k7rm4p'),
      ]);

      for (const response of responses) expect(response.statusCode, response.body).toBe(200);
      expect(await membershipCount(conferenceId, NADIA)).toBe(1);
    });

    /** A successful join, repeated, never consumes the failed-attempt allowance. */
    it('records no failed attempt for a success or a repeat', async () => {
      const { app } = await publishedWithCode('K7RM4P');
      await submit(app, NADIA, 'K7RM4P');
      await submit(app, NADIA, 'K7RM4P');

      const attempts = await client.query(
        'select count(*)::int as count from failed_join_attempt where user_sub = $1',
        [NADIA],
      );
      expect(attempts.rows[0].count).toBe(0);
    });
  });

  // ---------- Acceptance Scenario S03 (TI05) ----------

  it('refuses an unknown code with the exact message, and creates no Membership', async () => {
    const { app } = await publishedWithCode('K7RM4P');

    const unknown = await client.query(
      'select count(*)::int as count from conference where join_code = $1',
      ['ZZZ999'],
    );
    expect(unknown.rows[0].count).toBe(0);

    const response = await submit(app, NADIA, 'ZZZ999');

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('JOIN_CODE_UNKNOWN');
    expect(response.json().error.message).toBe('No conference found with that code.');

    const memberships = await client.query(
      'select count(*)::int as count from membership where user_sub = $1',
      [NADIA],
    );
    expect(memberships.rows[0].count).toBe(0);
  });

  // ---------- Acceptance Scenario S04 (TI05) ----------

  describe('each non-joinable conference state names its own reason', () => {
    /**
     * The three at once, in one database, exactly as the scenario states them: a draft, an archived
     * one, and one still marked `published` whose end date was yesterday.
     */
    async function threeNonJoinable(): Promise<FastifyInstance> {
      // Codes are minted on publish, in publish order: Retro first, then Summer Jam.
      const app = appWith({ today: '2026-09-15', codes: ['EF45GH', 'JK67MN'] });

      await createConference(app, {
        name: 'Draft Days',
        startDate: '2026-10-01',
        endDate: '2026-10-02',
      });

      const retro = await createConference(app, {
        name: 'Retro 2025',
        startDate: '2025-04-01',
        endDate: '2025-04-02',
      });
      await publish(app, retro);
      await archive(app, retro);

      const summer = await createConference(app, {
        name: 'Summer Jam',
        startDate: '2026-09-13',
        endDate: '2026-09-14',
      });
      await publish(app, summer);

      // "Draft Days" has no code at all, so the scenario's AB23CD is set directly – a draft cannot
      // be given one through the API, which is itself the rule (there is no code before publish).
      await client.query("update conference set join_code = 'AB23CD' where name = 'Draft Days'");

      return app;
    }

    it('refuses draft, archived and ended with three distinct codes and messages', async () => {
      const app = await threeNonJoinable();

      const refusals = [];
      for (const [index, code] of ['AB23CD', 'EF45GH', 'JK67MN'].entries()) {
        const response = await submit(app, CROWD[index]!, code);
        expect(response.statusCode, `${code}: ${response.body}`).toBe(409);
        refusals.push(response.json().error);
      }

      expect(refusals.map((error) => error.code)).toEqual([
        'JOIN_CONFERENCE_NOT_PUBLISHED',
        'JOIN_CONFERENCE_ARCHIVED',
        'JOIN_CONFERENCE_ENDED',
      ]);

      // Each names its own reason, and its own conference.
      expect(refusals[0]!.message).toMatch(/not been published/i);
      expect(refusals[0]!.message).toContain('Draft Days');
      expect(refusals[1]!.message).toMatch(/archived/i);
      expect(refusals[1]!.message).toContain('Retro 2025');
      expect(refusals[2]!.message).toMatch(/ended on 2026-09-14/);
      expect(refusals[2]!.message).toContain('Summer Jam');

      // No two are the same envelope.
      expect(new Set(refusals.map((error) => error.message)).size).toBe(3);

      const memberships = await client.query('select count(*)::int as count from membership');
      // Only the three creator seeds; no join wrote a fourth.
      expect(memberships.rows[0].count).toBe(3);
    });

    /** Joinability ends with the end date, not with the manual archiving step. */
    it('refuses "Summer Jam" although it was never archived', async () => {
      const app = await threeNonJoinable();

      const state = await client.query(
        "select lifecycle_state from conference where name = 'Summer Jam'",
      );
      expect(state.rows[0].lifecycle_state).toBe('published');

      const response = await submit(app, NADIA, 'JK67MN');
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('JOIN_CONFERENCE_ENDED');
    });

    /** The same conference, asked on its last day, is joinable – the boundary is inclusive. */
    it('accepts the same conference on its end date', async () => {
      const { app } = await publishedWithCode('JK67MN', {
        today: '2026-09-14',
        details: { name: 'Summer Jam', startDate: '2026-09-13', endDate: '2026-09-14' },
      });

      const response = await submit(app, NADIA, 'JK67MN');
      expect(response.statusCode, response.body).toBe(200);
    });
  });

  // ---------- Acceptance Scenario S05 (TI01, TI02) ----------

  describe('a code issued for an archived conference is never reused', () => {
    it('is rejected by the database constraint even against an archived row', async () => {
      const { app, conferenceId } = await publishedWithCode('EF45GH', { today: '2026-09-17' });
      await archive(app, conferenceId);

      const archivedRow = await client.query(
        'select lifecycle_state, join_code from conference where id = $1',
        [conferenceId],
      );
      expect(archivedRow.rows[0]).toEqual({ lifecycle_state: 'archived', join_code: 'EF45GH' });

      // Straight at the table, bypassing every application-level guard: the constraint is what
      // refuses, so a concurrent publish cannot slip past a read-then-check.
      await expect(
        client.query(
          `insert into conference (name, start_date, end_date, created_by_sub, join_code)
           values ($1, $2, $3, $4, $5)`,
          ['Another Conference', '2026-11-01', '2026-11-02', PRIYA, 'EF45GH'],
        ),
      ).rejects.toMatchObject({ code: '23505', constraint: 'conference_join_code_unique' });
    });

    it('never assigns the archived code to a newly published conference, and still refuses it', async () => {
      const { app, conferenceId } = await publishedWithCode('EF45GH', { today: '2026-09-17' });
      await archive(app, conferenceId);

      // Publishing more conferences, with the real generator rather than pinned codes.
      const live = appWith({ today: '2026-09-17' });
      const published: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        const id = await createConference(live, {
          name: `Later Conference ${index}`,
          startDate: '2026-10-01',
          endDate: '2026-10-02',
        });
        await publish(live, id);
        published.push(id);
      }

      const codes = await client.query(
        'select join_code from conference where id = any($1::uuid[])',
        [published],
      );
      const minted = codes.rows.map((row) => row.join_code as string);
      expect(minted).not.toContain('EF45GH');
      expect(new Set(minted).size).toBe(minted.length);
      for (const code of minted) expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);

      // And the old code resolves to the archived conference, not to any of the new ones.
      const response = await submit(live, NADIA, 'EF45GH');
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('JOIN_CONFERENCE_ARCHIVED');
      expect(response.json().error.message).toContain('Kickoff 2026');
    });

    /** A draft carries no code at all until it is published. */
    it('mints no code before publish', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);

      const draft = await client.query('select join_code from conference where id = $1', [
        conferenceId,
      ]);
      expect(draft.rows[0].join_code).toBeNull();

      await publish(app, conferenceId);

      const afterwards = await client.query('select join_code from conference where id = $1', [
        conferenceId,
      ]);
      expect(afterwards.rows[0].join_code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    });

    /** The Conference read does not carry the code – only the Organizer's code endpoint does. */
    it('keeps the code off the general conference payload', async () => {
      const { app, conferenceId } = await publishedWithCode('K7RM4P');

      const read = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}`,
        headers: as(PRIYA),
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().joinCode).toBeUndefined();
      expect(read.body).not.toContain('K7RM4P');
    });
  });

  // ---------- Acceptance Scenario S06 (TI07, TI08) ----------

  describe('viewing and regenerating the code', () => {
    it('shows the Admin the code and refuses a member without Admin and a non-member', async () => {
      const { app, conferenceId } = await publishedWithCode('K7RM4P');
      await submit(app, NADIA, 'K7RM4P');

      const admin = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/join-code`,
        headers: as(PRIYA),
      });
      expect(admin.statusCode, admin.body).toBe(200);
      expect(admin.json().joinCode).toBe('K7RM4P');

      // Nadia is a member, but an Attendee – and Oscar is neither.
      for (const sub of [NADIA, OSCAR]) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/conferences/${conferenceId}/join-code`,
          headers: as(sub),
        });
        expect(response.statusCode, sub).toBe(403);
        expect(response.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');
        // The refusal discloses nothing – least of all the code it was guarding.
        expect(response.body).not.toContain('K7RM4P');
      }
    });

    it('invalidates the old code immediately, joins on the new one, and keeps every Attendee', async () => {
      const { app, conferenceId } = await publishedWithCode('K7RM4P', { nextCodes: ['Q4XT8B'] });

      // A room full of attendees joined on the old code.
      for (const sub of [NADIA, OSCAR, ...CROWD]) {
        const joined = await submit(app, sub, 'K7RM4P');
        expect(joined.statusCode, `${sub}: ${joined.body}`).toBe(200);
      }
      const before = await membershipCount(conferenceId);
      expect(before).toBe(CROWD.length + 3); // attendees plus the creator's seed

      // Priya views the code, then regenerates it.
      const viewed = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/join-code`,
        headers: as(PRIYA),
      });
      expect(viewed.json().joinCode).toBe('K7RM4P');

      const regenerated = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/join-code/regenerate`,
        headers: as(PRIYA),
      });
      expect(regenerated.statusCode, regenerated.body).toBe(200);
      const fresh = regenerated.json().joinCode as string;
      expect(fresh).toBe('Q4XT8B');

      // The very next submission of the old code is refused as unknown – it is retained nowhere.
      const stale = await submit(app, `${OSCAR}`, 'K7RM4P');
      expect(stale.statusCode).toBe(404);
      expect(stale.json().error.code).toBe('JOIN_CODE_UNKNOWN');

      // The new one joins.
      const newcomer = await submit(app, PRIYA, fresh);
      expect(newcomer.statusCode, newcomer.body).toBe(200);

      // And nobody was removed.
      expect(await membershipCount(conferenceId)).toBe(before);
    });

    it('refuses to regenerate for a draft, which has no code to replace', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);

      const response = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/join-code/regenerate`,
        headers: as(PRIYA),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('JOIN_CONFERENCE_NOT_PUBLISHED');

      const row = await client.query('select join_code from conference where id = $1', [
        conferenceId,
      ]);
      expect(row.rows[0].join_code).toBeNull();
    });

    it('refuses a non-Admin regenerate and leaves the code untouched', async () => {
      const { app, conferenceId } = await publishedWithCode('K7RM4P');
      await submit(app, NADIA, 'K7RM4P');

      const response = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/join-code/regenerate`,
        headers: as(NADIA),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');

      const row = await client.query('select join_code from conference where id = $1', [
        conferenceId,
      ]);
      expect(row.rows[0].join_code).toBe('K7RM4P');
    });
  });

  // ---------- Acceptance Scenario S07 (TI06) ----------

  describe('the limiter throttles the employee, not the venue', () => {
    /**
     * Every request in this suite arrives over the same in-process transport, so they all share one
     * client address by construction – which is exactly the venue's NAT case. What separates them is
     * the `sub`, and only the `sub`.
     */
    it('lets an employee with one failed attempt join while another sub is throttled', async () => {
      const { app } = await publishedWithCode('K7RM4P');

      // The crowd each mistype once, from the one shared address.
      for (const sub of CROWD) {
        const response = await submit(app, sub, 'ZZZ999');
        expect(response.statusCode, sub).toBe(404);
      }

      // One sub spends its whole allowance.
      for (let attempt = 0; attempt < FAILED_ATTEMPT_LIMIT; attempt += 1) {
        const response = await submit(app, OSCAR, 'ZZZ999');
        expect(response.statusCode, `attempt ${attempt}`).toBe(404);
      }
      const throttled = await submit(app, OSCAR, 'K7RM4P');
      expect(throttled.statusCode).toBe(429);
      expect(throttled.json().error.code).toBe('JOIN_ATTEMPTS_RATE_LIMITED');

      // Everyone else – same address, one failure each – joins normally with the correct code.
      for (const sub of CROWD) {
        const response = await submit(app, sub, 'K7RM4P');
        expect(response.statusCode, `${sub}: ${response.body}`).toBe(200);
      }

      // And the correct code is still refused for the throttled sub, which is the point: the
      // refusal is about the sub's attempts, not about the code being wrong.
      expect((await submit(app, OSCAR, 'K7RM4P')).statusCode).toBe(429);
    });

    it('states when the employee may try again rather than only refusing', async () => {
      const { app } = await publishedWithCode('K7RM4P');
      for (let attempt = 0; attempt < FAILED_ATTEMPT_LIMIT; attempt += 1) {
        await submit(app, OSCAR, 'ZZZ999');
      }

      const response = await submit(app, OSCAR, 'ZZZ999');
      expect(response.statusCode).toBe(429);
      expect(response.json().error.message).toMatch(
        /try again in about \d+ minutes?|in about a minute/i,
      );
    });

    /** A refusal that is already rate-limited must not record yet another attempt. */
    it('does not count a request it refused as rate-limited', async () => {
      const { app } = await publishedWithCode('K7RM4P');
      for (let attempt = 0; attempt < FAILED_ATTEMPT_LIMIT; attempt += 1) {
        await submit(app, OSCAR, 'ZZZ999');
      }

      for (let extra = 0; extra < 5; extra += 1) await submit(app, OSCAR, 'ZZZ999');

      const rows = await client.query(
        'select count(*)::int as count from failed_join_attempt where user_sub = $1',
        [OSCAR],
      );
      expect(rows.rows[0].count).toBe(FAILED_ATTEMPT_LIMIT);
    });

    /**
     * The counter is shared server-side storage, proved by a **separate OS process**: it has no
     * module state to inherit, so the total it reads can only have come from PostgreSQL. An
     * in-process counter passes a two-instances-one-process test and fails this one.
     */
    it('accumulates attempts recorded by a different API process into the same total', async () => {
      const { app } = await publishedWithCode('K7RM4P');

      for (let attempt = 0; attempt < 3; attempt += 1) await submit(app, OSCAR, 'ZZZ999');

      const { stdout } = await run(process.execPath, [
        join(here, 'join-attempt-probe.ts'),
        OSCAR,
        'ZZZ999',
      ]);
      const probe = JSON.parse(stdout) as {
        pid: number;
        status: number;
        errorCode: string | null;
        attempts: number;
      };

      // It really was a different process, and it really did fail to join.
      expect(probe.pid).not.toBe(process.pid);
      expect(probe.status).toBe(404);
      expect(probe.errorCode).toBe('JOIN_CODE_UNKNOWN');

      // Its attempt added to the running total rather than starting a new one.
      expect(probe.attempts).toBe(4);

      // And this process sees the other process's attempt too.
      const { attempts } = await createFailedJoinAttempts(db).window(OSCAR);
      expect(attempts).toBe(4);

      const stored = await client.query(
        'select count(*)::int as count from failed_join_attempt where user_sub = $1',
        [OSCAR],
      );
      expect(stored.rows[0].count).toBe(4);
    });

    /**
     * `greatest()` ignores NULL arguments rather than propagating them, so an empty window reports
     * `0` seconds and not NULL. Asserted because the opposite assumption would put a branch in the
     * message builder that could never be taken, and nothing else would ever reveal it.
     */
    it('reports a zero wait and no attempts for a sub that has never failed', async () => {
      const empty = await createFailedJoinAttempts(db).window(NADIA);
      expect(empty).toEqual({ attempts: 0, retryAfterSeconds: 0 });
    });

    /** With attempts in the window the wait is a real remainder, bounded by the window length. */
    it('reports a wait inside the window once an attempt has been recorded', async () => {
      const { app } = await publishedWithCode('K7RM4P');
      await submit(app, OSCAR, 'ZZZ999');

      const state = await createFailedJoinAttempts(db).window(OSCAR);
      expect(state.attempts).toBe(1);
      expect(state.retryAfterSeconds).toBeGreaterThan(0);
      expect(state.retryAfterSeconds).toBeLessThanOrEqual(FAILED_ATTEMPT_WINDOW_MINUTES * 60);
    });

    /** The path never reads a request address – asserted at the schema, where a column would be. */
    it('stores no client address alongside an attempt', async () => {
      const columns = await client.query(
        "select column_name from information_schema.columns where table_name = 'failed_join_attempt'",
      );
      const names = (columns.rows as { column_name: string }[]).map((row) => row.column_name);
      expect(names.sort()).toEqual(['attempted_at', 'id', 'user_sub']);
    });
  });

  // ---------- Acceptance Scenario S08 (TI06) ----------

  describe('concurrent failed attempts by one sub', () => {
    /**
     * The threshold's worth of failures fired in parallel against the real database. A sequential
     * loop passes against a `select` then `update` counter that loses increments in production, so
     * the sequential test alone proves nothing about atomicity.
     */
    it('records exactly the number made, with the next one refused', async () => {
      const { app } = await publishedWithCode('K7RM4P');

      const responses = await Promise.all(
        Array.from({ length: FAILED_ATTEMPT_LIMIT }, () => submit(app, OSCAR, 'ZZZ999')),
      );
      for (const response of responses) expect(response.statusCode).toBe(404);

      // Asserted twice, on purpose. The row count states it about the store as it is built today;
      // the limiter's own reading states it about whatever the store becomes, so a future switch to
      // an incrementing counter row that loses updates fails here rather than passing quietly.
      const rows = await client.query(
        'select count(*)::int as count from failed_join_attempt where user_sub = $1',
        [OSCAR],
      );
      expect(rows.rows[0].count).toBe(FAILED_ATTEMPT_LIMIT);
      expect((await createFailedJoinAttempts(db).window(OSCAR)).attempts).toBe(
        FAILED_ATTEMPT_LIMIT,
      );

      const eleventh = await submit(app, OSCAR, 'ZZZ999');
      expect(eleventh.statusCode).toBe(429);
      expect(eleventh.json().error.code).toBe('JOIN_ATTEMPTS_RATE_LIMITED');
    });

    /**
     * Attempts either side of a window boundary belong to their own window – none double-counted,
     * none dropped. The older ones are aged past the window by rewriting their timestamps, which is
     * the only way to reach a boundary a test cannot wait ten minutes for.
     */
    it('attributes attempts either side of the window boundary to their own window', async () => {
      const { app } = await publishedWithCode('K7RM4P');
      const limiter = createFailedJoinAttempts(db);

      // Six failures, then age them out of the window.
      for (let attempt = 0; attempt < 6; attempt += 1) await submit(app, OSCAR, 'ZZZ999');
      expect((await limiter.window(OSCAR)).attempts).toBe(6);

      await client.query(
        `update failed_join_attempt
            set attempted_at = clock_timestamp() - make_interval(mins => $2)
          where user_sub = $1`,
        [OSCAR, FAILED_ATTEMPT_WINDOW_MINUTES + 1],
      );
      expect((await limiter.window(OSCAR)).attempts).toBe(0);

      // Six more inside the new window: counted, and not added to the previous six.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await submit(app, OSCAR, 'ZZZ999');
        expect(response.statusCode).toBe(404);
      }
      expect((await limiter.window(OSCAR)).attempts).toBe(6);

      // Which leaves the allowance intact for the correct code, rather than throttled by history.
      const joined = await submit(app, OSCAR, 'K7RM4P');
      expect(joined.statusCode, joined.body).toBe(200);
    });
  });

  // ---------- TI11: retention ----------

  describe('the failed-attempt store does not grow without bound', () => {
    it('prunes aged rows on the next recorded attempt while keeping in-window ones', async () => {
      const { app } = await publishedWithCode('K7RM4P');

      // Five aged failures for Oscar, and three current ones for Nadia.
      for (let attempt = 0; attempt < 5; attempt += 1) await submit(app, OSCAR, 'ZZZ999');
      await client.query(
        `update failed_join_attempt
            set attempted_at = clock_timestamp() - make_interval(mins => $2)
          where user_sub = $1`,
        [OSCAR, FAILED_ATTEMPT_WINDOW_MINUTES + 1],
      );
      for (let attempt = 0; attempt < 3; attempt += 1) await submit(app, NADIA, 'ZZZ999');

      // Nadia's attempts are inside the window, so the sweep they triggered kept them...
      const nadias = await client.query(
        'select count(*)::int as count from failed_join_attempt where user_sub = $1',
        [NADIA],
      );
      expect(nadias.rows[0].count).toBe(3);
      expect((await createFailedJoinAttempts(db).window(NADIA)).attempts).toBe(3);

      // ...and removed Oscar's aged rows entirely, not merely stopped counting them.
      const oscars = await client.query(
        'select count(*)::int as count from failed_join_attempt where user_sub = $1',
        [OSCAR],
      );
      expect(oscars.rows[0].count).toBe(0);

      // Nadia's remaining allowance is intact – pruning did not run too eagerly.
      const joined = await submit(app, NADIA, 'K7RM4P');
      expect(joined.statusCode, joined.body).toBe(200);
    });

    /** Retention is not a manual step: no request, command or schedule outside the write path. */
    it('keeps the store bounded across many attempts with no operational action', async () => {
      const { app } = await publishedWithCode('K7RM4P');

      for (const sub of CROWD) {
        await submit(app, sub, 'ZZZ999');
      }
      await client.query(
        `update failed_join_attempt set attempted_at = clock_timestamp() - make_interval(mins => $1)`,
        [FAILED_ATTEMPT_WINDOW_MINUTES + 1],
      );

      // One further attempt, and nothing else, collapses the store to just that attempt.
      await submit(app, NADIA, 'ZZZ999');

      const total = await client.query('select count(*)::int as count from failed_join_attempt');
      expect(total.rows[0].count).toBe(1);
    });
  });

  // ---------- the migration ----------

  it('reverts the join-code migration cleanly and re-applies', async () => {
    const present = await client.query("select to_regclass('public.failed_join_attempt') as table");
    expect(present.rows[0].table).not.toBeNull();

    const steps = await stepsToRevertThrough(client, '20260817180000000_join-code');
    await migrate('down', String(steps));

    const gone = await client.query("select to_regclass('public.failed_join_attempt') as table");
    expect(gone.rows[0].table).toBeNull();
    const columns = await client.query(
      "select column_name from information_schema.columns where table_name = 'conference' and column_name = 'join_code'",
    );
    expect(columns.rows).toEqual([]);

    await migrate('up');

    const back = await client.query("select to_regclass('public.failed_join_attempt') as table");
    expect(back.rows[0].table).not.toBeNull();
    const restored = await client.query(
      "select column_name from information_schema.columns where table_name = 'conference' and column_name = 'join_code'",
    );
    expect(restored.rows).toHaveLength(1);
  });
});
