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
 * Facilitator Discard and restore, against the real PostgreSQL the composed stack runs (S05, FR4).
 *
 * **Every property this story is risky for is a storage-level guarantee, and none of them is
 * provable against a fake that answers whatever the test wants**: the `ON DELETE CASCADE` that
 * decides the author-delete race, the primary key that makes both directions idempotent, the
 * composite foreign key that pins a trace to its Post-it's own Round, the anti-join that takes a
 * discarded Post-it off every Board including its author's, and the trigger that carries a Discard to
 * the room through the one activity cursor.
 *
 * Three disciplines run through the whole file, inherited from `placement.integration.test.ts`:
 *
 *   - **A refusal is asserted against the stored rows**, never against the response envelope alone.
 *     A route that returns a refusal and writes anyway passes a response-only test.
 *   - **Nothing here asserts that a request was issued.** Propagation is proved by what the *next*
 *     read returns, which is what a participant actually sees.
 *   - **The trace is read from the table as well as from the payload**, so a route that returned the
 *     right list over the wrong rows fails.
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
    '\n[integration] SKIPPED discard and restore – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/** Priya organizes (and so is Admin); Ida and Dev facilitate; Ada and Bo are in the room. */
const PRIYA = 'google-sub-priya';
const IDA = 'google-sub-ida';
const DEV = 'google-sub-dev';
const ADA = 'google-sub-ada';
const BO = 'google-sub-bo';

const NAMES: Record<string, string> = {
  [PRIYA]: 'Priya Raman',
  [IDA]: 'Ida Andersson',
  [DEV]: 'Dev Patel',
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

interface WirePostIt {
  id: string;
  text: string;
  authorName: string;
  mine: boolean;
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

interface WireDiscarded {
  id: string;
  text: string;
  authorName: string;
  discardedByName: string;
  discardedAt: string;
}

describe.skipIf(!reachable)('discard and restore against a real PostgreSQL', () => {
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

  function appWith(database: Database = db): FastifyInstance {
    const app = buildApp({
      db: database,
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
   * Ida and Dev both facilitate it. Priya created the Conference and so holds conference-wide
   * **Admin** and no Session Assignment - which is what the authority scenario needs. Ada and Bo are
   * Members with no Role Assignment at all, and Ada is both the author whose Post-it gets discarded
   * and the Member whose refusal is asserted.
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

    for (const sub of [IDA, DEV, ADA, BO]) await addMember(conferenceId, sub);

    for (const sub of [IDA, DEV]) {
      const granted = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/members/roles`,
        headers: as(PRIYA),
        payload: { email: `${sub}@ourcompany.example`, role: 'PresenterFacilitator' },
      });
      expect(granted.statusCode, granted.body).toBe(200);

      const assigned = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/sessions/${sessionId}/assignments`,
        headers: as(PRIYA),
        payload: { userSub: sub },
      });
      expect(assigned.statusCode, assigned.body).toBe(200);
    }

    const published = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/publish`,
      headers: as(PRIYA),
    });
    expect(published.statusCode, published.body).toBe(200);

    return { conferenceId, sessionId };
  }

  function transition(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    move: 'open' | 'close',
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/${move}`,
      headers: as(IDA),
    });
  }

  async function openPostItRound(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds`,
      headers: as(IDA),
      payload: POST_IT_ROUND,
    });
    expect(response.statusCode, response.body).toBe(200);
    const roundId = response.json().round.id as string;
    const opened = await transition(app, conferenceId, sessionId, roundId, 'open');
    expect(opened.statusCode, opened.body).toBe(200);
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

  /** The discard endpoint, called exactly as the SPA calls it. */
  function discard(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    sub = IDA,
  ) {
    return app.inject({
      method: 'POST',
      url: `${postItUrl(conferenceId, sessionId, roundId, postItId)}/discard`,
      headers: as(sub),
    });
  }

  function restore(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    sub = IDA,
  ) {
    return app.inject({
      method: 'POST',
      url: `${postItUrl(conferenceId, sessionId, roundId, postItId)}/restore`,
      headers: as(sub),
    });
  }

  async function discarded(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    sub = IDA,
  ): Promise<void> {
    const response = await discard(app, conferenceId, sessionId, roundId, postItId, sub);
    expect(response.statusCode, response.body).toBe(200);
  }

  function place(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    categoryId: string | null,
    sub = IDA,
  ) {
    return app.inject({
      method: 'PATCH',
      url: `${postItUrl(conferenceId, sessionId, roundId, postItId)}/placement`,
      headers: as(sub),
      payload: { categoryId },
    });
  }

  async function placed(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    categoryId: string | null,
  ): Promise<void> {
    const response = await place(app, conferenceId, sessionId, roundId, postItId, categoryId);
    expect(response.statusCode, response.body).toBe(200);
  }

  async function discardedList(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    sub = IDA,
  ): Promise<WireDiscarded[]> {
    const response = await app.inject({
      method: 'GET',
      url:
        `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}` +
        `/discarded-post-its`,
      headers: as(sub),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().discarded as WireDiscarded[];
  }

  async function boardOf(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    sub = IDA,
  ): Promise<WireRound> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
      headers: as(sub),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().rounds[0] as WireRound;
  }

  async function watermark(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    sub: string,
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
   * Archiving, from an app whose clock is past the Conference's last day.
   *
   * `CONFERENCE_ARCHIVE_TOO_EARLY` refuses an archive before then, and that guard is not what these
   * scenarios are about - so the transition is taken through a second app on the same database with
   * a later clock, and every other request keeps the conference-day clock the rest of the file uses.
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

  /**
   * The optimistic-concurrency base a Session delete carries, read straight from the row - the same
   * idiom `session-deletion.integration.test.ts` uses.
   */
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

  /** The trace as the table holds it – never as a response describes it. */
  async function storedTrace(
    postItId: string,
  ): Promise<{ round_id: string; discarded_by_sub: string; discarded_at: string } | undefined> {
    const { rows } = await client.query<{
      round_id: string;
      discarded_by_sub: string;
      discarded_at: string;
    }>(
      `select round_id, discarded_by_sub, discarded_at::text as discarded_at
         from post_it_discard where post_it_id = $1`,
      [postItId],
    );
    return rows[0];
  }

  async function storedPlacement(postItId: string): Promise<string | null> {
    const { rows } = await client.query<{ category_id: string | null }>(
      'select category_id from post_it where id = $1',
      [postItId],
    );
    return rows[0]?.category_id ?? null;
  }

  async function traceCount(): Promise<number> {
    const { rows } = await client.query<{ n: string }>('select count(*) as n from post_it_discard');
    return Number(rows[0]!.n);
  }

  // ---------- the trace, and what the schema guarantees about it (TI02) ----------

  describe('the discard trace', () => {
    it('records who discarded it and when, outside the post_it row', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);

      await discarded(app, conferenceId, sessionId, roundId, postItId);

      const trace = await storedTrace(postItId);
      expect(trace?.discarded_by_sub).toBe(IDA);
      expect(trace?.round_id).toBe(roundId);
      expect(trace?.discarded_at).toBeTruthy();

      // The post_it row itself gained nothing: no column on it says a Discard happened.
      const { rows } = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'post_it'`,
      );
      const columns = rows.map((row) => row.column_name);
      expect(columns.some((name) => /discard|deleted|tombstone|removed/i.test(name))).toBe(false);
    });

    it('survives round close, round reopen and conference archival', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      await discarded(app, conferenceId, sessionId, roundId, postItId);
      const before = await storedTrace(postItId);

      expect((await transition(app, conferenceId, sessionId, roundId, 'close')).statusCode).toBe(
        200,
      );
      expect(await storedTrace(postItId)).toEqual(before);

      expect((await transition(app, conferenceId, sessionId, roundId, 'open')).statusCode).toBe(
        200,
      );
      expect(await storedTrace(postItId)).toEqual(before);

      await archive(conferenceId);
      expect(await storedTrace(postItId)).toEqual(before);
    });

    it('advances the round’s activity watermark on discard and again on restore', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);

      const settled = await watermark(app, conferenceId, sessionId, ADA);
      await discarded(app, conferenceId, sessionId, roundId, postItId);
      const afterDiscard = await watermark(app, conferenceId, sessionId, ADA);
      expect(afterDiscard).not.toBe(settled);

      expect((await restore(app, conferenceId, sessionId, roundId, postItId)).statusCode).toBe(200);
      expect(await watermark(app, conferenceId, sessionId, ADA)).not.toBe(afterDiscard);
    });

    it('goes with the post_it row when its author deletes it, leaving no orphan', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      await discarded(app, conferenceId, sessionId, roundId, postItId);
      expect(await traceCount()).toBe(1);

      // Straight at the table: the cascade is the schema's, not the delete path's.
      await client.query('delete from post_it where id = $1', [postItId]);
      expect(await traceCount()).toBe(0);
    });

    it('refuses a trace that names a different round than its post-it’s', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const otherRoundId = await openPostItRound(app, conferenceId, sessionId);
      const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);

      await expect(
        client.query(
          `insert into post_it_discard (post_it_id, round_id, discarded_by_sub)
           values ($1, $2, $3)`,
          [postItId, otherRoundId, IDA],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  // ---------- discard, restore and their idempotence (TI03) ----------

  describe('discarding and restoring', () => {
    it('takes a post-it out of its category and drops that category’s count', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');

      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      const bo = await contributed(app, conferenceId, sessionId, roundId, BO, 'flaky CI');
      const spare = await contributed(app, conferenceId, sessionId, roundId, BO, 'slow laptops');
      for (const id of [ada, bo, spare]) {
        await placed(app, conferenceId, sessionId, roundId, id, tooling);
      }
      const unsorted = await contributed(app, conferenceId, sessionId, roundId, BO, 'no coffee');
      expect(unsorted).toBeTruthy();

      await discarded(app, conferenceId, sessionId, roundId, ada);

      const board = await boardOf(app, conferenceId, sessionId);
      const category = board.categories!.find((one) => one.id === tooling)!;
      expect(category.postItCount).toBe(2);
      expect(category.postIts.map((one) => one.text)).not.toContain(STAGING);
      expect(board.uncategorised!.postItCount).toBe(1);
      expect(board.uncategorised!.postIts.map((one) => one.text)).not.toContain(STAGING);

      // The placement came off in the same statement as the trace went in – which is what makes
      // "a restore returns it to Uncategorised" structural rather than remembered.
      expect(await storedPlacement(ada)).toBeNull();
    });

    it('returns a restored post-it to uncategorised, never to the category it came from', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      await placed(app, conferenceId, sessionId, roundId, ada, tooling);
      await discarded(app, conferenceId, sessionId, roundId, ada);

      const restored = await restore(app, conferenceId, sessionId, roundId, ada);
      expect(restored.statusCode, restored.body).toBe(200);

      const board = await boardOf(app, conferenceId, sessionId);
      expect(board.uncategorised!.postItCount).toBe(1);
      expect(board.uncategorised!.postIts.map((one) => one.text)).toContain(STAGING);
      expect(board.categories!.find((one) => one.id === tooling)!.postItCount).toBe(0);
      expect(await storedPlacement(ada)).toBeNull();
      expect(await discardedList(app, conferenceId, sessionId, roundId)).toEqual([]);
    });

    it('discards idempotently – no second row, and the first trace is untouched', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);

      await discarded(app, conferenceId, sessionId, roundId, ada, IDA);
      const first = await storedTrace(ada);

      // A different Facilitator, so a trace that was rewritten would say so.
      const again = await discard(app, conferenceId, sessionId, roundId, ada, DEV);
      expect(again.statusCode, again.body).toBe(200);

      expect(await storedTrace(ada)).toEqual(first);
      expect(await traceCount()).toBe(1);
    });

    it('restores idempotently – a post-it that was never discarded stays where it is', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
      const bo = await contributed(app, conferenceId, sessionId, roundId, BO, 'flaky CI');
      await placed(app, conferenceId, sessionId, roundId, bo, tooling);

      const response = await restore(app, conferenceId, sessionId, roundId, bo);
      expect(response.statusCode, response.body).toBe(200);

      expect(await storedPlacement(bo)).toBe(tooling);
      const board = await boardOf(app, conferenceId, sessionId);
      expect(board.categories!.find((one) => one.id === tooling)!.postItCount).toBe(1);
    });

    it('refuses a discard or restore of a post-it that is not on this board', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const absent = '00000000-0000-4000-8000-000000000abc';

      for (const attempt of [
        discard(app, conferenceId, sessionId, roundId, absent),
        restore(app, conferenceId, sessionId, roundId, absent),
      ]) {
        const response = await attempt;
        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe('POST_IT_NOT_FOUND');
      }
    });

    /**
     * The scoping conjuncts, proved against a **real** Post-it reached through the **wrong** Round.
     *
     * A nonexistent id proves only `p.id = $4`: every other conjunct in `ON_THIS_BOARD` could be
     * deleted and a test using one would still pass. This is what keeps one Session's Facilitator
     * from discarding another Board's Post-it through a hand-edited URL.
     */
    it('refuses a discard, a restore and a listing reached through the wrong round', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const otherRoundId = await openPostItRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      await discarded(app, conferenceId, sessionId, roundId, ada);
      const trace = await storedTrace(ada);

      // The Post-it exists and the Round exists; they just do not belong to each other.
      for (const attempt of [
        discard(app, conferenceId, sessionId, otherRoundId, ada),
        restore(app, conferenceId, sessionId, otherRoundId, ada),
      ]) {
        const response = await attempt;
        expect(response.statusCode, response.body).toBe(404);
        expect(response.json().error.code).toBe('POST_IT_NOT_FOUND');
      }
      // Nothing moved: the trace is byte-identical to the one the real Board wrote.
      expect(await storedTrace(ada)).toEqual(trace);

      // And the other Board's list does not carry this Board's discarded post-it.
      expect(await discardedList(app, conferenceId, sessionId, otherRoundId)).toEqual([]);
      expect(await discardedList(app, conferenceId, sessionId, roundId)).toHaveLength(1);
    });

    /**
     * Oldest Discard first, as `discarded-postits.html` draws it - and as the index carries it.
     *
     * A single-item list cannot tell the two orders apart, so the order was unproven and the
     * migration's own comment disagreed with the query.
     */
    it('lists the discarded post-its in the order they were discarded', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const first = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      const second = await contributed(app, conferenceId, sessionId, roundId, BO, 'flaky CI');

      await discarded(app, conferenceId, sessionId, roundId, first);
      await discarded(app, conferenceId, sessionId, roundId, second);

      const list = await discardedList(app, conferenceId, sessionId, roundId);
      expect(list.map((one) => one.id)).toEqual([first, second]);
    });

    /**
     * **The restore clears the placement itself**, so a `category_id` that reached a discarded
     * Post-it by any route cannot survive a restore.
     *
     * `place`'s not-discarded conjunct is a sub-select, and under `READ COMMITTED` a placement that
     * blocks on the Discard's row lock is re-checked by EvalPlanQual against `post_it` alone - the
     * sub-select still sees the command's original snapshot, without the trace. Rather than reason
     * about whether that window is reachable, the placement is written **straight to the table**
     * here, which reproduces the exact end state that race would leave, and the restore is asserted
     * to undo it. Without the clearing in `restore`, this returns the Post-it to "Tooling" and OC02
     * fails.
     */
    it('returns a post-it to uncategorised even if a placement reached it while discarded', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      await discarded(app, conferenceId, sessionId, roundId, ada);
      expect(await storedPlacement(ada)).toBeNull();

      // The end state the EvalPlanQual window would leave behind, written directly.
      await client.query('update post_it set category_id = $1 where id = $2', [tooling, ada]);
      expect(await storedPlacement(ada)).toBe(tooling);

      expect((await restore(app, conferenceId, sessionId, roundId, ada)).statusCode).toBe(200);

      expect(await storedPlacement(ada)).toBeNull();
      const board = await boardOf(app, conferenceId, sessionId);
      expect(board.uncategorised!.postIts.map((one) => one.text)).toContain(STAGING);
      expect(board.categories!.find((one) => one.id === tooling)!.postItCount).toBe(0);
    });

    it('lists a discarded post-it with its author, its discarder and its instant', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      await discarded(app, conferenceId, sessionId, roundId, ada, DEV);

      const list = await discardedList(app, conferenceId, sessionId, roundId);
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe(ada);
      expect(list[0]!.text).toBe(STAGING);
      expect(list[0]!.authorName).toBe('Ada Lovelace');
      expect(list[0]!.discardedByName).toBe('Dev Patel');
      expect(list[0]!.discardedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    });
  });

  // ---------- the placement path's two refusal sites (TI03, scenario S08) ----------

  describe('a discarded post-it cannot be placed', () => {
    it('refuses the placement naming the discard, not the destination category', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
      const hiring = await created(app, conferenceId, sessionId, roundId, 'Hiring');
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      await placed(app, conferenceId, sessionId, roundId, ada, tooling);
      await discarded(app, conferenceId, sessionId, roundId, ada);

      // Dev's board was read just before the Discard, so their client still shows it in Tooling.
      const response = await place(app, conferenceId, sessionId, roundId, ada, hiring, DEV);

      expect(response.statusCode, response.body).toBe(409);
      /*
       * **The whole point of this test.** Before the diagnosis learned about Discard, this answered
       * `CATEGORY_NOT_FOUND` – "that category is not on this board" – about a destination that was
       * perfectly valid, because `diagnosePlacement` reported `destination-missing` for every case
       * in which the post_it row was still found. Neither tsc nor the structure guards catch that;
       * only this assertion does.
       */
      expect(response.json().error.code).toBe('POST_IT_DISCARDED');
      expect(response.json().error.message).toMatch(/discarded/i);
      expect(response.json().error.message).not.toMatch(/category is not on this board/i);

      expect(await storedPlacement(ada)).toBeNull();
      const board = await boardOf(app, conferenceId, sessionId);
      expect(board.categories!.find((one) => one.id === hiring)!.postItCount).toBe(0);
    });

    it('still returns it to uncategorised when it is restored afterwards', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
      const hiring = await created(app, conferenceId, sessionId, roundId, 'Hiring');
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      await placed(app, conferenceId, sessionId, roundId, ada, tooling);
      await discarded(app, conferenceId, sessionId, roundId, ada);
      expect(
        (await place(app, conferenceId, sessionId, roundId, ada, hiring, DEV)).statusCode,
      ).toBe(409);

      expect((await restore(app, conferenceId, sessionId, roundId, ada)).statusCode).toBe(200);

      const board = await boardOf(app, conferenceId, sessionId);
      expect(board.uncategorised!.postIts.map((one) => one.text)).toContain(STAGING);
      expect(board.categories!.find((one) => one.id === hiring)!.postItCount).toBe(0);
      expect(board.categories!.find((one) => one.id === tooling)!.postItCount).toBe(0);
    });

    it('still refuses a genuinely missing destination with the category sentence', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const bo = await contributed(app, conferenceId, sessionId, roundId, BO, 'flaky CI');

      const response = await place(
        app,
        conferenceId,
        sessionId,
        roundId,
        bo,
        '00000000-0000-4000-8000-0000000000ca',
      );
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('CATEGORY_NOT_FOUND');
    });
  });

  // ---------- authority and the archived conference (TI04) ----------

  describe('who may discard, and when', () => {
    it('refuses a member holding membership alone, at the discard route', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);

      // Her own post-it, and still not hers to discard: Discard is the sorting act.
      const response = await discard(app, conferenceId, sessionId, roundId, ada, ADA);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');
      expect(await storedTrace(ada)).toBeUndefined();

      const list = await app.inject({
        method: 'GET',
        url:
          `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}` +
          `/discarded-post-its`,
        headers: as(ADA),
      });
      expect(list.statusCode).toBe(403);
    });

    it('admits a conference-wide admin holding no session assignment', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);

      await discarded(app, conferenceId, sessionId, roundId, ada, PRIYA);
      expect((await storedTrace(ada))?.discarded_by_sub).toBe(PRIYA);
    });

    it('refuses both discard and restore once the conference is archived', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      const bo = await contributed(app, conferenceId, sessionId, roundId, BO, 'flaky CI');
      await discarded(app, conferenceId, sessionId, roundId, ada);

      await archive(conferenceId);

      const sentence =
        'This conference has been archived, so it is read-only and can no longer ' + 'be changed.';

      const restored = await restore(app, conferenceId, sessionId, roundId, ada);
      expect(restored.statusCode).toBe(409);
      expect(restored.json().error.code).toBe('CONFERENCE_NOT_EDITABLE');
      expect(restored.json().error.message).toBe(sentence);
      expect(await storedTrace(ada)).toBeDefined();

      const attempted = await discard(app, conferenceId, sessionId, roundId, bo);
      expect(attempted.statusCode).toBe(409);
      expect(attempted.json().error.code).toBe('CONFERENCE_NOT_EDITABLE');
      expect(attempted.json().error.message).toBe(sentence);
      expect(await storedTrace(bo)).toBeUndefined();
    });
  });

  // ---------- what every other read shows (TI05) ----------

  describe('a discarded post-it is on no board at all', () => {
    it('is absent from its own author’s board, with no marker and no delete control', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      const kept = await contributed(
        app,
        conferenceId,
        sessionId,
        roundId,
        ADA,
        'and a whiteboard',
      );
      expect(kept).toBeTruthy();

      await discarded(app, conferenceId, sessionId, roundId, ada);

      const board = await boardOf(app, conferenceId, sessionId, ADA);
      const texts = board.uncategorised!.postIts.map((one) => one.text);
      expect(texts).not.toContain(STAGING);
      expect(texts).toContain('and a whiteboard');
      expect(board.uncategorised!.postItCount).toBe(1);
      // No marker of any kind rides the payload: the post-it is not in it to carry one.
      expect(JSON.stringify(board)).not.toMatch(/discard/i);
    });

    it('is absent from the projected board a display link resolves', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);

      const issued = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/display-link`,
        headers: as(IDA),
      });
      expect(issued.statusCode, issued.body).toBe(200);
      const token = issued.json().displayLink.token as string;

      await discarded(app, conferenceId, sessionId, roundId, ada);

      const projected = await app.inject({ method: 'GET', url: `/api/display/${token}` });
      expect(projected.statusCode, projected.body).toBe(200);
      expect(JSON.stringify(projected.json())).not.toContain(STAGING);
    });
  });

  // ---------- the author-delete race (TI06) ----------

  describe('an author’s delete racing a discard', () => {
    it('wins, removes the row, and takes the trace with it', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      await discarded(app, conferenceId, sessionId, roundId, ada);
      const beforeDelete = await watermark(app, conferenceId, sessionId, ADA);

      // Ada's device still holds a delete in flight against a post-it she can no longer see.
      const deleted = await app.inject({
        method: 'DELETE',
        url: postItUrl(conferenceId, sessionId, roundId, ada),
        headers: as(ADA),
      });
      expect(deleted.statusCode, deleted.body).toBe(200);

      const { rows } = await client.query('select id from post_it where id = $1', [ada]);
      expect(rows).toHaveLength(0);
      expect(await storedTrace(ada)).toBeUndefined();
      expect(await traceCount()).toBe(0);
      expect(await discardedList(app, conferenceId, sessionId, roundId)).toEqual([]);
      expect(await watermark(app, conferenceId, sessionId, ADA)).not.toBe(beforeDelete);
    });
  });

  // ---------- the session-deletion decision (TI07) ----------

  describe('session deletion counts a discarded post-it', () => {
    it('refuses the deletion and counts it, because its text is still restorable', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const ada = await contributed(app, conferenceId, sessionId, roundId, ADA, STAGING);
      await discarded(app, conferenceId, sessionId, roundId, ada);

      const response = await deleteSession(app, conferenceId, sessionId);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe('SESSION_HOLDS_CONTRIBUTIONS');
      expect(response.json().error.message).toContain('1 post-it');

      const { rows } = await client.query('select id from sessions where id = $1', [sessionId]);
      expect(rows).toHaveLength(1);
    });
  });

  describe('an author correcting a discarded post-it', () => {
    /*
     * The author's own correction is deliberately NOT refused against a discarded Post-it (owner
     * decision, 2026-08-31). `place` refuses one and `remove` does not; `edit` follows `remove`,
     * because an author owns their words whether or not a Facilitator has set the Post-it aside -
     * the same rule that already lets an author's deletion win its race against a Discard.
     *
     * This pins the consequence rather than hiding it: the text in the Facilitator's discarded
     * list, and the text a restore puts back in front of the room, can change under them. If
     * somebody later adds a not-discarded conjunct to `edit` for consistency with `place`, this
     * test is the thing that says the omission was a decision.
     */
    it('lets the author correct a discarded post-it, and the discarded list shows the new text', async () => {
      const app = appWith();
      const { conferenceId, sessionId } = await autumnOffsite(app);
      const roundId = await openPostItRound(app, conferenceId, sessionId);
      const postItId = await contributed(
        app,
        conferenceId,
        sessionId,
        roundId,
        ADA,
        'Standups drag',
      );

      await discarded(app, conferenceId, sessionId, roundId, postItId);

      const corrected = await app.inject({
        method: 'PATCH',
        url: postItUrl(conferenceId, sessionId, roundId, postItId),
        headers: as(ADA),
        payload: { text: 'Standups drag on for forty minutes' },
      });
      expect(corrected.statusCode, corrected.body).toBe(200);

      // Still discarded: the correction does not restore it, and no Board read returns it.
      const board = await boardOf(app, conferenceId, sessionId);
      expect(JSON.stringify(board)).not.toContain('Standups drag');

      // The Facilitator's list carries the author's new words, not the ones that were discarded.
      const list = await discardedList(app, conferenceId, sessionId, roundId);
      expect(list.map((entry) => entry.text)).toEqual(['Standups drag on for forty minutes']);
    });
  });
});
