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
import { isCanonicalDisplayToken } from '../src/rounds/display-link.ts';
import { redactDisplayToken } from '../src/routes/display.ts';
import { tokenFor, unusedCodeExchange } from './fake-auth.ts';
import { stepsToRevertThrough } from './migration-depth.ts';
import type { Verifier } from '../src/auth/verify-id-token.ts';

/**
 * The Display Link, against the real PostgreSQL the composed stack runs (S04, FR7).
 *
 * This story's whole risk is that a property is *claimed* rather than held, so almost nothing here
 * is provable against a fake that answers whatever the test wants: the partial unique index that
 * makes "one live link per Round" unraceable, the composite foreign key that makes a link for a
 * Voting Round unwritable, the cascade that turns a deleted Round into an unknown token, the
 * `to_char`'d wall-clock `day` the time bound is judged against, and the anonymous route's actual
 * response bytes.
 *
 * Four disciplines run through the file:
 *
 *   - **Refusals are compared as whole responses** - status, headers and body together - and never
 *     field by field. The disclosure this story guards against is *any difference at all*, and a
 *     field-by-field test only covers the fields somebody thought of.
 *   - **A refusal is asserted against the stored rows** as well as the envelope. A route that
 *     refuses and writes anyway passes a response-only test.
 *   - **Nothing here asserts that a request was issued.** Revocation is proved by what the *next*
 *     anonymous read returns, which is what a room machine actually sees.
 *   - **The no-vote-data guard is behavioural here and structural in
 *     `display-link-structure.test.ts`**, over a Session that genuinely holds a Poll with cast
 *     ballots - because a file-list guard is only as good as its longest omission.
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
    '\n[integration] SKIPPED display links – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

const MIGRATION = '20260903090000000_display-link';

/** Priya organizes (and so is Admin); Ada facilitates; Bo is in the room. */
const PRIYA = 'google-sub-priya';
const ADA = 'google-sub-ada';
const BO = 'google-sub-bo';

const NAMES: Record<string, string> = {
  [PRIYA]: 'Priya Raman',
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
const SECOND_ROUND = { kind: 'PostItRound', prompt: 'What went unexpectedly well?' };
const POLL = { kind: 'VotingRound', purpose: 'Poll', prompt: 'Where do we start?' };

const WAITING = 'Waiting three days for test data';
const REVIEWS = 'Review queue backed up on Fridays';

interface WirePostIt {
  id: string;
  text: string;
  authorName: string;
  mine: boolean;
}

interface WireBoard {
  prompt: string;
  categories: { id: string; name: string; postIts: WirePostIt[]; postItCount: number }[];
  uncategorised: { postIts: WirePostIt[]; postItCount: number };
}

describe.skipIf(!reachable)('display links against a real PostgreSQL', () => {
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

  /** `today` is the linked Session's own day unless a scenario states otherwise. */
  function appWith(today = '2026-09-15', mint?: () => string): FastifyInstance {
    const app = buildApp({
      db,
      auth: {
        verifier: namedVerifier(),
        users: createUserRepository(db),
        codeExchange: unusedCodeExchange(),
      },
      clock: fixedClock(today),
      ...(mint ? { mintDisplayLinkToken: mint } : {}),
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

  function roundsUrl(conferenceId: string, sessionId: string): string {
    return `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds`;
  }

  async function addRound(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    payload: Record<string, unknown>,
  ): Promise<{ id: string; options?: { id: string; label: string }[] }> {
    const response = await app.inject({
      method: 'POST',
      url: roundsUrl(conferenceId, sessionId),
      headers: as(PRIYA),
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().round;
  }

  interface Fixture {
    conferenceId: string;
    sessionId: string;
    otherSessionId: string;
    roundId: string;
    siblingRoundId: string;
    otherSessionRoundId: string;
  }

  /**
   * "Autumn Offsite", published, with two workshops.
   *
   * Ada facilitates the first one; Priya created the Conference and so holds conference-wide
   * **Admin** and no Session Assignment; Bo is a Member with no Role Assignment at all, and is the
   * one whose refusal the authority scenario asserts.
   *
   * The linked Session also carries a **second** Post-it Round, and the other Session carries one
   * of its own - both exist so the scope assertion has something to fail against.
   */
  async function autumnOffsite(app: FastifyInstance, publish = true): Promise<Fixture> {
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

    for (const sub of [ADA, BO]) await addMember(conferenceId, sub);

    const granted = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/members/roles`,
      headers: as(PRIYA),
      payload: { email: `${ADA}@ourcompany.example`, role: 'PresenterFacilitator' },
    });
    expect(granted.statusCode, granted.body).toBe(200);

    const assigned = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/assignments`,
      headers: as(PRIYA),
      payload: { userSub: ADA },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);

    const round = await addRound(app, conferenceId, sessionId, POST_IT_ROUND);
    const sibling = await addRound(app, conferenceId, sessionId, SECOND_ROUND);
    const otherRound = await addRound(app, conferenceId, otherSessionId, POST_IT_ROUND);

    if (publish) {
      const published = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/publish`,
        headers: as(PRIYA),
      });
      expect(published.statusCode, published.body).toBe(200);
    }

    return {
      conferenceId,
      sessionId,
      otherSessionId,
      roundId: round.id,
      siblingRoundId: sibling.id,
      otherSessionRoundId: otherRound.id,
    };
  }

  function linkUrl(fixture: Fixture, roundId = fixture.roundId): string {
    return `${roundsUrl(fixture.conferenceId, fixture.sessionId)}/${roundId}/display-link`;
  }

  async function issue(app: FastifyInstance, fixture: Fixture, sub = ADA): Promise<string> {
    const response = await app.inject({ method: 'POST', url: linkUrl(fixture), headers: as(sub) });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().displayLink.token as string;
  }

  /** The whole anonymous request, with no `Authorization` header of any kind. */
  function open(app: FastifyInstance, token: string) {
    return app.inject({ method: 'GET', url: `/api/display/${token}` });
  }

  /** Status, code, message and every header, as one comparable value. */
  function refusalShape(response: Awaited<ReturnType<typeof open>>): unknown {
    const headers = { ...response.headers } as Record<string, unknown>;
    // Varies per response by nature and says nothing about the reason.
    delete headers.date;
    delete headers['content-length'];
    return { status: response.statusCode, headers, body: response.body };
  }

  async function contribute(
    app: FastifyInstance,
    fixture: Fixture,
    roundId: string,
    sub: string,
    text: string,
  ): Promise<string> {
    // Priya is conference-wide Admin, so she can open a Round on any Session here.
    const opened = await app.inject({
      method: 'POST',
      url: `${roundsUrl(fixture.conferenceId, fixture.sessionId)}/${roundId}/open`,
      headers: as(PRIYA),
    });
    expect([200, 409], opened.body).toContain(opened.statusCode);

    const response = await app.inject({
      method: 'POST',
      url: `${roundsUrl(fixture.conferenceId, fixture.sessionId)}/${roundId}/post-its`,
      headers: as(sub),
      payload: { text },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().postIt.id as string;
  }

  // ---------- TI01: the storage guarantees ----------

  describe('the table', () => {
    it('refuses two live links for one round, whatever the application does', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);
      const token = await issue(app, fixture);

      await expect(
        client.query(
          `insert into display_link (token, round_id, conference_id, issued_by_sub)
           select $1, round_id, conference_id, issued_by_sub from display_link where token = $2`,
          ['A'.repeat(43), token],
        ),
      ).rejects.toMatchObject({ constraint: 'display_link_one_live_per_round' });
    });

    it('refuses a link naming a round in another conference, and a link on a voting round', async () => {
      const app = appWith();
      const first = await autumnOffsite(app);
      const poll = await addRound(app, first.conferenceId, first.sessionId, {
        ...POLL,
        options: ['Tooling', 'Meetings'],
      });

      // A Poll: refused by the composite key, because `round_kind` is pinned to 'PostItRound'.
      await expect(
        client.query(
          `insert into display_link (token, round_id, conference_id, issued_by_sub)
           values ($1, $2, $3, $4)`,
          ['B'.repeat(43), poll.id, first.conferenceId, ADA],
        ),
      ).rejects.toMatchObject({ constraint: 'display_link_round_in_conference' });

      // A Round of this Conference, claimed for a different Conference id.
      const otherConference = await app.inject({
        method: 'POST',
        url: '/api/conferences',
        headers: as(PRIYA),
        payload: { ...AUTUMN, name: 'Spring Offsite' },
      });
      expect(otherConference.statusCode, otherConference.body).toBe(200);

      await expect(
        client.query(
          `insert into display_link (token, round_id, conference_id, issued_by_sub)
           values ($1, $2, $3, $4)`,
          ['C'.repeat(43), first.roundId, otherConference.json().id, ADA],
        ),
      ).rejects.toMatchObject({ constraint: 'display_link_round_in_conference' });
    });

    it('refuses a second row carrying a token already recorded, in any state', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);
      const first = await issue(app, fixture);
      // Revoked, and still occupying its value forever - which is what "never reissued" rests on.
      await issue(app, fixture);

      await expect(
        client.query(
          `insert into display_link (token, round_id, conference_id, issued_by_sub)
           values ($1, $2, $3, $4)`,
          [first, fixture.siblingRoundId, fixture.conferenceId, ADA],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('removes a round’s links with the round', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);
      await issue(app, fixture);

      // Deleted at the table, because the cascade is the subject: the API has no round-delete
      // endpoint today, and the guarantee has to hold for a Session or Conference removal too.
      await client.query('delete from round where id = $1', [fixture.roundId]);

      const rows = await client.query('select 1 from display_link where round_id = $1', [
        fixture.roundId,
      ]);
      expect(rows.rowCount).toBe(0);
    });

    it('reverses cleanly', async () => {
      const steps = await stepsToRevertThrough(client, MIGRATION);
      await migrate('down', String(steps));
      const absent = await client.query(
        `select 1 from information_schema.tables where table_name = 'display_link'`,
      );
      expect(absent.rowCount).toBe(0);
      await migrate('up');
    });
  });

  // ---------- Acceptance Scenario S01 ----------

  describe('a facilitator issues, reads and replaces a link', () => {
    it('shows one value at a time; a second issue replaces the first', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);

      // No link has ever been issued: an ordinary state, not a failure.
      const before = await app.inject({ method: 'GET', url: linkUrl(fixture), headers: as(ADA) });
      expect(before.statusCode, before.body).toBe(200);
      expect(before.json().displayLink).toBeNull();

      const first = await issue(app, fixture);
      expect(isCanonicalDisplayToken(first)).toBe(true);

      const read = await app.inject({ method: 'GET', url: linkUrl(fixture), headers: as(ADA) });
      expect(read.json().displayLink.token).toBe(first);
      expect(typeof read.json().displayLink.issuedAt).toBe('string');

      // Issued again with no revoke in between, and naming no link.
      const second = await issue(app, fixture);
      expect(second).not.toBe(first);

      const after = await app.inject({ method: 'GET', url: linkUrl(fixture), headers: as(ADA) });
      expect(after.json().displayLink.token).toBe(second);

      // Exactly one live row, and the first is stamped revoked rather than deleted.
      const rows = await client.query<{ token: string; revoked_at: string | null }>(
        'select token, revoked_at from display_link where round_id = $1 order by issued_at',
        [fixture.roundId],
      );
      expect(rows.rows.map((row) => row.token)).toEqual([first, second]);
      expect(rows.rows[0]!.revoked_at).not.toBeNull();
      expect(rows.rows[1]!.revoked_at).toBeNull();

      // And the first no longer resolves.
      expect((await open(app, first)).statusCode).toBe(404);
      expect((await open(app, second)).statusCode).toBe(200);
    });

    it('leaves the board fully usable for a facilitator who never issues one', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);
      await contribute(app, fixture, fixture.roundId, BO, WAITING);

      const session = await app.inject({
        method: 'GET',
        url: `/api/conferences/${fixture.conferenceId}/sessions/${fixture.sessionId}`,
        headers: as(ADA),
      });
      expect(session.statusCode, session.body).toBe(200);
      const round = session
        .json()
        .rounds.find((entry: { id: string }) => entry.id === fixture.roundId);
      expect(round.uncategorised.postItCount).toBe(1);
      // Nothing on the board read mentions a link at all - a Member cannot learn one exists.
      expect(session.body).not.toMatch(/displayLink|display_link|token/i);
    });
  });

  // ---------- Acceptance Scenario S02 ----------

  describe('revoking stops the room screen at its next poll', () => {
    it('ceases to resolve, and a replacement is available immediately', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);
      await contribute(app, fixture, fixture.roundId, BO, WAITING);
      const token = await issue(app, fixture);

      // The room machine is polling and getting the board.
      expect((await open(app, token)).statusCode).toBe(200);

      const revoked = await app.inject({
        method: 'DELETE',
        url: linkUrl(fixture),
        headers: as(ADA),
      });
      expect(revoked.statusCode, revoked.body).toBe(200);

      // The next poll - nobody touched the room machine - no longer receives the board.
      const next = await open(app, token);
      expect(next.statusCode).toBe(404);
      expect(next.json().error.code).toBe('DISPLAY_LINK_UNAVAILABLE');

      // Straight away, a different and equally unguessable value.
      const replacement = await issue(app, fixture);
      expect(replacement).not.toBe(token);
      expect(isCanonicalDisplayToken(replacement)).toBe(true);
      expect((await open(app, replacement)).statusCode).toBe(200);
    });

    /**
     * Two authorized actors pressing Issue at the same instant - an assigned Facilitator and a
     * conference-wide Admin - or one fast double-tap that beat React's re-render past
     * `disabled={busy}`.
     *
     * The partial unique index is what makes "one live link per Round" true whatever the code does,
     * and it does. What this pins is what the **loser is told**: not a 500, but the link the Round
     * actually has (review 2026-08-31, finding 5). Asserted against the stored rows as well as the
     * responses, because a route that answers well and writes twice passes a response-only test.
     */
    it('answers both of two simultaneous issues, leaving exactly one live link', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);

      const [first, second] = await Promise.all([
        app.inject({ method: 'POST', url: linkUrl(fixture), headers: as(ADA) }),
        app.inject({ method: 'POST', url: linkUrl(fixture), headers: as(PRIYA) }),
      ]);

      for (const response of [first, second]) {
        expect(response.statusCode, response.body).toBe(200);
        expect(isCanonicalDisplayToken(response.json().displayLink.token as string)).toBe(true);
      }

      const live = await client.query<{ token: string }>(
        'select token from display_link where round_id = $1 and revoked_at is null',
        [fixture.roundId],
      );
      expect(live.rowCount).toBe(1);

      // Whatever each caller was handed, the value that resolves is the one live row - and every
      // token either of them saw is either that one or already dead.
      const winner = live.rows[0]!.token;
      expect((await open(app, winner)).statusCode).toBe(200);
      for (const response of [first, second]) {
        const token = response.json().displayLink.token as string;
        const answered = await open(app, token);
        expect(answered.statusCode, token === winner ? 'the live one' : 'a superseded one').toBe(
          token === winner ? 200 : 404,
        );
      }
    });

    it('revokes twice with the same end state, and never moves a link back to live', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);
      const token = await issue(app, fixture);

      for (const attempt of [1, 2]) {
        const response = await app.inject({
          method: 'DELETE',
          url: linkUrl(fixture),
          headers: as(ADA),
        });
        expect(response.statusCode, `attempt ${attempt}: ${response.body}`).toBe(200);
        expect(response.json().displayLink).toBeNull();
      }

      const rows = await client.query<{ revoked_at: string | null }>(
        'select revoked_at from display_link where token = $1',
        [token],
      );
      expect(rows.rows[0]!.revoked_at).not.toBeNull();
      expect((await open(app, token)).statusCode).toBe(404);
    });
  });

  // ---------- Acceptance Scenario S03 ----------

  describe('a revoked value is never reissued and never resolves again', () => {
    it('refuses v1 after v2 exists, and again after v2 is revoked', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);

      const v1 = await issue(app, fixture);
      const v2 = await issue(app, fixture);
      expect((await open(app, v1)).statusCode).toBe(404);

      await app.inject({ method: 'DELETE', url: linkUrl(fixture), headers: as(ADA) });
      expect((await open(app, v1)).statusCode).toBe(404);
      expect((await open(app, v2)).statusCode).toBe(404);

      // The refusals are indistinguishable from each other and from an unknown value.
      expect(refusalShape(await open(app, v1))).toEqual(refusalShape(await open(app, v2)));
    });

    /**
     * Asserted **against the stored rows**, not against the mint alone: the guarantee is that no
     * value ever recorded for any Round in any state can be produced again, and the table is what
     * holds it. A minter pinned to a value already stored is refused by the UNIQUE constraint.
     */
    it('cannot mint a value already recorded for any round in any state', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);
      const v1 = await issue(app, fixture);
      await issue(app, fixture); // v1 is now revoked but retained.

      // A second app whose minter insists on the retired value.
      const stubborn = appWith('2026-09-15', () => v1);
      await expect(
        stubborn.inject({ method: 'POST', url: linkUrl(fixture), headers: as(ADA) }),
      ).resolves.toMatchObject({ statusCode: 500 });

      const rows = await client.query('select 1 from display_link where token = $1', [v1]);
      expect(rows.rowCount).toBe(1);
    });
  });

  // ---------- Acceptance Scenario S04 ----------

  describe('a browser with no workspace session gets that one board and nothing else', () => {
    it('carries the linked board, its authors’ names, and nothing else in the conference', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);

      await contribute(app, fixture, fixture.roundId, BO, WAITING);
      await contribute(app, fixture, fixture.roundId, ADA, REVIEWS);
      await contribute(app, fixture, fixture.siblingRoundId, BO, 'On the other round');
      await contribute(
        app,
        { ...fixture, sessionId: fixture.otherSessionId },
        fixture.otherSessionRoundId,
        BO,
        'On the other session',
      );

      const created = await app.inject({
        method: 'POST',
        url: `${roundsUrl(fixture.conferenceId, fixture.sessionId)}/${fixture.roundId}/categories`,
        headers: as(ADA),
        payload: { name: 'Tooling' },
      });
      expect(created.statusCode, created.body).toBe(200);
      const categoryId = created.json().category.id as string;

      const postIts = await client.query<{ id: string; text: string }>(
        'select id, text from post_it where round_id = $1',
        [fixture.roundId],
      );
      const reviews = postIts.rows.find((row) => row.text === REVIEWS)!;
      const placed = await app.inject({
        method: 'PATCH',
        url:
          `${roundsUrl(fixture.conferenceId, fixture.sessionId)}/${fixture.roundId}` +
          `/post-its/${reviews.id}/placement`,
        headers: as(ADA),
        payload: { categoryId },
      });
      expect(placed.statusCode, placed.body).toBe(200);

      const token = await issue(app, fixture);
      const response = await open(app, token);
      expect(response.statusCode, response.body).toBe(200);
      // Nothing between the API and the room may answer from a copy.
      expect(response.headers['cache-control']).toBe('no-store');

      const board = response.json() as WireBoard;
      expect(board.prompt).toBe(POST_IT_ROUND.prompt);
      expect(board.categories.map((category) => category.name)).toEqual(['Tooling']);
      expect(board.categories[0]!.postIts.map((postIt) => postIt.text)).toEqual([REVIEWS]);
      expect(board.categories[0]!.postItCount).toBe(1);
      expect(board.uncategorised.postIts.map((postIt) => postIt.text)).toEqual([WAITING]);
      expect(board.uncategorised.postItCount).toBe(1);

      // The authors' display names, which is the whole point of a projected board.
      expect(board.categories[0]!.postIts[0]!.authorName).toBe(NAMES[ADA]);
      expect(board.uncategorised.postIts[0]!.authorName).toBe(NAMES[BO]);
      // Nobody is signed in, so nothing is anybody's.
      for (const postIt of [...board.categories[0]!.postIts, ...board.uncategorised.postIts]) {
        expect(postIt.mine).toBe(false);
      }

      // And nothing about the rest of the Conference.
      const body = response.body;
      expect(body).not.toContain('On the other round');
      expect(body).not.toContain('On the other session');
      expect(body).not.toContain(SECOND_ROUND.prompt);
      expect(body).not.toContain(RETRO.title);
      expect(body).not.toContain(AUTUMN.name);
      expect(body).not.toContain(fixture.conferenceId);
      expect(body).not.toContain(fixture.sessionId);
      expect(body).not.toMatch(/joinCode|membership|role|canRun|activityWatermark|authorSub/i);
      // `sub` is never published, and neither is an email address.
      expect(body).not.toContain(BO);
      expect(body).not.toContain('@ourcompany.example');
    });

    it('refuses every write verb and every path shape, disclosing nothing and echoing no token', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);
      await contribute(app, fixture, fixture.roundId, BO, WAITING);
      const token = await issue(app, fixture);

      const before = await client.query('select id, text, category_id from post_it');

      /*
       * **Compared as whole responses, and searched for the token.** An earlier version asserted
       * only `statusCode`, and the global not-found handler was quietly building its message from
       * the request path - so a POST answered `No endpoint exists at POST /api/display/<token>` and
       * put the bearer credential back into a response body, right after this story took such care
       * to keep it out of the request line and the query string (review 2026-08-31, M1).
       *
       * The trailing-slash GET is here for the same reason: it misses the registered route and used
       * to answer differently from every other dead shape.
       */
      const shapes: unknown[] = [];
      for (const [method, url] of [
        ['POST', `/api/display/${token}`],
        ['PUT', `/api/display/${token}`],
        ['PATCH', `/api/display/${token}`],
        ['DELETE', `/api/display/${token}`],
        ['GET', `/api/display/${token}/`],
        ['GET', `/api/display/${token}/anything`],
      ] as const) {
        const response = await app.inject({ method, url, payload: { text: 'Injected' } });
        expect(response.body, `${method} ${url}`).not.toContain(token);
        expect(response.json().error.code, `${method} ${url}`).toBe('DISPLAY_LINK_UNAVAILABLE');
        shapes.push(refusalShape(response));
      }
      for (const shape of shapes) expect(shape).toEqual(shapes[0]);

      const after = await client.query('select id, text, category_id from post_it');
      expect(after.rows).toEqual(before.rows);
      expect((await open(app, token)).statusCode).toBe(200);
    });
  });

  // ---------- Acceptance Scenario S05 ----------

  describe('the link reaches no vote data', () => {
    it('carries no tally, option, ballot or count over a session that holds a poll', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);
      await contribute(app, fixture, fixture.roundId, BO, WAITING);

      const poll = await addRound(app, fixture.conferenceId, fixture.sessionId, {
        ...POLL,
        options: ['Tooling', 'Meetings'],
      });
      const opened = await app.inject({
        method: 'POST',
        url: `${roundsUrl(fixture.conferenceId, fixture.sessionId)}/${poll.id}/open`,
        headers: as(ADA),
      });
      expect(opened.statusCode, opened.body).toBe(200);

      for (const sub of [ADA, BO, PRIYA]) {
        const cast = await app.inject({
          method: 'POST',
          url: `${roundsUrl(fixture.conferenceId, fixture.sessionId)}/${poll.id}/votes`,
          headers: as(sub),
          payload: { optionId: poll.options![0]!.id },
        });
        expect(cast.statusCode, cast.body).toBe(200);
      }
      // The ballots really are there, so this is not passing on an empty poll.
      const ballots = await client.query('select 1 from vote');
      expect(ballots.rowCount).toBe(3);

      const token = await issue(app, fixture);

      // In every state the route can answer in: resolved, and refused.
      const answered = await open(app, token);
      await app.inject({ method: 'DELETE', url: linkUrl(fixture), headers: as(ADA) });
      const refused = await open(app, token);

      for (const response of [answered, refused]) {
        expect(response.body).not.toMatch(
          /tally|ballot|voter|optionId|options|votes|hasVoted|Tooling|Meetings/i,
        );
        expect(response.body).not.toContain(poll.id);
        expect(response.body).not.toContain(POLL.prompt);
      }
      expect(answered.statusCode).toBe(200);
      expect(refused.statusCode).toBe(404);
    });
  });

  // ---------- Acceptance Scenario S06 ----------

  describe('the link dies with its round’s session day', () => {
    it('resolves on the day it was issued and on the session day, and not the day after', async () => {
      // Issued on the 10th, for a Session on the 15th. The clock is the server's, pinned.
      const issuing = appWith('2026-09-10');
      const fixture = await autumnOffsite(issuing);
      await contribute(issuing, fixture, fixture.roundId, BO, WAITING);
      const token = await issue(issuing, fixture);

      expect((await open(issuing, token)).statusCode).toBe(200);
      expect((await open(appWith('2026-09-15'), token)).statusCode).toBe(200);

      const late = await open(appWith('2026-09-16'), token);
      expect(late.statusCode).toBe(404);
      expect(late.json().error.message).toBe('This board is no longer available.');

      // The row is untouched: the bound is a comparison, not a write, so nothing expires it.
      const rows = await client.query<{ revoked_at: string | null }>(
        'select revoked_at from display_link where token = $1',
        [token],
      );
      expect(rows.rows[0]!.revoked_at).toBeNull();
    });

    it('is judged against sessions.day, not against an interval from issue', async () => {
      // Five days between issue and the Session: a countdown from issue would already have died.
      const issuing = appWith('2026-09-10');
      const fixture = await autumnOffsite(issuing);
      const token = await issue(issuing, fixture);
      expect((await open(appWith('2026-09-14'), token)).statusCode).toBe(200);

      // A link on the *other* Session, one day later, lives one day longer. Same issue instant.
      const otherFixtureLink = `${roundsUrl(fixture.conferenceId, fixture.otherSessionId)}/${fixture.otherSessionRoundId}/display-link`;
      const otherIssued = await issuing.inject({
        method: 'POST',
        url: otherFixtureLink,
        headers: as(PRIYA),
      });
      expect(otherIssued.statusCode, otherIssued.body).toBe(200);
      const otherToken = otherIssued.json().displayLink.token as string;

      const onTheSixteenth = appWith('2026-09-16');
      expect((await open(onTheSixteenth, token)).statusCode).toBe(404);
      expect((await open(onTheSixteenth, otherToken)).statusCode).toBe(200);
    });
  });

  // ---------- Acceptance Scenario S07 ----------

  describe('every unavailable case is one indistinguishable answer', () => {
    /*
     * Fastify will not normalise these for us: `ignoreDuplicateSlashes` is false and
     * `caseSensitive` is true by default, so `//api/display/<token>` and `/API/display/<token>`
     * match no route. Before the fix they matched none of the three guards either - the not-found
     * handler, the framework-error handler and `redactDisplayToken` all asked `startsWith` of the
     * raw path - so the request fell through to `routeNotFound`, which builds its message *from
     * the path*. A live bearer credential came back in the response body, and went unredacted into
     * the request line, defeating every protection this surface has at once (gap review G29).
     *
     * The token asserted against here is a real live one, so a regression cannot pass by refusing
     * a value that was never going to resolve anyway.
     */
    it('never echoes or logs the token, whatever slashes or casing the URL carries', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);
      const live = await issue(app, fixture);

      /*
       * Every spelling the re-review found leaking, not only the two the first fix covered.
       * `find-my-way` percent-decodes for *matching* and hands the handler the raw `request.url`,
       * so the encoded ones are display requests that a raw prefix test does not recognise; the
       * `.`/`..` ones resolve to the route the same way.
       */
      const spellings = [
        `//api/display/${live}`,
        `/api//display/${live}`,
        `/API/display/${live}`,
        `/Api/Display/${live}`,
        `/%61pi/display/${live}`,
        `/api/%64isplay/${live}`,
        `/api/display%2f${live}`,
        `/api%2Fdisplay/${live}`,
        `/./api/display/${live}`,
        `/foo/../api/display/${live}`,
        `/api/./display/${live}`,
      ];

      /*
       * The property is that the token never comes back, not that every spelling is refused.
       * Some of these decode to the real route and correctly serve the board; others resolve to
       * nothing and get the one neutral sentence. Both are fine. What is never fine is the
       * credential appearing in a body, a header, or the request line the logger writes.
       */
      for (const url of spellings) {
        const response = await app.inject({ method: 'GET', url });

        expect(response.body, url).not.toContain(live);
        expect(JSON.stringify(response.headers), url).not.toContain(live);
        expect(redactDisplayToken(url), url).not.toContain(live);

        // And no refusal names the address it refused, whatever shape it took.
        if (response.statusCode !== 200) {
          expect(JSON.parse(response.body).error.code, url).toBe('DISPLAY_LINK_UNAVAILABLE');
        }
      }
    });

    it('answers eight different reasons with byte-identical refusals', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);

      // 1. revoked
      const revoked = await issue(app, fixture);
      await app.inject({ method: 'DELETE', url: linkUrl(fixture), headers: as(ADA) });

      // 2. its session day has passed – same token, read through a later clock
      const expiring = await issue(app, fixture);

      // 3. a draft conference
      const draftApp = appWith();
      const draft = await autumnOffsite(draftApp, false);
      const draftToken = await issue(draftApp, draft, PRIYA);

      // 4. a deleted round
      const deletedRoundToken = await (async () => {
        const token = await issue(app, { ...fixture, roundId: fixture.siblingRoundId });
        await client.query('delete from round where id = $1', [fixture.siblingRoundId]);
        return token;
      })();

      // 5. never issued, but shaped like a token; 6. a value that could not be one at all;
      // 7 and 8: percent-malformed paths, which the *router* rejects before any handler runs.
      // Those two used to escape the shared envelope entirely with Fastify's own
      // `FST_ERR_BAD_URL` 400 - a seventh answer, differing in status, code, message, headers and
      // shape, echoing the requested path back (review 2026-08-31, finding 3). `'nope'` is
      // URL-safe, so it took the router's happy path and left the divergence invisible.
      const neverIssued = 'z'.repeat(43);
      const notEvenAToken = 'nope';

      const later = appWith('2026-09-16');
      const shapes = [
        refusalShape(await open(app, revoked)),
        refusalShape(await open(later, expiring)),
        refusalShape(await open(app, draftToken)),
        refusalShape(await open(app, deletedRoundToken)),
        refusalShape(await open(app, neverIssued)),
        refusalShape(await open(app, notEvenAToken)),
        refusalShape(await open(app, '%zz')),
        refusalShape(await open(app, '%')),
      ];

      // Compared as whole responses: status, every header, and the body, together.
      for (const shape of shapes) expect(shape).toEqual(shapes[0]);
      expect(JSON.parse((shapes[0] as { body: string }).body)).toEqual({
        error: {
          code: 'DISPLAY_LINK_UNAVAILABLE',
          message: 'This board is no longer available.',
        },
      });
    });

    it('starts rendering once the conference is published, with no reissue', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app, false);
      await contribute(app, fixture, fixture.roundId, PRIYA, WAITING);
      const token = await issue(app, fixture, PRIYA);

      // Created and openable, but neutral while the Conference is draft.
      expect((await open(app, token)).statusCode).toBe(404);

      const published = await app.inject({
        method: 'POST',
        url: `/api/conferences/${fixture.conferenceId}/publish`,
        headers: as(PRIYA),
      });
      expect(published.statusCode, published.body).toBe(200);

      // The same token, unreissued, with nobody touching the room machine.
      const now = await open(app, token);
      expect(now.statusCode, now.body).toBe(200);
      expect((now.json() as WireBoard).uncategorised.postIts[0]!.text).toBe(WAITING);
    });
  });

  // ---------- Acceptance Scenario S09 ----------

  describe('issue and revoke are held to sorting authority', () => {
    it('refuses a member with no assignment on all three, writing nothing', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);

      for (const [method, payload] of [
        ['POST', { actorSub: ADA, userSub: ADA, email: `${ADA}@ourcompany.example` }],
        ['DELETE', undefined],
        ['GET', undefined],
      ] as const) {
        const response = await app.inject({
          method,
          url: linkUrl(fixture),
          headers: as(BO),
          ...(payload ? { payload } : {}),
        });
        expect(response.statusCode, `${method}: ${response.body}`).toBe(403);
        expect(response.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');
      }

      const rows = await client.query('select 1 from display_link');
      expect(rows.rowCount).toBe(0);
    });

    it('never lets a response carrying the token be cached', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);

      /*
       * The three routes that **hand out** the credential, not just the one that spends it. confApp
       * is used on shared hardware by design, and Fastify sends no default directive - so without
       * this the body holding a live token is left to whatever heuristic a browser or an
       * intermediary applies (review 2026-08-31, L8).
       */
      for (const method of ['GET', 'POST', 'DELETE'] as const) {
        const response = await app.inject({ method, url: linkUrl(fixture), headers: as(ADA) });
        expect(response.statusCode, `${method}: ${response.body}`).toBe(200);
        expect(response.headers['cache-control'], method).toBe('no-store');
      }
    });

    it('lets an admin with no session assignment issue and revoke', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);

      // Priya created the Conference: conference-wide Admin, and no Session Assignment.
      const assignments = await client.query(
        'select 1 from session_assignment where user_sub = $1',
        [PRIYA],
      );
      expect(assignments.rowCount).toBe(0);

      const token = await issue(app, fixture, PRIYA);
      expect((await open(app, token)).statusCode).toBe(200);

      const revoked = await app.inject({
        method: 'DELETE',
        url: linkUrl(fixture),
        headers: as(PRIYA),
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
    });

    /**
     * **The actor is the credential** (Binding Constraint FR6). A body naming somebody else changes
     * neither the decision nor the row: there is no parameter on the seam an actor could arrive
     * through, so the field is *inert* rather than merely unused.
     */
    it('takes the issuer from the credential, whatever the body claims', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);

      const issued = await app.inject({
        method: 'POST',
        url: linkUrl(fixture),
        headers: as(ADA),
        payload: { issuedBySub: PRIYA, actorSub: PRIYA, email: `${PRIYA}@ourcompany.example` },
      });
      expect(issued.statusCode, issued.body).toBe(200);

      const rows = await client.query<{ issued_by_sub: string }>(
        'select issued_by_sub from display_link where token = $1',
        [issued.json().displayLink.token],
      );
      expect(rows.rows[0]!.issued_by_sub).toBe(ADA);
    });
  });

  // ---------- TI05: anonymity and the log ----------

  describe('the anonymous route', () => {
    it('answers with no Authorization header, and refuses one that is invalid the same way', async () => {
      const app = appWith();
      const fixture = await autumnOffsite(app);
      await contribute(app, fixture, fixture.roundId, BO, WAITING);
      const token = await issue(app, fixture);

      const anonymous = await app.inject({ method: 'GET', url: `/api/display/${token}` });
      expect(anonymous.statusCode, anonymous.body).toBe(200);

      // A room machine that somehow sent a stale credential is not refused for it: the token is
      // the boundary, and the header is not consulted at all.
      const withGarbage = await app.inject({
        method: 'GET',
        url: `/api/display/${token}`,
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      expect(withGarbage.statusCode, withGarbage.body).toBe(200);
      expect(withGarbage.body).toBe(anonymous.body);
    });

    /**
     * `loggerOptions: true` is Fastify's idiomatic "log with defaults", and it used to skip the
     * redaction entirely - a latent one-word regression on the story's most carefully guarded
     * property (review 2026-08-31, L4). Driven as its own case so the guarantee is not a property
     * of the shape `index.ts` happens to pass.
     */
    it.each([
      ['an options object', { level: 'info' } as const],
      ['the bare `true` shorthand', true as const],
    ])('never writes the token into a log line – %s', async (_name, shape) => {
      const lines: string[] = [];
      const stream = {
        write(line: string) {
          lines.push(line);
        },
      };
      const app = buildApp({
        db,
        auth: {
          verifier: namedVerifier(),
          users: createUserRepository(db),
          codeExchange: unusedCodeExchange(),
        },
        clock: fixedClock('2026-09-15'),
        loggerOptions: shape === true ? { stream } : { ...shape, stream },
      });
      apps.push(app);

      const fixture = await autumnOffsite(app);
      const token = await issue(app, fixture);
      expect((await open(app, token)).statusCode).toBe(200);
      expect((await open(app, 'z'.repeat(43))).statusCode).toBe(404);

      expect(lines.length).toBeGreaterThan(0);
      const written = lines.join('\n');
      expect(written).not.toContain(token);
      expect(written).not.toContain('z'.repeat(43));
      // The request line is still there, so this is redaction rather than silence.
      expect(written).toContain('/api/display/<token>');
    });
  });
});
