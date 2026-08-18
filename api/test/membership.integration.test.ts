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
import { createMembershipRepository } from '../src/conferences/membership-repository.ts';
import { fixedClock } from '../src/conferences/calendar-date.ts';
import type { ScheduleGate } from '../src/conferences/schedule-gate.ts';
import { subjectVerifier, tokenFor, unusedCodeExchange } from './fake-auth.ts';

/**
 * S08's membership revocation, against the real PostgreSQL the composed stack runs.
 *
 * Everything this story claims is a claim about *rows*: that exactly two kinds of them go, that
 * nothing else does, that the last Admin cannot be the one who goes, and that two departures
 * happening at once cannot both be allowed. None of that is provable against a fake – a stand-in
 * answers whatever the test asks it to, and the failure modes here (a cascading delete rule, a
 * read-then-write last-Admin check, a half-committed revocation) are precisely the ones a fake
 * cannot express.
 *
 * The verifier *is* stubbed, because who the caller is was settled in the S02 suite and the subject
 * here is what happens to their Membership.
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
    '\n[integration] SKIPPED membership management – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [joinPath(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: joinPath(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/** The employees every scenario is written around. */
const PRIYA = 'google-sub-priya';
const BJORN = 'google-sub-bjorn';
const NADIA = 'google-sub-nadia';
const OLA = 'google-sub-ola';
const IDA = 'google-sub-ida';
const EVERYONE = [PRIYA, BJORN, NADIA, OLA, IDA];

const KICKOFF = { name: 'Kickoff 2026', startDate: '2026-09-14', endDate: '2026-09-16' };
const RETRO = { name: 'Retro 2026', startDate: '2026-11-02', endDate: '2026-11-03' };

const KEYNOTE = {
  title: 'Opening Keynote',
  kind: 'Presentation',
  day: '2026-09-14',
  startTime: '09:00',
  endTime: '10:00',
  location: 'Main hall',
};

/** Retro runs in November, so its session has to fall inside its own span, not Kickoff's. */
const RETRO_SESSION = { ...KEYNOTE, title: 'Looking Back', day: '2026-11-02' };

/**
 * A stand-in for the participation records later phases add – post-its, votes, group memberships.
 *
 * Keyed the way those will be, on the user's `sub` and the Conference, with no reference to the
 * Membership row and no cascading rule off `app_user`. It exists because FR6's promise ("nothing
 * the person contributed is erased") has to be provable now, while the tables it is about are still
 * two phases away: revocation must be scoped so tightly that a table it has never heard of survives
 * it. A behavioural assertion over today's tables alone would pass for a delete that cascades.
 */
const PARTICIPATION = `
  create table if not exists test_participation_record (
    id            uuid primary key default gen_random_uuid(),
    conference_id uuid not null references conference (id) on delete cascade,
    user_sub      text not null references app_user (sub),
    body          text not null
  )
`;

function gateReporting(hasSession: boolean): ScheduleGate {
  return {
    async hasAtLeastOneSession() {
      return hasSession;
    },
  };
}

describe.skipIf(!reachable)('membership revocation against a real PostgreSQL', () => {
  const url = testDatabaseUrl!;
  let db: Database;
  let client: pg.Client;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    await migrate('up');
    db = createDatabase(url, { error: () => {} });
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(PARTICIPATION);
  });

  afterAll(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await client.query('drop table if exists test_participation_record');
    await client.end();
    await db.close();
  });

  beforeEach(async () => {
    await client.query('delete from test_participation_record');
    // Conference rows cascade to memberships, role assignments and session assignments.
    await client.query('delete from conference');
    await client.query('delete from app_user');

    const users = createUserRepository(db);
    for (const sub of EVERYONE) {
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

  // ---------- the fixtures every scenario is built from ----------

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

  async function publish(app: FastifyInstance, conferenceId: string, admin: string): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/publish`,
      headers: as(admin),
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  /** The code an employee would read off the slide, as the organizer endpoint reports it. */
  async function joinCodeOf(
    app: FastifyInstance,
    conferenceId: string,
    admin: string,
  ): Promise<string> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/join-code`,
      headers: as(admin),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().joinCode as string;
  }

  /**
   * Membership as S05 writes it – through the join endpoint, so nothing here fakes joining.
   *
   * Deliberately not named `join`: this module imports `node:path`, and a domain helper by that
   * name shadows the path join with a failure that surfaces far from its cause
   * (`docs/LEARNINGS.md` → Process & Tooling).
   */
  async function enterCode(app: FastifyInstance, sub: string, code: string) {
    return app.inject({ method: 'POST', url: '/api/join', headers: as(sub), payload: { code } });
  }

  async function entersCode(app: FastifyInstance, sub: string, code: string): Promise<void> {
    const response = await enterCode(app, sub, code);
    expect(response.statusCode, response.body).toBe(200);
  }

  /**
   * The conference every scenario starts from: created, with one session, published, and joinable.
   * Returns what the scenarios need to name – its id, its session, and the code employees type.
   */
  async function publishedKickoff(
    app: FastifyInstance,
    admin = PRIYA,
    details = KICKOFF,
    session = KEYNOTE,
  ): Promise<{ conferenceId: string; keynote: string; code: string }> {
    const conferenceId = await createConference(app, admin, details);
    const keynote = await addSession(app, conferenceId, admin, session);
    await publish(app, conferenceId, admin);
    return { conferenceId, keynote, code: await joinCodeOf(app, conferenceId, admin) };
  }

  async function grant(
    app: FastifyInstance,
    conferenceId: string,
    admin: string,
    sub: string,
    role: string,
  ): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/members/roles`,
      headers: as(admin),
      payload: { email: `${sub}@ourcompany.example`, role },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function leave(app: FastifyInstance, conferenceId: string, sub: string, payload?: unknown) {
    return app.inject({
      method: 'DELETE',
      url: `/api/conferences/${conferenceId}/membership`,
      headers: as(sub),
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function remove(app: FastifyInstance, conferenceId: string, admin: string, target: string) {
    return app.inject({
      method: 'DELETE',
      url: `/api/conferences/${conferenceId}/members/${target}`,
      headers: as(admin),
    });
  }

  // ---------- what the tables hold ----------

  async function isMember(conferenceId: string, sub: string): Promise<boolean> {
    const rows = await client.query(
      'select id from membership where conference_id = $1 and user_sub = $2',
      [conferenceId, sub],
    );
    return rows.rows.length === 1;
  }

  async function rolesOf(conferenceId: string, sub: string): Promise<string[]> {
    const rows = await client.query(
      'select role from role_assignment where conference_id = $1 and user_sub = $2 order by role',
      [conferenceId, sub],
    );
    return rows.rows.map((row) => row.role as string);
  }

  async function adminsOf(conferenceId: string): Promise<string[]> {
    const rows = await client.query(
      "select user_sub from role_assignment where conference_id = $1 and role = 'Admin' order by user_sub",
      [conferenceId],
    );
    return rows.rows.map((row) => row.user_sub as string);
  }

  /**
   * Every row of every table a revocation can touch, so a test can assert nothing at all was
   * written – not merely that a success status came back. A handler that deleted zero rows and one
   * that deleted the wrong rows both answer 200.
   */
  async function snapshot(): Promise<unknown[]> {
    const memberships = await client.query(
      'select conference_id, user_sub, joined_at from membership order by conference_id, user_sub',
    );
    const assignments = await client.query(
      'select conference_id, user_sub, role from role_assignment order by conference_id, user_sub, role',
    );
    const sessions = await client.query(
      'select conference_id, session_id, user_sub from session_assignment order by conference_id, session_id, user_sub',
    );
    return [...memberships.rows, ...assignments.rows, ...sessions.rows];
  }

  // ---------- Acceptance Scenario S01 (TI01, TI04, TI06) ----------

  describe('an attendee who leaves', () => {
    it('loses the membership, and is refused the schedule on the very next request', async () => {
      const app = appWith();
      const { conferenceId: kickoff, code } = await publishedKickoff(app);
      await entersCode(app, NADIA, code);

      // She is in, and the schedule is hers to read.
      const before = await app.inject({
        method: 'GET',
        url: `/api/conferences/${kickoff}/schedule`,
        headers: as(NADIA),
      });
      expect(before.statusCode, before.body).toBe(200);

      const left = await leave(app, kickoff, NADIA);
      expect(left.statusCode, left.body).toBe(200);
      expect(await isMember(kickoff, NADIA)).toBe(false);

      // The next request, on the same sign-in and the same connection.
      const after = await app.inject({
        method: 'GET',
        url: `/api/conferences/${kickoff}/schedule`,
        headers: as(NADIA),
      });
      expect(after.statusCode).toBe(403);
      // S01's envelope, with a displayable sentence and a machine code.
      expect(after.json().error.code).toBe('NOT_A_MEMBER');
      expect(after.json().error.message).toMatch(/not joined this conference/i);

      // Nothing about the sign-in was touched: no session was terminated, no token invalidated.
      const me = await app.inject({ method: 'GET', url: '/api/me', headers: as(NADIA) });
      expect(me.statusCode, me.body).toBe(200);
      expect(me.json().sub).toBe(NADIA);

      // And the conference is gone from her list, because that list is derived from membership.
      const mine = await app.inject({
        method: 'GET',
        url: '/api/me/conferences',
        headers: as(NADIA),
      });
      expect(mine.json().conferences).toEqual([]);
    });

    it('keeps every other conference they are in', async () => {
      const app = appWith();
      const kickoff = await publishedKickoff(app);
      await entersCode(app, NADIA, kickoff.code);

      const retro = await publishedKickoff(app, IDA, RETRO, RETRO_SESSION);
      await entersCode(app, NADIA, retro.code);

      expect((await leave(app, kickoff.conferenceId, NADIA)).statusCode).toBe(200);

      expect(await isMember(kickoff.conferenceId, NADIA)).toBe(false);
      expect(await isMember(retro.conferenceId, NADIA)).toBe(true);

      const readable = await app.inject({
        method: 'GET',
        url: '/api/me/conferences',
        headers: as(NADIA),
      });
      expect(readable.json().conferences.map((entry: { id: string }) => entry.id)).toEqual([
        retro.conferenceId,
      ]);
    });

    /**
     * The leave endpoint names nobody, so it cannot be pointed at anybody.
     *
     * A body naming another user is not rejected – it is simply not read. The target is the `sub`
     * S02 verified, and the only Membership this request can end is the caller's own.
     */
    it('cannot be pointed at somebody else by sending a target in the request', async () => {
      const app = appWith();
      const { conferenceId: kickoff, code } = await publishedKickoff(app);
      await entersCode(app, NADIA, code);
      await entersCode(app, OLA, code);

      const left = await leave(app, kickoff, NADIA, { userSub: OLA, conferenceId: kickoff });
      expect(left.statusCode, left.body).toBe(200);

      expect(await isMember(kickoff, NADIA)).toBe(false);
      expect(await isMember(kickoff, OLA)).toBe(true);
    });
  });

  // ---------- Acceptance Scenario S03 (TI05) ----------

  describe('removing a member', () => {
    it('is allowed to an admin of that conference, and to nobody else', async () => {
      const app = appWith();
      const { conferenceId: kickoff, code } = await publishedKickoff(app);
      for (const sub of [OLA, BJORN, NADIA]) await entersCode(app, sub, code);

      // Ida is an Admin – of a different conference, and not a member of this one.
      await createConference(app, IDA, RETRO);

      const removed = await remove(app, kickoff, PRIYA, OLA);
      expect(removed.statusCode, removed.body).toBe(200);
      expect(await isMember(kickoff, OLA)).toBe(false);

      for (const [caller, who] of [
        [BJORN, 'a member holding no admin role'],
        [IDA, 'an admin of another conference'],
      ] as const) {
        const refused = await remove(app, kickoff, caller, NADIA);
        expect(refused.statusCode, who).toBe(403);
        expect(refused.json().error.code, who).toBe('CONFERENCE_ROLE_REQUIRED');
        expect(typeof refused.json().error.message).toBe('string');
        expect(await isMember(kickoff, NADIA), who).toBe(true);
      }
    });

    /** The second removal of the same person: success, and provably not a second delete. */
    it('succeeds as a no-op for somebody who is not a member, writing nothing at all', async () => {
      const app = appWith();
      const { conferenceId: kickoff, code } = await publishedKickoff(app);
      await entersCode(app, OLA, code);

      expect((await remove(app, kickoff, PRIYA, OLA)).statusCode).toBe(200);
      expect(await isMember(kickoff, OLA)).toBe(false);
      expect(await rolesOf(kickoff, OLA)).toEqual([]);

      const before = await snapshot();
      const again = await remove(app, kickoff, PRIYA, OLA);
      expect(again.statusCode, again.body).toBe(200);
      // Not merely "a success status": no row was added, removed or modified by the second call.
      expect(await snapshot()).toEqual(before);

      // A `sub` nobody has ever held is the same case, and is equally not an error.
      const stranger = await remove(app, kickoff, PRIYA, 'google-sub-nobody');
      expect(stranger.statusCode, stranger.body).toBe(200);
      expect(await snapshot()).toEqual(before);
    });
  });

  // ---------- TI04 / TI05: who reaches the handlers at all ----------

  describe('both endpoints', () => {
    it('are refused before any handler code runs when the caller is not signed in', async () => {
      const app = appWith();
      const { conferenceId: kickoff, code } = await publishedKickoff(app);
      await entersCode(app, NADIA, code);

      const before = await snapshot();

      for (const url of [
        `/api/conferences/${kickoff}/membership`,
        `/api/conferences/${kickoff}/members/${NADIA}`,
      ]) {
        const refused = await app.inject({ method: 'DELETE', url });

        expect(refused.statusCode, url).toBe(401);
        // S02's wrapper, not this story's code: the caller was never resolved.
        expect(refused.json().error.code, url).toBe('AUTH_CREDENTIAL_MISSING');
      }

      expect(await snapshot()).toEqual(before);
    });

    /**
     * Leaving something you are not in.
     *
     * Refused by the same canonical check every other endpoint here uses, and told nothing further
     * – not whether the conference exists, not what state it is in. The no-op rule the PRD states
     * is about an *Admin removing* a non-member; a stranger's leave has no membership to be
     * idempotent about and is simply not their business.
     */
    it('refuse a leave from somebody who never joined, and write nothing', async () => {
      const app = appWith();
      const { conferenceId: kickoff } = await publishedKickoff(app);

      const before = await snapshot();
      const refused = await leave(app, kickoff, OLA);

      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');
      expect(await snapshot()).toEqual(before);
    });
  });

  // ---------- Acceptance Scenario S04 (TI02, TI04, TI05) ----------

  describe('the last admin', () => {
    async function soleAdminKickoff(app: FastifyInstance): Promise<string> {
      const { conferenceId, code } = await publishedKickoff(app);
      for (const sub of [BJORN, NADIA, OLA]) await entersCode(app, sub, code);
      return conferenceId;
    }

    it('can neither leave nor be removed, and keeps both their membership and their role', async () => {
      const app = appWith();
      const kickoff = await soleAdminKickoff(app);

      const attempts = [
        await leave(app, kickoff, PRIYA),
        // Removal by the only admin of themselves is the same rule, reached from the other path.
        await remove(app, kickoff, PRIYA, PRIYA),
      ];

      for (const refused of attempts) {
        expect(refused.statusCode, refused.body).toBe(409);
        expect(refused.json().error.code).toBe('CONFERENCE_LAST_ADMIN');
        expect(refused.json().error.message).toMatch(/make somebody else an admin first/i);
      }
      // The refusal for a departure says so, rather than talking about removing a role.
      expect(attempts[0]!.json().error.message).toMatch(/leave this conference/i);
      expect(attempts[1]!.json().error.message).toMatch(/remove this person/i);

      expect(await isMember(kickoff, PRIYA)).toBe(true);
      expect(await rolesOf(kickoff, PRIYA)).toEqual(['Admin']);
    });

    it('leaves successfully once a second admin exists, taking their admin role with them', async () => {
      const app = appWith();
      const kickoff = await soleAdminKickoff(app);
      await grant(app, kickoff, PRIYA, BJORN, 'Admin');

      const left = await leave(app, kickoff, PRIYA);
      expect(left.statusCode, left.body).toBe(200);

      expect(await isMember(kickoff, PRIYA)).toBe(false);
      expect(await rolesOf(kickoff, PRIYA)).toEqual([]);
      expect(await adminsOf(kickoff)).toEqual([BJORN]);
    });

    /**
     * The rule under genuine concurrency, which is the only way it can be proved.
     *
     * The overlap is forced rather than hoped for: a third connection holds the Conference row
     * first, so both revocations are *already in flight* and blocked on the same lock before either
     * can count anything. Released, they run one after the other and the second sees the conference
     * as the first left it.
     *
     * That interleaving is what discriminates. Without the lock both transactions would count two
     * Admins under their own snapshots, both would pass, and the conference would end with none –
     * which `Promise.all` over two calls does *not* prove on its own, because it also permits the
     * two to run end to end in either order, and both orders pass a read-then-write implementation.
     */
    it('survives two overlapping departures – exactly one succeeds and an admin is always left', async () => {
      for (const second of ['leave', 'remove'] as const) {
        const app = appWith();
        const kickoff = await soleAdminKickoff(app);
        await grant(app, kickoff, PRIYA, BJORN, 'Admin');

        const gate = new pg.Client({ connectionString: url });
        await gate.connect();
        await gate.query('begin');
        await gate.query('select id from conference where id = $1 for update', [kickoff]);

        const membership = createMembershipRepository(db);
        const departures = [
          membership.revoke(kickoff, PRIYA, 'left'),
          second === 'leave'
            ? membership.revoke(kickoff, BJORN, 'left')
            : membership.revoke(kickoff, BJORN, 'removed'),
        ].map((promise) => promise.then(() => 'ok' as const).catch((error: unknown) => error));

        // Long enough that a lock-less implementation would have counted and deleted by now.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await gate.query('rollback');
        await gate.end();

        const outcomes = await Promise.all(departures);
        const succeeded = outcomes.filter((outcome) => outcome === 'ok');
        const refused = outcomes.filter((outcome) => outcome !== 'ok');

        expect(succeeded, second).toHaveLength(1);
        expect(refused[0], second).toMatchObject({ code: 'CONFERENCE_LAST_ADMIN' });
        expect(await adminsOf(kickoff), second).toHaveLength(1);
      }
    });
  });

  // ---------- Acceptance Scenario S05 (TI01, TI07) ----------

  describe('ending a membership', () => {
    it('deletes that membership and that conference’s standing, and nothing else whatsoever', async () => {
      const app = appWith();
      const { conferenceId: kickoff, keynote, code } = await publishedKickoff(app);
      await entersCode(app, NADIA, code);
      await grant(app, kickoff, PRIYA, NADIA, 'PresenterFacilitator');

      const assigned = await app.inject({
        method: 'POST',
        url: `/api/conferences/${kickoff}/sessions/${keynote}/assignments`,
        headers: as(PRIYA),
        payload: { userSub: NADIA },
      });
      expect(assigned.statusCode, assigned.body).toBe(200);

      // She is also in a second conference, with standing of her own there.
      const retro = await createConference(app, NADIA, RETRO);

      // And rows exist recording what she did in Kickoff – the thing FR6 promises survives.
      await client.query(
        'insert into test_participation_record (conference_id, user_sub, body) values ($1, $2, $3)',
        [kickoff, NADIA, 'A post-it she wrote in the retrospective session'],
      );

      const removed = await remove(app, kickoff, PRIYA, NADIA);
      expect(removed.statusCode, removed.body).toBe(200);

      // Exactly two things are gone: the membership, and the standing it carried here.
      expect(await isMember(kickoff, NADIA)).toBe(false);
      expect(await rolesOf(kickoff, NADIA)).toEqual([]);
      const orphanAssignments = await client.query(
        'select id from session_assignment where conference_id = $1 and user_sub = $2',
        [kickoff, NADIA],
      );
      expect(orphanAssignments.rows).toEqual([]);

      // Her user record is untouched.
      const user = await client.query('select sub, email from app_user where sub = $1', [NADIA]);
      expect(user.rows).toHaveLength(1);

      // Her other conference is untouched, membership and standing alike.
      expect(await isMember(retro, NADIA)).toBe(true);
      expect(await rolesOf(retro, NADIA)).toEqual(['Admin']);

      // And every record of what she did in the conference she was removed from is still there,
      // unmodified. The deletion cascaded to nothing.
      const records = await client.query(
        'select body from test_participation_record where conference_id = $1 and user_sub = $2',
        [kickoff, NADIA],
      );
      expect(records.rows).toEqual([{ body: 'A post-it she wrote in the retrospective session' }]);

      // The session she was assigned to is still on the schedule; only her assignment went.
      const session = await client.query('select title from sessions where id = $1', [keynote]);
      expect(session.rows[0].title).toBe('Opening Keynote');
    });

    /**
     * No intermediate state is observable.
     *
     * A failure is forced *between* the two deletes, which is the one moment an implementation that
     * issued them outside a transaction would leave a member with no membership but a live Admin
     * role. Both rows must still be there afterwards.
     */
    it('is atomic – a failure between the two deletes leaves both rows standing', async () => {
      const app = appWith();
      const { conferenceId: kickoff, code } = await publishedKickoff(app);
      await entersCode(app, BJORN, code);
      await grant(app, kickoff, PRIYA, BJORN, 'Admin');

      const breakingAfterMembership: Database = {
        ...db,
        async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
          return db.transaction(async (tx) =>
            work({
              async query<R extends pg.QueryResultRow>(
                text: string,
                values: readonly unknown[] = [],
              ): Promise<R[]> {
                if (text.includes('delete from role_assignment')) {
                  throw new Error('injected failure between the two deletes');
                }
                return tx.query<R>(text, values);
              },
            }),
          );
        },
      };

      await expect(
        createMembershipRepository(breakingAfterMembership).revoke(kickoff, BJORN, 'removed'),
      ).rejects.toThrow(/injected failure/);

      expect(await isMember(kickoff, BJORN)).toBe(true);
      expect(await rolesOf(kickoff, BJORN)).toEqual(['Admin']);
    });
  });

  // ---------- Acceptance Scenario S06 (TI01, TI04) ----------

  describe('somebody who left', () => {
    it('re-joins with the code exactly as a first-time joiner, with no trace of having left', async () => {
      const app = appWith();
      const { conferenceId: kickoff, keynote, code } = await publishedKickoff(app);
      await entersCode(app, NADIA, code);
      await grant(app, kickoff, PRIYA, NADIA, 'PresenterFacilitator');
      await app.inject({
        method: 'POST',
        url: `/api/conferences/${kickoff}/sessions/${keynote}/assignments`,
        headers: as(PRIYA),
        payload: { userSub: NADIA },
      });

      expect((await leave(app, kickoff, NADIA)).statusCode).toBe(200);

      const rejoined = await enterCode(app, NADIA, code);
      expect(rejoined.statusCode, rejoined.body).toBe(200);
      expect(rejoined.json().conference.name).toBe('Kickoff 2026');

      // A first-time joiner's state exactly: in the conference, and nothing more.
      expect(await isMember(kickoff, NADIA)).toBe(true);
      expect(await rolesOf(kickoff, NADIA)).toEqual([]);

      const roster = await app.inject({
        method: 'GET',
        url: `/api/conferences/${kickoff}/members`,
        headers: as(PRIYA),
      });
      const nadia = roster
        .json()
        .members.find((member: { sub: string }) => member.sub === NADIA) as {
        roles: string[];
        sessionIds: string[];
      };
      expect(nadia.roles).toEqual(['Attendee']);
      // The sessions she used to run do not come back with her – that would be a trace of having
      // been here before, visible to every admin looking at the roster.
      expect(nadia.sessionIds).toEqual([]);

      // Nothing anywhere in what the API returns records that she left and came back.
      expect(JSON.stringify(roster.json())).not.toMatch(/left|departed|former|previous/i);
      expect(JSON.stringify(rejoined.json())).not.toMatch(/left|departed|former|previous/i);

      // And the schedule reads again, on the same sign-in.
      const schedule = await app.inject({
        method: 'GET',
        url: `/api/conferences/${kickoff}/schedule`,
        headers: as(NADIA),
      });
      expect(schedule.statusCode, schedule.body).toBe(200);
    });
  });

  // ---------- Acceptance Scenario S07 (TI03) ----------

  describe('an archived conference', () => {
    /**
     * Joining happens while the conference is running and archiving the day after it ends, so two
     * clocks are needed - one app for each. They share the database, which is the point: the rows
     * are the same conference seen from two days.
     */
    async function archivedKickoff(
      duringTheConference: FastifyInstance,
      afterItEnded: FastifyInstance,
    ): Promise<string> {
      const { conferenceId, code } = await publishedKickoff(duringTheConference, IDA);
      await entersCode(duringTheConference, NADIA, code);

      const archived = await afterItEnded.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/archive`,
        headers: as(IDA),
      });
      expect(archived.statusCode, archived.body).toBe(200);
      return conferenceId;
    }

    it('refuses a leave and a removal alike, naming the archived state, and stays readable', async () => {
      // A day after it ended, which is the earliest it can be archived.
      const app = appWith({ today: '2026-09-17' });
      const kickoff = await archivedKickoff(appWith({ today: '2026-09-15' }), app);

      const attempts = [await leave(app, kickoff, NADIA), await remove(app, kickoff, IDA, NADIA)];

      for (const refused of attempts) {
        expect(refused.statusCode, refused.body).toBe(409);
        // S03's exported guard, not a re-derived archived check – so the code is its code.
        expect(refused.json().error.code).toBe('CONFERENCE_NOT_EDITABLE');
        expect(refused.json().error.message).toMatch(/archived/i);
      }

      expect(await isMember(kickoff, NADIA)).toBe(true);
      expect(await isMember(kickoff, IDA)).toBe(true);

      // Archiving makes a conference read-only, not invisible: its members still read it (FR9).
      const schedule = await app.inject({
        method: 'GET',
        url: `/api/conferences/${kickoff}/schedule`,
        headers: as(NADIA),
      });
      expect(schedule.statusCode, schedule.body).toBe(200);
      expect(schedule.json().conference.state).toBe('archived');
    });
  });

  // ---------- TI07: the schema's own delete rules ----------

  describe('the database’s declared delete rules', () => {
    /**
     * Asked of the catalog, not of today's rows.
     *
     * A behavioural test proves only that the rows which happened to exist survived one deletion.
     * This one also fails when a *future* table is added under a cascading rule – which is the
     * failure mode FR6 is exposed to, because the tables that will hold post-its and votes do not
     * exist yet and their author is the very user a revocation is about.
     *
     * One constraint is named as the known exception: `failed_join_attempt` is the join limiter's
     * own bookkeeping (S05), not a record of what anybody did in a conference, and no revocation
     * path can fire it – ending a Membership never deletes an `app_user` row. Naming it rather than
     * filtering the query is what keeps the assertion sharp: any *new* cascading rule fails here.
     */
    it('let no cascading delete reach a user or a membership, apart from the one known exception', async () => {
      const cascading = await client.query(
        `select con.conname   as constraint_name,
                child.relname as child_table,
                parent.relname as parent_table,
                con.confdeltype as rule
           from pg_constraint con
           join pg_class child  on child.oid  = con.conrelid
           join pg_class parent on parent.oid = con.confrelid
          where con.contype = 'f'
            and parent.relname in ('app_user', 'membership')
            and con.confdeltype <> 'a'
          order by con.conname`,
      );

      expect(
        cascading.rows.map((row) => ({
          constraint: row.constraint_name as string,
          child: row.child_table as string,
          parent: row.parent_table as string,
        })),
      ).toEqual([
        {
          constraint: 'failed_join_attempt_user_sub_fkey',
          child: 'failed_join_attempt',
          parent: 'app_user',
        },
      ]);
    });

    /** Nothing hangs off a Membership at all, so ending one can have no children to take with it. */
    it('declare no foreign key referencing the membership table from anywhere', async () => {
      const children = await client.query(
        `select con.conname as constraint_name
           from pg_constraint con
           join pg_class parent on parent.oid = con.confrelid
          where con.contype = 'f' and parent.relname = 'membership'`,
      );
      expect(children.rows).toEqual([]);
    });
  });
});
