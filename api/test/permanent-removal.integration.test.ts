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
import { tokenFor, unusedCodeExchange } from './fake-auth.ts';
import type { Verifier } from '../src/auth/verify-id-token.ts';

/**
 * **Permanent Removal** against the real PostgreSQL the composed stack runs (S06, FR5).
 *
 * Every property this story is risky for is a storage-level or a role-level guarantee, and none of
 * them is provable against a fake that answers whatever the test wants: the `ON DELETE CASCADE`
 * that takes a Discard trace with the row it belongs to, the `ROLE_RANK` that stops a Session
 * Assignment from conferring conference-wide Admin, the delete trigger that carries the removal to
 * the room through the one activity cursor, and the unconditional contribution count that makes a
 * Session deletable again.
 *
 * Three disciplines run through the whole file, inherited from `discard.integration.test.ts`:
 *
 *   - **A refusal is asserted against the stored rows**, never against the response envelope alone.
 *     A route that returns a refusal and writes anyway passes a response-only test.
 *   - **Nothing here asserts that a request was issued.** What is proved is what the *next* read
 *     returns, which is what a participant actually sees.
 *   - **The absence is read from the table as well as from the payload**, so a route that returned
 *     the right board over the wrong rows fails.
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
    '\n[integration] SKIPPED permanent removal – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/** Priya organizes (and so is Admin); Ida facilitates; Ada and Bo are in the room. */
const PRIYA = 'google-sub-priya';
const IDA = 'google-sub-ida';
const ADA = 'google-sub-ada';
const BO = 'google-sub-bo';

const NAMES: Record<string, string> = {
  [PRIYA]: 'Priya Raman',
  [IDA]: 'Ida Andersson',
  [ADA]: 'Ada Lovelace',
  [BO]: 'Bo Nilsson',
};

function namedVerifier(hd = 'ourcompany.example'): Verifier {
  return {
    async verify(token: string) {
      const prefix = 'test-token:';
      if (!token.startsWith(prefix)) {
        return { ok: false, code: 'AUTH_TOKEN_MALFORMED' } as const;
      }
      const sub = token.slice(prefix.length);
      return {
        ok: true,
        claims: {
          sub,
          hd,
          email: `${sub}@${hd}`,
          displayName: NAMES[sub] ?? sub,
          nonce: undefined,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      } as const;
    },
  };
}

const AUTUMN = { name: 'Autumn Offsite', startDate: '2026-09-15', endDate: '2026-09-16' };

const WAYS_OF_WORKING = {
  title: 'Ways of Working',
  kind: 'Workshop',
  day: '2026-09-15',
  startTime: '13:00',
  endTime: '15:00',
  location: 'Room 2',
};

const POST_IT_ROUND = { kind: 'PostItRound', prompt: 'What slowed us down this quarter?' };

const STAGING = 'we need a staging box';

const ARCHIVED_SENTENCE =
  'This conference has been archived, so it is read-only and can no longer be changed.';

const ADMIN_SENTENCE =
  'Only an admin can permanently remove a post-it. You can discard it instead.';

interface WirePostIt {
  id: string;
  text: string;
  authorName: string;
}

interface WireCategory {
  id: string;
  name: string;
  postIts: WirePostIt[];
  postItCount: number;
}

interface WireRound {
  id: string;
  state: string;
  categories?: WireCategory[];
  uncategorised?: { postIts: WirePostIt[]; postItCount: number };
}

describe.skipIf(!reachable)('permanent removal against a real PostgreSQL', () => {
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
    for (const [sub, displayName] of Object.entries(NAMES)) {
      await users.upsertFromClaims({
        sub,
        hd: 'ourcompany.example',
        email: `${sub}@ourcompany.example`,
        displayName,
        nonce: undefined,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
    }
  });

  function appWith(): FastifyInstance {
    const app = buildApp({
      db,
      auth: {
        verifier: namedVerifier(),
        users: createUserRepository(db),
        codeExchange: unusedCodeExchange(),
      },
      clock: fixedClock('2026-09-15'),
    });
    apps.push(app);
    return app;
  }

  function as(sub: string): { authorization: string } {
    return { authorization: `Bearer ${tokenFor(sub)}` };
  }

  async function addMember(conferenceId: string, sub: string): Promise<void> {
    await client.query(
      `insert into membership (conference_id, user_sub) values ($1, $2)
       on conflict (conference_id, user_sub) do nothing`,
      [conferenceId, sub],
    );
  }

  /**
   * "Autumn Offsite", published, with one workshop.
   *
   * The cast is what the authority scenarios need: **Priya** created the Conference and so holds
   * conference-wide Admin and *no* Session Assignment; **Ida** holds a Session Assignment on this
   * very Session and no Admin; **Ada** and **Bo** are Members with no Role Assignment at all. Those
   * three shapes are exactly the three answers FR5 distinguishes.
   */
  async function autumnOffsite(
    app: FastifyInstance,
  ): Promise<{ conferenceId: string; sessionId: string }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conferences',
      headers: as(PRIYA),
      payload: AUTUMN,
    });
    expect(created.statusCode, created.body).toBe(200);
    const conferenceId = created.json().id as string;

    const session = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions`,
      headers: as(PRIYA),
      payload: WAYS_OF_WORKING,
    });
    expect(session.statusCode, session.body).toBe(200);
    const sessionId = session.json().session.id as string;

    for (const sub of [IDA, ADA, BO]) await addMember(conferenceId, sub);

    const granted = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/members/roles`,
      headers: as(PRIYA),
      payload: { email: `${IDA}@ourcompany.example`, role: 'PresenterFacilitator' },
    });
    expect(granted.statusCode, granted.body).toBe(200);

    const assigned = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/assignments`,
      headers: as(PRIYA),
      payload: { userSub: IDA },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);

    const published = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/publish`,
      headers: as(PRIYA),
    });
    expect(published.statusCode, published.body).toBe(200);

    return { conferenceId, sessionId };
  }

  /**
   * A second Session on the Conference, so a deletion is not refused for being the last one.
   *
   * `SESSION_LAST_IN_PUBLISHED_CONFERENCE` is a different guard with a different reason, and it is
   * not what the contrast below is about - both halves of it get the same second Session so the
   * only difference between them is which removal was used.
   */
  async function secondSession(app: FastifyInstance, conferenceId: string): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions`,
      headers: as(PRIYA),
      payload: { ...WAYS_OF_WORKING, title: 'Retro', startTime: '15:30', endTime: '16:30' },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function newRound(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    open = true,
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds`,
      headers: as(IDA),
      payload: POST_IT_ROUND,
    });
    expect(response.statusCode, response.body).toBe(200);
    const roundId = response.json().round.id as string;
    if (open) {
      const opened = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/open`,
        headers: as(IDA),
      });
      expect(opened.statusCode, opened.body).toBe(200);
    }
    return roundId;
  }

  async function created(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    name: string,
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/categories`,
      headers: as(IDA),
      payload: { name },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().category.id as string;
  }

  async function contributed(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    sub: string,
    text: string,
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/post-its`,
      headers: as(sub),
      payload: { text },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().postIt.id as string;
  }

  function postItUrl(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
  ): string {
    return (
      `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}` +
      `/post-its/${postItId}`
    );
  }

  /** The permanent-removal endpoint, called exactly as the SPA calls it. */
  function removePermanently(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    sub = PRIYA,
    payload?: unknown,
  ) {
    return app.inject({
      method: 'POST',
      url: `${postItUrl(conferenceId, sessionId, roundId, postItId)}/permanent-removal`,
      headers: as(sub),
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function removed(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    sub = PRIYA,
  ): Promise<void> {
    const response = await removePermanently(app, conferenceId, sessionId, roundId, postItId, sub);
    expect(response.statusCode, response.body).toBe(200);
  }

  async function discarded(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
  ): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: `${postItUrl(conferenceId, sessionId, roundId, postItId)}/discard`,
      headers: as(IDA),
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function placed(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    categoryId: string | null,
  ): Promise<void> {
    const response = await app.inject({
      method: 'PATCH',
      url: `${postItUrl(conferenceId, sessionId, roundId, postItId)}/placement`,
      headers: as(IDA),
      payload: { categoryId },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function sessionRead(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    sub = IDA,
  ): Promise<{ rounds: WireRound[]; canRun: boolean; canRemovePermanently: boolean }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
      headers: as(sub),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  async function boardOf(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    sub = IDA,
  ): Promise<WireRound> {
    return (await sessionRead(app, conferenceId, sessionId, sub)).rounds[0]!;
  }

  async function discardedList(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
  ): Promise<{ id: string }[]> {
    const response = await app.inject({
      method: 'GET',
      url:
        `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}` +
        `/discarded-post-its`,
      headers: as(IDA),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().discarded as { id: string }[];
  }

  async function watermark(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    sub = ADA,
  ): Promise<string> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/activities/watermark`,
      headers: as(sub),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().activityWatermark as string;
  }

  /**
   * Archiving, from an app whose clock is past the Conference's last day - the idiom
   * `discard.integration.test.ts` uses, for the same reason: `CONFERENCE_ARCHIVE_TOO_EARLY` is not
   * what these scenarios are about.
   */
  async function archive(conferenceId: string): Promise<void> {
    const later = buildApp({
      db,
      auth: {
        verifier: namedVerifier(),
        users: createUserRepository(db),
        codeExchange: unusedCodeExchange(),
      },
      clock: fixedClock('2026-09-20'),
    });
    apps.push(later);
    const response = await later.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/archive`,
      headers: as(PRIYA),
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  /** The optimistic-concurrency base a Session delete carries, read straight from the row. */
  async function deleteSession(app: FastifyInstance, conferenceId: string, sessionId: string) {
    const { rows } = await client.query<{ version: string; state: string }>(
      `select to_char(s.last_updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                as version,
              c.lifecycle_state as state
         from sessions s join conference c on c.id = s.conference_id
        where s.id = $1`,
      [sessionId],
    );
    const base = rows[0]!;
    return app.inject({
      method: 'DELETE',
      url:
        `/api/conferences/${conferenceId}/sessions/${sessionId}` +
        `?conferenceState=${base.state}&version=${encodeURIComponent(base.version)}`,
      headers: as(PRIYA),
    });
  }

  async function storedPostIt(postItId: string): Promise<{ id: string } | undefined> {
    const { rows } = await client.query<{ id: string }>('select id from post_it where id = $1', [
      postItId,
    ]);
    return rows[0];
  }

  async function storedTrace(postItId: string): Promise<{ post_it_id: string } | undefined> {
    const { rows } = await client.query<{ post_it_id: string }>(
      'select post_it_id from post_it_discard where post_it_id = $1',
      [postItId],
    );
    return rows[0];
  }

  // ---------- the removal itself (TI01) ----------

  describe('an admin removes a post-it out of a category', () => {
    /** Acceptance Scenario S01. */
    it('takes it off every board, drops the count, and moves the cursor the room polls', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await newRound(app, conferenceId, sessionId);
      const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');

      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      const ci = await contributed(app, conferenceId, sessionId, roundId, BO, 'flaky CI');
      const builds = await contributed(app, conferenceId, sessionId, roundId, BO, 'slow builds');
      for (const id of [ada, ci, builds]) {
        await placed(app, conferenceId, sessionId, roundId, id, tooling);
      }

      // What an attendee's device is holding when the removal happens.
      const polled = await watermark(app, conferenceId, sessionId);

      await removed(app, conferenceId, sessionId, roundId, ada);

      const board = await boardOf(app, conferenceId, sessionId);
      const category = board.categories!.find((one) => one.id === tooling)!;
      expect(category.postIts.map((one) => one.text)).toEqual(['flaky CI', 'slow builds']);
      expect(category.postItCount).toBe(2);
      expect(board.uncategorised!.postIts.map((one) => one.text)).toEqual([]);

      // The row itself, not just the projection over it.
      expect(await storedPostIt(ada)).toBeUndefined();

      // And the attendee's next poll differs, so their next read shows the same board.
      expect(await watermark(app, conferenceId, sessionId)).not.toBe(polled);
      const attendeeBoard = await boardOf(app, conferenceId, sessionId, ADA);
      expect(
        attendeeBoard.categories!.find((one) => one.id === tooling)!.postIts.map((p) => p.text),
      ).toEqual(['flaky CI', 'slow builds']);
    });

    it('touches no post-it on another round of the same session', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const first = await newRound(app, conferenceId, sessionId);
      const second = await newRound(app, conferenceId, sessionId);

      const here = await contributed(app, conferenceId, sessionId, first, ADA, STAGING);
      const there = await contributed(app, conferenceId, sessionId, second, ADA, STAGING);

      /*
       * The same post-it id, named against the *wrong* round. The guard is the statement's own
       * predicate, so this matches nothing - and, because matching nothing is a success here, it
       * has to be proved by the rows rather than by a refusal.
       */
      await removed(app, conferenceId, sessionId, second, here);
      expect(await storedPostIt(here)).toBeDefined();
      expect(await storedPostIt(there)).toBeDefined();

      await removed(app, conferenceId, sessionId, first, here);
      expect(await storedPostIt(here)).toBeUndefined();
      expect(await storedPostIt(there)).toBeDefined();
    });

    /** A closed Round is not a barrier: moderation cannot wait for a Round to reopen. */
    it('removes from a closed round, where the author’s own delete is refused', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await newRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);

      const closed = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/close`,
        headers: as(IDA),
      });
      expect(closed.statusCode, closed.body).toBe(200);

      // The author's own path is refused on a closed round - the contrast this story preserves.
      const byAuthor = await app.inject({
        method: 'DELETE',
        url: postItUrl(conferenceId, sessionId, roundId, ada),
        headers: as(ADA),
      });
      expect(byAuthor.statusCode).toBe(409);
      expect(await storedPostIt(ada)).toBeDefined();

      await removed(app, conferenceId, sessionId, roundId, ada);
      expect(await storedPostIt(ada)).toBeUndefined();
    });
  });

  // ---------- idempotency (TI01, Acceptance Scenario S04) ----------

  describe('removing a post-it that is already gone', () => {
    it('succeeds silently, writes nothing, and leaves the board unchanged', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await newRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      const bo = await contributed(app, conferenceId, sessionId, roundId, BO, 'flaky CI');

      await removed(app, conferenceId, sessionId, roundId, ada);

      // Bo took his own down from his phone a moment ago.
      const byAuthor = await app.inject({
        method: 'DELETE',
        url: postItUrl(conferenceId, sessionId, roundId, bo),
        headers: as(BO),
      });
      expect(byAuthor.statusCode, byAuthor.body).toBe(200);

      const before = await boardOf(app, conferenceId, sessionId);
      const settled = await watermark(app, conferenceId, sessionId);

      for (const id of [ada, bo]) {
        const again = await removePermanently(app, conferenceId, sessionId, roundId, id);
        expect(again.statusCode, again.body).toBe(200);
        expect(again.json()).toEqual({ removed: true });
      }

      // Nothing written: the board is identical and the cursor has not moved.
      expect(await boardOf(app, conferenceId, sessionId)).toEqual(before);
      expect(await watermark(app, conferenceId, sessionId)).toBe(settled);
    });
  });

  // ---------- the discard trace, through the schema's cascade (TI02) ----------

  describe('removing an already-discarded post-it', () => {
    /** Acceptance Scenario S02. */
    it('takes its trace with it and the pending restore disappears', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await newRound(app, conferenceId, sessionId);
      const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      await placed(app, conferenceId, sessionId, roundId, ada, tooling);
      await discarded(app, conferenceId, sessionId, roundId, ada);

      // It is sitting in the facilitator's reversal list, awaiting a possible restore.
      expect((await discardedList(app, conferenceId, sessionId, roundId)).map((d) => d.id)).toEqual(
        [ada],
      );
      expect(await storedTrace(ada)).toBeDefined();

      await removed(app, conferenceId, sessionId, roundId, ada);

      // The row, the trace, and the offer to put it back - all gone.
      expect(await storedPostIt(ada)).toBeUndefined();
      expect(await storedTrace(ada)).toBeUndefined();
      expect(await discardedList(app, conferenceId, sessionId, roundId)).toEqual([]);

      // And a restore attempted against that id afterwards brings nothing back.
      const restored = await app.inject({
        method: 'POST',
        url: `${postItUrl(conferenceId, sessionId, roundId, ada)}/restore`,
        headers: as(IDA),
      });
      expect(restored.statusCode).toBe(404);
      const board = await boardOf(app, conferenceId, sessionId);
      expect(board.uncategorised!.postIts).toEqual([]);
      expect(board.categories!.find((one) => one.id === tooling)!.postItCount).toBe(0);
    });

    /**
     * And the trace goes because the **schema** takes it, not because this story deletes it.
     *
     * Asserted against `information_schema` rather than against the removal's effect, because the
     * effect is identical either way: a second delete statement issued by S06 would pass the test
     * above and would make one fact true two ways. The structural half - that no source on this
     * path names `post_it_discard` - is in `permanent-removal-structure.test.ts`.
     */
    it('goes through the foreign key’s cascade, which the schema still declares', async () => {
      const { rows } = await client.query<{ delete_rule: string }>(
        `select rc.delete_rule
           from information_schema.referential_constraints rc
           join information_schema.table_constraints tc
             on tc.constraint_name = rc.constraint_name
            and tc.constraint_schema = rc.constraint_schema
          where tc.table_name = 'post_it_discard'
            and rc.unique_constraint_name in (
              select constraint_name from information_schema.table_constraints
               where table_name = 'post_it' and constraint_type = 'PRIMARY KEY'
            )`,
      );
      expect(rows.length, 'the trace should reference post_it').toBeGreaterThan(0);
      for (const rule of rows) expect(rule.delete_rule).toBe('CASCADE');
    });
  });

  // ---------- who may remove, and when (TI03) ----------

  describe('who may permanently remove', () => {
    /** Acceptance Scenario S03. */
    it('refuses a facilitator holding a session assignment, offering discard instead', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await newRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);

      const response = await removePermanently(app, conferenceId, sessionId, roundId, ada, IDA);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('POST_IT_ADMIN_REQUIRED');
      expect(response.json().error.message).toBe(ADMIN_SENTENCE);
      expect(await storedPostIt(ada)).toBeDefined();

      // And the control was never offered to her in the first place.
      const read = await sessionRead(app, conferenceId, sessionId, IDA);
      expect(read.canRun).toBe(true);
      expect(read.canRemovePermanently).toBe(false);
    });

    it('refuses a member holding membership alone with the neutral sentence', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await newRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);

      /*
       * Her own post-it, and still not hers to remove this way. The sentence is the neutral one -
       * she is told nothing about the conference, the session or what she would need, because
       * the sorting-authority gate refuses her before the Admin question is even asked.
       */
      const response = await removePermanently(app, conferenceId, sessionId, roundId, ada, ADA);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');
      expect(response.json().error.message).not.toContain('admin');
      expect(await storedPostIt(ada)).toBeDefined();

      const read = await sessionRead(app, conferenceId, sessionId, ADA);
      expect(read.canRun).toBe(false);
      expect(read.canRemovePermanently).toBe(false);
    });

    it('admits a conference-wide admin holding no session assignment', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await newRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);

      const read = await sessionRead(app, conferenceId, sessionId, PRIYA);
      expect(read.canRemovePermanently).toBe(true);

      await removed(app, conferenceId, sessionId, roundId, ada);
      expect(await storedPostIt(ada)).toBeUndefined();
    });

    /**
     * Binding Constraint FR6: a body naming an actor is **accepted and never read**.
     *
     * Ignored rather than refused is the stronger statement - a route that refuses an actor field
     * and a route that trusts one both pass "does not accept a body with an actor in it", and only
     * one of them is correct.
     */
    it('ignores an actorSub in the body: the acting identity is the credential', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await newRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      const bo = await contributed(app, conferenceId, sessionId, roundId, BO, 'flaky CI');

      // Ida names the Admin in the body. It changes nothing: she is still refused.
      const impersonated = await removePermanently(
        app,
        conferenceId,
        sessionId,
        roundId,
        ada,
        IDA,
        { actorSub: PRIYA, userSub: PRIYA, adminSub: PRIYA },
      );
      expect(impersonated.statusCode).toBe(403);
      expect(impersonated.json().error.code).toBe('POST_IT_ADMIN_REQUIRED');
      expect(await storedPostIt(ada)).toBeDefined();

      // And the Admin naming somebody else is accepted and acts as herself.
      const accepted = await removePermanently(app, conferenceId, sessionId, roundId, bo, PRIYA, {
        actorSub: IDA,
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(await storedPostIt(bo)).toBeUndefined();
    });

    /** Acceptance Scenario S05. */
    it('refuses on an archived conference, naming the archived state', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await newRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);

      await archive(conferenceId);

      const response = await removePermanently(app, conferenceId, sessionId, roundId, ada);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFERENCE_NOT_EDITABLE');
      expect(response.json().error.message).toBe(ARCHIVED_SENTENCE);
      expect(await storedPostIt(ada)).toBeDefined();

      // And the control is not offered on an archived conference, even to the Admin.
      expect((await sessionRead(app, conferenceId, sessionId, PRIYA)).canRemovePermanently).toBe(
        false,
      );
    });
  });

  // ---------- the session-deletion counter-case (TI06) ----------

  describe('session deletion after a permanent removal', () => {
    /**
     * Acceptance Scenario S07 - **both halves in one test**, because the contrast is the claim.
     *
     * The same Session, the same single Post-it, two different removals: permanently removed, it
     * is deletable; merely discarded, it is refused. Neither answer is coded anywhere - the count
     * has no state condition in it at all (`post-it-repository.ts#countPostItsForSession`), and
     * these two assertions are what stop one being added.
     */
    it('is permitted after a removal and still refused after a mere discard', async () => {
      const app = appWith();

      const discardedCase = await autumnOffsite(app);
      await secondSession(app, discardedCase.conferenceId);
      const discardedRound = await newRound(
        app,
        discardedCase.conferenceId,
        discardedCase.sessionId,
      );
      const kept = await contributed(
        app,
        discardedCase.conferenceId,
        discardedCase.sessionId,
        discardedRound,
        ADA,
        STAGING,
      );
      await discarded(
        app,
        discardedCase.conferenceId,
        discardedCase.sessionId,
        discardedRound,
        kept,
      );

      const refused = await deleteSession(app, discardedCase.conferenceId, discardedCase.sessionId);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe('SESSION_HOLDS_CONTRIBUTIONS');

      const removedCase = await autumnOffsite(app);
      await secondSession(app, removedCase.conferenceId);
      const removedRound = await newRound(app, removedCase.conferenceId, removedCase.sessionId);
      const gone = await contributed(
        app,
        removedCase.conferenceId,
        removedCase.sessionId,
        removedRound,
        ADA,
        STAGING,
      );
      await removed(app, removedCase.conferenceId, removedCase.sessionId, removedRound, gone);

      const deleted = await deleteSession(app, removedCase.conferenceId, removedCase.sessionId);
      expect(deleted.statusCode, deleted.body).toBe(200);

      const { rows } = await client.query('select id from sessions where id = $1', [
        removedCase.sessionId,
      ]);
      expect(rows).toHaveLength(0);
    });
  });
});
