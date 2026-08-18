import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join as joinPath } from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDatabase, type Database, type Queryable } from '../src/db.ts';
import { createUserRepository } from '../src/auth/users.ts';
import {
  assertConferenceKeepsAnAdmin,
  lockConference,
} from '../src/conferences/role-repository.ts';
import { fixedClock } from '../src/conferences/calendar-date.ts';
import type { ScheduleGate } from '../src/conferences/schedule-gate.ts';
import { subjectVerifier, tokenFor, unusedCodeExchange } from './fake-auth.ts';
import { stepsToRevertThrough } from './migration-depth.ts';

/**
 * S07's per-conference role model, against the real PostgreSQL the composed stack runs.
 *
 * The negative cases are the subject here, not an afterthought: every protected endpoint gets an
 * explicit under-privileged caller, and the Presenter/Facilitator-on-an-unassigned-Session case is
 * stated for the Session write path specifically. None of that is provable against a fake that
 * answers whatever the test wants – the last-Admin rule in particular is a claim about two
 * concurrent transactions, which only a real database can refute.
 *
 * The verifier *is* stubbed, because who the caller is was settled in the S02 suite and the subject
 * here is what that caller may do.
 */

const run = promisify(execFile);
const repoRoot = joinPath(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
    '\n[integration] SKIPPED per-conference roles – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [joinPath(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: joinPath(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/** The employees every scenario is written around. Lars is the one who has never signed in. */
const PRIYA = 'google-sub-priya';
const BJORN = 'google-sub-bjorn';
const NADIA = 'google-sub-nadia';
const LARS_EMAIL = 'lars@ourcompany.example';

const KICKOFF = { name: 'Kickoff 2026', startDate: '2026-09-14', endDate: '2026-09-16' };
const RETRO = { name: 'Retro 2027', startDate: '2027-03-02', endDate: '2027-03-03' };

const KEYNOTE = {
  title: 'Opening Keynote',
  kind: 'Presentation',
  day: '2026-09-14',
  startTime: '09:00',
  endTime: '10:00',
  location: 'Main hall',
};

const WORKSHOP = {
  title: 'Design Workshop',
  kind: 'Workshop',
  day: '2026-09-14',
  startTime: '11:00',
  endTime: '12:30',
  location: 'Room 2',
};

function gateReporting(hasSession: boolean): ScheduleGate {
  return {
    async hasAtLeastOneSession() {
      return hasSession;
    },
  };
}

describe.skipIf(!reachable)('per-conference roles against a real PostgreSQL', () => {
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
    // Conference rows cascade to memberships, role assignments and session assignments.
    await client.query('delete from conference');
    await client.query('delete from app_user');

    const users = createUserRepository(db);
    for (const sub of [PRIYA, BJORN, NADIA]) {
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

  function appWith(options: { hasSession?: boolean; today?: string } = {}): FastifyInstance {
    const app = buildApp({
      db,
      auth: {
        verifier: subjectVerifier(),
        users: createUserRepository(db),
        codeExchange: unusedCodeExchange(),
      },
      scheduleGate: gateReporting(options.hasSession ?? true),
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
    sub: string,
    details = KICKOFF,
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

  /**
   * Membership, written directly.
   *
   * Standing in for S05's join endpoint, which is proved in its own suite. This story *reads*
   * Membership and never writes it, so producing it here through SQL keeps each test's subject the
   * role model rather than the join flow.
   */
  async function addMember(conferenceId: string, sub: string): Promise<void> {
    await client.query(
      `insert into membership (conference_id, user_sub) values ($1, $2)
       on conflict (conference_id, user_sub) do nothing`,
      [conferenceId, sub],
    );
  }

  async function addSession(
    app: FastifyInstance,
    conferenceId: string,
    admin: string,
    details: Record<string, string> = KEYNOTE,
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions`,
      headers: as(admin),
      payload: details,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().session.id as string;
  }

  async function grant(
    app: FastifyInstance,
    conferenceId: string,
    admin: string,
    email: string,
    role: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/members/roles`,
      headers: as(admin),
      payload: { email, role },
    });
  }

  async function revoke(
    app: FastifyInstance,
    conferenceId: string,
    admin: string,
    sub: string,
    role: string,
  ) {
    return app.inject({
      method: 'DELETE',
      url: `/api/conferences/${conferenceId}/members/${sub}/roles/${role}`,
      headers: as(admin),
    });
  }

  /**
   * The base an S09 write carries – the row version and the Conference's lifecycle state at load.
   *
   * These scenarios are about *who* may write, not about concurrency, so every call reads the
   * current values: the refusal under test must be the authorization one, never a stale base.
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

  async function assignSession(
    app: FastifyInstance,
    conferenceId: string,
    admin: string,
    sessionId: string,
    sub: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/assignments`,
      headers: as(admin),
      payload: { userSub: sub },
    });
  }

  function emailOf(sub: string): string {
    return `${sub}@ourcompany.example`;
  }

  async function rolesOf(conferenceId: string, sub: string): Promise<string[]> {
    const rows = await client.query(
      'select role from role_assignment where conference_id = $1 and user_sub = $2 order by role',
      [conferenceId, sub],
    );
    return rows.rows.map((row) => row.role as string);
  }

  /** A Conference where Björn holds Presenter/Facilitator and both Sessions exist. */
  async function kickoffWithPresenter(app: FastifyInstance): Promise<{
    conferenceId: string;
    keynote: string;
    workshop: string;
  }> {
    const conferenceId = await createConference(app, PRIYA);
    const keynote = await addSession(app, conferenceId, PRIYA, KEYNOTE);
    const workshop = await addSession(app, conferenceId, PRIYA, WORKSHOP);
    await addMember(conferenceId, BJORN);

    const granted = await grant(app, conferenceId, PRIYA, emailOf(BJORN), 'PresenterFacilitator');
    expect(granted.statusCode, granted.body).toBe(200);

    return { conferenceId, keynote, workshop };
  }

  // ---------- Acceptance Scenario S01: a role is meaningful only where it was granted ----------

  describe('a role granted in one conference', () => {
    it('has no effect in another, and leaves the other conference’s roles untouched', async () => {
      const app = appWith();
      const kickoff = await createConference(app, PRIYA, KICKOFF);
      const retro = await createConference(app, BJORN, RETRO);
      await addMember(kickoff, BJORN);

      const granted = await grant(app, kickoff, PRIYA, emailOf(BJORN), 'PresenterFacilitator');
      expect(granted.statusCode, granted.body).toBe(200);

      // Björn's authority in each conference is exactly what was granted there.
      expect(await rolesOf(kickoff, BJORN)).toEqual(['PresenterFacilitator']);
      expect(await rolesOf(retro, BJORN)).toEqual(['Admin']);

      // Keyed on the sub, and on nothing else.
      const stored = await client.query(
        'select user_sub from role_assignment where conference_id = $1 and role = $2',
        [kickoff, 'PresenterFacilitator'],
      );
      expect(stored.rows[0].user_sub).toBe(BJORN);
      expect(stored.rows[0].user_sub).not.toContain('@');
    });

    it('does not let its holder administer a conference they are not in', async () => {
      const app = appWith();
      const retro = await createConference(app, BJORN, RETRO);

      // Priya is an Admin – of a different conference. Here she is nothing at all.
      const refused = await grant(app, retro, PRIYA, emailOf(BJORN), 'Admin');
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');

      expect(await rolesOf(retro, BJORN)).toEqual(['Admin']);
    });
  });

  // ---------- Acceptance Scenario S02: presenting and facilitating are one role ----------

  describe('presenting and facilitating', () => {
    it('are the same role with the same permissions, whatever the session kind', async () => {
      const app = appWith();
      const { conferenceId, keynote, workshop } = await kickoffWithPresenter(app);

      for (const sessionId of [keynote, workshop]) {
        const assigned = await assignSession(app, conferenceId, PRIYA, sessionId, BJORN);
        expect(assigned.statusCode, assigned.body).toBe(200);
      }

      // One role value covers a Presentation and a Workshop alike – the kind is never consulted.
      for (const [sessionId, details] of [
        [keynote, KEYNOTE],
        [workshop, WORKSHOP],
      ] as const) {
        const edited = await app.inject({
          method: 'PATCH',
          url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
          headers: as(BJORN),
          payload: { ...details, location: 'Moved by its holder', base: await baseFor(sessionId) },
        });
        expect(edited.statusCode, `${details.kind}: ${edited.body}`).toBe(200);
      }

      expect(await rolesOf(conferenceId, BJORN)).toEqual(['PresenterFacilitator']);
    });

    /** No separate Presenter or Facilitator role is representable – in the API or the database. */
    it('cannot be split into two roles through the API', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);
      await addMember(conferenceId, BJORN);

      for (const role of ['Presenter', 'Facilitator']) {
        const refused = await grant(app, conferenceId, PRIYA, emailOf(BJORN), role);
        expect(refused.statusCode, role).toBe(400);
      }

      expect(await rolesOf(conferenceId, BJORN)).toEqual([]);
    });

    it('cannot be split into two roles in the database either', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);

      for (const role of ['Presenter', 'Facilitator']) {
        await expect(
          client.query(
            'insert into role_assignment (conference_id, user_sub, role) values ($1, $2, $3)',
            [conferenceId, BJORN, role],
          ),
          role,
        ).rejects.toMatchObject({ code: '23514' });
      }
    });
  });

  // ---------- Acceptance Scenario S03: session scope ----------

  describe('a presenter/facilitator', () => {
    it('edits the session assigned to them and nothing else in the conference', async () => {
      const app = appWith();
      const { conferenceId, keynote, workshop } = await kickoffWithPresenter(app);
      await assignSession(app, conferenceId, PRIYA, keynote, BJORN);

      // 1. Their own session – the one thing they may do.
      const own = await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${conferenceId}/sessions/${keynote}`,
        headers: as(BJORN),
        payload: { ...KEYNOTE, title: 'Opening Keynote, revised', base: await baseFor(keynote) },
      });
      expect(own.statusCode, own.body).toBe(200);

      // 2. A session they are not assigned to.
      const other = await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${conferenceId}/sessions/${workshop}`,
        headers: as(BJORN),
        payload: { ...WORKSHOP, title: 'Hijacked' },
      });
      expect(other.statusCode).toBe(403);
      expect(other.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');

      // 3. The conference itself.
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${conferenceId}`,
        headers: as(BJORN),
        payload: { ...KICKOFF, name: 'Hijacked' },
      });
      expect(renamed.statusCode).toBe(403);

      // 4. Granting a role to somebody else.
      const granting = await grant(app, conferenceId, BJORN, emailOf(NADIA), 'Admin');
      expect(granting.statusCode).toBe(403);

      // Nothing the three refusals touched was persisted.
      const rows = await client.query('select title from sessions where id = $1', [workshop]);
      expect(rows.rows[0].title).toBe('Design Workshop');
      const conference = await client.query('select name from conference where id = $1', [
        conferenceId,
      ]);
      expect(conference.rows[0].name).toBe('Kickoff 2026');
      expect(await rolesOf(conferenceId, NADIA)).toEqual([]);
    });

    it('is refused on creating and deleting sessions, which stay conference-wide acts', async () => {
      const app = appWith();
      const { conferenceId, keynote } = await kickoffWithPresenter(app);
      await assignSession(app, conferenceId, PRIYA, keynote, BJORN);

      const created = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/sessions`,
        headers: as(BJORN),
        payload: { ...KEYNOTE, title: 'Session of my own' },
      });
      expect(created.statusCode).toBe(403);

      // Refused even for the session they hold: removing it changes the schedule everyone reads.
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/conferences/${conferenceId}/sessions/${keynote}`,
        headers: as(BJORN),
      });
      expect(deleted.statusCode).toBe(403);

      const surviving = await client.query(
        'select count(*)::int as count from sessions where conference_id = $1',
        [conferenceId],
      );
      expect(surviving.rows[0].count).toBe(2);
    });

    /** An Admin needs no Session Assignment: their authority is conference-wide. */
    it('is outdone by an admin, who succeeds at all four holding no session assignment', async () => {
      const app = appWith();
      const { conferenceId, keynote, workshop } = await kickoffWithPresenter(app);

      const assignments = await client.query(
        'select count(*)::int as count from session_assignment where conference_id = $1 and user_sub = $2',
        [conferenceId, PRIYA],
      );
      expect(assignments.rows[0].count).toBe(0);

      for (const [sessionId, details] of [
        [keynote, KEYNOTE],
        [workshop, WORKSHOP],
      ] as const) {
        const edited = await app.inject({
          method: 'PATCH',
          url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
          headers: as(PRIYA),
          payload: { ...details, location: 'Moved by the admin', base: await baseFor(sessionId) },
        });
        expect(edited.statusCode, edited.body).toBe(200);
      }

      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${conferenceId}`,
        headers: as(PRIYA),
        payload: {
          ...KICKOFF,
          name: 'Kickoff 2026, renamed',
          base: await conferenceBase(app, conferenceId, PRIYA),
        },
      });
      expect(renamed.statusCode, renamed.body).toBe(200);

      const granted = await grant(app, conferenceId, PRIYA, emailOf(NADIA), 'Admin');
      // Nadia is not a member yet, so this is refused for *that* reason – not for permission.
      expect(granted.json().error.code).toBe('ROLE_TARGET_NOT_A_MEMBER');
    });
  });

  // ---------- Acceptance Scenario S04: every admin-only endpoint refuses a mere attendee ----------

  describe('an attendee of a published conference', () => {
    it('is refused at every protected endpoint S03, S04 and S05 introduced', async () => {
      const app = appWith({ today: '2026-09-17' });
      const conferenceId = await createConference(app, PRIYA);
      const keynote = await addSession(app, conferenceId, PRIYA, KEYNOTE);
      await addMember(conferenceId, NADIA);

      const published = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/publish`,
        headers: as(PRIYA),
      });
      expect(published.statusCode, published.body).toBe(200);

      const endpoints = [
        { method: 'PATCH' as const, url: '', payload: { ...KICKOFF, name: 'Hijacked' } },
        { method: 'POST' as const, url: '/publish' },
        { method: 'POST' as const, url: '/archive' },
        { method: 'POST' as const, url: '/sessions', payload: KEYNOTE },
        { method: 'PATCH' as const, url: `/sessions/${keynote}`, payload: KEYNOTE },
        { method: 'DELETE' as const, url: `/sessions/${keynote}` },
        { method: 'GET' as const, url: '/join-code' },
        { method: 'POST' as const, url: '/join-code/regenerate' },
        { method: 'GET' as const, url: '/members' },
      ];

      for (const endpoint of endpoints) {
        const response = await app.inject({
          method: endpoint.method,
          url: `/api/conferences/${conferenceId}${endpoint.url}`,
          headers: as(NADIA),
          ...(endpoint.payload ? { payload: endpoint.payload } : {}),
        });

        expect(response.statusCode, `${endpoint.method} ${endpoint.url}`).toBe(403);
        // S01's envelope, from the shared check – not a comparison inside the handler.
        expect(response.json().error.code, `${endpoint.method} ${endpoint.url}`).toBe(
          'CONFERENCE_ROLE_REQUIRED',
        );
        expect(typeof response.json().error.message).toBe('string');
      }

      // No state changed behind any of them.
      const row = await client.query('select name, lifecycle_state from conference where id = $1', [
        conferenceId,
      ]);
      expect(row.rows[0]).toEqual({ name: 'Kickoff 2026', lifecycle_state: 'published' });
      const sessions = await client.query(
        'select count(*)::int as count from sessions where conference_id = $1',
        [conferenceId],
      );
      expect(sessions.rows[0].count).toBe(1);
    });
  });

  // ---------- Acceptance Scenario S05 / S06 (TI06): creating consults no instance permission ----

  describe('any authenticated employee', () => {
    it('creates a conference and is seeded both a membership and an admin role assignment', async () => {
      const app = appWith();

      // Nadia holds no role anywhere at all.
      const before = await client.query('select count(*)::int as count from role_assignment');
      expect(before.rows[0].count).toBe(0);

      const conferenceId = await createConference(app, NADIA, {
        name: 'Team Days 2027',
        startDate: '2027-05-03',
        endDate: '2027-05-04',
      });

      const membership = await client.query(
        'select user_sub from membership where conference_id = $1',
        [conferenceId],
      );
      expect(membership.rows).toEqual([{ user_sub: NADIA }]);
      expect(await rolesOf(conferenceId, NADIA)).toEqual(['Admin']);

      // And she is on her own member list from the moment it exists.
      const members = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/members`,
        headers: as(NADIA),
      });
      expect(members.statusCode, members.body).toBe(200);
      expect(members.json().members).toHaveLength(1);
      expect(members.json().members[0].sub).toBe(NADIA);
      expect(members.json().members[0].roles).toEqual(['Admin', 'Attendee']);
    });

    /** No role row can exist that is not scoped to exactly one conference. */
    it('holds no role that is not scoped to a single conference', async () => {
      const column = await client.query(
        `select is_nullable from information_schema.columns
          where table_name = 'role_assignment' and column_name = 'conference_id'`,
      );
      expect(column.rows[0].is_nullable).toBe('NO');

      const assignment = await client.query(
        `select is_nullable from information_schema.columns
          where table_name = 'session_assignment' and column_name = 'conference_id'`,
      );
      expect(assignment.rows[0].is_nullable).toBe('NO');
    });

    it('remains unauthorized on a conference where they are only an attendee', async () => {
      const app = appWith();
      const kickoff = await createConference(app, PRIYA);
      await addMember(kickoff, NADIA);
      await createConference(app, NADIA, {
        name: 'Team Days 2027',
        startDate: '2027-05-03',
        endDate: '2027-05-04',
      });

      // Being an Admin of her own conference buys her nothing here.
      const refused = await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${kickoff}`,
        headers: as(NADIA),
        payload: { ...KICKOFF, name: 'Hijacked' },
      });
      expect(refused.statusCode).toBe(403);
    });

    /** The creator is a normal member: a valid target for a grant and a revoke like anybody else. */
    it('is a valid grant and revoke target in their own conference', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);

      const granted = await grant(app, conferenceId, PRIYA, emailOf(PRIYA), 'PresenterFacilitator');
      expect(granted.statusCode, granted.body).toBe(200);
      expect(await rolesOf(conferenceId, PRIYA)).toEqual(['Admin', 'PresenterFacilitator']);

      const revoked = await revoke(app, conferenceId, PRIYA, PRIYA, 'PresenterFacilitator');
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(await rolesOf(conferenceId, PRIYA)).toEqual(['Admin']);
    });
  });

  // ---------- Acceptance Scenario S06 (TI07): the last admin ----------

  describe('the last admin of a conference', () => {
    it('cannot be removed, including by self-demotion, and the row survives', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);

      for (const attempt of ['first', 'second']) {
        const refused = await revoke(app, conferenceId, PRIYA, PRIYA, 'Admin');
        expect(refused.statusCode, attempt).toBe(409);
        expect(refused.json().error.code).toBe('CONFERENCE_LAST_ADMIN');
        expect(refused.json().error.message).toMatch(/at least one admin/i);
        expect(await rolesOf(conferenceId, PRIYA)).toEqual(['Admin']);
      }
    });

    it('can be removed once a second admin exists', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);
      await addMember(conferenceId, BJORN);

      const granted = await grant(app, conferenceId, PRIYA, emailOf(BJORN), 'Admin');
      expect(granted.statusCode, granted.body).toBe(200);

      const revoked = await revoke(app, conferenceId, PRIYA, PRIYA, 'Admin');
      expect(revoked.statusCode, revoked.body).toBe(200);

      const admins = await client.query(
        "select user_sub from role_assignment where conference_id = $1 and role = 'Admin'",
        [conferenceId],
      );
      expect(admins.rows).toEqual([{ user_sub: BJORN }]);

      // Priya keeps her Membership – revoking a role is not removing a person (FR6 is S08's).
      const membership = await client.query(
        'select count(*)::int as count from membership where conference_id = $1 and user_sub = $2',
        [conferenceId, PRIYA],
      );
      expect(membership.rows[0].count).toBe(1);
    });

    /**
     * The rule under genuine concurrency, which is the only way it can be proved.
     *
     * Two Admins revoke each other in two *overlapping* transactions, and the overlap is forced
     * rather than hoped for: the second transaction reaches for the lock while the first still
     * holds it, with its delete already issued and uncommitted.
     *
     * That interleaving is what makes this test discriminate. Without the row lock the second
     * transaction never waits, and under READ COMMITTED its snapshot still shows the first Admin
     * whose deletion has not committed – so it counts one remaining Admin, passes, and both commit
     * into a conference nobody can administer. `Promise.all` over two repository calls does *not*
     * prove this: it lets the two transactions run end to end in either order, and both orders pass
     * against a read-then-write implementation. This one was checked by removing `for update` and
     * confirming it fails.
     *
     * It drives the two exported pieces – `lockConference` and `assertConferenceKeepsAnAdmin` –
     * directly, because those are what S08 consumes for leaving and removal.
     */
    it('survives two genuinely overlapping revocations, leaving exactly one admin standing', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);
      await addMember(conferenceId, BJORN);
      expect((await grant(app, conferenceId, PRIYA, emailOf(BJORN), 'Admin')).statusCode).toBe(200);

      const first = new pg.Client({ connectionString: url });
      const second = new pg.Client({ connectionString: url });
      await first.connect();
      await second.connect();

      /** The two raw clients as the `Queryable` the exported rule takes. */
      const queryable = (client: pg.Client): Queryable => ({
        async query<T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []) {
          const result = await client.query<T>(text, values as unknown[]);
          return result.rows;
        },
      });

      const dropAdmin = `delete from role_assignment
                          where conference_id = $1 and user_sub = $2 and role = 'Admin'`;

      try {
        // The first transaction takes the lock and removes Priya, without committing.
        await first.query('begin');
        await lockConference(queryable(first), conferenceId);
        await first.query(dropAdmin, [conferenceId, PRIYA]);

        // The second reaches for the same lock while the first still holds it, and must wait.
        await second.query('begin');
        const secondRevocation = (async () => {
          await lockConference(queryable(second), conferenceId);
          await second.query(dropAdmin, [conferenceId, BJORN]);
          await assertConferenceKeepsAnAdmin(queryable(second), conferenceId);
        })();

        // Long enough that an unlocked implementation would have finished its count by now.
        await new Promise((resolve) => setTimeout(resolve, 200));

        // The first still sees Björn, so it is allowed to finish.
        await assertConferenceKeepsAnAdmin(queryable(first), conferenceId);
        await first.query('commit');

        // Released, the second now counts the conference as the first left it: no Admin at all.
        await expect(secondRevocation).rejects.toMatchObject({
          code: 'CONFERENCE_LAST_ADMIN',
        });
        await second.query('rollback');
      } finally {
        await first.query('rollback').catch(() => undefined);
        await second.query('rollback').catch(() => undefined);
        await first.end();
        await second.end();
      }

      const admins = await client.query(
        "select user_sub from role_assignment where conference_id = $1 and role = 'Admin'",
        [conferenceId],
      );
      expect(admins.rows).toEqual([{ user_sub: BJORN }]);
    });
  });

  // ---------- Acceptance Scenario S07 (TI08): the target must resolve to a sub ----------

  describe('a grant target', () => {
    it('who has never signed in is refused, naming the sign-in requirement, and writes nothing', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);

      const refused = await grant(app, conferenceId, PRIYA, LARS_EMAIL, 'PresenterFacilitator');

      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('ROLE_TARGET_NOT_SIGNED_IN');
      expect(refused.json().error.message).toMatch(/sign in/i);

      const written = await client.query(
        'select count(*)::int as count from role_assignment where conference_id = $1',
        [conferenceId],
      );
      // Only the creator's own Admin row, which the grant did not add to.
      expect(written.rows[0].count).toBe(1);
    });

    /**
     * The Discovered Requirement recorded in the FIS: an address can name two people, because
     * `app_user` carries no unique index on email and a reissued address leaves both rows holding
     * it. Refused rather than resolved to whichever row sorted first.
     */
    it('whose address matches two accounts is refused as ambiguous, with its own code', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);
      await addMember(conferenceId, BJORN);
      await addMember(conferenceId, NADIA);

      // A leaver who never signs in again keeps the address; the new holder signs in and gets it too.
      const shared = 'shared.address@ourcompany.example';
      await client.query('update app_user set email = $2 where sub = $1', [BJORN, shared]);
      await client.query('update app_user set email = $2 where sub = $1', [NADIA, shared]);

      const refused = await grant(app, conferenceId, PRIYA, shared, 'PresenterFacilitator');

      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('ROLE_TARGET_AMBIGUOUS');
      expect(refused.json().error.message).toMatch(/more than one/i);

      expect(await rolesOf(conferenceId, BJORN)).toEqual([]);
      expect(await rolesOf(conferenceId, NADIA)).toEqual([]);
    });

    it('who is not a member is refused for that reason, with a different code again', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);

      const refused = await grant(app, conferenceId, PRIYA, emailOf(NADIA), 'Admin');
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('ROLE_TARGET_NOT_A_MEMBER');
    });

    /** The stored key is the sub, so a later email change leaves the role intact and resolvable. */
    it('keeps their role when their email address changes afterwards', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);
      await addMember(conferenceId, BJORN);

      const granted = await grant(app, conferenceId, PRIYA, emailOf(BJORN), 'PresenterFacilitator');
      expect(granted.statusCode, granted.body).toBe(200);

      const stored = await client.query(
        'select user_sub from role_assignment where conference_id = $1 and role = $2',
        [conferenceId, 'PresenterFacilitator'],
      );
      expect(stored.rows[0].user_sub).toBe(BJORN);

      // Björn is renamed. Nothing keyed, joined or looked the assignment up by address.
      await client.query('update app_user set email = $2 where sub = $1', [
        BJORN,
        'bjorn.newname@ourcompany.example',
      ]);

      expect(await rolesOf(conferenceId, BJORN)).toEqual(['PresenterFacilitator']);

      const members = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/members`,
        headers: as(PRIYA),
      });
      const bjorn = members.json().members.find((member: { sub: string }) => member.sub === BJORN);
      expect(bjorn.roles).toContain('PresenterFacilitator');
      expect(bjorn.email).toBe('bjorn.newname@ourcompany.example');
    });

    it('is never recorded by address on any assignment row', async () => {
      for (const table of ['role_assignment', 'session_assignment']) {
        const columns = await client.query(
          'select column_name from information_schema.columns where table_name = $1',
          [table],
        );
        expect(
          columns.rows.map((row) => row.column_name),
          table,
        ).not.toContain('email');
      }
    });
  });

  // ---------- Acceptance Scenario S08: an archived conference ----------

  describe('an archived conference', () => {
    async function archivedKickoff(app: FastifyInstance): Promise<{
      conferenceId: string;
      keynote: string;
    }> {
      const conferenceId = await createConference(app, PRIYA);
      const keynote = await addSession(app, conferenceId, PRIYA, KEYNOTE);
      await addMember(conferenceId, BJORN);
      expect(
        (await grant(app, conferenceId, PRIYA, emailOf(BJORN), 'PresenterFacilitator')).statusCode,
      ).toBe(200);
      expect((await assignSession(app, conferenceId, PRIYA, keynote, BJORN)).statusCode).toBe(200);

      await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/publish`,
        headers: as(PRIYA),
      });
      const archived = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/archive`,
        headers: as(PRIYA),
      });
      expect(archived.statusCode, archived.body).toBe(200);
      return { conferenceId, keynote };
    }

    it('refuses a grant, a revoke and a session assignment, each naming the archived state', async () => {
      const app = appWith({ today: '2026-09-17' });
      const { conferenceId, keynote } = await archivedKickoff(app);

      const attempts = [
        await grant(app, conferenceId, PRIYA, emailOf(BJORN), 'Admin'),
        await revoke(app, conferenceId, PRIYA, BJORN, 'PresenterFacilitator'),
        await assignSession(app, conferenceId, PRIYA, keynote, BJORN),
      ];

      for (const response of attempts) {
        expect(response.statusCode).toBe(409);
        // The guard S03 exported, not a re-derived archived check – so the code is its code.
        expect(response.json().error.code).toBe('CONFERENCE_NOT_EDITABLE');
        expect(response.json().error.message).toMatch(/archived/i);
      }
    });

    it('keeps its role and session assignments, and they stay readable', async () => {
      const app = appWith({ today: '2026-09-17' });
      const { conferenceId, keynote } = await archivedKickoff(app);

      expect(await rolesOf(conferenceId, BJORN)).toEqual(['PresenterFacilitator']);

      const members = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/members`,
        headers: as(PRIYA),
      });
      expect(members.statusCode, members.body).toBe(200);

      const bjorn = members.json().members.find((member: { sub: string }) => member.sub === BJORN);
      expect(bjorn.sessionIds).toEqual([keynote]);
    });

    /** The two refusal reasons this story introduces carry different machine codes. */
    it('refuses for a different reason, and with a different code, than a never-signed-in target', async () => {
      const app = appWith({ today: '2026-09-17' });
      const { conferenceId } = await archivedKickoff(app);

      const archived = await grant(app, conferenceId, PRIYA, emailOf(BJORN), 'Admin');
      expect(archived.json().error.code).toBe('CONFERENCE_NOT_EDITABLE');

      const draft = await createConference(app, PRIYA, RETRO);
      const unknown = await grant(app, draft, PRIYA, LARS_EMAIL, 'Admin');
      expect(unknown.json().error.code).toBe('ROLE_TARGET_NOT_SIGNED_IN');

      expect(archived.json().error.code).not.toBe(unknown.json().error.code);
    });
  });

  // ---------- TI09: session assignments ----------

  describe('assigning a presenter/facilitator to sessions', () => {
    it('yields one row per session and lists the holders on each session', async () => {
      const app = appWith();
      const { conferenceId, keynote, workshop } = await kickoffWithPresenter(app);

      for (const sessionId of [keynote, workshop]) {
        expect((await assignSession(app, conferenceId, PRIYA, sessionId, BJORN)).statusCode).toBe(
          200,
        );
      }

      const rows = await client.query(
        'select session_id from session_assignment where conference_id = $1 and user_sub = $2 order by session_id',
        [conferenceId, BJORN],
      );
      expect(rows.rows).toHaveLength(2);

      const members = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/members`,
        headers: as(PRIYA),
      });
      const body = members.json();

      // Both directions from one read, and they agree with each other.
      const bjorn = body.members.find((member: { sub: string }) => member.sub === BJORN);
      expect([...bjorn.sessionIds].sort()).toEqual([keynote, workshop].sort());
      for (const session of body.sessions) {
        expect(session.holders, session.title).toEqual([BJORN]);
      }
    });

    it('is refused for somebody who does not hold the role in that conference', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);
      const keynote = await addSession(app, conferenceId, PRIYA, KEYNOTE);
      await addMember(conferenceId, NADIA);

      const refused = await assignSession(app, conferenceId, PRIYA, keynote, NADIA);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('SESSION_ASSIGNMENT_ROLE_REQUIRED');

      const rows = await client.query(
        'select count(*)::int as count from session_assignment where conference_id = $1',
        [conferenceId],
      );
      expect(rows.rows[0].count).toBe(0);
    });

    it('leaves no orphan behind when the role is revoked', async () => {
      const app = appWith();
      const { conferenceId, keynote, workshop } = await kickoffWithPresenter(app);
      for (const sessionId of [keynote, workshop]) {
        await assignSession(app, conferenceId, PRIYA, sessionId, BJORN);
      }

      const revoked = await revoke(app, conferenceId, PRIYA, BJORN, 'PresenterFacilitator');
      expect(revoked.statusCode, revoked.body).toBe(200);

      const rows = await client.query(
        'select count(*)::int as count from session_assignment where conference_id = $1 and user_sub = $2',
        [conferenceId, BJORN],
      );
      expect(rows.rows[0].count).toBe(0);

      // The Membership is untouched: a revoked role is not a removed person.
      const membership = await client.query(
        'select count(*)::int as count from membership where conference_id = $1 and user_sub = $2',
        [conferenceId, BJORN],
      );
      expect(membership.rows[0].count).toBe(1);
    });

    it('accepts the conference creator like any other member', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);
      const keynote = await addSession(app, conferenceId, PRIYA, KEYNOTE);

      expect(
        (await grant(app, conferenceId, PRIYA, emailOf(PRIYA), 'PresenterFacilitator')).statusCode,
      ).toBe(200);
      expect((await assignSession(app, conferenceId, PRIYA, keynote, PRIYA)).statusCode).toBe(200);
    });

    /**
     * The recorded owner decision: assignment is not a pre-publish step. A conference with no
     * assignment at all publishes, and a session is assignable afterwards exactly as before.
     */
    it('is not required before publish, and stays possible after it', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);
      const keynote = await addSession(app, conferenceId, PRIYA, KEYNOTE);
      await addMember(conferenceId, BJORN);

      const assignments = await client.query(
        'select count(*)::int as count from session_assignment where conference_id = $1',
        [conferenceId],
      );
      expect(assignments.rows[0].count).toBe(0);

      const published = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/publish`,
        headers: as(PRIYA),
      });
      expect(published.statusCode, published.body).toBe(200);

      expect(
        (await grant(app, conferenceId, PRIYA, emailOf(BJORN), 'PresenterFacilitator')).statusCode,
      ).toBe(200);
      expect((await assignSession(app, conferenceId, PRIYA, keynote, BJORN)).statusCode).toBe(200);
    });

    it('is removed again by unassigning, leaving the role in place', async () => {
      const app = appWith();
      const { conferenceId, keynote } = await kickoffWithPresenter(app);
      await assignSession(app, conferenceId, PRIYA, keynote, BJORN);

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/conferences/${conferenceId}/sessions/${keynote}/assignments/${BJORN}`,
        headers: as(PRIYA),
      });
      expect(removed.statusCode, removed.body).toBe(200);

      expect(await rolesOf(conferenceId, BJORN)).toEqual(['PresenterFacilitator']);

      // And the scope check now refuses them for the session they no longer hold.
      const edit = await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${conferenceId}/sessions/${keynote}`,
        headers: as(BJORN),
        payload: { ...KEYNOTE, title: 'No longer mine' },
      });
      expect(edit.statusCode).toBe(403);
    });
  });

  // ---------- TI01: the schema itself ----------

  describe('the session assignment table', () => {
    it('refuses the same holder on the same session twice', async () => {
      const app = appWith();
      const { conferenceId, keynote } = await kickoffWithPresenter(app);
      await assignSession(app, conferenceId, PRIYA, keynote, BJORN);

      await expect(
        client.query(
          'insert into session_assignment (conference_id, session_id, user_sub) values ($1, $2, $3)',
          [conferenceId, keynote, BJORN],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    /** Conference-scoped structurally: a session from another conference cannot be named. */
    it('refuses a session that belongs to a different conference', async () => {
      const app = appWith();
      const kickoff = await createConference(app, PRIYA, KICKOFF);
      const retro = await createConference(app, PRIYA, RETRO);
      const keynote = await addSession(app, kickoff, PRIYA, KEYNOTE);

      await expect(
        client.query(
          'insert into session_assignment (conference_id, session_id, user_sub) values ($1, $2, $3)',
          [retro, keynote, PRIYA],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('is removed with its session', async () => {
      const app = appWith();
      const { conferenceId, keynote, workshop } = await kickoffWithPresenter(app);
      await assignSession(app, conferenceId, PRIYA, keynote, BJORN);

      const keynoteBase = await baseFor(keynote);
      const deleted = await app.inject({
        method: 'DELETE',
        url:
          `/api/conferences/${conferenceId}/sessions/${keynote}` +
          `?conferenceState=${keynoteBase.conferenceState}` +
          `&version=${encodeURIComponent(keynoteBase.version)}`,
        headers: as(PRIYA),
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(workshop).toBeDefined();

      const rows = await client.query(
        'select count(*)::int as count from session_assignment where session_id = $1',
        [keynote],
      );
      expect(rows.rows[0].count).toBe(0);
    });

    it('reverts cleanly and re-applies', async () => {
      const present = await client.query('select to_regclass($1) as table', [
        'public.session_assignment',
      ]);
      expect(present.rows[0].table).not.toBeNull();

      const steps = await stepsToRevertThrough(client, '20260817210000000_session-assignment');
      await migrate('down', String(steps));

      const gone = await client.query('select to_regclass($1) as table', [
        'public.session_assignment',
      ]);
      expect(gone.rows[0].table).toBeNull();

      await migrate('up');

      const back = await client.query('select to_regclass($1) as table', [
        'public.session_assignment',
      ]);
      expect(back.rows[0].table).not.toBeNull();
    });
  });

  // ---------- TI02: what the check itself resolves ----------

  describe('the canonical role check', () => {
    it('grants an admin a required attendee check and refuses an attendee a required admin one', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);
      await addMember(conferenceId, NADIA);
      await addSession(app, conferenceId, PRIYA, KEYNOTE);
      await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/publish`,
        headers: as(PRIYA),
      });

      // The Admin passes a membership-level read of their own conference.
      const adminRead = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/schedule`,
        headers: as(PRIYA),
      });
      expect(adminRead.statusCode, adminRead.body).toBe(200);

      // The Attendee fails an Admin-level one.
      const attendeeWrite = await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${conferenceId}`,
        headers: as(NADIA),
        payload: { ...KICKOFF, name: 'Hijacked' },
      });
      expect(attendeeWrite.statusCode).toBe(403);
    });

    /**
     * No authority without a Membership row. The grant path cannot produce this state – a target
     * must already be a member – so it is written directly, which is the only way to prove the
     * check refuses a role holder who is not in the conference rather than trusting the data.
     */
    it('refuses a role holder who has no membership for the conference', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);

      await client.query(
        "insert into role_assignment (conference_id, user_sub, role) values ($1, $2, 'Admin')",
        [conferenceId, BJORN],
      );
      const membership = await client.query(
        'select count(*)::int as count from membership where conference_id = $1 and user_sub = $2',
        [conferenceId, BJORN],
      );
      expect(membership.rows[0].count).toBe(0);

      const refused = await app.inject({
        method: 'PATCH',
        url: `/api/conferences/${conferenceId}`,
        headers: as(BJORN),
        payload: { ...KICKOFF, name: 'Member by implication' },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');
    });

    it('re-reads its rows per request, so a revoked role takes effect on the next call', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, PRIYA);
      await addMember(conferenceId, BJORN);
      await grant(app, conferenceId, PRIYA, emailOf(BJORN), 'Admin');

      const before = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/members`,
        headers: as(BJORN),
      });
      expect(before.statusCode, before.body).toBe(200);

      await revoke(app, conferenceId, PRIYA, BJORN, 'Admin');

      // Same app instance, same process: nothing was cached from the call that succeeded.
      const after = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/members`,
        headers: as(BJORN),
      });
      expect(after.statusCode).toBe(403);
    });
  });
});
