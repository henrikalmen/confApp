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
import { createRoundRepository, type Round } from '../src/rounds/round-repository.ts';
import { createPostItRepository } from '../src/rounds/post-it-repository.ts';
import { createVoteRepository } from '../src/votes/vote-repository.ts';
import { subjectVerifier, tokenFor, unusedCodeExchange } from './fake-auth.ts';

/**
 * S05 – contribution-safe Session deletion, against the real PostgreSQL the composed stack runs.
 *
 * Nothing here is provable against a fake. The refusal turns on rows in three tables written by
 * three earlier stories; the retained Conference cascade is a property of the foreign keys; and the
 * two race scenarios turn on which lock mode conflicts with which, which only PostgreSQL can
 * answer. The Rounds, Post-its and Votes are seeded through the production repositories – S01's
 * authoring path, S02's contribution path, S03's cast path – rather than by hand-written INSERTs,
 * so what is counted is what those stories actually write.
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
    '\n[integration] SKIPPED contribution-safe session deletion – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/**
 * Ida organises; the rest are the room.
 *
 * Twenty-five of them, because Acceptance Scenario S04 seeds 25 Votes and a Member may cast only
 * one per Poll - a smaller room would make that scenario's stated volume unreachable rather than
 * merely unwritten. Acceptance Scenario S02 takes the first eight.
 */
const IDA = 'google-sub-ida';
const ROOM = Array.from({ length: 25 }, (_, index) => `google-sub-member-${index + 1}`);
const EIGHT = ROOM.slice(0, 8);

const AUTUMN = { name: 'Autumn Offsite', startDate: '2026-09-15', endDate: '2026-09-16' };
const SPRING = { name: 'Spring Kickoff', startDate: '2026-09-15', endDate: '2026-09-16' };

function sessionAt(title: string, startTime: string, endTime: string): Record<string, unknown> {
  return {
    title,
    description: null,
    kind: 'Workshop',
    day: '2026-09-15',
    startTime,
    endTime,
    location: 'Room A',
  };
}

const POST_IT_ROUND = {
  kind: 'PostItRound' as const,
  purpose: null,
  prompt: 'What should we keep doing?',
  options: [],
};

function poll(question: string, options: string[]) {
  return { kind: 'VotingRound' as const, purpose: 'Poll' as const, prompt: question, options };
}

/** Long enough that a blocked statement is genuinely queued behind a lock rather than racing it. */
const LOCK_WAIT_MS = 150;

/** Resolves to `'pending'` if the promise has not settled within the lock-wait window. */
async function settledWithin<T>(work: Promise<T>): Promise<T | 'pending'> {
  const pending = Symbol('pending');
  const timer = new Promise<typeof pending>((resolve) =>
    setTimeout(() => resolve(pending), LOCK_WAIT_MS),
  );
  const result = await Promise.race([work, timer]);
  return result === pending ? 'pending' : (result as T);
}

describe.skipIf(!reachable)('contribution-safe session deletion against a real PostgreSQL', () => {
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
    await client.query('delete from conference');
    await client.query('delete from app_user');

    const users = createUserRepository(db);
    for (const sub of [IDA, ...ROOM]) {
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
      clock: fixedClock(today),
    });
    apps.push(app);
    return app;
  }

  function as(sub: string): { authorization: string } {
    return { authorization: `Bearer ${tokenFor(sub)}` };
  }

  /** How many backends in this database are waiting on a lock right now. */
  async function lockWaiters(): Promise<number> {
    const rows = await client.query<{ waiting: number }>(
      `select count(*)::int as waiting
         from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    return rows.rows[0]?.waiting ?? 0;
  }

  /**
   * Starts `work`, then asserts it is parked **and parked on a lock of its own** – the two halves
   * of TI03's "assert the losing write actually blocked rather than racing through".
   *
   * `settledWithin` alone proves only "did not settle in 150 ms", which a GC pause or a cold
   * `app.inject` satisfies just as well as a lock does, and it degrades toward *passing* - the
   * direction that hides a regression. So PostgreSQL is asked as well.
   *
   * It is asked as a **rising count around this statement**, not as "is anybody waiting". Several
   * of these tests park two writes in turn, and a database-wide "somebody is waiting" would be
   * satisfied by the *first* one for the whole of the second - which would quietly turn the second
   * assertion back into the bare timeout it exists to replace.
   *
   * Takes a thunk rather than a promise so the baseline is read before the work can start waiting,
   * and hands the still-pending work back **wrapped in an object**. Returning the promise bare
   * would be a deadlock: an `async` function assimilates a returned promise, so `await parked(…)`
   * would wait for the very work this helper exists to leave parked.
   */
  async function parked<T>(start: () => Promise<T>): Promise<{ work: Promise<T> }> {
    const before = await lockWaiters();
    const work = start();
    // A no-op observer, so a rejection landing while we are still parked is not reported as
    // unhandled. The caller awaits `work` itself and asserts on what it did.
    const observed = work.then(
      (value) => value as unknown,
      (error: unknown) => error,
    );

    expect(await settledWithin(observed)).toBe('pending');
    expect(await lockWaiters(), 'this write should itself be waiting on a lock').toBeGreaterThan(
      before,
    );
    return { work };
  }

  const rounds = () => createRoundRepository(db);
  const postIts = () => createPostItRepository(db);
  const votes = () => createVoteRepository(db);

  async function createConference(app: FastifyInstance, details = AUTUMN): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/conferences',
      headers: as(IDA),
      payload: details,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().id as string;
  }

  async function addSession(
    app: FastifyInstance,
    conferenceId: string,
    session: Record<string, unknown>,
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions`,
      headers: as(IDA),
      payload: session,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().session.id as string;
  }

  async function publish(app: FastifyInstance, conferenceId: string): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/publish`,
      headers: as(IDA),
    });
    expect(response.statusCode, response.body).toBe(200);
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

  async function deleteSession(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    base?: { conferenceState: string; version: string },
  ) {
    const carried = base ?? (await baseFor(sessionId));
    return app.inject({
      method: 'DELETE',
      url:
        `/api/conferences/${conferenceId}/sessions/${sessionId}` +
        `?conferenceState=${carried.conferenceState}&version=${encodeURIComponent(carried.version)}`,
      headers: as(IDA),
    });
  }

  async function countOf(table: string, column: string, value: string): Promise<number> {
    const rows = await client.query<{ count: string }>(
      `select count(*)::int as count from ${table} where ${column} = $1`,
      [value],
    );
    return Number(rows.rows[0]!.count);
  }

  async function scheduleWatermark(conferenceId: string): Promise<string> {
    const rows = await client.query<{ watermark: string }>(
      `select to_char(schedule_watermark_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as watermark
         from conference where id = $1`,
      [conferenceId],
    );
    return rows.rows[0]!.watermark;
  }

  /** A Post-it Round holding `count` named contributions, then closed as a real one would be. */
  async function boardOf(conferenceId: string, sessionId: string, count: number): Promise<Round> {
    const round = await rounds().create(conferenceId, sessionId, POST_IT_ROUND);
    expect((await rounds().open(conferenceId, sessionId, round.id)).outcome).toBe('changed');
    for (let index = 0; index < count; index += 1) {
      const written = await postIts().contribute(
        conferenceId,
        sessionId,
        round.id,
        ROOM[index % ROOM.length]!,
        `Idea number ${index + 1}`,
      );
      expect(written.outcome).toBe('written');
    }
    expect((await rounds().close(conferenceId, sessionId, round.id)).outcome).toBe('changed');
    return round;
  }

  /** A Poll that `voters` people have voted in, then closed. */
  async function pollWith(
    conferenceId: string,
    sessionId: string,
    voters: readonly string[],
  ): Promise<Round> {
    const round = await rounds().create(
      conferenceId,
      sessionId,
      poll('How was the offsite?', ['Good', 'Fine', 'Poor']),
    );
    expect((await rounds().open(conferenceId, sessionId, round.id)).outcome).toBe('changed');
    for (const [index, voter] of voters.entries()) {
      const cast = await votes().cast(
        conferenceId,
        sessionId,
        round.id,
        round.options[index % round.options.length]!.id,
        voter,
      );
      expect(cast.outcome).toBe('cast');
    }
    expect((await rounds().close(conferenceId, sessionId, round.id)).outcome).toBe('changed');
    return round;
  }

  // ---------- Acceptance Scenario S01 [OC01] (TI01, TI02, TI04, TI07) ----------

  describe('a session holding a board of post-its', () => {
    it('refuses deletion, names the twelve post-its, and loses nothing', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const retro = await addSession(
        app,
        conferenceId,
        sessionAt('Team Retrospective', '09:00', '10:00'),
      );
      await addSession(app, conferenceId, sessionAt('Lightning Talks', '11:00', '12:00'));
      await publish(app, conferenceId);

      const round = await boardOf(conferenceId, retro, 12);

      const refused = await deleteSession(app, conferenceId, retro);

      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe('SESSION_HOLDS_CONTRIBUTIONS');
      expect(refused.json().error.message).toBe(
        'This session has collected 12 post-its and cannot be deleted. ' +
          'Edit the session, or move it to another day or time, instead.',
      );

      // …and afterwards the Session, its Round and all twelve Post-its are still readable.
      expect(await countOf('sessions', 'id', retro)).toBe(1);
      expect(await countOf('round', 'session_id', retro)).toBe(1);
      expect(await countOf('post_it', 'round_id', round.id)).toBe(12);
    });
  });

  // ---------- Acceptance Scenario S02 [OC01, OC04] (TI01, TI02, TI05) ----------

  describe('a session whose only contribution is anonymous votes', () => {
    it('refuses deletion just as firmly, and the ballots survive', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const sentiment = await addSession(
        app,
        conferenceId,
        sessionAt('Sentiment Check', '09:00', '10:00'),
      );
      await addSession(app, conferenceId, sessionAt('Lightning Talks', '11:00', '12:00'));
      await publish(app, conferenceId);

      const round = await pollWith(conferenceId, sentiment, EIGHT);
      expect(await countOf('post_it', 'conference_id', conferenceId)).toBe(0);

      const refused = await deleteSession(app, conferenceId, sentiment);

      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe('SESSION_HOLDS_CONTRIBUTIONS');
      expect(refused.json().error.message).toContain('8 votes');
      expect(refused.json().error.message).not.toContain('post-it');

      expect(await countOf('sessions', 'id', sentiment)).toBe(1);
      expect(await countOf('vote', 'round_id', round.id)).toBe(8);
      // The has-voted facts are untouched too – the guard neither read nor wrote them.
      expect(await countOf('round_voter', 'round_id', round.id)).toBe(8);
    });

    /**
     * The behavioural half of the anonymity criterion, which does not know the file list the
     * source-level guard in `session-deletion-structure.test.ts` reads
     * (`docs/LEARNINGS.md#testing`: pair any file-list assertion with one that does not know it).
     *
     * The refusal is reached with the has-voted table **empty of the voters it names**: eight
     * ballots exist and not one `round_voter` row does. If the count reached ballots through the
     * has-voted record it would see zero and the delete would succeed, destroying eight Votes. The
     * guard knows *that* ballots exist and nothing about *whose* they are.
     */
    it('refuses without reading the has-voted record', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const sentiment = await addSession(
        app,
        conferenceId,
        sessionAt('Sentiment Check', '09:00', '10:00'),
      );
      await addSession(app, conferenceId, sessionAt('Lightning Talks', '11:00', '12:00'));
      await publish(app, conferenceId);

      const round = await pollWith(conferenceId, sentiment, EIGHT);
      await client.query('delete from round_voter where round_id = $1', [round.id]);
      expect(await countOf('round_voter', 'round_id', round.id)).toBe(0);

      const refused = await deleteSession(app, conferenceId, sentiment);

      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.message).toContain('8 votes');
      expect(await countOf('vote', 'round_id', round.id)).toBe(8);
    });
  });

  // ---------- Acceptance Scenario S03 [OC02] (TI02) ----------

  describe('a session with authored rounds but nothing contributed', () => {
    it('is deleted, takes both rounds with it, and advances the schedule watermark', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const talks = await addSession(
        app,
        conferenceId,
        sessionAt('Lightning Talks', '09:00', '10:00'),
      );
      await addSession(app, conferenceId, sessionAt('Team Retrospective', '11:00', '12:00'));
      await publish(app, conferenceId);

      await rounds().create(conferenceId, talks, POST_IT_ROUND);
      await rounds().create(conferenceId, talks, poll('Which track next?', ['One', 'Two']));
      expect(await countOf('round', 'session_id', talks)).toBe(2);

      const before = await scheduleWatermark(conferenceId);
      const deleted = await deleteSession(app, conferenceId, talks);

      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(await countOf('sessions', 'id', talks)).toBe(0);
      expect(await countOf('round', 'session_id', talks)).toBe(0);
      // An open Attendee view drops the Session because the whole-schedule watermark moved.
      expect((await scheduleWatermark(conferenceId)) > before).toBe(true);
    });

    /**
     * Discovered Requirement, propagated from S03's review: `round_option` carries an
     * `AFTER INSERT OR UPDATE OR DELETE` trigger, and this is the story that deletes Rounds.
     *
     * During the cascade it fires once per option row while the Round it would advance is being
     * deleted in the same transaction. Expected to no-op harmlessly – the same shape as S02's
     * shipped `post_it` delete trigger – but until now nothing exercised it, and a raise here would
     * abort a delete the guard had already permitted.
     */
    it('deletes a session holding a multi-option poll, the cascade reaching round_option', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const talks = await addSession(
        app,
        conferenceId,
        sessionAt('Lightning Talks', '09:00', '10:00'),
      );
      await addSession(app, conferenceId, sessionAt('Team Retrospective', '11:00', '12:00'));
      await publish(app, conferenceId);

      const round = await rounds().create(
        conferenceId,
        talks,
        poll('Where next?', ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']),
      );
      expect(await countOf('round_option', 'round_id', round.id)).toBe(6);

      /*
       * The trigger has to be attached for this case to be worth running at all – dropped, the
       * delete below would succeed for a reason that says nothing about what S03 shipped.
       */
      const attached = await client.query<{ tgname: string }>(
        `select t.tgname from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
          where c.relname = 'round_option' and not t.tgisinternal`,
      );
      expect(attached.rows.map((row) => row.tgname)).toContain(
        'round_option_advances_activity_watermark',
      );

      const deleted = await deleteSession(app, conferenceId, talks);

      // It fires six times during the cascade, once per option, each time against a Round row that
      // is being deleted in the same transaction – and no-ops rather than raising.
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(await countOf('round', 'id', round.id)).toBe(0);
      expect(await countOf('round_option', 'round_id', round.id)).toBe(0);
    });
  });

  // ---------- Acceptance Scenario S04 [OC03] (TI06) ----------

  describe('deleting the whole conference', () => {
    /**
     * The guard is at Session level **by decision**, not by oversight
     * (`prd.md#fr7-contribution-safe-session-deletion`, fourth criterion). Archiving is the
     * intended "we are finished with this" path for a Conference that has run; deletion stays
     * available for one created in error, and it still takes everything with it.
     *
     * There is no Conference-deletion endpoint and this story adds none – the retained cascade is a
     * schema property, so it is asserted against the row. Both behaviours are asserted side by
     * side, on the same seeded fixture, so neither can drift without the other noticing.
     */
    it('is permitted and cascades to every session, round, post-it and vote', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const first = await addSession(
        app,
        conferenceId,
        sessionAt('Team Retrospective', '09:00', '10:00'),
      );
      const second = await addSession(
        app,
        conferenceId,
        sessionAt('Sentiment Check', '11:00', '12:00'),
      );
      const third = await addSession(
        app,
        conferenceId,
        sessionAt('Lightning Talks', '13:00', '14:00'),
      );
      await publish(app, conferenceId);

      // The scenario's own volumes: three Sessions, five Rounds, 40 Post-its and 25 Votes.
      await boardOf(conferenceId, first, 24);
      await boardOf(conferenceId, second, 16);
      await pollWith(conferenceId, second, ROOM.slice(0, 13));
      await pollWith(conferenceId, third, ROOM.slice(13, 25));
      await rounds().create(conferenceId, third, POST_IT_ROUND);

      expect(await countOf('sessions', 'conference_id', conferenceId)).toBe(3);
      expect(await countOf('round', 'conference_id', conferenceId)).toBe(5);
      expect(await countOf('post_it', 'conference_id', conferenceId)).toBe(40);
      const ballots = await client.query<{ count: number }>(
        `select count(*)::int as count from vote v
           join round r on r.id = v.round_id where r.conference_id = $1`,
        [conferenceId],
      );
      expect(ballots.rows[0]!.count).toBe(25);

      /*
       * **The cascade rules the database actually holds**, not the ones the migrations say.
       * Migrations here are append-only, so a later `ALTER TABLE … DROP CONSTRAINT … ADD …
       * ON DELETE RESTRICT` would leave `session-deletion-structure.test.ts` fully green while
       * breaking the Conference deletion FR7 keeps available. `confdeltype = 'c'` is CASCADE.
       */
      const chain = await client.query<{ conrelid: string; confrelid: string }>(
        `select cl.relname as conrelid, ref.relname as confrelid
           from pg_constraint c
           join pg_class cl on cl.oid = c.conrelid
           join pg_class ref on ref.oid = c.confrelid
          where c.contype = 'f' and c.confdeltype = 'c'
            and cl.relname in ('sessions', 'round', 'round_option', 'post_it', 'vote', 'round_voter')`,
      );
      const declared = chain.rows.map((row) => `${row.conrelid} → ${row.confrelid}`);
      for (const link of [
        'sessions → conference',
        'round → sessions',
        'round_option → round',
        'post_it → round',
        'vote → round',
        'round_voter → round',
      ]) {
        expect(declared, `${link} should cascade on delete`).toContain(link);
      }

      // Side by side: the Session-level delete on this very fixture is refused…
      const refused = await deleteSession(app, conferenceId, first);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe('SESSION_HOLDS_CONTRIBUTIONS');
      expect(refused.json().error.message).toContain('24 post-its');

      // …and the Conference-level delete is not.
      await client.query('delete from conference where id = $1', [conferenceId]);

      expect(await countOf('sessions', 'conference_id', conferenceId)).toBe(0);
      expect(await countOf('round', 'conference_id', conferenceId)).toBe(0);
      expect(await countOf('post_it', 'conference_id', conferenceId)).toBe(0);
      for (const table of ['round_option', 'vote', 'round_voter']) {
        const rows = await client.query<{ count: string }>(
          `select count(*)::int as count from ${table}`,
        );
        expect(Number(rows.rows[0]!.count), `${table} should be empty`).toBe(0);
      }
    });
  });

  // ---------- Acceptance Scenario S05 [OC01] (TI04) ----------

  describe('the refusal an organizer is told about', () => {
    /**
     * The contribution refusal is more permanent than the sole-Session one, so it is answered
     * first: adding a second Session would not make this delete possible, while
     * SESSION_LAST_IN_PUBLISHED_CONFERENCE would send the Organizer to do exactly that.
     */
    it('names the collected post-its, not the sole-session rule', async () => {
      const app = appWith();
      const conferenceId = await createConference(app, SPRING);
      const opening = await addSession(
        app,
        conferenceId,
        sessionAt('Opening Workshop', '09:00', '10:00'),
      );
      await publish(app, conferenceId);
      await boardOf(conferenceId, opening, 3);

      const refused = await deleteSession(app, conferenceId, opening);

      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe('SESSION_HOLDS_CONTRIBUTIONS');
      expect(refused.json().error.message).toContain('3 post-its');
      expect(await countOf('sessions', 'id', opening)).toBe(1);
    });

    it('still answers SESSION_NOT_FOUND for a session id that is not there', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const opening = await addSession(
        app,
        conferenceId,
        sessionAt('Opening Workshop', '09:00', '10:00'),
      );
      await publish(app, conferenceId);
      await boardOf(conferenceId, opening, 3);

      const base = await baseFor(opening);
      const refused = await deleteSession(
        app,
        conferenceId,
        '11111111-1111-4111-8111-111111111111',
        base,
      );

      expect(refused.statusCode, refused.body).toBe(404);
      expect(refused.json().error.code).toBe('SESSION_NOT_FOUND');
    });

    it('still answers EDIT_VERSION_CONFLICT for a stale base version', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const opening = await addSession(
        app,
        conferenceId,
        sessionAt('Opening Workshop', '09:00', '10:00'),
      );
      await addSession(app, conferenceId, sessionAt('Lightning Talks', '11:00', '12:00'));
      await publish(app, conferenceId);
      await boardOf(conferenceId, opening, 3);

      const stale = { ...(await baseFor(opening)), version: '2020-01-01T00:00:00.000000Z' };
      const refused = await deleteSession(app, conferenceId, opening, stale);

      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe('EDIT_VERSION_CONFLICT');
    });
  });

  // ---------- Acceptance Scenarios S06 and S07 [OC01] (TI03) ----------

  describe('a contribution arriving while the delete is in flight', () => {
    /**
     * S06, first ordering: the contribution is written but **not yet committed** when the delete
     * begins. The delete's `for update` on the Round row waits for it, and once the contribution
     * commits the delete resumes and its count sees the Post-it.
     *
     * The blocked assertion is the load-bearing one: without it this test would pass against a
     * delete that raced straight through and refused for some other reason. What it proves is that
     * the Round lock **exists** - removing it makes this case red.
     *
     * What it does **not** discriminate is the lock's *mode*. The uncommitted insert takes
     * `FOR KEY SHARE` for its foreign key, but it also fires
     * `post_it_advances_activity_watermark`, whose `UPDATE round SET activity_watermark = …`
     * leaves it holding `FOR NO KEY UPDATE` as well - and that conflicts with a requested
     * `FOR NO KEY UPDATE` too. So downgrading the mode would leave this case green. The mode is
     * pinned by `session-deletion-structure.test.ts` -> "takes the session and round locks in a
     * mode that conflicts with FOR KEY SHARE", and that text assertion is not redundant with this
     * one.
     */
    it('blocks the delete on an uncommitted post-it, then refuses it', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const ideas = await addSession(app, conferenceId, sessionAt('Ideas Round', '09:00', '10:00'));
      await addSession(app, conferenceId, sessionAt('Lightning Talks', '11:00', '12:00'));
      await publish(app, conferenceId);

      const round = await rounds().create(conferenceId, ideas, POST_IT_ROUND);
      await rounds().open(conferenceId, ideas, round.id);
      const base = await baseFor(ideas);

      const contributor = new pg.Client({ connectionString: url });
      await contributor.connect();
      let deleting: Promise<unknown>;
      try {
        await contributor.query('begin');
        await contributor.query(
          `insert into post_it (round_id, conference_id, author_sub, text)
           values ($1, $2, $3, 'One more idea')`,
          [round.id, conferenceId, ROOM[0]],
        );

        // Queued behind the contribution's FOR KEY SHARE on the Round row, not racing it.
        deleting = (await parked(() => deleteSession(app, conferenceId, ideas, base))).work;

        await contributor.query('commit');
      } finally {
        await contributor.end();
      }

      const refused = (await deleting) as { statusCode: number; body: string };
      expect(refused.statusCode, refused.body).toBe(409);
      expect(JSON.parse(refused.body).error.code).toBe('SESSION_HOLDS_CONTRIBUTIONS');

      // Never "the delete succeeded and a committed post-it disappeared with it".
      expect(await countOf('sessions', 'id', ideas)).toBe(1);
      expect(await countOf('post_it', 'round_id', round.id)).toBe(1);
    });

    /**
     * S06, second ordering: the contribution commits **after** the delete has begun but before it
     * reaches the Round lock. Held deterministic by parking the delete on the Conference row lock
     * it takes first, which S02's contribution path does not take at all – so the Post-it lands in
     * the window the count has to cover.
     */
    it('counts a post-it that commits after the delete has begun', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const ideas = await addSession(app, conferenceId, sessionAt('Ideas Round', '09:00', '10:00'));
      await addSession(app, conferenceId, sessionAt('Lightning Talks', '11:00', '12:00'));
      await publish(app, conferenceId);

      const round = await rounds().create(conferenceId, ideas, POST_IT_ROUND);
      await rounds().open(conferenceId, ideas, round.id);
      const base = await baseFor(ideas);

      const holder = new pg.Client({ connectionString: url });
      await holder.connect();
      let deleting: Promise<unknown>;
      try {
        await holder.query('begin');
        await holder.query('select id from conference where id = $1 for update', [conferenceId]);

        deleting = (await parked(() => deleteSession(app, conferenceId, ideas, base))).work;

        // The Attendee contributes while the delete is parked. Nothing it needs is held.
        const written = await postIts().contribute(
          conferenceId,
          ideas,
          round.id,
          ROOM[0]!,
          'Typed while the delete was in flight',
        );
        expect(written.outcome).toBe('written');

        await holder.query('commit');
      } finally {
        await holder.end();
      }

      const refused = (await deleting) as { statusCode: number; body: string };
      expect(refused.statusCode, refused.body).toBe(409);
      expect(JSON.parse(refused.body).error.code).toBe('SESSION_HOLDS_CONTRIBUTIONS');
      expect(await countOf('post_it', 'round_id', round.id)).toBe(1);
    });

    /**
     * S06, third ordering: the delete gets there first. The contribution then blocks on the Round
     * lock and, when the Session is gone, is refused because the Round it named no longer exists –
     * it is never accepted and then destroyed.
     *
     * **This case exercises the contribution side only.** The delete is replayed by a second
     * connection, because a transaction the API owns cannot be paused from outside it - so nothing
     * here runs `sessions.remove`, and it stays green with both of the delete's locks removed. The
     * delete's own locks are proved by the two cases above and by the S07 case below. The replayed
     * statements mirror the production predicates exactly so the two cannot be read as different.
     */
    it('refuses a contribution once the round it named has been locked and deleted', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const ideas = await addSession(app, conferenceId, sessionAt('Ideas Round', '09:00', '10:00'));
      await addSession(app, conferenceId, sessionAt('Lightning Talks', '11:00', '12:00'));
      await publish(app, conferenceId);

      const round = await rounds().create(conferenceId, ideas, POST_IT_ROUND);
      await rounds().open(conferenceId, ideas, round.id);

      const deleter = new pg.Client({ connectionString: url });
      await deleter.connect();
      let contributing: Promise<unknown>;
      try {
        await deleter.query('begin');
        await deleter.query(
          'select id from sessions where id = $2 and conference_id = $1 for update',
          [conferenceId, ideas],
        );
        await deleter.query(
          'select id from round where conference_id = $1 and session_id = $2 order by id for update',
          [conferenceId, ideas],
        );

        // The insert needs FOR KEY SHARE on the locked Round row, so it waits rather than landing.
        contributing = (
          await parked(() =>
            postIts()
              .contribute(conferenceId, ideas, round.id, ROOM[0]!, 'Too late for this round')
              .catch((error: unknown) => ({ outcome: 'threw', error })),
          )
        ).work;

        await deleter.query('delete from sessions where id = $1', [ideas]);
        await deleter.query('commit');
      } finally {
        await deleter.end();
      }

      /*
       * Not accepted-and-destroyed: the write fails because the Round it named is gone, which is
       * the second of the two outcomes Acceptance Scenario S06 permits.
       *
       * The mechanism is a foreign-key violation, not S02's ordinary empty-result path: the
       * insert's source query read the Round before the delete committed, and only the key check
       * saw it go. **This test was originally written to assert `threw`**, pinning the fact that
       * the violation reached S02's contribute route unmapped and surfaced as a 500 - deliberately,
       * so the pin would fail loudly when somebody fixed it rather than drifting quietly. It did
       * exactly that. `insertOrDiagnose` in `post-it-repository.ts` now catches SQLSTATE 23503 and
       * routes it to the same diagnosis an empty result takes, so the contributor is told the Round
       * is gone instead of being told the API broke.
       *
       * The invariant this story owns is unchanged either way: nothing was written.
       */
      const outcome = (await contributing) as { outcome: string; error?: { message?: string } };
      expect(outcome.outcome).toBe('missing');
      expect(await countOf('post_it', 'round_id', round.id)).toBe(0);
    });

    /**
     * S07: a Round authored on the Session **while the real delete holds the Session row**.
     *
     * S01's authoring path takes no Conference lock, so without the delete's own Session-row lock a
     * Round created here would sit outside the counted set and could carry a committed Post-it into
     * the cascade. Its insert needs `FOR KEY SHARE` on the `sessions` row for
     * `round_session_in_conference`, and `FOR UPDATE` is the mode that conflicts with that.
     *
     * The delete is the API's own, and it is parked *after* it has taken the Session row: an
     * existing Round row is held by a third connection, so the delete gets through the Conference
     * and Session locks and then waits at `lockRoundsOfSession`. Nothing here stands in for the
     * lock under test - remove the `for update` from the Session read and the authoring below
     * stops blocking, which is the whole point of driving it this way round.
     */
    /**
     * **The delete gives up rather than park the Conference row indefinitely.**
     *
     * The sequence holds the Conference row while it waits on Session and Round rows. Without a
     * bound that wait is unbounded: one Round row held open by anything - a stalled client, a
     * session left mid-transaction - blocks every writer in that Conference, not just other
     * deletes. It is not a deadlock, so the SQLSTATE 40P01 retry never sees it and nothing resolves
     * it.
     *
     *  bounds it, and 55P03 is mapped to a refusal that says to try again
     * rather than reaching the error handler as an INTERNAL_ERROR. Driven by holding a Round row
     * from a third connection for longer than the timeout and letting the delete run into it.
     */
    it('gives up and asks the organizer to retry when a row is held too long', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const ideas = await addSession(app, conferenceId, sessionAt('Ideas Round', '09:00', '10:00'));
      await addSession(app, conferenceId, sessionAt('Lightning Talks', '11:00', '12:00'));
      await publish(app, conferenceId);
      const existing = await rounds().create(conferenceId, ideas, POST_IT_ROUND);

      const holder = new pg.Client({ connectionString: url });
      await holder.connect();
      try {
        await holder.query('begin');
        // Held for the whole of the delete's five-second ceiling and beyond.
        await holder.query('select id from round where id = $1 for update', [existing.id]);

        const refused = await deleteSession(app, conferenceId, ideas);

        expect(refused.statusCode, refused.body).toBe(503);
        expect(refused.json().error.code).toBe('CONFERENCE_BUSY');
        expect(refused.json().error.message).toMatch(/try again/i);
      } finally {
        await holder.query('rollback');
        await holder.end();
      }

      // Nothing was written, and the session is still there to delete once the holder lets go.
      expect(await countOf('sessions', 'id', ideas)).toBe(1);
    }, 20000);

    it('makes a round authored mid-delete wait on the delete, and fail once the session is gone', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const ideas = await addSession(app, conferenceId, sessionAt('Ideas Round', '09:00', '10:00'));
      await addSession(app, conferenceId, sessionAt('Lightning Talks', '11:00', '12:00'));
      await publish(app, conferenceId);

      // An empty Round, so the delete is still permitted once it gets past the lock it parks on.
      const existing = await rounds().create(conferenceId, ideas, POST_IT_ROUND);
      const base = await baseFor(ideas);

      const holder = new pg.Client({ connectionString: url });
      await holder.connect();
      let deleting: Promise<unknown>;
      let authoring: Promise<Round>;
      try {
        await holder.query('begin');
        await holder.query('select id from round where id = $1 for update', [existing.id]);

        // Parks at the round lock, holding the Conference and Session rows.
        deleting = (await parked(() => deleteSession(app, conferenceId, ideas, base))).work;

        // The Facilitator authors a *new* Round on the same Session, and cannot get past the
        // Session row the delete is holding.
        authoring = (await parked(() => rounds().create(conferenceId, ideas, POST_IT_ROUND))).work;

        await holder.query('commit');
      } finally {
        await holder.end();
      }

      const deleted = (await deleting) as { statusCode: number; body: string };
      expect(deleted.statusCode, deleted.body).toBe(200);

      // The authoring resolves after the delete, and fails because its Session is gone. There is no
      // ordering in which the Round exists, holds a committed Post-it, and is absent from the count.
      await expect(authoring).rejects.toThrow();
      expect(await countOf('round', 'session_id', ideas)).toBe(0);
      expect(await countOf('sessions', 'id', ideas)).toBe(0);
    });

    /**
     * The same window, with the **anonymous** contribution kind.
     *
     * S06 and S07 name Post-its, and every case above uses one - but the Vote is the contribution
     * the load-bearing rule is actually about, and `session-repository.ts` claims that from the
     * Round lock onwards "no Post-it **and no Vote** can enter a Round of this Session". That half
     * was safe by construction and unguarded; this is the guard.
     *
     * The refusal names the ballot and says nothing else about it - no option, no voter, no per-
     * option figure.
     */
    it('counts a vote cast after the delete has begun, and names it and nothing more', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const sentiment = await addSession(
        app,
        conferenceId,
        sessionAt('Sentiment Check', '09:00', '10:00'),
      );
      await addSession(app, conferenceId, sessionAt('Lightning Talks', '11:00', '12:00'));
      await publish(app, conferenceId);

      const round = await rounds().create(
        conferenceId,
        sentiment,
        poll('How was the offsite?', ['Good', 'Fine', 'Poor']),
      );
      await rounds().open(conferenceId, sentiment, round.id);
      const base = await baseFor(sentiment);

      const holder = new pg.Client({ connectionString: url });
      await holder.connect();
      let deleting: Promise<unknown>;
      try {
        await holder.query('begin');
        await holder.query('select id from conference where id = $1 for update', [conferenceId]);

        deleting = (await parked(() => deleteSession(app, conferenceId, sentiment, base))).work;

        const cast = await votes().cast(
          conferenceId,
          sentiment,
          round.id,
          round.options[0]!.id,
          ROOM[0]!,
        );
        expect(cast.outcome).toBe('cast');

        await holder.query('commit');
      } finally {
        await holder.end();
      }

      const refused = (await deleting) as { statusCode: number; body: string };
      expect(refused.statusCode, refused.body).toBe(409);
      const error = JSON.parse(refused.body).error;
      expect(error.code).toBe('SESSION_HOLDS_CONTRIBUTIONS');
      expect(error.message).toContain('1 vote');
      // The refusal names the ballot and carries nothing that could be read back to a person.
      expect(error.current).toBeUndefined();
      expect(error.message).not.toMatch(/Good|Fine|Poor|google-sub/);
      expect(await countOf('vote', 'round_id', round.id)).toBe(1);
      expect(await countOf('sessions', 'id', sentiment)).toBe(1);
    });

    /**
     * S07, the other ordering: the Round was authored *before* the delete took hold, so it is
     * inside the counted set and its Post-it refuses the delete. Parked on the Conference lock
     * again, because that is the one lock S01's authoring path does not contend for.
     */
    it('counts a round authored and contributed to before the delete takes hold', async () => {
      const app = appWith();
      const conferenceId = await createConference(app);
      const ideas = await addSession(app, conferenceId, sessionAt('Ideas Round', '09:00', '10:00'));
      await addSession(app, conferenceId, sessionAt('Lightning Talks', '11:00', '12:00'));
      await publish(app, conferenceId);
      const base = await baseFor(ideas);

      const holder = new pg.Client({ connectionString: url });
      await holder.connect();
      let deleting: Promise<unknown>;
      try {
        await holder.query('begin');
        await holder.query('select id from conference where id = $1 for update', [conferenceId]);

        deleting = (await parked(() => deleteSession(app, conferenceId, ideas, base))).work;

        const late = await rounds().create(conferenceId, ideas, POST_IT_ROUND);
        await rounds().open(conferenceId, ideas, late.id);
        const written = await postIts().contribute(
          conferenceId,
          ideas,
          late.id,
          ROOM[0]!,
          'Into a round the delete has not seen',
        );
        expect(written.outcome).toBe('written');

        await holder.query('commit');
      } finally {
        await holder.end();
      }

      const refused = (await deleting) as { statusCode: number; body: string };
      expect(refused.statusCode, refused.body).toBe(409);
      expect(JSON.parse(refused.body).error.code).toBe('SESSION_HOLDS_CONTRIBUTIONS');
      expect(await countOf('sessions', 'id', ideas)).toBe(1);
      expect(await countOf('post_it', 'conference_id', conferenceId)).toBe(1);
    });
  });
});
