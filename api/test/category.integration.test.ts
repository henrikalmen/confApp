import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDatabase, type Database, type Queryable } from '../src/db.ts';
import { createUserRepository } from '../src/auth/users.ts';
import {
  CATEGORY_LIMIT_PER_BOARD,
  CATEGORY_NAME_MAX_LENGTH,
} from '../src/rounds/category-validation.ts';
import { fixedClock } from '../src/conferences/calendar-date.ts';
import { tokenFor, unusedCodeExchange } from './fake-auth.ts';
import type { Verifier } from '../src/auth/verify-id-token.ts';
import { stepsToRevertThrough } from './migration-depth.ts';

/**
 * Categories, Uncategorised and sorting authority, against the real PostgreSQL the composed stack
 * runs.
 *
 * Every rule proved here is a storage-level guarantee, an authority decision or a propagation
 * property, and **none of them is provable against a fake that answers whatever the test wants**:
 * the composite foreign key that makes a Category on a Poll unwritable, the `CHECK` plus deferred
 * `UNIQUE` that make the 20-per-Board cap unraceable by two concurrent creates, the `NO ACTION`
 * foreign key that makes "an occupied Category cannot be removed" a guarantee rather than a
 * handler's promise, and the trigger that carries a Category change to every open Board through the
 * one activity cursor.
 *
 * Two disciplines run through the whole file, inherited from `post-it.integration.test.ts`:
 *
 *   - **A refusal is asserted against the stored rows**, never against the response envelope alone.
 *     A route that returns a refusal and writes anyway passes a response-only test.
 *   - **Nothing here asserts that a request was issued.** Propagation is proved by what the *next*
 *     read returns, which is what a participant actually sees.
 *
 * The verifier is stubbed, because who the caller is was settled in the auth suite and the subject
 * here is what that caller may do to a Board.
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
    '\n[integration] SKIPPED categories and sorting authority – no PostgreSQL at ' +
      'TEST_DATABASE_URL.\n[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/** Priya organizes (and so is Admin); Ida facilitates the workshop; Ada and Bo are in the room. */
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
  arrivedAfterClose: boolean;
}

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
  categories?: WireCategory[];
  uncategorised?: { postIts: WirePostIt[]; postItCount: number };
  textMaxLength?: number;
}

interface WireSession {
  rounds: WireRound[];
  canRun: boolean;
  activityWatermark: string | null;
}

describe.skipIf(!reachable)('categories and sorting authority against a real PostgreSQL', () => {
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
    // Conference rows cascade to sessions, rounds, post-its, categories, memberships and roles.
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
   * "Autumn Offsite", published, with the workshop Ida facilitates.
   *
   * Priya created it and so holds conference-wide **Admin** and no Session Assignment, which is
   * exactly the pair FR6's second criterion is about. Ada and Bo are Members with no Role
   * Assignment at all.
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

  function categoryPath(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    categoryId?: string,
  ): string {
    const base = `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/categories`;
    return categoryId === undefined ? base : `${base}/${categoryId}`;
  }

  function createCategory(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    payload: Record<string, unknown>,
    sub = IDA,
  ) {
    return app.inject({
      method: 'POST',
      url: categoryPath(conferenceId, sessionId, roundId),
      headers: as(sub),
      payload,
    });
  }

  async function created(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    name: string,
    sub = IDA,
  ): Promise<string> {
    const response = await createCategory(app, conferenceId, sessionId, roundId, { name }, sub);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().category.id as string;
  }

  function changeCategory(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    categoryId: string,
    payload: Record<string, unknown>,
    sub = IDA,
  ) {
    return app.inject({
      method: 'PATCH',
      url: categoryPath(conferenceId, sessionId, roundId, categoryId),
      headers: as(sub),
      payload,
    });
  }

  function removeCategory(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    categoryId: string,
    payload?: Record<string, unknown>,
    sub = IDA,
  ) {
    return app.inject({
      method: 'DELETE',
      url: categoryPath(conferenceId, sessionId, roundId, categoryId),
      headers: as(sub),
      payload: payload ?? {},
    });
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
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/post-its`,
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

  async function boardOf(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    sub = IDA,
  ): Promise<WireRound> {
    const { rounds } = await readSession(app, conferenceId, sessionId, sub);
    return rounds[0]!;
  }

  /** The stored ordering, read straight from the table – never from a response. */
  async function storedOrder(roundId: string): Promise<[string, number][]> {
    const { rows } = await client.query<{ name: string; position: number }>(
      'select name, position from category where round_id = $1 order by position, id',
      [roundId],
    );
    return rows.map((row) => [row.name, row.position]);
  }

  async function storedPlacements(roundId: string): Promise<(string | null)[]> {
    const { rows } = await client.query<{ category_id: string | null }>(
      'select category_id from post_it where round_id = $1 order by created_at, id',
      [roundId],
    );
    return rows.map((row) => row.category_id);
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

  async function archive(conferenceId: string): Promise<void> {
    await client.query("update conference set lifecycle_state = 'archived' where id = $1", [
      conferenceId,
    ]);
  }

  // ---------- Acceptance Scenario S01: creating a Category places nothing (TI01, TI03…TI07) ------

  /**
   * A Category is created on a Board that already holds Post-its, on a **closed** Round.
   *
   * Both halves are the point. Sorting happens after the room has written, so the Round being
   * closed must refuse nothing here - a Board write is not a contribution - and creating a bucket
   * must not sweep anything into it. The count is asserted from the payload and the placements from
   * the table, so a route that returned the right numbers over the wrong rows would fail.
   */
  it('creates a category on a closed round holding post-its, and auto-places nothing', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    for (const text of ['Test data', 'Handovers', 'Meetings', 'Staging', 'Runbooks']) {
      await contributed(app, conferenceId, sessionId, roundId, ADA, text);
    }
    expect((await transition(app, conferenceId, sessionId, roundId, 'close')).statusCode).toBe(200);

    const response = await createCategory(app, conferenceId, sessionId, roundId, {
      name: 'Tooling',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().category.position).toBe(1);
    // A first category is not a duplicate of anything, so no warning rides the write.
    expect(response.json().warning).toBeUndefined();

    const round = await boardOf(app, conferenceId, sessionId);
    expect(round.state).toBe('closed');
    expect(round.categories!.map((category) => [category.name, category.postItCount])).toEqual([
      ['Tooling', 0],
    ]);
    expect(round.categories![0]!.postIts).toEqual([]);
    expect(round.uncategorised!.postItCount).toBe(5);
    expect(round.uncategorised!.postIts.length).toBe(5);

    // And the stored rows agree: five post-its, none of them placed.
    expect(await storedPlacements(roundId)).toEqual([null, null, null, null, null]);
  });

  // ---------- Acceptance Scenario S02: rename moves nothing; reorder clamps (TI03, TI05, TI06) ---

  it('renames without moving anything, and clamps a reorder past the end of the order', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
    await created(app, conferenceId, sessionId, roundId, 'Process');
    await created(app, conferenceId, sessionId, roundId, 'People');
    expect(await storedOrder(roundId)).toEqual([
      ['Tooling', 1],
      ['Process', 2],
      ['People', 3],
    ]);

    // Three post-its into "Tooling", written straight to the column: placement is S03's endpoint,
    // and what this scenario is about is that a rename and a reorder leave placements alone.
    for (const text of ['Slow build', 'Flaky tests', 'No staging']) {
      const id = await contributed(app, conferenceId, sessionId, roundId, ADA, text);
      await client.query('update post_it set category_id = $2 where id = $1', [id, tooling]);
    }

    const renamed = await changeCategory(app, conferenceId, sessionId, roundId, tooling, {
      name: 'Tooling & CI',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);

    const moved = await changeCategory(app, conferenceId, sessionId, roundId, tooling, {
      position: 99,
    });
    // Clamped rather than refused - FR1's own validation rule.
    expect(moved.statusCode, moved.body).toBe(200);

    const round = await boardOf(app, conferenceId, sessionId);
    expect(round.categories!.map((category) => category.name)).toEqual([
      'Process',
      'People',
      'Tooling & CI',
    ]);
    // Contiguous afterwards: no position skipped and none repeated.
    expect(await storedOrder(roundId)).toEqual([
      ['Process', 1],
      ['People', 2],
      ['Tooling & CI', 3],
    ]);

    // The rename moved nothing: the same three post-its are still in it, under its new name.
    const renamedCategory = round.categories!.find((c) => c.name === 'Tooling & CI')!;
    expect(renamedCategory.postItCount).toBe(3);
    expect(renamedCategory.postIts.map((postIt) => postIt.text)).toEqual([
      'Slow build',
      'Flaky tests',
      'No staging',
    ]);
    expect(round.uncategorised!.postItCount).toBe(0);
  });

  // ---------- Acceptance Scenario S03: Uncategorised with no Categories at all (TI01, TI04…TI07) --

  it('renders uncategorised on an empty board, takes a late arrival into it, and is unaddressable', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const empty = await boardOf(app, conferenceId, sessionId);
    expect(empty.categories).toEqual([]);
    expect(empty.uncategorised).toEqual({ postIts: [], postItCount: 0 });

    expect((await transition(app, conferenceId, sessionId, roundId, 'close')).statusCode).toBe(200);

    // Composed offline while the round ran, drained after it closed: accepted, marked late, and
    // landing in Uncategorised like every other arrival - never auto-placed.
    const late = await contribute(app, conferenceId, sessionId, roundId, BO, {
      text: 'Typed in the lift',
      offlineComposed: true,
      submissionId: '9f1d1e2a-0000-4000-8000-000000000001',
    });
    expect(late.statusCode, late.body).toBe(200);

    const after = await boardOf(app, conferenceId, sessionId);
    expect(after.categories).toEqual([]);
    expect(after.uncategorised!.postItCount).toBe(1);
    expect(after.uncategorised!.postIts[0]!.text).toBe('Typed in the lift');
    expect(after.uncategorised!.postIts[0]!.arrivedAfterClose).toBe(true);
    expect(await storedPlacements(roundId)).toEqual([null]);

    /*
     * Nothing addresses Uncategorised. There is no identifier for it to send, so the only thing a
     * category endpoint can be handed is an id that names a real Category - or one that names
     * nothing, which is what every one of these is.
     */
    const stranger = '9f1d1e2a-0000-4000-8000-0000000000ff';
    const renamed = await changeCategory(app, conferenceId, sessionId, roundId, stranger, {
      name: 'Not a category',
    });
    expect(renamed.statusCode).toBe(404);
    expect(renamed.json().error.code).toBe('CATEGORY_NOT_FOUND');

    const reordered = await changeCategory(app, conferenceId, sessionId, roundId, stranger, {
      position: 1,
    });
    expect(reordered.statusCode).toBe(404);
    expect(reordered.json().error.code).toBe('CATEGORY_NOT_FOUND');

    const removed = await removeCategory(app, conferenceId, sessionId, roundId, stranger);
    expect(removed.statusCode).toBe(404);
    expect(removed.json().error.code).toBe('CATEGORY_NOT_FOUND');

    // And the post-it is still exactly where it was.
    expect(await storedPlacements(roundId)).toEqual([null]);
  });

  // ---------- Acceptance Scenario S04: occupied removal needs a destination (TI03, TI06) ---------

  it('removes an empty category outright, and refuses an occupied one until a destination is named', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const process = await created(app, conferenceId, sessionId, roundId, 'Process');
    const people = await created(app, conferenceId, sessionId, roundId, 'People');

    for (const text of ['Standups', 'Handovers', 'Sign-off', 'Retros']) {
      const id = await contributed(app, conferenceId, sessionId, roundId, ADA, text);
      await client.query('update post_it set category_id = $2 where id = $1', [id, process]);
    }

    // Empty: no prompt, no destination, gone.
    const emptyGone = await removeCategory(app, conferenceId, sessionId, roundId, people);
    expect(emptyGone.statusCode, emptyGone.body).toBe(200);
    expect(await storedOrder(roundId)).toEqual([['Process', 1]]);

    // Occupied, with no destination: refused, and the sentence names the count.
    const refused = await removeCategory(app, conferenceId, sessionId, roundId, process);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('CATEGORY_HOLDS_POST_ITS');
    expect(refused.json().error.message).toMatch(/This category holds 4 post-its/);
    // Nothing was written: the category and all four post-its are still stored.
    expect(await storedOrder(roundId)).toEqual([['Process', 1]]);
    expect(await storedPlacements(roundId)).toEqual([process, process, process, process]);

    // Occupied, choosing Uncategorised - which is the **absence** of a placement, sent as `null`.
    const moved = await removeCategory(app, conferenceId, sessionId, roundId, process, {
      destinationCategoryId: null,
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await storedOrder(roundId)).toEqual([]);
    expect(await storedPlacements(roundId)).toEqual([null, null, null, null]);

    const round = await boardOf(app, conferenceId, sessionId);
    expect(round.categories).toEqual([]);
    expect(round.uncategorised!.postItCount).toBe(4);
  });

  it('moves an occupied category’s post-its into another category on the same board', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const process = await created(app, conferenceId, sessionId, roundId, 'Process');
    const people = await created(app, conferenceId, sessionId, roundId, 'People');
    const id = await contributed(app, conferenceId, sessionId, roundId, ADA, 'Standups');
    await client.query('update post_it set category_id = $2 where id = $1', [id, process]);

    const moved = await removeCategory(app, conferenceId, sessionId, roundId, process, {
      destinationCategoryId: people,
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await storedPlacements(roundId)).toEqual([people]);
    // And the survivor is renumbered contiguously rather than left at position 2.
    expect(await storedOrder(roundId)).toEqual([['People', 1]]);
  });

  it('refuses a destination that is a category on some other board, and moves nothing', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const otherRound = await addRound(app, conferenceId, sessionId, POST_IT_ROUND);

    const process = await created(app, conferenceId, sessionId, roundId, 'Process');
    const elsewhere = await created(app, conferenceId, sessionId, otherRound, 'Elsewhere');
    const id = await contributed(app, conferenceId, sessionId, roundId, ADA, 'Standups');
    await client.query('update post_it set category_id = $2 where id = $1', [id, process]);

    const refused = await removeCategory(app, conferenceId, sessionId, roundId, process, {
      destinationCategoryId: elsewhere,
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error.code).toBe('CATEGORY_NOT_FOUND');
    expect(await storedPlacements(roundId)).toEqual([process]);
    expect(await storedOrder(roundId)).toEqual([['Process', 1]]);
  });

  /**
   * **A refused removal writes nothing at all - including the move it had already made.**
   *
   * A removal with a destination moves the Post-its and *then* deletes the row, and the delete
   * carries the occupancy guard. If a Post-it is in the Category by the time that delete runs, the
   * removal is refused - and the relocation has to go back with it. Returning the refusal normally
   * would commit it: the Facilitator would read "this category holds N post-its" while those
   * Post-its had already been moved somewhere nobody confirmed.
   *
   * The arrival is driven **inside the transaction**, through the recording database, and that is
   * deliberate rather than a shortcut. Driving it from a second connection deadlocks the test
   * rather than the product: the transaction's own relocation has already taken the Round row lock
   * through the cursor trigger, so any other connection writing a Post-it on this Round waits for a
   * transaction that is itself waiting for that write. What is under test is the *rollback*, and
   * the injected row reproduces exactly the condition that triggers it.
   */
  it('rolls back the post-its it had already moved when the removal is refused', async () => {
    const plain = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(plain);
    const roundId = await openPostItRound(plain, conferenceId, sessionId);

    const source = await created(plain, conferenceId, sessionId, roundId, 'Source');
    const destination = await created(plain, conferenceId, sessionId, roundId, 'Destination');

    const moving: string[] = [];
    for (const text of ['Slow build', 'Flaky tests']) {
      const id = await contributed(plain, conferenceId, sessionId, roundId, ADA, text);
      await client.query('update post_it set category_id = $2 where id = $1', [id, source]);
      moving.push(id);
    }
    // Unsorted, and placed into the Category the instant its post-its have been moved out.
    const arriving = await contributed(plain, conferenceId, sessionId, roundId, BO, 'Late idea');

    let placed = false;
    const racing: Database = {
      async query(text, values) {
        return db.query(text, values);
      },
      async transaction(work) {
        return db.transaction(async (tx: Queryable) => {
          const gated: Queryable = {
            async query(text, values) {
              const rows = await tx.query(text, values);
              if (!placed && /update post_it set category_id = \$2/.test(text)) {
                placed = true;
                await tx.query('update post_it set category_id = $2 where id = $1', [
                  arriving,
                  source,
                ]);
              }
              return rows;
            },
          };
          return work(gated);
        });
      },
      async close() {},
    };

    const refused = await removeCategory(
      appWith(racing),
      conferenceId,
      sessionId,
      roundId,
      source,
      { destinationCategoryId: destination },
    );
    expect(placed, 'the arrival should have been driven mid-transaction').toBe(true);

    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('CATEGORY_HOLDS_POST_ITS');
    // The count is read **after** the rollback, so it describes the Board as it actually stands.
    expect(refused.json().error.message).toMatch(/This category holds 2 post-its/);

    // **Nothing moved.** Both Post-its are still in the Category the refusal named, and the one
    // that was never sorted is still unsorted.
    const { rows } = await client.query<{ id: string; category_id: string | null }>(
      'select id, category_id from post_it where round_id = $1',
      [roundId],
    );
    const placement = new Map(rows.map((row) => [row.id, row.category_id]));
    expect(placement.get(moving[0]!)).toBe(source);
    expect(placement.get(moving[1]!)).toBe(source);
    expect(placement.get(arriving)).toBeNull();
    expect(await storedOrder(roundId)).toEqual([
      ['Source', 1],
      ['Destination', 2],
    ]);
  });

  /**
   * A position below the range is **clamped, not refused** - the same rule as a position above it.
   *
   * FR1 states one validation rule for both ends, and the obvious way to build a "move up" control
   * is to decrement, which produces 0 at the top of the order.
   */
  it('clamps a position below the range instead of refusing it', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    await created(app, conferenceId, sessionId, roundId, 'Tooling');
    const process = await created(app, conferenceId, sessionId, roundId, 'Process');

    const moved = await changeCategory(app, conferenceId, sessionId, roundId, process, {
      position: 0,
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await storedOrder(roundId)).toEqual([
      ['Process', 1],
      ['Tooling', 2],
    ]);

    /*
     * And `null` is "leave the position alone" rather than "move to the front". It reaches the
     * route uncoerced because the schema admits it, so a rename that carries it moves nothing.
     */
    const renamed = await changeCategory(app, conferenceId, sessionId, roundId, process, {
      name: 'Process & handovers',
      position: null,
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(await storedOrder(roundId)).toEqual([
      ['Process & handovers', 1],
      ['Tooling', 2],
    ]);
  });

  /**
   * A reorder that changes nothing writes nothing, and so tells nobody.
   *
   * Every row a renumber writes fires the cursor trigger, so a move to the position a Category
   * already holds would hand every open Board in the room a refetch that finds the same Board.
   */
  it('does not advance the cursor for a reorder that leaves the order as it was', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
    await created(app, conferenceId, sessionId, roundId, 'Process');

    const before = await watermark(app, conferenceId, sessionId, ADA);
    const unmoved = await changeCategory(app, conferenceId, sessionId, roundId, tooling, {
      position: 1,
    });
    expect(unmoved.statusCode, unmoved.body).toBe(200);

    expect(await watermark(app, conferenceId, sessionId, ADA)).toBe(before);
    expect(await storedOrder(roundId)).toEqual([
      ['Tooling', 1],
      ['Process', 2],
    ]);
  });

  // ---------- Acceptance Scenario S05: authority is decided at the API (TI06, TI11) --------------

  it('refuses a member with no assignment, admits an admin with none, and ignores an actor field', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    // Ada is a Member of the Conference and holds neither a Session Assignment nor Admin.
    const member = await createCategory(
      app,
      conferenceId,
      sessionId,
      roundId,
      { name: 'Sneaked in' },
      ADA,
    );
    expect(member.statusCode).toBe(403);
    expect(member.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');
    expect(await storedOrder(roundId)).toEqual([]);

    // Priya created the Conference, so she is Admin - and holds no Session Assignment for this
    // Session. Conference-wide authority is what admits her.
    const admin = await createCategory(
      app,
      conferenceId,
      sessionId,
      roundId,
      { name: 'Tooling' },
      PRIYA,
    );
    expect(admin.statusCode, admin.body).toBe(200);

    const { rows: assignments } = await client.query<{ held: number }>(
      `select count(*)::int as held from session_assignment
        where conference_id = $1 and session_id = $2 and user_sub = $3`,
      [conferenceId, sessionId, PRIYA],
    );
    expect(assignments[0]!.held).toBe(0);

    /*
     * A body claiming to be somebody else is **accepted and ignored**, which is the stronger
     * statement than refusing it: a route that refuses an actor field and a route that trusts one
     * both pass "does not accept a body with an actor in it", and only one of them is correct.
     * There is no author column on a Category to inspect, so what is proved is that the request is
     * decided by the credential - Ada's is refused whatever the body claims, Ida's succeeds.
     */
    const impersonating = await createCategory(
      app,
      conferenceId,
      sessionId,
      roundId,
      { name: 'Claimed', authorSub: IDA, actorSub: IDA, userSub: PRIYA },
      ADA,
    );
    expect(impersonating.statusCode).toBe(403);
    expect(await storedOrder(roundId)).toEqual([['Tooling', 1]]);

    const honest = await createCategory(
      app,
      conferenceId,
      sessionId,
      roundId,
      { name: 'Process', actorSub: ADA, userSub: ADA },
      IDA,
    );
    expect(honest.statusCode, honest.body).toBe(200);
    expect(await storedOrder(roundId)).toEqual([
      ['Tooling', 1],
      ['Process', 2],
    ]);
  });

  // ---------- Acceptance Scenario S06: archived refuses every write (TI04, TI06, TI11) -----------

  it('refuses every category write on an archived conference and still serves the board', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
    await created(app, conferenceId, sessionId, roundId, 'Process');
    for (const text of ['Slow build', 'Standups', 'Sign-off', 'Retros']) {
      await contributed(app, conferenceId, sessionId, roundId, ADA, text);
    }

    await archive(conferenceId);

    const writes = [
      await createCategory(app, conferenceId, sessionId, roundId, { name: 'People' }),
      await changeCategory(app, conferenceId, sessionId, roundId, tooling, { name: 'Renamed' }),
      await changeCategory(app, conferenceId, sessionId, roundId, tooling, { position: 2 }),
      await removeCategory(app, conferenceId, sessionId, roundId, tooling, {
        destinationCategoryId: null,
      }),
    ];
    for (const refused of writes) {
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe('CONFERENCE_NOT_EDITABLE');
      // The one archived sentence this API has, not a second copy of the PRD's paraphrase.
      expect(refused.json().error.message).toBe(
        'This conference has been archived, so it is read-only and can no longer be changed.',
      );
    }
    expect(await storedOrder(roundId)).toEqual([
      ['Tooling', 1],
      ['Process', 2],
    ]);

    /*
     * Archival stops writes; it does not empty or hide the Board. A Conference archived with four
     * post-its still in Uncategorised is a valid terminal state, and the categorised output has to
     * be able to represent it (`prd.md#fr2-the-uncategorised-holding-area`).
     */
    const round = await boardOf(app, conferenceId, sessionId);
    expect(round.categories!.map((category) => category.name)).toEqual(['Tooling', 'Process']);
    expect(round.uncategorised!.postItCount).toBe(4);
    expect(round.uncategorised!.postIts.length).toBe(4);
  });

  // ---------- Acceptance Scenario S07: the cap and the ordering under concurrency (TI01…TI11) ----

  /**
   * The 20-per-Board cap cannot be raced past, and the loser reads the counted refusal.
   *
   * **Two real connections, not two sequential calls.** A transaction is held open past its insert
   * so the API's own create computes the same next position from the state it can see, and the
   * held transaction commits only once the request's COMMIT is already waiting on it. Sequential
   * inserts could not tell a storage constraint from an application-level count.
   *
   * The refusal must be the counted sentence rather than an unmapped internal error, even though
   * the deferred unique constraint raises 23505 at COMMIT rather than at the failing statement.
   */
  it('lets only one of two concurrent creates take the twentieth slot, and counts the refusal', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    for (let position = 1; position <= CATEGORY_LIMIT_PER_BOARD - 1; position += 1) {
      await client.query(
        'insert into category (round_id, conference_id, name, position) values ($1, $2, $3, $4)',
        [roundId, conferenceId, `Seeded ${position}`, position],
      );
    }

    const rival = new pg.Client({ connectionString: url });
    await rival.connect();
    let response;
    try {
      await rival.query('begin');
      await rival.query(
        `insert into category (round_id, conference_id, name, position)
         select $1, $2, 'Rival', coalesce(max(position), 0) + 1 from category where round_id = $1`,
        [roundId, conferenceId],
      );

      // Started, deliberately not awaited: its own COMMIT blocks on the row the rival is holding.
      const pending = createCategory(app, conferenceId, sessionId, roundId, { name: 'Loser' });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await rival.query('commit');
      response = await pending;
    } finally {
      await rival.end();
    }

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.code).toBe('CATEGORY_LIMIT_REACHED');
    // Named, both of them: the limit and the count as the board actually stands.
    expect(response.json().error.message).toMatch(
      new RegExp(`at most ${CATEGORY_LIMIT_PER_BOARD} categories`),
    );
    expect(response.json().error.message).toMatch(
      new RegExp(`already holds ${CATEGORY_LIMIT_PER_BOARD}`),
    );

    const { rows } = await client.query<{ held: number }>(
      'select count(*)::int as held from category where round_id = $1',
      [roundId],
    );
    expect(rows[0]!.held).toBe(CATEGORY_LIMIT_PER_BOARD);
    // Exactly one of the two names is stored, and it is the winner's.
    const names = (await storedOrder(roundId)).map(([name]) => name);
    expect(names).toContain('Rival');
    expect(names).not.toContain('Loser');
  });

  it('refuses a twenty-first category outright, naming the limit and the count', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    for (let position = 1; position <= CATEGORY_LIMIT_PER_BOARD; position += 1) {
      await client.query(
        'insert into category (round_id, conference_id, name, position) values ($1, $2, $3, $4)',
        [roundId, conferenceId, `Seeded ${position}`, position],
      );
    }

    const refused = await createCategory(app, conferenceId, sessionId, roundId, { name: 'Extra' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('CATEGORY_LIMIT_REACHED');
    expect(refused.json().error.message).toMatch(
      new RegExp(`already holds ${CATEGORY_LIMIT_PER_BOARD}`),
    );

    const { rows } = await client.query<{ held: number }>(
      'select count(*)::int as held from category where round_id = $1',
      [roundId],
    );
    expect(rows[0]!.held).toBe(CATEGORY_LIMIT_PER_BOARD);
  });

  /**
   * Two Facilitators reorder the same Board at once.
   *
   * Last write wins **for the ordering as a whole** (`prd.md#edge-cases`): the Board settles on one
   * Facilitator's intended ordering entire, never on a *composition* of the two moves, and neither
   * of them is offered a conflict prompt - they converge through the one activity cursor.
   *
   * **Four Categories and two disjoint moves, with the overlap forced.** Both halves are the point.
   * At three Categories every move touches every row, so the composition and the two intended
   * orderings are hard to tell apart; at four, with the changed sets disjoint, a per-Category merge
   * produces an ordering that is contiguous, complete and asked for by nobody. And `Promise.all`
   * guarantees nothing about the interleaving - if the two happen to run in sequence, composing
   * them is the *correct* answer and the assertion below would be wrong. So the losing reorder is
   * parked on its write through a gated `Database` until the winner has committed, which is the
   * only arrangement in which "whole, not composed" is a meaningful claim.
   *
   * What this proves is the **property**. The mechanism behind it - that a renumber writes every
   * row in the ordering rather than only the ones that moved - is pinned in
   * `category-structure.test.ts`, because the two implementations converge here: the discarded
   * filter compared each row against its *live* value, which after the winner committed differed
   * for every row anyway.
   */
  it('overwrites a concurrent reorder whole, rather than composing the two moves', async () => {
    const plain = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(plain);
    const roundId = await openPostItRound(plain, conferenceId, sessionId);

    const alpha = await created(plain, conferenceId, sessionId, roundId, 'Alpha');
    const beta = await created(plain, conferenceId, sessionId, roundId, 'Beta');
    await created(plain, conferenceId, sessionId, roundId, 'Gamma');
    const delta = await created(plain, conferenceId, sessionId, roundId, 'Delta');
    expect((await storedOrder(roundId)).map(([name]) => name)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
      'Delta',
    ]);
    void alpha;

    /*
     * Ida moves Beta to the front  -> Beta, Alpha, Gamma, Delta   (rows 1 and 2 change)
     * Priya moves Delta to third   -> Alpha, Beta, Delta, Gamma   (rows 3 and 4 change)
     *
     * The changed sets are disjoint, so a per-Category merge produces `Beta, Alpha, Delta, Gamma` -
     * contiguous, complete, and an ordering neither of them asked for.
     */
    let release: () => void = () => {};
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parking = true;

    const gated: Database = {
      async query(text, values) {
        return db.query(text, values);
      },
      async transaction(work) {
        return db.transaction(async (tx: Queryable) =>
          work({
            async query(text, values) {
              // The ordering has been read; hold the write open until the rival has committed.
              if (parking && /update category c/.test(text)) {
                parking = false;
                await parked;
              }
              return tx.query(text, values);
            },
          }),
        );
      },
      async close() {},
    };

    const idas = changeCategory(appWith(gated), conferenceId, sessionId, roundId, beta, {
      position: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(parking, 'Ida’s reorder should be parked on its write').toBe(false);

    const priyas = await changeCategory(plain, conferenceId, sessionId, roundId, delta, {
      position: 3,
    });
    expect(priyas.statusCode, priyas.body).toBe(200);
    expect((await storedOrder(roundId)).map(([name]) => name)).toEqual([
      'Alpha',
      'Beta',
      'Delta',
      'Gamma',
    ]);

    release();
    const written = await idas;
    // Neither is a refusal, and neither carries a conflict for anybody to act on.
    expect(written.statusCode, written.body).toBe(200);

    const settled = await storedOrder(roundId);
    // Ida wrote last and wrote **whole**: the ordering she computed from the Board she read, with
    // Priya's move gone. `Beta, Alpha, Delta, Gamma` - the two moves composed - is the failure.
    expect(settled.map(([name]) => name)).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
    expect(settled.map(([, position]) => position)).toEqual([1, 2, 3, 4]);
  });

  /**
   * And the ordinary concurrent case leaves the Board whole, whichever way the two land.
   *
   * Weaker than the test above by design: `Promise.all` decides nothing about the interleaving, so
   * what is asserted is only what must hold in *every* interleaving - positions contiguous from 1,
   * no Category duplicated and none missing.
   */
  it('leaves the ordering contiguous and complete under two unsynchronised reorders', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
    await created(app, conferenceId, sessionId, roundId, 'Process');
    const people = await created(app, conferenceId, sessionId, roundId, 'People');

    const [first, second] = await Promise.all([
      changeCategory(app, conferenceId, sessionId, roundId, people, { position: 1 }),
      changeCategory(app, conferenceId, sessionId, roundId, tooling, { position: 3 }),
    ]);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);

    const stored = await storedOrder(roundId);
    expect(stored.map(([, position]) => position)).toEqual([1, 2, 3]);
    expect([...stored.map(([name]) => name)].sort()).toEqual(['People', 'Process', 'Tooling']);
  });

  it('leaves no hole in the ordering when a removal races a removal', async () => {
    const plain = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(plain);
    const roundId = await openPostItRound(plain, conferenceId, sessionId);

    await created(plain, conferenceId, sessionId, roundId, 'Alpha');
    const beta = await created(plain, conferenceId, sessionId, roundId, 'Beta');
    const gamma = await created(plain, conferenceId, sessionId, roundId, 'Gamma');
    await created(plain, conferenceId, sessionId, roundId, 'Delta');

    /*
     * Ida reads the Board - Alpha, Beta, Gamma, Delta - and is held there. Priya then removes Gamma
     * outright and commits. Ida resumes and removes Beta, renumbering from the ordering she read,
     * which still names Gamma.
     *
     * Ranking the array's own ordinality skips the number belonging to the id that is now gone and
     * leaves Alpha at 1 and Delta at 3. The hole is not cosmetic: `create` takes its position from
     * `max(position) + 1`, so the Board silently loses one of its twenty slots for good.
     */
    let release: () => void = () => {};
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parking = true;

    const gated: Database = {
      async query(text, values) {
        return db.query(text, values);
      },
      async transaction(work) {
        return db.transaction(async (tx: Queryable) =>
          work({
            async query(text, values) {
              // The ordering has been read; hold before the delete so the rival commits first.
              if (parking && /delete from category c/.test(text)) {
                parking = false;
                await parked;
              }
              return tx.query(text, values);
            },
          }),
        );
      },
      async close() {},
    };

    const idas = removeCategory(appWith(gated), conferenceId, sessionId, roundId, beta);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(parking, 'Ida’s removal should be parked on its delete').toBe(false);

    const priyas = await removeCategory(plain, conferenceId, sessionId, roundId, gamma);
    expect(priyas.statusCode, priyas.body).toBe(200);

    release();
    const removed = await idas;
    expect(removed.statusCode, removed.body).toBe(200);

    const settled = await storedOrder(roundId);
    expect(settled.map(([name]) => name)).toEqual(['Alpha', 'Delta']);
    // Contiguous from 1, with no slot burned: `[1, 3]` is the defect this pins.
    expect(settled.map(([, position]) => position)).toEqual([1, 2]);
  });

  // ---------- Acceptance Scenario S08: the name rule, and the duplicate warning (TI02, TI06) -----

  it('counts the name in code points after trimming, and warns rather than refuses a duplicate', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    await created(app, conferenceId, sessionId, roundId, 'Tooling');

    const blank = await createCategory(app, conferenceId, sessionId, roundId, { name: '   ' });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error.code).toBe('CATEGORY_NAME_INVALID');
    expect(blank.json().error.details[0].field).toBe('name');

    /*
     * A name of emoji, which is where `.length` and `char_length` disagree: 61 code points measure
     * 122 UTF-16 units. The refusal names the limit **and** the offending length, so somebody
     * mid-typing knows what to change.
     */
    const tooLong = await createCategory(app, conferenceId, sessionId, roundId, {
      name: '🎯'.repeat(CATEGORY_NAME_MAX_LENGTH + 1),
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.code).toBe('CATEGORY_NAME_INVALID');
    expect(tooLong.json().error.message).toMatch(new RegExp(`${CATEGORY_NAME_MAX_LENGTH}`));
    expect(tooLong.json().error.message).toMatch(new RegExp(`${CATEGORY_NAME_MAX_LENGTH + 1}`));

    const atTheLimit = await createCategory(app, conferenceId, sessionId, roundId, {
      name: '🎯'.repeat(CATEGORY_NAME_MAX_LENGTH),
    });
    expect(atTheLimit.statusCode, atTheLimit.body).toBe(200);

    // Two refusals wrote nothing; the boundary name did.
    expect((await storedOrder(roundId)).length).toBe(2);

    /*
     * A duplicate is **stored**, with a warning on the response. Names are labels, not identifiers,
     * and the Report groups by identity (`prd.md#fr1-categories-on-a-board`).
     */
    const duplicate = await createCategory(app, conferenceId, sessionId, roundId, {
      name: 'Tooling',
    });
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(duplicate.json().warning).toMatch(/already has that name/i);
    expect((await storedOrder(roundId)).filter(([name]) => name === 'Tooling').length).toBe(2);

    // A rename onto an existing name warns the same way, and still writes.
    const renamed = await changeCategory(
      app,
      conferenceId,
      sessionId,
      roundId,
      (
        await client.query<{ id: string }>(
          "select id from category where round_id = $1 and name <> 'Tooling' order by position limit 1",
          [roundId],
        )
      ).rows[0]!.id,
      { name: '  tooling  ' },
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().warning).toMatch(/already has that name/i);
    // Trimmed on the way in, exactly as a post-it's text is.
    expect(renamed.json().category.name).toBe('tooling');
  });

  // ---------- Acceptance Scenario S09: one cursor, and a Vote still moves nothing (TI01, TI09) ----

  it('advances the one activity cursor on each of the four category writes, and on no vote', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const pollId = await addRound(app, conferenceId, sessionId, POLL);
    expect((await transition(app, conferenceId, sessionId, pollId, 'open')).statusCode).toBe(200);

    // Read by a plain Member, which is who the poll loop is gated on.
    const seen: string[] = [await watermark(app, conferenceId, sessionId, ADA)];

    const categoryId = await created(app, conferenceId, sessionId, roundId, 'Tooling');
    seen.push(await watermark(app, conferenceId, sessionId, ADA));

    expect(
      (await changeCategory(app, conferenceId, sessionId, roundId, categoryId, { name: 'Tools' }))
        .statusCode,
    ).toBe(200);
    seen.push(await watermark(app, conferenceId, sessionId, ADA));

    await created(app, conferenceId, sessionId, roundId, 'Process');
    const beforeReorder = await watermark(app, conferenceId, sessionId, ADA);
    expect(
      (await changeCategory(app, conferenceId, sessionId, roundId, categoryId, { position: 2 }))
        .statusCode,
    ).toBe(200);
    const afterReorder = await watermark(app, conferenceId, sessionId, ADA);

    expect(
      (await removeCategory(app, conferenceId, sessionId, roundId, categoryId)).statusCode,
    ).toBe(200);
    const afterRemove = await watermark(app, conferenceId, sessionId, ADA);

    // Each of the four moved it, and the value is only ever compared for difference.
    expect(new Set(seen).size).toBe(seen.length);
    expect(beforeReorder).not.toBe(afterReorder);
    expect(afterReorder).not.toBe(afterRemove);

    // And the poller's next Session read shows the change, which is what a participant sees.
    const board = await boardOf(app, conferenceId, sessionId, ADA);
    expect(board.categories!.map((category) => category.name)).toEqual(['Process']);

    /*
     * A Vote advances it by nothing (ADR-007). The Membership-gated poll is held open by every
     * Attendee in the room, and a cursor that moved on a ballot would be a vote-arrival oracle for
     * somebody the running tally is deliberately withheld from.
     */
    const optionId = (
      await client.query<{ id: string }>(
        'select id from round_option where round_id = $1 order by position limit 1',
        [pollId],
      )
    ).rows[0]!.id;
    const beforeVote = await watermark(app, conferenceId, sessionId, ADA);
    const cast = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${pollId}/votes`,
      headers: as(BO),
      payload: { optionId },
    });
    expect(cast.statusCode, cast.body).toBe(200);
    expect(await watermark(app, conferenceId, sessionId, ADA)).toBe(beforeVote);
  });

  // ---------- TI04: one read per Board, whatever it holds ----------------------------------------

  /**
   * The statement count across a **whole request** does not grow with the number of Categories or
   * of Post-its.
   *
   * Counted at the `Database` seam rather than at a repository, so a handler that looped per
   * Category anywhere in the request - not only in the read seam - would be caught. Two Sessions
   * are read through the same recording database: one bare, one carrying three Categories and eight
   * Post-its, and the two counts must be identical.
   */
  it('answers a session and everything on its boards in the same number of statements', async () => {
    const counted: string[] = [];
    const recording: Database = {
      async query(text, values) {
        counted.push(text);
        return db.query(text, values);
      },
      async transaction(work) {
        return db.transaction(async (tx: Queryable) => {
          const recorded: Queryable = {
            async query(text, values) {
              counted.push(text);
              return tx.query(text, values);
            },
          };
          return work(recorded);
        });
      },
      async close() {},
    };

    const app = appWith(recording);
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    counted.length = 0;
    await readSession(app, conferenceId, sessionId, IDA);
    const bare = counted.length;

    const first = await created(app, conferenceId, sessionId, roundId, 'Tooling');
    const second = await created(app, conferenceId, sessionId, roundId, 'Process');
    await created(app, conferenceId, sessionId, roundId, 'People');
    for (const text of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const id = await contributed(app, conferenceId, sessionId, roundId, ADA, text);
      await client.query('update post_it set category_id = $2 where id = $1', [
        id,
        text < 'e' ? first : second,
      ]);
    }

    counted.length = 0;
    const loaded = await readSession(app, conferenceId, sessionId, IDA);
    const full = counted.length;

    expect(loaded.rounds[0]!.categories!.length).toBe(3);
    expect(full).toBe(bare);
  });

  /**
   * A Post-it whose Category is gone by the time the Categories are read still appears - in
   * **Uncategorised**, never nowhere (Discovered Requirement).
   *
   * The Session read takes the Post-its and the Categories as two statements with no transaction
   * between them, so a removal landing in between leaves the Post-it snapshot naming a row the
   * Category snapshot no longer has. Driven deterministically here: the recording database performs
   * the removal, on a separate connection, at the moment the Post-it read completes and before the
   * Category read runs.
   *
   * Grouped strictly by id, the Post-it would be in neither bucket and would vanish from the
   * payload for one read - which is exactly the invariant `prd.md#fr2-the-uncategorised-holding-area`
   * forbids: a non-discarded Post-it is in exactly one Category or in Uncategorised, never neither.
   */
  it('renders a post-it in uncategorised when its category is removed mid-read', async () => {
    const plain = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(plain);
    const roundId = await openPostItRound(plain, conferenceId, sessionId);
    const tooling = await created(plain, conferenceId, sessionId, roundId, 'Tooling');
    const id = await contributed(plain, conferenceId, sessionId, roundId, ADA, 'Slow build');
    await client.query('update post_it set category_id = $2 where id = $1', [id, tooling]);

    /*
     * The two reads go out together inside one `Promise.all`, so the interleaving is forced rather
     * than hoped for: the Category read waits until the Post-it read has answered, the removal is
     * then driven on a separate connection, and only then does the Category read run. What comes
     * back is a Post-it snapshot from before the removal beside a Category snapshot from after it -
     * which is exactly the state a real removal landing between them produces.
     */
    let removed = false;
    let postItsRead: () => void = () => {};
    const postItsAnswered = new Promise<void>((resolve) => {
      postItsRead = resolve;
    });

    const racing: Database = {
      async query(text, values) {
        if (/from post_it p/.test(text) && /join app_user/.test(text)) {
          const rows = await db.query(text, values);
          postItsRead();
          return rows;
        }
        if (/from category c/.test(text) && /join round r/.test(text)) {
          await postItsAnswered;
          if (!removed) {
            removed = true;
            await client.query('update post_it set category_id = null where category_id = $1', [
              tooling,
            ]);
            await client.query('delete from category where id = $1', [tooling]);
          }
          return db.query(text, values);
        }
        return db.query(text, values);
      },
      async transaction(work) {
        return db.transaction(work);
      },
      async close() {},
    };

    const round = await boardOf(appWith(racing), conferenceId, sessionId);
    expect(removed, 'the removal should have been driven between the two reads').toBe(true);

    // The category is gone from the read, and its post-it is in Uncategorised rather than nowhere.
    expect(round.categories).toEqual([]);
    expect(round.uncategorised!.postItCount).toBe(1);
    expect(round.uncategorised!.postIts[0]!.text).toBe('Slow build');
  });

  // ---------- TI01: the constraints, and the migration's own reversibility -----------------------

  it('refuses a category on a poll, and a placement into another round’s category', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const pollId = await addRound(app, conferenceId, sessionId, POLL);
    const otherRound = await openPostItRound(app, conferenceId, sessionId);

    // Through the route: the kind comparison lives in the insert's own source predicate, so a Poll
    // reads as "no such round here" rather than as an internal error from the foreign key.
    const onAPoll = await createCategory(app, conferenceId, sessionId, pollId, { name: 'Nope' });
    expect(onAPoll.statusCode).toBe(404);
    expect(onAPoll.json().error.code).toBe('ROUND_NOT_FOUND');

    // And through the table: the composite foreign key is the guarantee behind that predicate.
    await expect(
      client.query(
        'insert into category (round_id, conference_id, name, position) values ($1, $2, $3, 1)',
        [pollId, conferenceId, 'Nope'],
      ),
    ).rejects.toThrow(/category_round_in_conference/i);

    const here = await created(app, conferenceId, sessionId, roundId, 'Tooling');
    const stray = await contributed(app, conferenceId, sessionId, otherRound, ADA, 'Elsewhere');
    await expect(
      client.query('update post_it set category_id = $2 where id = $1', [stray, here]),
    ).rejects.toThrow(/post_it_placed_on_its_own_round/i);
  });

  /**
   * A Post-it placed into a Category **between the count and the delete** is answered with the
   * counted sentence, not with "that category is gone".
   *
   * The guard that produces this lives in the DELETE's own predicate, so there is no window after
   * it. Driven deterministically: the recording database places a Post-it, on a separate
   * connection, at the moment the removal's occupancy count answers - the request has already
   * decided the Category was empty by then.
   */
  it('refuses a removal whose category acquired a post-it mid-transaction, naming the count', async () => {
    const plain = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(plain);
    const roundId = await openPostItRound(plain, conferenceId, sessionId);
    const tooling = await created(plain, conferenceId, sessionId, roundId, 'Tooling');
    const id = await contributed(plain, conferenceId, sessionId, roundId, ADA, 'Slow build');

    let placed = false;
    const racing: Database = {
      async query(text, values) {
        return db.query(text, values);
      },
      async transaction(work) {
        return db.transaction(async (tx: Queryable) =>
          work({
            async query(text, values) {
              const rows = await tx.query(text, values);
              if (!placed && /count\(\*\)::int as held from post_it/.test(text)) {
                placed = true;
                await client.query('update post_it set category_id = $2 where id = $1', [
                  id,
                  tooling,
                ]);
              }
              return rows;
            },
          }),
        );
      },
      async close() {},
    };

    const refused = await removeCategory(
      appWith(racing),
      conferenceId,
      sessionId,
      roundId,
      tooling,
    );
    expect(placed, 'the placement should have been driven mid-transaction').toBe(true);

    // The counted sentence, and 409 - never a 404 about a category that is sitting right there.
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('CATEGORY_HOLDS_POST_ITS');
    expect(refused.json().error.message).toMatch(/This category holds 1 post-it/);

    // And nothing was written: the category is still stored, still holding its post-it.
    expect(await storedOrder(roundId)).toEqual([['Tooling', 1]]);
    expect(await storedPlacements(roundId)).toEqual([tooling]);
  });

  it('refuses to delete a category that still holds a post-it, through any path', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
    const id = await contributed(app, conferenceId, sessionId, roundId, ADA, 'Slow build');
    await client.query('update post_it set category_id = $2 where id = $1', [id, tooling]);

    // Not a rule a handler remembers: the `NO ACTION` foreign key refuses it in the database.
    await expect(client.query('delete from category where id = $1', [tooling])).rejects.toThrow(
      /post_it_placed_on_its_own_round/i,
    );
  });

  it('takes categories and placed post-its with the round, the session and the conference', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
    const id = await contributed(app, conferenceId, sessionId, roundId, ADA, 'Slow build');
    await client.query('update post_it set category_id = $2 where id = $1', [id, tooling]);

    /*
     * One statement deletes the Round, which cascades to `post_it` and to `category` together. This
     * is why the placement foreign key is `NO ACTION` and not `RESTRICT`: `RESTRICT` fires
     * immediately and would break Round - and so Session and Conference - deletion outright.
     */
    await client.query('delete from round where id = $1', [roundId]);
    const { rows } = await client.query<{ categories: number; post_its: number }>(
      `select (select count(*)::int from category where round_id = $1) as categories,
              (select count(*)::int from post_it where round_id = $1) as post_its`,
      [roundId],
    );
    expect(rows[0]).toEqual({ categories: 0, post_its: 0 });
  });

  it('deletes a session that holds only categories, and refuses one that holds post-its', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    await created(app, conferenceId, sessionId, roundId, 'Tooling');

    // A second Session, so the published Conference is not left without a schedule.
    const spare = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions`,
      headers: as(PRIYA),
      payload: { ...WAYS_OF_WORKING, title: 'Spare', startTime: '15:30', endTime: '16:00' },
    });
    expect(spare.statusCode, spare.body).toBe(200);

    /*
     * A Category is not a contribution. S05's deletion guard counts `post_it` and `vote` rows, and
     * this story adds no third thing for it to count - a Session whose Board was named but never
     * written to stays deletable. The precondition pair is S09's optimistic-concurrency base and is
     * carried here exactly as the shipped delete surface carries it.
     */
    const base = await client.query<{ version: string; state: string }>(
      `select to_char(s.last_updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as version,
              c.lifecycle_state as state
         from sessions s join conference c on c.id = s.conference_id
        where s.id = $1`,
      [sessionId],
    );
    const deleted = await app.inject({
      method: 'DELETE',
      url:
        `/api/conferences/${conferenceId}/sessions/${sessionId}` +
        `?conferenceState=${base.rows[0]!.state}&version=${encodeURIComponent(base.rows[0]!.version)}`,
      headers: as(PRIYA),
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const { rows } = await client.query<{ held: number }>(
      'select count(*)::int as held from category where round_id = $1',
      [roundId],
    );
    expect(rows[0]!.held).toBe(0);
  });

  it('leaves the shipped author contribute, correct and remove paths working with a placement', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
    const id = await contributed(app, conferenceId, sessionId, roundId, ADA, 'Slow build');
    await client.query('update post_it set category_id = $2 where id = $1', [id, tooling]);

    const corrected = await app.inject({
      method: 'PATCH',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/post-its/${id}`,
      headers: as(ADA),
      payload: { text: 'The build is slow' },
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    // Correcting the text does not move it out of the category it was sorted into.
    expect(await storedPlacements(roundId)).toEqual([tooling]);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/post-its/${id}`,
      headers: as(ADA),
    });
    expect(removed.statusCode, removed.body).toBe(200);

    /*
     * The row goes and leaves **no trace at all** - the category it was in is still there and holds
     * nothing, and there is no tombstone anywhere to say a post-it was ever in it.
     */
    expect(await storedPlacements(roundId)).toEqual([]);
    expect(await storedOrder(roundId)).toEqual([['Tooling', 1]]);
    const board = await boardOf(app, conferenceId, sessionId);
    expect(board.categories![0]!.postItCount).toBe(0);
  });

  it('applies and rolls back cleanly, taking the table, the column and its trigger with it', async () => {
    const present = async (): Promise<{
      table: boolean;
      column: boolean;
      trigger: boolean;
    }> => {
      const { rows } = await client.query<{ table: boolean; column: boolean; trigger: boolean }>(
        `select
           exists (select 1 from information_schema.tables where table_name = 'category') as "table",
           exists (select 1 from information_schema.columns
                    where table_name = 'post_it' and column_name = 'category_id') as "column",
           exists (select 1 from pg_trigger
                    where tgname = 'category_advances_activity_watermark') as "trigger"`,
      );
      return rows[0]!;
    };

    expect(await present()).toEqual({ table: true, column: true, trigger: true });

    const steps = await stepsToRevertThrough(client, '20260902090000000_category-and-placement');
    await migrate('down', String(steps));
    try {
      expect(await present()).toEqual({ table: false, column: false, trigger: false });

      // The shipped schema is intact underneath: `post_it` and the one advancing function are both
      // still here, so this migration took only what it added.
      const { rows } = await client.query<{ post_it: boolean; advance: boolean }>(
        `select
           exists (select 1 from information_schema.tables where table_name = 'post_it') as post_it,
           exists (select 1 from pg_proc
                    where proname = 'advance_round_activity_watermark') as advance`,
      );
      expect(rows[0]).toEqual({ post_it: true, advance: true });
    } finally {
      await migrate('up');
    }

    expect(await present()).toEqual({ table: true, column: true, trigger: true });
  });

  it('states the name cap as exactly the exported constant, at the boundary', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const insert = (name: string) =>
      client.query(
        'insert into category (round_id, conference_id, name, position) values ($1, $2, $3, 1)',
        [roundId, conferenceId, name],
      );

    await expect(insert('   ')).rejects.toThrow(/category_name_present/i);
    // The CHECK's boundary is the exported constant's, and both sides are read from it here, so a
    // change to either alone fails this test.
    await expect(insert('z'.repeat(CATEGORY_NAME_MAX_LENGTH + 1))).rejects.toThrow(
      /category_name_present/i,
    );
    await expect(insert('z'.repeat(CATEGORY_NAME_MAX_LENGTH))).resolves.toBeDefined();
  });
});
