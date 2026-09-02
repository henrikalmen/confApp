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
import { POST_IT_MAX_LENGTH } from '../src/rounds/post-it-validation.ts';
import { fixedClock } from '../src/conferences/calendar-date.ts';
import { tokenFor, unusedCodeExchange } from './fake-auth.ts';
import type { Verifier } from '../src/auth/verify-id-token.ts';
import { stepsToRevertThrough } from './migration-depth.ts';

/**
 * S02's named Post-it contribution, against the real PostgreSQL the composed stack runs.
 *
 * Every rule proved here is a storage-level guarantee, an authority decision or a propagation
 * property, and none is provable against a fake that answers whatever the test wants: the composite
 * foreign key that makes a Post-it on a Poll unwritable, the guards that live inside the write
 * statements' predicates, the triggers that move `round.activity_watermark` on a **delete**, and
 * the two watermarks a Post-it write must leave alone.
 *
 * Two disciplines run through the whole file (FIS -> Testing Strategy):
 *
 *   - **A refusal is asserted against the stored row**, never against the response envelope alone.
 *     A route that returns a refusal and writes anyway passes a response-only test.
 *   - **Nothing here asserts that a request was issued.** Propagation is proved by what the *next*
 *     read returns, which is the thing a participant actually sees.
 *
 * The verifier is stubbed, because who the caller is was settled in the S02 auth suite and the
 * subject here is what that caller may do - and, for the load-bearing case, whose name the
 * contribution lands under.
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
    '\n[integration] SKIPPED named post-it contribution – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/** Priya organizes; Ida facilitates the workshop; Ada, Bo and Cleo are in the room. */
const PRIYA = 'google-sub-priya';
const IDA = 'google-sub-ida';
const ADA = 'google-sub-ada';
const BO = 'google-sub-bo';
const CLEO = 'google-sub-cleo';
/** Signed in, in no conference at all. */
const OUTSIDER = 'google-sub-outsider';

const NAMES: Record<string, string> = {
  [PRIYA]: 'Priya Raman',
  [IDA]: 'Ida Andersson',
  [ADA]: 'Ada Lovelace',
  [BO]: 'Bo Nilsson',
  [CLEO]: 'Cleo Marsh',
  [OUTSIDER]: 'Otto Sider',
};

/**
 * `subjectVerifier` with a real display name per subject.
 *
 * The shared one answers `displayName: sub`, and `withAuth` upserts the caller's `app_user` row from
 * the claims on **every** request – so a name seeded in `beforeEach` is overwritten the moment its
 * owner makes a request. That would leave every board assertion comparing a name against the `sub`
 * beside it, which a route emitting `author_sub` where the joined `display_name` belongs would pass
 * unnoticed. Distinct names are what make the join observable.
 */
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

const POLL = {
  kind: 'VotingRound',
  purpose: 'Poll',
  prompt: 'Where should we start?',
  options: ['Tooling', 'Meetings'],
};

interface WirePostIt {
  id: string;
  text: string;
  authorName: string;
  mine: boolean;
  edited: boolean;
  /** S04's late-arrival marker, on the same read model every surface already uses. */
  arrivedAfterClose: boolean;
}

/**
 * One Category on a Board, as the grouped Board read returns it (facilitator-board S02).
 *
 * `postItCount` is the server's count, consumed rather than re-derived - the same discipline as
 * `mine` and `canRun`.
 */
interface WireCategory {
  id: string;
  name: string;
  postIts: WirePostIt[];
  postItCount: number;
}

interface WireRound {
  id: string;
  kind: string;
  prompt: string;
  state: string;
  /**
   * The Board, grouped. Present exactly on a `PostItRound` the read loaded a board for, and
   * `uncategorised` is present whenever `categories` is - even when both are empty.
   *
   * There is no flat `postIts` array on a Round any more: a Post-it appears exactly once in the
   * payload, under the Category holding it or in Uncategorised, so no surface groups client-side.
   */
  categories?: WireCategory[];
  uncategorised?: { postIts: WirePostIt[]; postItCount: number };
  textMaxLength?: number;
  options?: { id: string; label: string }[];
}

interface WireSession {
  session: Record<string, unknown>;
  rounds: WireRound[];
  canRun: boolean;
  activityWatermark: string | null;
}

describe.skipIf(!reachable)('named post-it contribution against a real PostgreSQL', () => {
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
    // Conference rows cascade to sessions, rounds, options, post-its, memberships and roles.
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
   * "Autumn Offsite", published, with the workshop Ida facilitates; Ada, Bo and Cleo are Members
   * with no Role Assignment at all. Otto has joined nothing.
   */
  async function autumnOffsite(app: FastifyInstance): Promise<{
    conferenceId: string;
    sessionId: string;
  }> {
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

    for (const sub of [IDA, ADA, BO, CLEO]) await addMember(conferenceId, sub);

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

  async function addRound(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds`,
      headers: as(IDA),
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().round.id as string;
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

  /** An **open** Post-it Round on the workshop, which is what most of these scenarios need. */
  async function openPostItRound(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
  ): Promise<string> {
    const roundId = await addRound(app, conferenceId, sessionId, POST_IT_ROUND);
    const opened = await transition(app, conferenceId, sessionId, roundId, 'open');
    expect(opened.statusCode, opened.body).toBe(200);
    return roundId;
  }

  function boardPath(conferenceId: string, sessionId: string, roundId: string, postItId?: string) {
    const board = `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/post-its`;
    return postItId === undefined ? board : `${board}/${postItId}`;
  }

  function contribute(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    sub: string,
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: boardPath(conferenceId, sessionId, roundId),
      headers: as(sub),
      payload,
    });
  }

  async function contributed(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    sub: string,
    text: string,
  ): Promise<string> {
    const response = await contribute(app, conferenceId, sessionId, roundId, sub, { text });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().postIt.id as string;
  }

  function correct(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    sub: string,
    text: string,
  ) {
    return app.inject({
      method: 'PATCH',
      url: boardPath(conferenceId, sessionId, roundId, postItId),
      headers: as(sub),
      payload: { text },
    });
  }

  function remove(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    sub: string,
  ) {
    return app.inject({
      method: 'DELETE',
      url: boardPath(conferenceId, sessionId, roundId, postItId),
      headers: as(sub),
    });
  }

  async function readSession(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    sub: string,
  ): Promise<WireSession> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
      headers: as(sub),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  /** The board of the one Round on this Session, as `sub` reads it. */
  async function boardSeenBy(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    sub: string,
  ): Promise<WirePostIt[]> {
    const { rounds } = await readSession(app, conferenceId, sessionId, sub);
    return boardOf(rounds[0]!);
  }

  /**
   * Every Post-it on one Round, wherever it sits, in Board order.
   *
   * S02 of this bundle contributes nothing to a Category, so this is Uncategorised followed by
   * whatever any Category holds - and the assertions below are about the Post-its themselves, which
   * the grouping did not change. The point of reading it this way rather than from a flat array is
   * that a Post-it appearing twice would show up here as a duplicate.
   */
  function boardOf(round: WireRound): WirePostIt[] {
    return [
      ...(round.uncategorised?.postIts ?? []),
      ...(round.categories ?? []).flatMap((category) => category.postIts),
    ];
  }

  /** The stored row, read straight from the table – never from a response. */
  async function storedRow(
    postItId: string,
  ): Promise<{ author_sub: string; text: string; edited_at: string | null } | undefined> {
    const { rows } = await client.query<{
      author_sub: string;
      text: string;
      edited_at: string | null;
    }>('select author_sub, text, edited_at from post_it where id = $1', [postItId]);
    return rows[0];
  }

  async function countRows(): Promise<number> {
    const { rows } = await client.query<{ total: string }>('select count(*) as total from post_it');
    return Number(rows[0]!.total);
  }

  /**
   * Resolves once some backend is genuinely waiting on a lock in this database.
   *
   * Polled rather than slept through: a fixed delay makes a concurrency test pass on a fast machine
   * and flake on a slow one, and proves nothing about the overlap it claims to create.
   */
  async function waitForALockWaiter(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { rows } = await client.query<{ total: string }>(
        `select count(*) as total from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (Number(rows[0]!.total) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('No backend ever waited on a lock, so the overlap under test never happened.');
  }

  function pollWatermark(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    sub: string,
  ) {
    return app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/activities/watermark`,
      headers: as(sub),
    });
  }

  // ---------- Acceptance Scenario S02: the author is the credential (TI03, TI04) ----------

  /**
   * **The load-bearing rule of this story** (Binding Constraint FR3).
   *
   * The request carries `authorSub` and `authorName` naming Bo, and both are *inert*: the row lands
   * under Ada's `sub` and the board shows Ada's name. Inert rather than refused is the stronger
   * statement - a route that refused an author field and a route that trusted one would both pass
   * "an author field is not accepted", and only one of them is correct.
   */
  it('attributes the post-it to the caller, whatever the body claims', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const response = await contribute(app, conferenceId, sessionId, roundId, ADA, {
      text: 'Waiting three days for test data',
      authorSub: BO,
      authorName: NAMES[BO],
      author: BO,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().postIt.authorName).toBe(NAMES[ADA]);

    // The stored row, not the response: a route that answered correctly and wrote Bo's sub would
    // pass a response-only assertion.
    const stored = await storedRow(response.json().postIt.id as string);
    expect(stored?.author_sub).toBe(ADA);

    const board = await boardSeenBy(app, conferenceId, sessionId, BO);
    expect(board.map((postIt) => [postIt.text, postIt.authorName])).toEqual([
      ['Waiting three days for test data', NAMES[ADA]],
    ]);
    // And Bo, whom the body named as the author, is offered nothing on it.
    expect(board[0]!.mine).toBe(false);
  });

  /** Contributing needs Membership – the "contributes" half of the authority split. */
  it('refuses a signed-in non-member and writes nothing', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const response = await contribute(app, conferenceId, sessionId, roundId, OUTSIDER, {
      text: 'I should not be here',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('NOT_A_MEMBER');
    expect(await countRows()).toBe(0);
  });

  // ---------- Acceptance Scenario S01 / S03: it reaches the room (TI04, TI05, TI06) ----------

  /**
   * The board Bo reads is the board Ada wrote to, under Ada's name - and a correction and a deletion
   * both reach it too, through the same read.
   *
   * The client half of "with no reload" is `web/test/SessionActivitiesPanel.test.tsx`; what this
   * proves is the half a screen cannot: that the *next* read of the Session genuinely carries each
   * change, deletion included, and that the deletion leaves no trace at all.
   */
  it('carries a contribution, a correction and a deletion through to every member’s read', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const typo = await contributed(
      app,
      conferenceId,
      sessionId,
      roundId,
      ADA,
      'Waitng three days for test data',
    );
    const doomed = await contributed(app, conferenceId, sessionId, roundId, ADA, 'Ignore me');

    expect((await boardSeenBy(app, conferenceId, sessionId, BO)).map((p) => p.text)).toEqual([
      'Waitng three days for test data',
      'Ignore me',
    ]);

    const corrected = await correct(
      app,
      conferenceId,
      sessionId,
      roundId,
      typo,
      ADA,
      'Waiting three days for test data',
    );
    expect(corrected.statusCode, corrected.body).toBe(200);

    const removed = await remove(app, conferenceId, sessionId, roundId, doomed, ADA);
    expect(removed.statusCode, removed.body).toBe(200);

    const bosBoard = await boardSeenBy(app, conferenceId, sessionId, BO);
    expect(bosBoard.map((postIt) => [postIt.text, postIt.authorName, postIt.edited])).toEqual([
      ['Waiting three days for test data', NAMES[ADA], true],
    ]);

    // No tombstone, no placeholder, no trace that it existed (prd.md#edge-cases) - asserted on the
    // table, because a soft-delete flag is exactly what a board read would hide.
    expect(await storedRow(doomed)).toBeUndefined();
    expect(await countRows()).toBe(1);
  });

  /**
   * "A Member may contribute any number of Post-its to one Round" (FR3), and no count exists to
   * enforce.
   */
  it('accepts every post-it one author writes to one round, naming no cap in any response', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    for (let index = 0; index < 12; index += 1) {
      const response = await contribute(app, conferenceId, sessionId, roundId, ADA, {
        text: `Idea ${index}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toMatch(/limit|maximum|too many|cap/i);
    }

    const board = await boardSeenBy(app, conferenceId, sessionId, ADA);
    expect(board.length).toBe(12);
    expect(board.every((postIt) => postIt.mine)).toBe(true);
  });

  // ---------- Acceptance Scenario S04: somebody else's post-it (TI03, TI05) ----------

  it('refuses another member’s edit and delete, and leaves the stored row untouched', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const adas = await contributed(app, conferenceId, sessionId, roundId, ADA, 'Ada’s idea');

    const edited = await correct(app, conferenceId, sessionId, roundId, adas, BO, 'Bo’s words');
    expect(edited.statusCode).toBe(403);
    expect(edited.json().error.code).toBe('POST_IT_NOT_AUTHOR');

    const deleted = await remove(app, conferenceId, sessionId, roundId, adas, BO);
    expect(deleted.statusCode).toBe(403);
    expect(deleted.json().error.code).toBe('POST_IT_NOT_AUTHOR');

    // Re-read from the table, not from the response: a route that refused and wrote anyway would
    // pass on the envelopes alone.
    const stored = await storedRow(adas);
    expect(stored?.text).toBe('Ada’s idea');
    expect(stored?.author_sub).toBe(ADA);
    expect(stored?.edited_at).toBeNull();
  });

  // ---------- Acceptance Scenario S05: a closed round (TI04, TI05, TI09) ----------

  /**
   * The requests go **straight at the API**, past whatever the client would or would not have
   * offered. A disabled control is not the guarantee; the write statement's predicate is.
   */
  it('refuses contribution, correction and removal on a closed round, and stays readable', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const adas = await contributed(app, conferenceId, sessionId, roundId, ADA, 'Still here');

    const closed = await transition(app, conferenceId, sessionId, roundId, 'close');
    expect(closed.statusCode, closed.body).toBe(200);

    const contribution = await contribute(app, conferenceId, sessionId, roundId, ADA, {
      text: 'Too late',
    });
    expect(contribution.statusCode).toBe(409);
    expect(contribution.json().error.code).toBe('POST_IT_ROUND_CLOSED');
    expect(contribution.json().error.message).toMatch(/closed/i);

    const edited = await correct(app, conferenceId, sessionId, roundId, adas, ADA, 'Changed');
    expect(edited.statusCode).toBe(409);
    expect(edited.json().error.code).toBe('POST_IT_ROUND_CLOSED');
    expect(edited.json().error.message).toMatch(/ended/i);

    const deleted = await remove(app, conferenceId, sessionId, roundId, adas, ADA);
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().error.code).toBe('POST_IT_ROUND_CLOSED');

    // Nothing was written and nothing was lost: the prompt and the whole board still read back.
    const { rounds } = await readSession(app, conferenceId, sessionId, ADA);
    expect(rounds[0]!.state).toBe('closed');
    expect(rounds[0]!.prompt).toBe(POST_IT_ROUND.prompt);
    expect(boardOf(rounds[0]!)).toEqual([
      {
        id: adas,
        text: 'Still here',
        authorName: NAMES[ADA],
        mine: true,
        edited: false,
        // Contributed while the round was open, so it is not a late arrival - the marker is the
        // Round's state at the instant of the write, and this row was written before the close.
        arrivedAfterClose: false,
      },
    ]);
    expect(await countRows()).toBe(1);
  });

  /**
   * A Poll is not a board, whichever way it is running.
   *
   * Both cases answer the same sentence – there is no Post-it Round here to add to – and the
   * **open** Poll is the one that has to be reached deliberately. Without a kind comparison in the
   * insert's own source predicate the select matches, `round_kind` falls to its column default, and
   * the composite foreign key refuses the write: the room reads an internal error where a refusal
   * belongs, and nothing is written either way so no response-only assertion would tell them apart.
   */
  it('refuses a contribution to a poll, whether it is open or closed', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const pollId = await addRound(app, conferenceId, sessionId, POLL);

    const beforeOpening = await contribute(app, conferenceId, sessionId, pollId, ADA, {
      text: 'A post-it on a closed poll',
    });
    expect(beforeOpening.statusCode, beforeOpening.body).toBe(404);
    expect(beforeOpening.json().error.code).toBe('ROUND_NOT_FOUND');

    const opened = await transition(app, conferenceId, sessionId, pollId, 'open');
    expect(opened.statusCode, opened.body).toBe(200);

    const whileRunning = await contribute(app, conferenceId, sessionId, pollId, ADA, {
      text: 'A post-it on a running poll',
    });
    expect(whileRunning.statusCode, whileRunning.body).toBe(404);
    expect(whileRunning.json().error.code).toBe('ROUND_NOT_FOUND');

    expect(await countRows()).toBe(0);
  });

  // ---------- Acceptance Scenario S06: a refused contribution persists nothing (TI01, TI04) ----

  it('refuses blank and over-length text at field level, naming the limit, and writes nothing', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const blank = await contribute(app, conferenceId, sessionId, roundId, ADA, { text: '   \n  ' });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error.code).toBe('POST_IT_TEXT_INVALID');
    expect(blank.json().error.details[0].field).toBe('text');

    const tooLong = 'x'.repeat(POST_IT_MAX_LENGTH + 1);
    const over = await contribute(app, conferenceId, sessionId, roundId, ADA, { text: tooLong });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.code).toBe('POST_IT_TEXT_INVALID');
    expect(over.json().error.details[0].field).toBe('text');
    // The refusal names the limit it enforces, and it is the exported constant - not a number
    // written into the message.
    expect(over.json().error.message).toContain(String(POST_IT_MAX_LENGTH));
    expect(over.json().error.message).toContain(String(POST_IT_MAX_LENGTH + 1));

    expect(await countRows()).toBe(0);
    expect((await boardSeenBy(app, conferenceId, sessionId, ADA)).length).toBe(0);
  });

  /**
   * The cap's boundary, at the API, read from the constant on both sides.
   *
   * Changing `POST_IT_MAX_LENGTH` alone leaves this passing; changing the migration's CHECK alone
   * makes the accepted case fail with a constraint violation. That is what pins the two together.
   */
  it('accepts text of exactly the cap and refuses one character more', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const exact = await contribute(app, conferenceId, sessionId, roundId, ADA, {
      text: 'y'.repeat(POST_IT_MAX_LENGTH),
    });
    expect(exact.statusCode, exact.body).toBe(200);

    const over = await contribute(app, conferenceId, sessionId, roundId, ADA, {
      text: 'y'.repeat(POST_IT_MAX_LENGTH + 1),
    });
    expect(over.statusCode).toBe(400);

    expect(await countRows()).toBe(1);
  });

  // ---------- Acceptance Scenario S07: coming back later (TI06, TI09) ----------

  it('returns a closed round’s whole board, with authors, in the one session read', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    await contributed(app, conferenceId, sessionId, roundId, ADA, 'Test data');
    await contributed(app, conferenceId, sessionId, roundId, BO, 'Handover gaps');
    await contributed(app, conferenceId, sessionId, roundId, CLEO, 'Meeting load');
    await transition(app, conferenceId, sessionId, roundId, 'close');

    const payload = await readSession(app, conferenceId, sessionId, CLEO);
    expect(payload.rounds[0]!.state).toBe('closed');
    expect(boardOf(payload.rounds[0]!).map((postIt) => [postIt.text, postIt.authorName])).toEqual([
      ['Test data', NAMES[ADA]],
      ['Handover gaps', NAMES[BO]],
      ['Meeting load', NAMES[CLEO]],
    ]);
    // Only Cleo's is hers, so only hers would be offered a control.
    expect(boardOf(payload.rounds[0]!).map((postIt) => postIt.mine)).toEqual([false, false, true]);
    /*
     * And all three are in **Uncategorised**, which is present with its own count on a Board that
     * has no Category at all. Nothing is auto-placed and nothing has to be created for a Post-it to
     * have somewhere to be (facilitator-board S02, FR2).
     */
    expect(payload.rounds[0]!.categories).toEqual([]);
    expect(payload.rounds[0]!.uncategorised!.postItCount).toBe(3);
    // The cap the compose box renders from, and it is the API's one constant.
    expect(payload.rounds[0]!.textMaxLength).toBe(POST_IT_MAX_LENGTH);
  });

  /** The name is joined at read time, so a rename reaches every post-it its owner ever wrote. */
  it('shows a renamed author’s new name on their existing post-its', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    await contributed(app, conferenceId, sessionId, roundId, ADA, 'Test data');

    await client.query('update app_user set display_name = $2 where sub = $1', [
      ADA,
      'Ada Byron King',
    ]);

    const board = await boardSeenBy(app, conferenceId, sessionId, BO);
    expect(board[0]!.authorName).toBe('Ada Byron King');
  });

  // ---------- Acceptance Scenario S08: the prompt stays editable (TI02, TI06) ----------

  /**
   * FR1's one criterion that S01 could not prove: the prompt is editable **after contributions
   * exist**, and the edit leaves every post-it exactly as its author wrote it.
   */
  it('lets the facilitator clarify the prompt of a round that already holds post-its', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    await contributed(app, conferenceId, sessionId, roundId, ADA, 'Test data');
    await contributed(app, conferenceId, sessionId, roundId, BO, 'Handover gaps');

    const before = await readSession(app, conferenceId, sessionId, ADA);

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}`,
      headers: as(IDA),
      payload: { kind: 'PostItRound', prompt: 'What slowed us down this quarter, exactly?' },
    });
    expect(edited.statusCode, edited.body).toBe(200);

    const after = await readSession(app, conferenceId, sessionId, ADA);
    expect(after.rounds[0]!.prompt).toBe('What slowed us down this quarter, exactly?');
    // Byte-identical in text, author, order and edited-marker.
    expect(after.rounds[0]!.uncategorised).toEqual(before.rounds[0]!.uncategorised);
    expect(after.rounds[0]!.categories).toEqual(before.rounds[0]!.categories);
    // The round stayed open across the edit, so the room can keep contributing.
    expect(after.rounds[0]!.state).toBe('open');

    // And the change reaches Ada's open view through the same cursor a contribution moves.
    expect(BigInt(after.activityWatermark!) > BigInt(before.activityWatermark!)).toBe(true);
  });

  // ---------- TI02: the one cursor, and the two watermarks it must not touch ----------

  async function scheduleWatermark(conferenceId: string): Promise<string> {
    const { rows } = await client.query<{ value: string }>(
      'select schedule_watermark_at::text as value from conference where id = $1',
      [conferenceId],
    );
    return rows[0]!.value;
  }

  async function sessionVersion(sessionId: string): Promise<string> {
    const { rows } = await client.query<{ value: string }>(
      'select last_updated_at::text as value from sessions where id = $1',
      [sessionId],
    );
    return rows[0]!.value;
  }

  it('advances the activity watermark on every insert, edit and delete – and nothing else', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const schedule = await scheduleWatermark(conferenceId);
    const version = await sessionVersion(sessionId);

    // Read as a number, never as text: the cursor is a counter now, and '10' sorts before '9'.
    const read = async (): Promise<bigint> =>
      BigInt((await readSession(app, conferenceId, sessionId, ADA)).activityWatermark!);

    const afterOpen = await read();

    const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, 'One');
    const afterInsert = await read();
    expect(afterInsert > afterOpen).toBe(true);

    const edited = await correct(app, conferenceId, sessionId, roundId, postItId, ADA, 'Two');
    expect(edited.statusCode, edited.body).toBe(200);
    const afterEdit = await read();
    expect(afterEdit > afterInsert).toBe(true);

    // The one that matters most: a delete leaves no row behind to notice, so a cursor that did not
    // move on it would leave the post-it on every other board until something else happened to write.
    const deleted = await remove(app, conferenceId, sessionId, roundId, postItId, ADA);
    expect(deleted.statusCode, deleted.body).toBe(200);
    const afterDelete = await read();
    expect(afterDelete > afterEdit).toBe(true);

    // Neither of the other two cursors moved across any of it: a post-it must not make every
    // attendee's Schedule refetch, nor move an Organizer's concurrency base for this Session.
    expect(await scheduleWatermark(conferenceId)).toBe(schedule);
    expect(await sessionVersion(sessionId)).toBe(version);
  });

  /**
   * Strict monotonicity per row, which is what `nextval` buys unconditionally: two writes inside one
   * transaction take two sequence values, where `now()` would have stamped both with the same
   * transaction-start time and a polling client would never have seen the second.
   *
   * Read from *inside* the transaction, where both values are visible.
   */
  it('produces two distinct values for two post-it writes in one transaction', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    await client.query('begin');
    const values: string[] = [];
    for (const text of ['first', 'second']) {
      await client.query(
        `insert into post_it (round_id, conference_id, author_sub, text) values ($1, $2, $3, $4)`,
        [roundId, conferenceId, ADA, text],
      );
      const { rows } = await client.query<{ value: string }>(
        'select activity_watermark::text as value from round where id = $1',
        [roundId],
      );
      values.push(rows[0]!.value);
    }
    await client.query('commit');

    expect(values[0]).not.toBe(values[1]);
    expect(BigInt(values[1]!) > BigInt(values[0]!)).toBe(true);
  });

  /**
   * **A column that did not exist when the trigger was written still moves the cursor.**
   *
   * The trigger's `WHEN` clause used to enumerate the Round columns worth reacting to - `prompt`,
   * `state`, `closed_at`, `position`. Anything added later fell outside it, so an UPDATE touching
   * only the new column advanced nothing and reached no open client: the write succeeded, the suite
   * stayed green, and the room simply did not see the change. That is the mechanism behind the
   * option-edit gap this bundle already hit once.
   * `20260901120000000_round-watermark-when-inversion.sql` inverts the clause to name the one thing
   * it must *not* react to - the cursor writing to itself - so a new column is inside the rule by
   * construction.
   *
   * Proved by actually adding one. A test that reasoned about the clause's text would be asserting
   * its own reading of the SQL; this adds a column the trigger has never heard of, writes to it, and
   * reads the cursor. The column is dropped again in `finally`, so nothing survives the test.
   */
  it('advances the cursor for a round column added after the trigger was written', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const cursor = async (): Promise<bigint> => {
      const { rows } = await client.query<{ value: string }>(
        'select activity_watermark::text as value from round where id = $1',
        [roundId],
      );
      return BigInt(rows[0]!.value);
    };

    await client.query('alter table round add column probe_note text');
    try {
      const before = await cursor();
      // An UPDATE touching only a column the trigger's author never saw.
      await client.query('update round set probe_note = $2 where id = $1', [roundId, 'anything']);
      expect(await cursor()).toBeGreaterThan(before);
    } finally {
      await client.query('alter table round drop column probe_note');
    }
  });

  // ---------- TI01: what the schema itself refuses ----------

  /**
   * A Post-it on a Poll, and a Post-it naming a Round in another Conference, are **unwritable** -
   * refused by a constraint, not by application code. These go straight at the table, past every
   * route, which is the only way to tell a schema guarantee from a handler that happens to check.
   */
  it('refuses a post-it on a poll, and one whose conference differs from its round’s', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const pollId = await addRound(app, conferenceId, sessionId, POLL);
    const postItRoundId = await openPostItRound(app, conferenceId, sessionId);

    await expect(
      client.query(
        `insert into post_it (round_id, conference_id, author_sub, text) values ($1, $2, $3, $4)`,
        [pollId, conferenceId, ADA, 'A post-it on a poll'],
      ),
      // Foreign key, not a check on `kind` in a handler: the composite key has no matching row.
    ).rejects.toThrow(/post_it_round_in_conference|foreign key/i);

    const otherConference = await app.inject({
      method: 'POST',
      url: '/api/conferences',
      headers: as(PRIYA),
      payload: { name: 'Spring Offsite', startDate: '2027-03-01', endDate: '2027-03-02' },
    });
    const otherId = otherConference.json().id as string;

    await expect(
      client.query(
        `insert into post_it (round_id, conference_id, author_sub, text) values ($1, $2, $3, $4)`,
        [postItRoundId, otherId, ADA, 'Wrong conference'],
      ),
    ).rejects.toThrow(/post_it_round_in_conference|foreign key/i);

    expect(await countRows()).toBe(0);
  });

  it('refuses blank text and text over the cap at the table, whatever the API did', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const insert = (text: string) =>
      client.query(
        `insert into post_it (round_id, conference_id, author_sub, text) values ($1, $2, $3, $4)`,
        [roundId, conferenceId, ADA, text],
      );

    await expect(insert('   ')).rejects.toThrow(/post_it_text_present/i);
    // The CHECK's boundary is the exported constant's, and both sides are read from it here, so a
    // change to either alone fails this test.
    await expect(insert('z'.repeat(POST_IT_MAX_LENGTH + 1))).rejects.toThrow(
      /post_it_text_present/i,
    );
    await expect(insert('z'.repeat(POST_IT_MAX_LENGTH))).resolves.toBeDefined();
  });

  /** Identity is the OIDC `sub`, and no column here holds an address (ADR-002). */
  it('holds no email column, and keys its author on app_user.sub', async () => {
    const { rows } = await client.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_name = 'post_it' order by ordinal_position`,
    );
    const names = rows.map((row) => row.column_name);
    expect(names).toEqual([
      'id',
      'round_id',
      'conference_id',
      'round_kind',
      'author_sub',
      'text',
      'created_at',
      'edited_at',
      // S04's two, and neither is an identity: whether this one arrived after its round closed,
      // and the identity of the *submission* that produced it - which is what makes a retry one
      // post-it rather than two.
      'arrived_after_close',
      'submission_id',
      /*
       * The facilitator-board bundle's placement, and the **only** column it adds to this row.
       *
       * NULL is Uncategorised - the absence of a placement is the state, not a sentinel - so the
       * row still carries no tombstone, no soft-delete flag and no `deleted_at`, and an author
       * deleting their own post-it still leaves no trace at all (Binding Constraint FR4). This list
       * is what would fail if a later story tried to add one.
       */
      'category_id',
    ]);
    // Named explicitly as well as by the list above, because it is the assertion that survives a
    // careless "just add the column to the array" edit.
    for (const name of names) expect(name).not.toMatch(/deleted|discard|tombstone|removed/i);
    for (const name of names) expect(name).not.toMatch(/mail/i);

    // No display name copied onto the row either - it is joined, so a rename reaches every post-it.
    expect(names).not.toContain('author_name');
    expect(names).not.toContain('display_name');

    const { rows: keys } = await client.query<{ foreign_table: string; foreign_column: string }>(
      `select ccu.table_name as foreign_table, ccu.column_name as foreign_column
         from information_schema.table_constraints tc
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = tc.constraint_name
        where tc.table_name = 'post_it' and tc.constraint_type = 'FOREIGN KEY'`,
    );
    expect(
      keys.some((key) => key.foreign_table === 'app_user' && key.foreign_column === 'sub'),
    ).toBe(true);
  });

  // ---------- TI07: the two-scalar poll ----------

  it('answers the poll with two scalars, moves it on every write, and repeats itself otherwise', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const poll = async (): Promise<{ activityWatermark: string; state: string }> => {
      const response = await pollWatermark(app, conferenceId, sessionId, ADA);
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };

    const first = await poll();
    expect(Object.keys(first).sort()).toEqual(['activityWatermark', 'state']);
    expect(first.state).toBe('published');
    // No round or post-it content of any kind rides along.
    expect(JSON.stringify(first)).not.toMatch(/prompt|postIt|round|kind|author/i);

    // Two polls with no write between them agree, so a client refetches nothing.
    expect((await poll()).activityWatermark).toBe(first.activityWatermark);
    // And it is the same value the read hands the client to compare against.
    expect((await readSession(app, conferenceId, sessionId, ADA)).activityWatermark).toBe(
      first.activityWatermark,
    );

    const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, 'One');
    const afterInsert = await poll();
    expect(BigInt(afterInsert.activityWatermark) > BigInt(first.activityWatermark)).toBe(true);

    await correct(app, conferenceId, sessionId, roundId, postItId, ADA, 'Two');
    const afterEdit = await poll();
    expect(BigInt(afterEdit.activityWatermark) > BigInt(afterInsert.activityWatermark)).toBe(true);

    await remove(app, conferenceId, sessionId, roundId, postItId, ADA);
    expect(BigInt((await poll()).activityWatermark) > BigInt(afterEdit.activityWatermark)).toBe(
      true,
    );
  });

  it('refuses the poll to a non-member, exactly as the read does', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);

    const response = await pollWatermark(app, conferenceId, sessionId, OUTSIDER);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('NOT_A_MEMBER');
  });

  // ---------- S04: the closed-round rule's two branches, and a retry that cannot duplicate ------

  /**
   * The interaction this story exists for, on **one** round.
   *
   * Björn's live contribution and Nadia's offline-composed one meet the same closed Round in the
   * same test, because two tests each proving one half is exactly the shape that lets the two rules
   * drift into a contradiction (FIS -> Testing Strategy). The refusal and the acceptance are the
   * same predicate with one term switched, and this is what says so.
   */
  // ---------- S08: what a Member without sorting authority reaches, and reads ----------

  /** The idea Ada writes down, reused across the three scenarios below. */
  const WAITING = 'Waiting three days for test data';

  /*
   * The Board writes S03, S05 and S06 built, addressed here only to be **refused**. This story adds
   * no route, no gate and no Attendee-specific branch: what it proves is that the shipped
   * `authorizeWrite` narrowing already stands between every Member and every one of them.
   */
  function boardWrite(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    act: 'discard' | 'restore' | 'permanent-removal',
    sub: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `${boardPath(conferenceId, sessionId, roundId, postItId)}/${act}`,
      headers: as(sub),
    });
  }

  function place(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    categoryId: string | null,
    sub: string,
  ) {
    return app.inject({
      method: 'PATCH',
      url: `${boardPath(conferenceId, sessionId, roundId, postItId)}/placement`,
      headers: as(sub),
      payload: { categoryId },
    });
  }

  /** A Category on this Round, created by the Facilitator who is assigned to the Session. */
  async function createdCategory(
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

  /** The stored placement, read straight from the table – never from a response. */
  async function storedPlacement(postItId: string): Promise<string | null | undefined> {
    const { rows } = await client.query<{ category_id: string | null }>(
      'select category_id from post_it where id = $1',
      [postItId],
    );
    return rows[0]?.category_id;
  }

  /** Whether a Discard trace exists for this Post-it – the state S05 stores outside the row. */
  async function storedDiscard(postItId: string): Promise<boolean> {
    const { rows } = await client.query('select 1 from post_it_discard where post_it_id = $1', [
      postItId,
    ]);
    return rows.length > 0;
  }

  /** One Round's Board as `sub` reads it, region by region. */
  async function regionsSeenBy(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    sub: string,
  ): Promise<WireRound> {
    const { rounds } = await readSession(app, conferenceId, sessionId, sub);
    return rounds[0]!;
  }

  /**
   * **A Member is refused every Board write – on the Post-it they wrote themselves** (Acceptance
   * Scenario S02, TI03).
   *
   * Ada authored it and Ida placed it into "Handovers". Ada then addresses the placement route, the
   * Discard route and the restore route directly, as somebody with a phone and a copy of the URL
   * would: all three are refused by the **shipped** sorting-authority gate, before anything about
   * the Board is consulted, and each refusal names the authority required rather than saying
   * something about the Post-it.
   *
   * Every reading afterwards is of the **stored row and the discard table**, not of the envelope: a
   * refusal that answered 403 and moved the Post-it anyway would pass an envelope assertion.
   */
  it('refuses a member every board write on their own post-it, and moves nothing', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const handovers = await createdCategory(app, conferenceId, sessionId, roundId, 'Handovers');
    const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, WAITING);

    const placed = await place(app, conferenceId, sessionId, roundId, postItId, handovers, IDA);
    expect(placed.statusCode, placed.body).toBe(200);

    // Her own post-it, and still not hers to sort: placement, Discard and restore alike.
    const attempts = [
      await place(app, conferenceId, sessionId, roundId, postItId, null, ADA),
      await boardWrite(app, conferenceId, sessionId, roundId, postItId, 'discard', ADA),
      await boardWrite(app, conferenceId, sessionId, roundId, postItId, 'restore', ADA),
    ];
    for (const attempt of attempts) {
      expect(attempt.statusCode, attempt.body).toBe(403);
      expect(attempt.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');
      /*
       * The **code** is what names the authority required; the sentence deliberately does not,
       * because distinguishing "you hold no role here" from "this is not one of your sessions"
       * would tell a caller which Sessions of a Conference they cannot see exist
       * (`api/src/conferences/authorization.ts`). What it must never do is say anything about the
       * Post-it - a refusal that mentioned the placement or its author would answer a question the
       * caller was refused.
       */
      expect(attempt.json().error.message).toMatch(/do not have permission/i);
      expect(attempt.json().error.message).not.toMatch(/post-it|category|author|discard/i);
      // Nothing moved, after each one.
      expect(await storedPlacement(postItId)).toBe(handovers);
      expect(await storedDiscard(postItId)).toBe(false);
    }

    // And the two acts that **are** an author's stay hers: correcting her own words, and deleting
    // them. Neither is placement, and the placement is untouched by either.
    const corrected = await correct(
      app,
      conferenceId,
      sessionId,
      roundId,
      postItId,
      ADA,
      'Waiting three days for test data, still',
    );
    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(await storedPlacement(postItId)).toBe(handovers);

    const removed = await remove(app, conferenceId, sessionId, roundId, postItId, ADA);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await storedRow(postItId)).toBeUndefined();
  });

  /**
   * **A Discard, a restore and a permanent removal, read from the author's own phone** (Acceptance
   * Scenario S03, TI04).
   *
   * The exclusion is S05's anti-join in the read statement itself, and this is what it looks like
   * from the one place the temptation to make an exception lives: the author's own Board. There is
   * no marker, no placeholder and no field anywhere on the payload from which the removal could be
   * inferred - the serialised payload is searched for the word, because a flag added later would
   * have to be named to be excluded and this does not name one.
   *
   * A restore returns it to **Uncategorised**, not to the Category it was discarded from: absence of
   * a placement is what Uncategorised is, and the Discard took the placement with it.
   */
  it('carries nothing of a discarded, restored or permanently removed post-it to its author’s board', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const tooling = await createdCategory(app, conferenceId, sessionId, roundId, 'Tooling');
    const discarded = await contributed(app, conferenceId, sessionId, roundId, ADA, WAITING);
    const removed = await contributed(
      app,
      conferenceId,
      sessionId,
      roundId,
      ADA,
      'and a whiteboard',
    );

    await place(app, conferenceId, sessionId, roundId, discarded, tooling, IDA);
    await place(app, conferenceId, sessionId, roundId, removed, tooling, IDA);

    const discardedResponse = await boardWrite(
      app,
      conferenceId,
      sessionId,
      roundId,
      discarded,
      'discard',
      IDA,
    );
    expect(discardedResponse.statusCode, discardedResponse.body).toBe(200);

    // Priya is a conference-wide Admin with no Session Assignment: the permanent removal is hers.
    const permanently = await boardWrite(
      app,
      conferenceId,
      sessionId,
      roundId,
      removed,
      'permanent-removal',
      PRIYA,
    );
    expect(permanently.statusCode, permanently.body).toBe(200);

    const afterBoth = await regionsSeenBy(app, conferenceId, sessionId, ADA);
    expect(boardOf(afterBoth).map((one) => one.id)).toEqual([]);
    expect(afterBoth.categories!.find((one) => one.id === tooling)!.postItCount).toBe(0);
    expect(afterBoth.uncategorised!.postItCount).toBe(0);
    // Nothing on what Ada received says either post-it ever existed.
    const payload = JSON.stringify(afterBoth);
    expect(payload).not.toMatch(/discard/i);
    expect(payload).not.toContain(discarded);
    expect(payload).not.toContain(removed);

    // Restored, it comes back to Uncategorised - never to the Category it was sitting in.
    const restored = await boardWrite(
      app,
      conferenceId,
      sessionId,
      roundId,
      discarded,
      'restore',
      IDA,
    );
    expect(restored.statusCode, restored.body).toBe(200);

    const afterRestore = await regionsSeenBy(app, conferenceId, sessionId, ADA);
    expect(afterRestore.uncategorised!.postIts.map((one) => one.text)).toEqual([WAITING]);
    expect(afterRestore.uncategorised!.postItCount).toBe(1);
    expect(afterRestore.categories!.find((one) => one.id === tooling)!.postItCount).toBe(0);
    // The permanently removed one is still gone, and stays gone on every later read.
    expect(JSON.stringify(afterRestore)).not.toContain(removed);
  });

  /**
   * **Nothing about votes reaches the payload the Attendee's Board is rendered from** (Structural
   * Criterion 1, Binding Constraint FR8, ADR-006).
   *
   * The structural half of this lives in `post-it-structure.test.ts` and reads a list of modules.
   * This is the half that **knows no list** (`docs/LEARNINGS.md#testing`): a real application
   * assembles a real Session read for a real Member and every key it produced, at every depth, is
   * swept. A per-voter field added anywhere on the assembly path - in the Board projection, in the
   * wire builder, or at the point in `routes/rounds.ts` where the tally is decided for the whole
   * payload - fails here whichever file it was written in, which is exactly what the file-list
   * guard cannot promise (S08 quick-review C05).
   *
   * Keys rather than the serialized text, deliberately: a Post-it's own words are a Member's to
   * choose, and somebody writing "we should vote on this" must not turn a guard red.
   */
  it('names no vote data anywhere on an attendee’s session read', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const tooling = await createdCategory(app, conferenceId, sessionId, roundId, 'Tooling');
    const placed = await contributed(app, conferenceId, sessionId, roundId, ADA, WAITING);
    await place(app, conferenceId, sessionId, roundId, placed, tooling, IDA);
    await contributed(app, conferenceId, sessionId, roundId, BO, 'and a whiteboard');

    // Ada is a Member with no Session Assignment and no Admin: this is the Attendee's own read.
    const payload = await readSession(app, conferenceId, sessionId, ADA);

    // Swept over a payload that really carries the Board - an empty read would prove nothing.
    expect(boardOf(payload.rounds[0]!).map((one) => one.text)).toContain(WAITING);

    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        keys.add(key);
        walk(entry);
      }
    };
    walk(payload);

    expect(keys.size, 'the sweep should have found the payload’s keys').toBeGreaterThan(10);
    expect([...keys].filter((key) => /vote|ballot|tally|option/i.test(key))).toEqual([]);
  });

  /**
   * **A queued Post-it drained after the sorting began lands in Uncategorised, and is never
   * auto-placed** (Acceptance Scenario S04, TI05).
   *
   * The Facilitator has emptied Uncategorised into "Handovers" before either drain arrives, which is
   * the state that makes "never auto-placed" a claim worth proving: the obvious wrong answer is to
   * put a late arrival wherever the Board's activity is. Run twice - once while the Round is still
   * open and once after it has closed - because the queue drains whenever the link returns and the
   * Round's state at that moment is not the device's business.
   */
  it('lands a post-it drained after sorting began in uncategorised, open round or closed', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const handovers = await createdCategory(app, conferenceId, sessionId, roundId, 'Handovers');

    const first = await contributed(app, conferenceId, sessionId, roundId, ADA, WAITING);
    const second = await contributed(app, conferenceId, sessionId, roundId, BO, 'Flaky CI');
    for (const postItId of [first, second]) {
      await place(app, conferenceId, sessionId, roundId, postItId, handovers, IDA);
    }

    const sorted = await regionsSeenBy(app, conferenceId, sessionId, CLEO);
    expect(sorted.uncategorised!.postItCount).toBe(0);
    expect(sorted.categories![0]!.postItCount).toBe(2);

    // Cleo's phone drains what it has been holding. The Round is still open.
    const drained = await contribute(app, conferenceId, sessionId, roundId, CLEO, {
      text: 'The venue wifi died at ten',
      offlineComposed: true,
      submissionId: '9b7d2c14-0000-4000-8000-0000000008a1',
    });
    expect(drained.statusCode, drained.body).toBe(200);

    const afterOpen = await regionsSeenBy(app, conferenceId, sessionId, CLEO);
    expect(afterOpen.uncategorised!.postIts.map((one) => one.text)).toEqual([
      'The venue wifi died at ten',
    ]);
    expect(afterOpen.uncategorised!.postItCount).toBe(1);
    // No Category moved: the contribution path writes no placement, so there is none to move.
    expect(afterOpen.categories![0]!.postItCount).toBe(2);
    expect(afterOpen.categories![0]!.postIts.map((one) => one.text)).toEqual([WAITING, 'Flaky CI']);

    // And again after the Round has closed, where the only difference is the late marking.
    const closed = await transition(app, conferenceId, sessionId, roundId, 'close');
    expect(closed.statusCode, closed.body).toBe(200);

    const late = await contribute(app, conferenceId, sessionId, roundId, CLEO, {
      text: 'And the coffee machine',
      offlineComposed: true,
      submissionId: '9b7d2c14-0000-4000-8000-0000000008a2',
    });
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json().postIt.arrivedAfterClose).toBe(true);

    const afterClose = await regionsSeenBy(app, conferenceId, sessionId, CLEO);
    expect(afterClose.uncategorised!.postIts.map((one) => one.text)).toEqual([
      'The venue wifi died at ten',
      'And the coffee machine',
    ]);
    expect(afterClose.uncategorised!.postItCount).toBe(2);
    expect(afterClose.categories![0]!.postItCount).toBe(2);
    // Nothing is placed by arriving: neither drain carries a category on the stored row.
    expect(await storedPlacement(late.json().postIt.id)).toBeNull();
  });

  /**
   * **Membership ends access to the Board and nothing else** (Acceptance Scenario S06, TI07).
   *
   * Ada's Membership is revoked while she has the Session open. Her next read is refused with the
   * shipped Membership sentence - and her Post-its stay exactly where they are on every other
   * Member's Board, still under her name. A Post-it is the room's record of what was said; losing
   * the right to read the Board is not a reason to unsay it, and the Report is built from these.
   *
   * The non-Member's read is the same refusal, word for word, and it discloses nothing: whether that
   * Conference exists, whether that Session exists, and whether anything was ever written on it are
   * all questions it does not answer.
   */
  it('refuses the board once membership ends, and leaves that member’s post-its attributed', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const tooling = await createdCategory(app, conferenceId, sessionId, roundId, 'Tooling');

    const placed = await contributed(app, conferenceId, sessionId, roundId, ADA, WAITING);
    const unplaced = await contributed(
      app,
      conferenceId,
      sessionId,
      roundId,
      ADA,
      'and a whiteboard',
    );
    await place(app, conferenceId, sessionId, roundId, placed, tooling, IDA);

    // She can read it, and both of hers are on it, before anything is revoked.
    const before = await regionsSeenBy(app, conferenceId, sessionId, ADA);
    expect(
      boardOf(before)
        .map((one) => one.id)
        .sort(),
    ).toEqual([placed, unplaced].sort());

    await client.query('delete from membership where conference_id = $1 and user_sub = $2', [
      conferenceId,
      ADA,
    ]);

    const refused = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
      headers: as(ADA),
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.code).toBe('NOT_A_MEMBER');

    // A signed-in employee who never joined gets the identical answer - which is what stops the
    // refusal from being a way to discover which conferences and sessions are real.
    const outsider = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
      headers: as(OUTSIDER),
    });
    expect(outsider.statusCode, outsider.body).toBe(403);
    expect(outsider.json().error).toEqual(refused.json().error);
    expect(outsider.json().error.message).not.toMatch(/session|round|post-it|ways of working/i);

    // And on Bo's Board, who is still a Member: both of Ada's, where they were, under her name.
    const after = await regionsSeenBy(app, conferenceId, sessionId, BO);
    expect(after.categories!.find((one) => one.id === tooling)!.postIts).toEqual([
      {
        id: placed,
        text: WAITING,
        authorName: NAMES[ADA],
        mine: false,
        edited: false,
        arrivedAfterClose: false,
      },
    ]);
    expect(after.uncategorised!.postIts.map((one) => one.authorName)).toEqual([NAMES[ADA]]);
    expect(after.uncategorised!.postItCount).toBe(1);
  });

  it('refuses a live post-it to a closed round and takes an offline-composed one, marked late', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const closed = await transition(app, conferenceId, sessionId, roundId, 'close');
    expect(closed.statusCode, closed.body).toBe(200);

    // Björn is online throughout. His post-it is refused and nothing is written for it.
    const live = await contribute(app, conferenceId, sessionId, roundId, BO, {
      text: 'Typed just now, into a round that has ended',
    });
    expect(live.statusCode, live.body).toBe(409);
    expect(live.json().error.code).toBe('POST_IT_ROUND_CLOSED');

    // Nadia's waited on her phone through the dead spot. The same round takes it.
    const queued = await contribute(app, conferenceId, sessionId, roundId, ADA, {
      text: 'Nobody owns the staging environment',
      offlineComposed: true,
      submissionId: '9b7d2c14-0000-4000-8000-000000000001',
    });
    expect(queued.statusCode, queued.body).toBe(200);
    expect(queued.json().postIt.arrivedAfterClose).toBe(true);

    // And it is on the board for everybody, marked, under her own name.
    const board = await boardSeenBy(app, conferenceId, sessionId, BO);
    expect(board).toEqual([
      {
        id: queued.json().postIt.id,
        text: 'Nobody owns the staging environment',
        authorName: NAMES[ADA],
        mine: false,
        edited: false,
        arrivedAfterClose: true,
      },
    ]);
    expect(await countRows()).toBe(1);
  });

  /**
   * The marker follows the Round's state at the moment of the write, not the state the device last
   * saw - so a round reopened while the phone was out of coverage takes the same post-it as an
   * ordinary contribution, with nothing marked anywhere.
   */
  it('takes an offline-composed post-it into a reopened round with no late marking', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    await transition(app, conferenceId, sessionId, roundId, 'close');
    const reopened = await transition(app, conferenceId, sessionId, roundId, 'open');
    expect(reopened.statusCode, reopened.body).toBe(200);

    const arrived = await contribute(app, conferenceId, sessionId, roundId, ADA, {
      text: 'Nobody owns the staging environment',
      offlineComposed: true,
      submissionId: '9b7d2c14-0000-4000-8000-000000000002',
    });
    expect(arrived.statusCode, arrived.body).toBe(200);
    expect(arrived.json().postIt.arrivedAfterClose).toBe(false);

    const board = await boardSeenBy(app, conferenceId, sessionId, BO);
    expect(board.map((postIt) => postIt.arrivedAfterClose)).toEqual([false]);
  });

  /**
   * Late is something that happens to a Round that **ran**.
   *
   * A Round is `closed` from the moment it is authored, so the state alone cannot tell one that has
   * finished from one nobody has ever started - and the offline branch must not read them as the
   * same thing. A queued Post-it arriving at a Round that never opened is refused exactly as a live
   * one is; accepting it would put text on a board that never ran, stamped as having arrived after
   * a close that never happened.
   *
   * `closed_at` is what separates the two, and it is the same column `open` already reads for the
   * reopen rule - asserted here as `null` before the attempt, so the case under test is genuinely
   * the never-opened one and not a Round the fixture happened to close.
   */
  it('refuses an offline-composed post-it to a round that was never opened', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await addRound(app, conferenceId, sessionId, POST_IT_ROUND);

    const { rows } = await client.query<{ state: string; closed_at: string | null }>(
      'select state, closed_at from round where id = $1',
      [roundId],
    );
    expect(rows).toEqual([{ state: 'closed', closed_at: null }]);

    const queued = await contribute(app, conferenceId, sessionId, roundId, ADA, {
      text: 'Nobody owns the staging environment',
      offlineComposed: true,
      submissionId: '9b7d2c14-0000-4000-8000-000000000010',
    });
    expect(queued.statusCode, queued.body).toBe(409);
    expect(queued.json().error.code).toBe('POST_IT_ROUND_CLOSED');

    // Refused against the table, not merely in the envelope: nothing was written for it, and the
    // board a Facilitator would open on the day is still empty.
    expect(await countRows()).toBe(0);
    expect(await boardSeenBy(app, conferenceId, sessionId, BO)).toEqual([]);
  });

  /**
   * A retried send produces one post-it, not two - and the guarantee holds when the two attempts
   * are served by different API processes, which is the case an application-side check cannot cover
   * (Binding Constraint FR2).
   *
   * The second process is given its **own** connection pool, so the two share nothing but the
   * database. That is the point: the first attempt's row is the only trace of it that the retry can
   * possibly see.
   */
  it('resolves a repeated submission identity onto the post-it already written, across processes', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const submissionId = '9b7d2c14-0000-4000-8000-000000000003';
    const payload = {
      text: 'Nobody owns the staging environment',
      offlineComposed: true,
      submissionId,
    };

    // The first attempt reaches the API; its response never reaches the phone.
    const first = await contribute(app, conferenceId, sessionId, roundId, ADA, payload);
    expect(first.statusCode, first.body).toBe(200);

    const otherDb = createDatabase(url, { error: () => {} });
    try {
      const otherProcess = buildApp({
        db: otherDb,
        auth: {
          verifier: namedVerifier(),
          users: createUserRepository(otherDb),
          codeExchange: unusedCodeExchange(),
        },
        clock: fixedClock('2026-09-15'),
      });
      apps.push(otherProcess);

      const retry = await contribute(otherProcess, conferenceId, sessionId, roundId, ADA, payload);
      expect(retry.statusCode, retry.body).toBe(200);
      // Both answered with the same post-it, not two.
      expect(retry.json().postIt.id).toBe(first.json().postIt.id);
    } finally {
      await otherDb.close();
    }

    expect(await countRows()).toBe(1);
    const board = await boardSeenBy(app, conferenceId, sessionId, BO);
    expect(board).toHaveLength(1);
  });

  /**
   * **A withdrawn Post-it must not come back.**
   *
   * The identity that makes a retry harmless used to live only on the `post_it` row, so removing
   * the Post-it removed it. The sequence is ordinary and entirely within the rules: the send
   * arrives and writes the row, its answer is lost so the device still holds the item, the author
   * sees the Post-it on the board and takes it down - which they may, while the Round is open
   * (FR3) - and then the queue drains. With the identity gone, the constraint had nothing to refuse
   * and put the withdrawn idea back in front of the room **under its author's real name**, with
   * nothing on screen to explain its return.
   *
   * `post_it_delivery` outlives the row so the retry is answered rather than obeyed: a 200 that
   * carries no Post-it, which tells the device to drop the item and leaves the board as its author
   * left it.
   */
  it('does not recreate a post-it its author withdrew, when the queued send retries', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const payload = {
      text: 'Said it, thought better of it',
      offlineComposed: true,
      submissionId: '9b7d2c14-0000-4000-8000-000000000011',
    };

    // The send lands. Its answer never reaches the phone, so the item stays queued.
    const first = await contribute(app, conferenceId, sessionId, roundId, ADA, payload);
    expect(first.statusCode, first.body).toBe(200);
    const postItId = first.json().postIt.id;

    // Its author sees it on the board and takes it down, which the open Round permits.
    const removed = await remove(app, conferenceId, sessionId, roundId, postItId, ADA);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await countRows()).toBe(0);

    // The queue drains. This is the request that used to resurrect it.
    const retry = await contribute(app, conferenceId, sessionId, roundId, ADA, payload);
    expect(retry.statusCode, retry.body).toBe(200);
    // A success with nothing to show - so the device stops retrying, and nothing is written.
    expect(retry.json().postIt).toBeNull();

    expect(await countRows()).toBe(0);
    // Read as the room reads it, not as a row count: the board is still empty.
    expect(await boardSeenBy(app, conferenceId, sessionId, BO)).toHaveLength(0);
  });

  /**
   * With the application's own handling bypassed entirely, the **constraint** is what refuses the
   * repeat - and it leaves live contributions, which carry no submission identity, alone.
   *
   * PostgreSQL treats NULLs as distinct in a unique constraint, so "one post-it, not two" costs the
   * ordinary path nothing at all. Written straight at the table, because a test that went through
   * the route would pass just as well against a read-then-insert in application code.
   */
  it('refuses a second row for one submission identity at the table, and never for a live one', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const insert = (submissionId: string | null, text: string) =>
      client.query(
        `insert into post_it (round_id, conference_id, author_sub, text, submission_id)
         values ($1, $2, $3, $4, $5)`,
        [roundId, conferenceId, ADA, text, submissionId],
      );

    const submissionId = '9b7d2c14-0000-4000-8000-000000000004';
    await expect(insert(submissionId, 'One idea')).resolves.toBeDefined();
    await expect(insert(submissionId, 'The same idea, sent twice')).rejects.toThrow(
      /post_it_submission_unique/i,
    );

    // Two live contributions, neither carrying an identity, both land.
    await expect(insert(null, 'Typed here')).resolves.toBeDefined();
    await expect(insert(null, 'Typed here too')).resolves.toBeDefined();
    expect(await countRows()).toBe(3);
  });

  /**
   * The marker is computed **inside the insert**, from the row the insert itself read.
   *
   * A close is staged on a second connection and committed while the arrival is already under way.
   * The arrival's own statement read the round before that commit, so its marker is `false` - and an
   * implementation that decided lateness with a second query *after* the write would say `true`
   * here, which is exactly what this pins. The trigger's own `UPDATE round` is what makes the
   * arrival wait, so the two really do overlap rather than merely following one another.
   */
  it('marks an arrival from the round state its own write read, not from a later one', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    /**
     * `for update` on the round row is what the arrival actually waits on: inserting a post-it
     * takes a `for key share` lock on its parent round through the composite foreign key, and the
     * two conflict. So the arrival gets as far as having read the round and computed its marker,
     * and then stops - with the close still uncommitted.
     */
    const closer = new pg.Client({ connectionString: url });
    await closer.connect();
    let arrival: ReturnType<typeof contribute> | undefined;
    try {
      await closer.query('begin');
      await closer.query('select 1 from round where id = $1 for update', [roundId]);

      // Started, not awaited.
      arrival = contribute(app, conferenceId, sessionId, roundId, ADA, {
        text: 'Nobody owns the staging environment',
        offlineComposed: true,
        submissionId: '9b7d2c14-0000-4000-8000-000000000005',
      });

      // Waited for rather than slept past: the assertion below means nothing unless the arrival is
      // genuinely blocked on the lock at the moment the close commits.
      await waitForALockWaiter();

      await closer.query(`update round set state = 'closed' where id = $1`, [roundId]);
      await closer.query('commit');
    } finally {
      await closer.end();
    }

    const response = await arrival!;
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().postIt.arrivedAfterClose).toBe(false);

    const { rows } = await client.query<{ arrived_after_close: boolean; state: string }>(
      `select p.arrived_after_close, r.state from post_it p join round r on r.id = p.round_id`,
    );
    expect(rows).toEqual([{ arrived_after_close: false, state: 'closed' }]);
  });

  /**
   * A post-it that waited on a device is validated **on arrival**, by the same rule and the same
   * message a live one meets - there is no second copy of it anywhere, least of all on the phone.
   */
  it('applies the same text validation to an offline-composed contribution', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    await transition(app, conferenceId, sessionId, roundId, 'close');

    const refused = await contribute(app, conferenceId, sessionId, roundId, ADA, {
      text: 'z'.repeat(POST_IT_MAX_LENGTH + 1),
      offlineComposed: true,
      submissionId: '9b7d2c14-0000-4000-8000-000000000006',
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error.code).toBe('POST_IT_TEXT_INVALID');
    expect(refused.json().error.message).toContain(String(POST_IT_MAX_LENGTH));
    expect(await countRows()).toBe(0);
  });

  /**
   * The **first** attempt already carries an identity, so an ambiguous live submission and the
   * queued retry that follows it are one contribution.
   *
   * This is the case the client cannot see: the request reached the API, the row was written, and
   * the answer was lost on the way back. The phone reads that as an ordinary transport failure and
   * queues the text — and if the identity were minted only on the way into the queue, the retry
   * would carry a *different* key, the constraint would see two, and one idea would land twice
   * under a real name. So the live POST carries `submissionId` and no `offlineComposed`, and the
   * retry carries the same `submissionId` with it.
   */
  it('treats an ambiguous live submission and its queued retry as one contribution', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const submissionId = '9b7d2c14-0000-4000-8000-000000000007';

    // The live attempt: it landed, and its author never found out.
    const live = await contribute(app, conferenceId, sessionId, roundId, ADA, {
      text: 'Nobody owns the staging environment',
      submissionId,
    });
    expect(live.statusCode, live.body).toBe(200);
    expect(live.json().postIt.arrivedAfterClose).toBe(false);

    // The queued retry, once the signal returned.
    const retry = await contribute(app, conferenceId, sessionId, roundId, ADA, {
      text: 'Nobody owns the staging environment',
      submissionId,
      offlineComposed: true,
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().postIt.id).toBe(live.json().postIt.id);

    expect(await countRows()).toBe(1);
    expect(await boardSeenBy(app, conferenceId, sessionId, BO)).toHaveLength(1);
  });

  /**
   * Two attempts at one queued item **overlapping**, not one after the other.
   *
   * The sequential test above proves the retry finds a committed row, which a read-then-insert in
   * application code would also manage. This is the case it could not: both inserts in flight at
   * once, on separate connection pools. `ON CONFLICT DO NOTHING` waits for the concurrent inserter
   * of the same key rather than skipping past it, so the loser reads the winner's committed row -
   * and the constraint, not any code, is what decided there would be one.
   */
  it('resolves two overlapping attempts at one submission identity into a single post-it', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const payload = {
      text: 'Nobody owns the staging environment',
      submissionId: '9b7d2c14-0000-4000-8000-000000000008',
      offlineComposed: true,
    };

    const otherDb = createDatabase(url, { error: () => {} });
    try {
      const otherProcess = buildApp({
        db: otherDb,
        auth: {
          verifier: namedVerifier(),
          users: createUserRepository(otherDb),
          codeExchange: unusedCodeExchange(),
        },
        clock: fixedClock('2026-09-15'),
      });
      apps.push(otherProcess);

      // Neither is awaited before the other is issued.
      const [first, second] = await Promise.all([
        contribute(app, conferenceId, sessionId, roundId, ADA, payload),
        contribute(otherProcess, conferenceId, sessionId, roundId, ADA, payload),
      ]);

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().postIt.id).toBe(first.json().postIt.id);
    } finally {
      await otherDb.close();
    }

    expect(await countRows()).toBe(1);
  });

  /**
   * A repeat of an identity is resolved only against the caller's **own** row, on a Round of
   * **this** Session in **this** Conference.
   *
   * Every other statement in the repository carries that scoping, and the retry path is the one
   * place a missing predicate would answer `200` with somebody else's text and somebody else's
   * name. Driven by writing a row directly under another member, in another Conference, with an
   * identity a caller then presents.
   */
  it('never resolves a submission identity onto another member’s or another conference’s post-it', async () => {
    const app = appWith();
    const mine = await autumnOffsite(app);
    const myRound = await openPostItRound(app, mine.conferenceId, mine.sessionId);

    const submissionId = '9b7d2c14-0000-4000-8000-000000000009';

    // Bo's post-it, on the same Round, under the same submission identity - written straight at the
    // table so no route decided any of it.
    await client.query(
      `insert into post_it (round_id, conference_id, author_sub, text, submission_id)
       values ($1, $2, $3, $4, $5)`,
      [myRound, mine.conferenceId, BO, 'Bo typed this and it is his', submissionId],
    );

    // Ada presents the same identity. The constraint refuses her insert, and the resolution must
    // not hand her Bo's row: it is not hers, and she never wrote it.
    const attempt = await contribute(app, mine.conferenceId, mine.sessionId, myRound, ADA, {
      text: 'Nobody owns the staging environment',
      submissionId,
      offlineComposed: true,
    });

    // Whatever the outcome, it is never Bo's post-it returned to Ada.
    if (attempt.statusCode === 200) {
      expect(attempt.json().postIt.authorName).toBe(NAMES[ADA]);
      expect(attempt.json().postIt.text).not.toBe('Bo typed this and it is his');
    }
    const board = await boardSeenBy(app, mine.conferenceId, mine.sessionId, BO);
    expect(board.filter((postIt) => postIt.authorName === NAMES[BO])).toHaveLength(1);
  });

  // ---------- TI01: reversibility ----------

  /**
   * The counter migration reverts to the instant it replaced, and forward again.
   *
   * Its down step is not just "drop what I added": it has to put S02's `activity_watermark_at` and
   * both of S02's function bodies back, because S02's own down step drops them by name and runs
   * after this one. A down step that only dropped the counter would be reversible exactly once and
   * would then break the migration under it - which is the failure this asserts against.
   */
  it('rolls the activity watermark counter back to the timestamp it replaced, and forward', async () => {
    const watermarkColumns = async (): Promise<string[]> => {
      const { rows } = await client.query<{ column_name: string; data_type: string }>(
        `select column_name, data_type from information_schema.columns
          where table_name = 'round' and column_name like '%watermark%' order by 1`,
      );
      return rows.map((row) => `${row.column_name}:${row.data_type}`);
    };
    const sequences = async (): Promise<string[]> => {
      const { rows } = await client.query<{ relname: string }>(
        `select relname from pg_class where relkind = 'S' and relname like '%watermark%' order by 1`,
      );
      return rows.map((row) => row.relname);
    };

    expect(await watermarkColumns()).toEqual(['activity_watermark:bigint']);
    expect(await sequences()).toEqual(['activity_watermark_seq']);

    const steps = await stepsToRevertThrough(
      client,
      '20260829120000000_activity-watermark-counter',
    );
    await migrate('down', String(steps));
    try {
      expect(await watermarkColumns()).toEqual(['activity_watermark_at:timestamp with time zone']);
      expect(await sequences()).toEqual([]);
    } finally {
      await migrate('up');
    }

    expect(await watermarkColumns()).toEqual(['activity_watermark:bigint']);
    expect(await sequences()).toEqual(['activity_watermark_seq']);
  });

  /**
   * S04's own migration, up and down.
   *
   * Reverted far enough to include it, then re-applied: the two columns and the constraint go and
   * come back, and the rest of the table is untouched either way.
   */
  it('adds and removes the late-arrival marker, the submission identity and its constraint', async () => {
    const postItColumns = async (): Promise<string[]> => {
      const { rows } = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'post_it' and column_name in ('arrived_after_close', 'submission_id')
          order by column_name`,
      );
      return rows.map((row) => row.column_name);
    };
    const submissionConstraints = async (): Promise<string[]> => {
      const { rows } = await client.query<{ constraint_name: string }>(
        `select constraint_name from information_schema.table_constraints
          where table_name = 'post_it' and constraint_name = 'post_it_submission_unique'`,
      );
      return rows.map((row) => row.constraint_name);
    };

    expect(await postItColumns()).toEqual(['arrived_after_close', 'submission_id']);
    expect(await submissionConstraints()).toEqual(['post_it_submission_unique']);

    const steps = await stepsToRevertThrough(client, '20260830090000000_post-it-late-arrival');
    await migrate('down', String(steps));
    try {
      // S02's own down step runs on the way through, so `post_it` is gone entirely here - which is
      // the same thing as neither column being present, and is what the empty lists say.
      expect(await postItColumns()).toEqual([]);
      expect(await submissionConstraints()).toEqual([]);
    } finally {
      await migrate('up');
    }

    expect(await postItColumns()).toEqual(['arrived_after_close', 'submission_id']);
    expect(await submissionConstraints()).toEqual(['post_it_submission_unique']);
  });

  it('applies and rolls back cleanly, taking its table, column and triggers with it', async () => {
    // Far enough back to include *this* migration, whatever later stories have stacked on top of
    // it - `migrate down` counts from the newest. Reverting a fixed one step said "post-it is the
    // last migration", which stopped being true the moment S03 added the vote tables
    // (`migration-depth.ts`).
    const steps = await stepsToRevertThrough(client, '20260828120000000_post-it');
    await migrate('down', String(steps));

    const { rows: gone } = await client.query<{ present: boolean }>(
      `select exists (select 1 from information_schema.tables where table_name = 'post_it') as present`,
    );
    expect(gone[0]!.present).toBe(false);

    // Under either name: this revert passes back through the counter migration, whose own down
    // step restores S02's `activity_watermark_at` so that S02's down step finds what it drops.
    const { rows: column } = await client.query<{ present: boolean }>(
      `select exists (
         select 1 from information_schema.columns
          where table_name = 'round' and column_name like '%watermark%'
       ) as present`,
    );
    expect(column[0]!.present).toBe(false);

    const { rows: triggers } = await client.query<{ tgname: string }>(
      `select tgname from pg_trigger where tgname like '%activity_watermark%'`,
    );
    expect(triggers).toEqual([]);

    await migrate('up');
    const { rows: back } = await client.query<{ present: boolean }>(
      `select exists (select 1 from information_schema.tables where table_name = 'post_it') as present`,
    );
    expect(back[0]!.present).toBe(true);
  });
});
