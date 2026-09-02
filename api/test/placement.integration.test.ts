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
import { fixedClock } from '../src/conferences/calendar-date.ts';
import { tokenFor, unusedCodeExchange } from './fake-auth.ts';
import type { Verifier } from '../src/auth/verify-id-token.ts';

/**
 * Placing Post-its into Categories, against the real PostgreSQL the composed stack runs (S03).
 *
 * Every rule proved here is a storage-level guarantee, an authority decision or a propagation
 * property, and **none of them is provable against a fake that answers whatever the test wants**:
 * the composite foreign key that makes a cross-Board destination unwritable, the predicate that
 * lets a repeat placement match its own row, the trigger that carries a placement to every open
 * Board through the one activity cursor, and the two real writers that make "last write wins per
 * Post-it" a claim about concurrency rather than about call order.
 *
 * Three disciplines run through the whole file, inherited from `category.integration.test.ts`:
 *
 *   - **A refusal is asserted against the stored rows**, never against the response envelope alone.
 *     A route that returns a refusal and writes anyway passes a response-only test.
 *   - **Nothing here asserts that a request was issued.** Propagation is proved by what the *next*
 *     read returns, which is what a participant actually sees.
 *   - **Placements are read from the table as well as from the payload**, so a route that returned
 *     the right grouping over the wrong rows fails.
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
    '\n[integration] SKIPPED placing post-its into categories – no PostgreSQL at ' +
      'TEST_DATABASE_URL.\n[integration] Start the stack first: docker compose up -d\n',
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

const RETRO = {
  title: 'Delivery Retro',
  kind: 'Workshop',
  day: '2026-09-16',
  startTime: '09:00',
  endTime: '10:00',
  location: 'Room 5',
};

const POST_IT_ROUND = { kind: 'PostItRound', prompt: 'What slowed us down this quarter?' };

const WAITING = 'Waiting three days for test data';

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
}

interface WireSession {
  rounds: WireRound[];
  canRun: boolean;
  activityWatermark: string | null;
}

describe.skipIf(!reachable)('placing post-its into categories against a real PostgreSQL', () => {
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

  async function addSession(
    app: FastifyInstance,
    conferenceId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const session = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions`,
      headers: as(PRIYA),
      payload,
    });
    expect(session.statusCode, session.body).toBe(200);
    return session.json().session.id as string;
  }

  /**
   * "Autumn Offsite", published, with two workshops.
   *
   * Ida and Dev both facilitate the first one - two holders of the same Session Assignment is what
   * the concurrency scenario needs. Priya created the Conference and so holds conference-wide
   * **Admin** and no Session Assignment. Ada and Bo are Members with no Role Assignment at all, and
   * Ada is the one whose refusal the authority scenario asserts.
   *
   * The second Session carries a Board of its own, which is where the cross-Board destination the
   * API must refuse comes from.
   */
  async function autumnOffsite(app: FastifyInstance): Promise<{
    conferenceId: string;
    sessionId: string;
    otherSessionId: string;
  }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conferences',
      headers: as(PRIYA),
      payload: AUTUMN,
    });
    expect(created.statusCode, created.body).toBe(200);
    const conferenceId = created.json().id as string;

    const sessionId = await addSession(app, conferenceId, WAYS_OF_WORKING);
    const otherSessionId = await addSession(app, conferenceId, RETRO);

    for (const sub of [IDA, DEV, ADA, BO]) await addMember(conferenceId, sub);

    for (const sub of [IDA, DEV]) {
      const granted = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/members/roles`,
        headers: as(PRIYA),
        payload: { email: `${sub}@ourcompany.example`, role: 'PresenterFacilitator' },
      });
      expect(granted.statusCode, granted.body).toBe(200);

      for (const target of [sessionId, otherSessionId]) {
        const assigned = await app.inject({
          method: 'POST',
          url: `/api/conferences/${conferenceId}/sessions/${target}/assignments`,
          headers: as(PRIYA),
          payload: { userSub: sub },
        });
        expect(assigned.statusCode, assigned.body).toBe(200);
      }
    }

    const published = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/publish`,
      headers: as(PRIYA),
    });
    expect(published.statusCode, published.body).toBe(200);

    return { conferenceId, sessionId, otherSessionId };
  }

  async function addRound(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    payload: Record<string, unknown> = POST_IT_ROUND,
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
    const roundId = await addRound(app, conferenceId, sessionId);
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

  /** The placement endpoint, called exactly as the SPA calls it. */
  function place(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    body: Record<string, unknown>,
    sub = IDA,
  ) {
    return app.inject({
      method: 'PATCH',
      url:
        `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}` +
        `/post-its/${postItId}/placement`,
      headers: as(sub),
      payload: body,
    });
  }

  async function placed(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    postItId: string,
    categoryId: string | null,
    sub = IDA,
  ): Promise<void> {
    const response = await place(
      app,
      conferenceId,
      sessionId,
      roundId,
      postItId,
      { categoryId },
      sub,
    );
    expect(response.statusCode, response.body).toBe(200);
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

  /** Where every Post-it on a Round sits, read straight from the table – never from a response. */
  async function storedPlacements(roundId: string): Promise<[string, string | null][]> {
    const { rows } = await client.query<{ text: string; category_id: string | null }>(
      'select text, category_id from post_it where round_id = $1 order by created_at, id',
      [roundId],
    );
    return rows.map((row) => [row.text, row.category_id]);
  }

  async function storedPlacement(postItId: string): Promise<string | null> {
    const { rows } = await client.query<{ category_id: string | null }>(
      'select category_id from post_it where id = $1',
      [postItId],
    );
    return rows[0]?.category_id ?? null;
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

  /** The counts a Board reports, as `[name, count]` pairs plus Uncategorised's own. */
  function counts(round: WireRound): { regions: [string, number][]; uncategorised: number } {
    return {
      regions: round.categories!.map((category) => [category.name, category.postItCount]),
      uncategorised: round.uncategorised!.postItCount,
    };
  }

  // ---------- Acceptance Scenario S01: out of Uncategorised, into a Category (TI01, TI02) -------

  it('places a post-it from uncategorised into a category, and both counts follow', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const handovers = await created(app, conferenceId, sessionId, roundId, 'Handovers');
    await created(app, conferenceId, sessionId, roundId, 'Tooling');
    const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, WAITING);

    const before = await boardOf(app, conferenceId, sessionId);
    expect(counts(before)).toEqual({
      regions: [
        ['Handovers', 0],
        ['Tooling', 0],
      ],
      uncategorised: 1,
    });

    const response = await place(app, conferenceId, sessionId, roundId, postItId, {
      categoryId: handovers,
    });
    expect(response.statusCode, response.body).toBe(200);
    // The Post-it comes back on the same wire shape every other read uses - author name included,
    // author `sub` never.
    expect(response.json().postIt.text).toBe(WAITING);
    expect(response.json().postIt.authorName).toBe('Ada Lovelace');
    expect(response.json().postIt).not.toHaveProperty('authorSub');

    const after = await boardOf(app, conferenceId, sessionId);
    expect(counts(after)).toEqual({
      regions: [
        ['Handovers', 1],
        ['Tooling', 0],
      ],
      uncategorised: 0,
    });
    expect(after.categories![0]!.postIts.map((item) => item.text)).toEqual([WAITING]);
    // And the stored row agrees, so a route that grouped the payload without writing would fail.
    expect(await storedPlacements(roundId)).toEqual([[WAITING, handovers]]);
  });

  // ---------- Acceptance Scenario S02: on to a second Category, and back (TI01, TI03) -----------

  it('moves a post-it between categories and back to uncategorised, counting right each time', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const handovers = await created(app, conferenceId, sessionId, roundId, 'Handovers');
    const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
    const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, WAITING);

    for (const [destination, expected] of [
      [handovers, { regions: [1, 0], uncategorised: 0 }],
      [tooling, { regions: [0, 1], uncategorised: 0 }],
      [null, { regions: [0, 0], uncategorised: 1 }],
    ] as [string | null, { regions: number[]; uncategorised: number }][]) {
      await placed(app, conferenceId, sessionId, roundId, postItId, destination);

      const round = await boardOf(app, conferenceId, sessionId);
      expect(counts(round).regions.map(([, count]) => count)).toEqual(expected.regions);
      expect(counts(round).uncategorised).toBe(expected.uncategorised);

      // Exactly one place, every time: the payload cannot show it twice and cannot lose it.
      const drawn = round.categories!.flatMap((category) => category.postIts).length;
      expect(drawn + round.uncategorised!.postIts.length).toBe(1);
      expect(await storedPlacement(postItId)).toBe(destination);
    }
  });

  /**
   * Each move is answered from **one Board read**, not one request per Category or per Post-it.
   *
   * Counted across a whole request at the `Database` seam, because the property is about a request
   * rather than about a file: a one-statement repository call says nothing about a handler looping
   * per Category (`docs/LEARNINGS.md#testing`).
   */
  it('answers the board after a placement in the same number of statements, whatever it holds', async () => {
    const counted: string[] = [];
    const recording: Database = {
      async query(text, values) {
        counted.push(text);
        return db.query(text, values);
      },
      async transaction(work) {
        return db.transaction(async (tx: Queryable) =>
          work({
            async query(text, values) {
              counted.push(text);
              return tx.query(text, values);
            },
          }),
        );
      },
      async close() {},
    };

    const app = appWith(recording);
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    counted.length = 0;
    await readSession(app, conferenceId, sessionId, IDA);
    const bare = counted.length;

    const destinations: string[] = [];
    for (const name of ['Handovers', 'Tooling', 'Meetings', 'Staging']) {
      destinations.push(await created(app, conferenceId, sessionId, roundId, name));
    }
    for (const [index, text] of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].entries()) {
      const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, text);
      await placed(
        app,
        conferenceId,
        sessionId,
        roundId,
        postItId,
        destinations[index % destinations.length]!,
      );
    }

    counted.length = 0;
    const loaded = await readSession(app, conferenceId, sessionId, IDA);

    expect(loaded.rounds[0]!.categories!.length).toBe(4);
    expect(counted.length).toBe(bare);
  });

  // ---------- Acceptance Scenario S03: it reaches everybody else's board (TI03) -----------------

  /**
   * A placement moves the Session's one activity cursor, which is what every other open Board is
   * comparing against - there is no second cursor and no cadence of this story's own.
   *
   * Asserted from a **second reader's** Session read rather than from the writer's response: what
   * Bo sees is the product's claim, and a route that answered correctly to its own caller while
   * leaving the cursor still would pass a writer-only test.
   */
  it('advances the session’s activity cursor and shows the move on another member’s read', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const handovers = await created(app, conferenceId, sessionId, roundId, 'Handovers');
    const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, WAITING);

    const before = await watermark(app, conferenceId, sessionId, BO);
    const bosBoardBefore = await boardOf(app, conferenceId, sessionId, BO);
    expect(bosBoardBefore.uncategorised!.postItCount).toBe(1);

    await placed(app, conferenceId, sessionId, roundId, postItId, handovers);

    expect(await watermark(app, conferenceId, sessionId, BO)).not.toBe(before);

    const bosBoard = await boardOf(app, conferenceId, sessionId, BO);
    expect(bosBoard.categories![0]!.postIts.map((item) => item.text)).toEqual([WAITING]);
    expect(counts(bosBoard)).toEqual({ regions: [['Handovers', 1]], uncategorised: 0 });
  });

  // ---------- Acceptance Scenario S04: open, closed, reopened (TI01, TI02) ----------------------

  it('places while the round is open, after it closes, and leaves everything through a reopen', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);

    const handovers = await created(app, conferenceId, sessionId, roundId, 'Handovers');
    const ids: string[] = [];
    for (const text of ['One', 'Two', 'Three', 'Four']) {
      ids.push(await contributed(app, conferenceId, sessionId, roundId, ADA, text));
    }
    // Two placed before anything else happens, so the reopen has something to leave alone.
    for (const id of ids.slice(0, 2)) {
      await placed(app, conferenceId, sessionId, roundId, id, handovers);
    }

    // A third while the Round is still open, and then a fourth once it has ended.
    await placed(app, conferenceId, sessionId, roundId, ids[2]!, handovers);
    expect((await transition(app, conferenceId, sessionId, roundId, 'close')).statusCode).toBe(200);
    await placed(app, conferenceId, sessionId, roundId, ids[3]!, handovers);

    const closed = await boardOf(app, conferenceId, sessionId);
    expect(closed.state).toBe('closed');
    expect(counts(closed)).toEqual({ regions: [['Handovers', 4]], uncategorised: 0 });

    // Reopened: the Categories and every placement survive untouched.
    expect((await transition(app, conferenceId, sessionId, roundId, 'open')).statusCode).toBe(200);
    const reopened = await boardOf(app, conferenceId, sessionId);
    expect(reopened.state).toBe('open');
    expect(counts(reopened)).toEqual({ regions: [['Handovers', 4]], uncategorised: 0 });

    // And a Post-it contributed after the reopen arrives in Uncategorised - never auto-placed.
    await contributed(app, conferenceId, sessionId, roundId, BO, 'Five');
    const after = await boardOf(app, conferenceId, sessionId);
    expect(counts(after)).toEqual({ regions: [['Handovers', 4]], uncategorised: 1 });
    expect(after.uncategorised!.postIts.map((item) => item.text)).toEqual(['Five']);
  });

  // ---------- Acceptance Scenario S05: the three refusals, each writing nothing (TI01, TI02) ----

  it('refuses a caller with no sorting authority, a cross-board destination and an archived write', async () => {
    const app = appWith();
    const { conferenceId, sessionId, otherSessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const handovers = await created(app, conferenceId, sessionId, roundId, 'Handovers');
    const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, WAITING);

    // A second Board, on another Session, with a Category of its own.
    const otherRoundId = await openPostItRound(app, conferenceId, otherSessionId);
    const elsewhere = await created(app, conferenceId, otherSessionId, otherRoundId, 'Elsewhere');

    const untouched = await boardOf(app, conferenceId, sessionId);

    /*
     * Ada is a Conference Member with no Session Assignment on this Session and no conference-wide
     * Admin. She is refused by the sorting-authority gate before anything about the Board is
     * consulted, so she learns nothing further.
     */
    const noAuthority = await place(
      app,
      conferenceId,
      sessionId,
      roundId,
      postItId,
      { categoryId: handovers },
      ADA,
    );
    expect(noAuthority.statusCode, noAuthority.body).toBe(403);
    expect(noAuthority.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');

    /*
     * A destination on another Board, named by somebody who does hold the authority.
     *
     * **This asserts the refusal, not the mechanism behind it**, and the distinction is worth
     * stating: the predicate and the composite foreign key `post_it_placed_on_its_own_round` both
     * refuse this, and removing either leaves the other answering identically. That the condition
     * lives in the *statement's own predicate* - rather than in a read taken first, which two
     * replicas would each pass - is pinned in `placement-structure.test.ts`, exactly as S02 pinned
     * its renumber mechanism.
     */
    const crossBoard = await place(app, conferenceId, sessionId, roundId, postItId, {
      categoryId: elsewhere,
    });
    expect(crossBoard.statusCode, crossBoard.body).toBe(404);
    expect(crossBoard.json().error.code).toBe('CATEGORY_NOT_FOUND');
    // The sentence says the Board changed rather than reporting a bare failure, and carries no
    // count and nothing about the Board the destination actually belongs to.
    expect(crossBoard.json().error.message).toMatch(/not on this board/i);
    expect(crossBoard.json().error.message).not.toMatch(/Elsewhere|Delivery Retro|\d/);

    /*
     * A Post-it that is not on this Board is its own sentence, not the destination's.
     *
     * The id has to be a **real Post-it living on the other Board**, not an unknown uuid: an
     * unknown one is refused by any predicate at all, so it would prove nothing about scoping. A
     * predicate that dropped `r.session_id` would still answer this one correctly only if the row
     * it finds is genuinely somebody else's Board.
     */
    const strayId = await contributed(
      app,
      conferenceId,
      otherSessionId,
      otherRoundId,
      ADA,
      WAITING,
    );
    const strayPostIt = await place(app, conferenceId, sessionId, roundId, strayId, {
      categoryId: handovers,
    });
    expect(strayPostIt.statusCode, strayPostIt.body).toBe(404);
    expect(strayPostIt.json().error.code).toBe('POST_IT_NOT_FOUND');

    /*
     * A body claiming to be somebody else is **accepted and ignored**, which is the stronger
     * statement than refusing it: a route that refuses an actor field and a route that trusts one
     * both pass "does not accept a body with an actor in it", and only one of them is correct. Ada
     * is refused whatever she claims, and Ida's write is not attributed to whoever the body names.
     */
    const impersonating = await place(
      app,
      conferenceId,
      sessionId,
      roundId,
      postItId,
      { categoryId: handovers, actorSub: IDA, facilitatorSub: IDA, email: `${IDA}@x.example` },
      ADA,
    );
    expect(impersonating.statusCode, impersonating.body).toBe(403);
    expect(impersonating.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');

    // Nothing has been written by any of the four.
    expect(await storedPlacements(roundId)).toEqual([[WAITING, null]]);
    expect(await boardOf(app, conferenceId, sessionId)).toEqual(untouched);

    // And the archived Conference refuses the same write, with the one archived sentence.
    await archive(conferenceId);
    const archived = await place(app, conferenceId, sessionId, roundId, postItId, {
      categoryId: handovers,
    });
    expect(archived.statusCode, archived.body).toBe(409);
    expect(archived.json().error.code).toBe('CONFERENCE_NOT_EDITABLE');
    expect(archived.json().error.message).toBe(
      'This conference has been archived, so it is read-only and can no longer be changed.',
    );
    expect(await storedPlacements(roundId)).toEqual([[WAITING, null]]);
  });

  /**
   * A body carrying an actor field is ignored on the **successful** path too.
   *
   * The refusal above proves the decision is the credential's; this proves the write is. A
   * placement carries no actor to a column, so what is asserted is that the same request written by
   * Ida lands identically whatever the body claims about who is acting.
   */
  it('attributes and decides a successful placement by the credential, never by the body', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const handovers = await created(app, conferenceId, sessionId, roundId, 'Handovers');
    const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, WAITING);

    const response = await place(app, conferenceId, sessionId, roundId, postItId, {
      categoryId: handovers,
      actorSub: ADA,
      email: `${ADA}@ourcompany.example`,
    });
    expect(response.statusCode, response.body).toBe(200);
    // The Post-it is still Ada's - a placement changes where an idea sits, never whose it is.
    expect(response.json().postIt.authorName).toBe('Ada Lovelace');
    expect(await storedPlacement(postItId)).toBe(handovers);

    const { rows } = await client.query<{ author_sub: string }>(
      'select author_sub from post_it where id = $1',
      [postItId],
    );
    expect(rows[0]!.author_sub).toBe(ADA);
  });

  // ---------- Acceptance Scenario S06: the requested end state is the one that holds (TI01) -----

  it('succeeds silently when a post-it is placed where it already is', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const handovers = await created(app, conferenceId, sessionId, roundId, 'Handovers');
    const tooling = await created(app, conferenceId, sessionId, roundId, 'Tooling');
    const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, WAITING);

    await placed(app, conferenceId, sessionId, roundId, postItId, handovers);
    const settled = await boardOf(app, conferenceId, sessionId);

    // Again, to the same place. A predicate conditioned on "currently somewhere else" would match
    // no row here and be indistinguishable from "the post-it is gone".
    const repeat = await place(app, conferenceId, sessionId, roundId, postItId, {
      categoryId: handovers,
    });
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(repeat.json().postIt.id).toBe(postItId);

    expect(await boardOf(app, conferenceId, sessionId)).toEqual(settled);
    expect(await storedPlacement(postItId)).toBe(handovers);
    void tooling;

    // And the same rule holds for Uncategorised, which is an absence rather than a destination row.
    await placed(app, conferenceId, sessionId, roundId, postItId, null);
    const back = await place(app, conferenceId, sessionId, roundId, postItId, {
      categoryId: null,
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(await storedPlacement(postItId)).toBeNull();
  });

  /**
   * Two Facilitators place the same Post-it at the same time.
   *
   * **Two real writers, not two sequential calls.** Sequential writes cannot distinguish last-write
   * -wins from any other policy, so Ida's placement is parked on its own statement through a gated
   * `Database` until Dev's has committed, and only then released. That is the only arrangement in
   * which "the last write is the one that holds" is a claim about concurrency.
   *
   * Both succeed. Neither is shown a conflict, a merge prompt or a "somebody else changed this"
   * interstitial - there is no such response on this route to be shown - and the Post-it ends in
   * exactly one Category.
   */
  it('lets two concurrent sorters both succeed, with the last write winning', async () => {
    const plain = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(plain);
    const roundId = await openPostItRound(plain, conferenceId, sessionId);
    const handovers = await created(plain, conferenceId, sessionId, roundId, 'Handovers');
    const tooling = await created(plain, conferenceId, sessionId, roundId, 'Tooling');
    const postItId = await contributed(plain, conferenceId, sessionId, roundId, ADA, WAITING);

    let release: () => void = () => {};
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parking = true;

    const gated: Database = {
      async query(text, values) {
        if (parking && /update post_it p/.test(text) && /set category_id/.test(text)) {
          parking = false;
          await parked;
        }
        return db.query(text, values);
      },
      async transaction(work) {
        return db.transaction(work);
      },
      async close() {},
    };

    // Started, deliberately not awaited: its write is held until Dev's has landed.
    const idas = place(
      appWith(gated),
      conferenceId,
      sessionId,
      roundId,
      postItId,
      { categoryId: handovers },
      IDA,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(parking, 'Ida’s placement should be parked on its write').toBe(false);

    const devs = await place(
      plain,
      conferenceId,
      sessionId,
      roundId,
      postItId,
      { categoryId: tooling },
      DEV,
    );
    expect(devs.statusCode, devs.body).toBe(200);
    expect(await storedPlacement(postItId)).toBe(tooling);

    release();
    const written = await idas;
    // Neither is a refusal, and neither carries a conflict for anybody to act on.
    expect(written.statusCode, written.body).toBe(200);
    expect(JSON.stringify(written.json())).not.toMatch(/conflict|changed by|somebody else/i);

    // Ida wrote last, so Ida's destination is the one that holds - and the Post-it is in exactly
    // one place.
    expect(await storedPlacement(postItId)).toBe(handovers);
    const settled = await boardOf(plain, conferenceId, sessionId);
    expect(counts(settled)).toEqual({
      regions: [
        ['Handovers', 1],
        ['Tooling', 0],
      ],
      uncategorised: 0,
    });

    // And each sees the other's result on the shared read, near-live: Dev's next read is Ida's
    // board, with no reload and nothing merged.
    const devsView = await boardOf(plain, conferenceId, sessionId, DEV);
    expect(devsView.categories![0]!.postIts.map((item) => item.text)).toEqual([WAITING]);
  });

  /**
   * A destination removed while the placement is in flight is answered as a destination that is not
   * there, not as an internal error.
   *
   * The predicate's own snapshot can still see a Category the foreign key no longer does - the FK
   * is checked at end of statement against committed state - so this is the one placement race the
   * statement cannot close, and it is caught rather than prevented. Driven deterministically: the
   * gated `Database` removes the Category on a separate connection at the moment the write is about
   * to run.
   */
  it('answers a destination removed mid-placement as a destination that is not on this board', async () => {
    const plain = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(plain);
    const roundId = await openPostItRound(plain, conferenceId, sessionId);
    const doomed = await created(plain, conferenceId, sessionId, roundId, 'Doomed');
    const postItId = await contributed(plain, conferenceId, sessionId, roundId, ADA, WAITING);

    let removed = false;
    const racing: Database = {
      async query(text, values) {
        if (!removed && /update post_it p/.test(text) && /set category_id/.test(text)) {
          removed = true;
          await client.query('delete from category where id = $1', [doomed]);
        }
        return db.query(text, values);
      },
      async transaction(work) {
        return db.transaction(work);
      },
      async close() {},
    };

    const response = await place(
      appWith(racing),
      conferenceId,
      sessionId,
      roundId,
      postItId,
      { categoryId: doomed },
      IDA,
    );
    expect(removed, 'the removal should have been driven before the write').toBe(true);
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().error.code).toBe('CATEGORY_NOT_FOUND');
    expect(await storedPlacement(postItId)).toBeNull();
  });

  // ---------- the author's own writes are untouched by any of this ------------------------------

  /**
   * Sorting neither reuses nor relaxes the author paths.
   *
   * A Facilitator may place anybody's Post-it and may not correct or remove it; its author may
   * correct and remove their own while the Round is open and may not place it. Both halves are
   * asserted here because the two routes now sit on adjacent addresses.
   */
  it('keeps the author’s membership gate and the facilitator’s sorting gate apart', async () => {
    const app = appWith();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const roundId = await openPostItRound(app, conferenceId, sessionId);
    const handovers = await created(app, conferenceId, sessionId, roundId, 'Handovers');
    const postItId = await contributed(app, conferenceId, sessionId, roundId, ADA, WAITING);

    const base =
      `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}` +
      `/post-its/${postItId}`;

    // Ida sorts Ada's post-it, and cannot change a word of it.
    await placed(app, conferenceId, sessionId, roundId, postItId, handovers);
    const edited = await app.inject({
      method: 'PATCH',
      url: base,
      headers: as(IDA),
      payload: { text: 'Rewritten by the facilitator' },
    });
    expect(edited.statusCode, edited.body).toBe(403);
    expect(edited.json().error.code).toBe('POST_IT_NOT_AUTHOR');

    // Ada corrects her own, from inside the Category it now sits in - the placement is untouched.
    const corrected = await app.inject({
      method: 'PATCH',
      url: base,
      headers: as(ADA),
      payload: { text: 'Waiting three days for test data, still' },
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(await storedPlacement(postItId)).toBe(handovers);

    // And Ada may not sort, however her own the post-it is.
    const sorting = await place(
      app,
      conferenceId,
      sessionId,
      roundId,
      postItId,
      { categoryId: null },
      ADA,
    );
    expect(sorting.statusCode, sorting.body).toBe(403);
    expect(sorting.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');
    expect(await storedPlacement(postItId)).toBe(handovers);

    // Her own removal still works and still leaves no trace.
    const removedByAuthor = await app.inject({
      method: 'DELETE',
      url: base,
      headers: as(ADA),
    });
    expect(removedByAuthor.statusCode, removedByAuthor.body).toBe(200);
    expect(await storedPlacements(roundId)).toEqual([]);
  });
});
