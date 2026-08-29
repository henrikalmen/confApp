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
import { subjectVerifier, tokenFor, unusedCodeExchange } from './fake-auth.ts';
import { stepsToRevertThrough } from './migration-depth.ts';

/**
 * S03's anonymous Poll voting and result reveal, against the real PostgreSQL the composed stack
 * runs.
 *
 * Every rule proved here is a storage-level guarantee, an authority decision or a concurrency
 * property, and not one of them is provable against a fake that answers whatever the test wants:
 * the uniqueness constraint that makes a Vote single-use under two simultaneous submissions, the
 * row lock that makes the Poll freeze a check-and-write rather than two statements, the trigger
 * that moves the one cursor, and the shape of a payload an Attendee is actually handed.
 *
 * **The ballot gate is the production binding throughout.** S01's frozen-content scenario binds a
 * port answering `true` because Vote storage did not exist when it was written; here the Votes are
 * real, which is the whole point of TI08 - the freeze either works against a stored ballot or it
 * does not.
 *
 * What this suite cannot prove, stated so nobody reads it as more than it is: the ballot row and
 * the has-voted row share an `xmin`, and a holder of direct database credentials can pair them with
 * an ordinary `SELECT`. Nothing below inspects a system column, and nothing could. See
 * `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md`.
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
    '\n[integration] SKIPPED anonymous poll voting – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/** Priya organizes; Grace facilitates the workshop; Ada and the others are simply in the room. */
const PRIYA = 'google-sub-priya';
const GRACE = 'google-sub-grace';
const ADA = 'google-sub-ada';
const ROOM = ['google-sub-bo', 'google-sub-cleo', 'google-sub-dev', 'google-sub-eli'];
const OUTSIDER = 'google-sub-outsider';
const EVERYONE = [PRIYA, GRACE, ADA, ...ROOM, OUTSIDER];

const AUTUMN = { name: 'Autumn Offsite', startDate: '2026-09-15', endDate: '2026-09-16' };

const WAYS_OF_WORKING = {
  title: 'Ways of Working',
  kind: 'Workshop',
  day: '2026-09-15',
  startTime: '13:00',
  endTime: '15:00',
  location: 'Room 2',
};

const POLL = {
  kind: 'VotingRound',
  purpose: 'Poll',
  prompt: 'Where should we start?',
  options: ['Yes', 'No', 'Not sure'],
};

const POST_IT = { kind: 'PostItRound', prompt: 'What slows us down most?' };

interface WireOption {
  id: string;
  label: string;
}

interface WireRound {
  id: string;
  kind: string;
  purpose?: string;
  prompt: string;
  state: string;
  options?: WireOption[];
  hasVoted?: boolean;
  tally?: { optionId: string; votes: number }[];
  postIts?: unknown[];
}

interface SessionPayload {
  rounds: WireRound[];
  canRun: boolean;
  activityWatermark: string | null;
}

describe.skipIf(!reachable)('anonymous poll voting against a real PostgreSQL', () => {
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

  /** The app under test, always on the production ballot gate – see the file note. */
  function newApp(): FastifyInstance {
    const app = buildApp({
      db,
      auth: {
        verifier: subjectVerifier(),
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

  /**
   * "Autumn Offsite", published, one Session. Grace facilitates it; Ada and the room are Members
   * with no Role Assignment at all; the outsider joined no conference.
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

    for (const sub of [GRACE, ADA, ...ROOM]) {
      await client.query(
        `insert into membership (conference_id, user_sub) values ($1, $2)
         on conflict (conference_id, user_sub) do nothing`,
        [conferenceId, sub],
      );
    }

    const granted = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/members/roles`,
      headers: as(PRIYA),
      payload: { email: `${GRACE}@ourcompany.example`, role: 'PresenterFacilitator' },
    });
    expect(granted.statusCode, granted.body).toBe(200);

    const assigned = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/assignments`,
      headers: as(PRIYA),
      payload: { userSub: GRACE },
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

  function roundsUrl(conferenceId: string, sessionId: string): string {
    return `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds`;
  }

  async function addRound(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    payload: Record<string, unknown>,
  ): Promise<WireRound> {
    const response = await app.inject({
      method: 'POST',
      url: roundsUrl(conferenceId, sessionId),
      headers: as(GRACE),
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().round as WireRound;
  }

  async function transition(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    move: 'open' | 'close',
  ): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: `${roundsUrl(conferenceId, sessionId)}/${roundId}/${move}`,
      headers: as(GRACE),
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  function castVote(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    optionId: string,
    sub: string,
    extra: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: `${roundsUrl(conferenceId, sessionId)}/${roundId}/votes`,
      headers: as(sub),
      payload: { optionId, ...extra },
    });
  }

  function readTally(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    sub: string,
  ) {
    return app.inject({
      method: 'GET',
      url: `${roundsUrl(conferenceId, sessionId)}/${roundId}/tally`,
      headers: as(sub),
    });
  }

  async function readSession(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    sub: string,
  ): Promise<SessionPayload> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
      headers: as(sub),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as SessionPayload;
  }

  /** The Session's activity cursor, as a number - it is a counter, and '10' sorts before '9'. */
  async function watermark(conferenceId: string, sessionId: string): Promise<bigint> {
    const rows = await client.query<{ at: string }>(
      `select max(activity_watermark)::text as at from round
        where conference_id = $1 and session_id = $2`,
      [conferenceId, sessionId],
    );
    return BigInt(rows.rows[0]!.at);
  }

  /** An open Poll on a published Session, with its option ids. */
  async function openPoll(app: FastifyInstance): Promise<{
    conferenceId: string;
    sessionId: string;
    poll: WireRound;
    options: Record<string, string>;
  }> {
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const poll = await addRound(app, conferenceId, sessionId, POLL);
    await transition(app, conferenceId, sessionId, poll.id, 'open');
    const options = Object.fromEntries(poll.options!.map((o) => [o.label, o.id]));
    return { conferenceId, sessionId, poll, options };
  }

  // ---------- Acceptance Scenario S01 (TI04, TI05, TI09) ----------

  it('lets a member cast one vote in an open poll and tells them it registered', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);

    const before = await readSession(app, conferenceId, sessionId, ADA);
    expect(before.rounds[0]!.hasVoted).toBe(false);
    // Ada holds a Membership and no Session Assignment, so she is not offered the running tally.
    expect(before.rounds[0]!.tally).toBeUndefined();

    const cast = await castVote(app, conferenceId, sessionId, poll.id, options['Not sure']!, ADA);
    expect(cast.statusCode, cast.body).toBe(200);
    // The cast tells her it landed and nothing else - not even a count she would be allowed to see.
    expect(cast.json()).toEqual({ voted: true });

    const after = await readSession(app, conferenceId, sessionId, ADA);
    expect(after.rounds[0]!.hasVoted).toBe(true);
    // Still no tally while it runs, and no affordance to change it: a Vote is final, so there is
    // no endpoint to change or withdraw one at all.
    expect(after.rounds[0]!.tally).toBeUndefined();

    // Exactly two rows, in the two places they belong.
    const ballots = await client.query('select round_id, option_id from vote');
    expect(ballots.rows).toEqual([{ round_id: poll.id, option_id: options['Not sure'] }]);
    const voters = await client.query('select round_id, user_sub from round_voter');
    expect(voters.rows).toEqual([{ round_id: poll.id, user_sub: ADA }]);
  });

  /**
   * **The identity on the ballot path comes from the credential and from nothing else**, and the
   * ballot carries none of it (Binding Constraint FR3, `AGENTS.md`).
   */
  it('records the vote against the caller, ignoring any voter named in the body', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);

    const cast = await castVote(app, conferenceId, sessionId, poll.id, options['Yes']!, ADA, {
      userSub: GRACE,
      voterSub: GRACE,
      email: `${GRACE}@ourcompany.example`,
    });
    expect(cast.statusCode, cast.body).toBe(200);

    // Ada is the one recorded; Grace is not, and can still vote herself.
    const voters = await client.query<{ user_sub: string }>('select user_sub from round_voter');
    expect(voters.rows.map((row) => row.user_sub)).toEqual([ADA]);

    const grace = await castVote(app, conferenceId, sessionId, poll.id, options['No']!, GRACE);
    expect(grace.statusCode, grace.body).toBe(200);
  });

  // ---------- Acceptance Scenario S02 (TI05, TI09) ----------

  it('refuses a second vote and reveals nothing about the tally in doing so', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);

    // Ada, and eleven others, have voted.
    expect(
      (await castVote(app, conferenceId, sessionId, poll.id, options['No']!, ADA)).statusCode,
    ).toBe(200);
    for (const sub of [GRACE, ...ROOM]) {
      expect(
        (await castVote(app, conferenceId, sessionId, poll.id, options['Yes']!, sub)).statusCode,
        sub,
      ).toBe(200);
    }

    const again = await castVote(app, conferenceId, sessionId, poll.id, options['Yes']!, ADA);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('VOTE_ALREADY_CAST');
    // A displayable sentence, and no number anywhere in the body - no counts, no per-option data,
    // no total. Asserted over the whole serialized refusal rather than over named fields, because
    // the failure this guards against is a field nobody thought to name.
    expect(again.json().error.message).toMatch(/already voted/i);
    expect(JSON.stringify(again.json())).not.toMatch(/\d/);
    expect(Object.keys(again.json().error).sort()).toEqual(['code', 'message']);

    // And no second ballot exists: five people voted, five ballots.
    const ballots = await client.query<{ n: string }>('select count(*)::text as n from vote');
    expect(ballots.rows[0]!.n).toBe('6');
    const voters = await client.query<{ n: string }>('select count(*)::text as n from round_voter');
    expect(voters.rows[0]!.n).toBe('6');
  });

  // ---------- Acceptance Scenario S03 (TI04, TI05) ----------

  it('still records a member as having voted after every trace of their device is gone', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);
    expect(
      (await castVote(app, conferenceId, sessionId, poll.id, options['Not sure']!, ADA)).statusCode,
    ).toBe(200);

    /*
     * A second app instance with its own pool and its own repositories: nothing about Ada survives
     * in this process, which is the point - the fact is server-side, and the API runs across
     * replicas with no request affinity anyway (ADR-004).
     */
    const reinstalled = newApp();
    const again = await castVote(
      reinstalled,
      conferenceId,
      sessionId,
      poll.id,
      options['Yes']!,
      ADA,
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('VOTE_ALREADY_CAST');

    expect((await readSession(reinstalled, conferenceId, sessionId, ADA)).rounds[0]!.hasVoted).toBe(
      true,
    );
  });

  // ---------- Acceptance Scenario S04 (TI02, TI06, TI07, TI09, TI10) ----------

  it('builds the tally for the assigned facilitator alone, and refuses the attendee outright', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);

    for (const sub of [ADA, ROOM[0]!, ROOM[1]!]) {
      expect(
        (await castVote(app, conferenceId, sessionId, poll.id, options['Yes']!, sub)).statusCode,
      ).toBe(200);
    }

    const three = await readTally(app, conferenceId, sessionId, poll.id, GRACE);
    expect(three.statusCode, three.body).toBe(200);
    expect(three.json()).toEqual({
      tally: [
        { optionId: options['Yes'], votes: 3 },
        { optionId: options['No'], votes: 0 },
        { optionId: options['Not sure'], votes: 0 },
      ],
    });

    /*
     * A fourth member votes while Grace's screen is open, and **the cursor does not move** - a Vote
     * advances nothing (ADR-007). The watermark poll is Membership-gated, so a movement here was a
     * "a ballot just landed" signal readable by the very Attendees the running tally is withheld
     * from. Grace's screen keeps up by re-reading the Session on the shared tick instead, which is
     * the read taken immediately below.
     */
    const before = await watermark(conferenceId, sessionId);
    expect(
      (await castVote(app, conferenceId, sessionId, poll.id, options['No']!, ROOM[2]!)).statusCode,
    ).toBe(200);
    expect(await watermark(conferenceId, sessionId)).toBe(before);

    const four = await readTally(app, conferenceId, sessionId, poll.id, GRACE);
    expect(four.json().tally.map((entry: { votes: number }) => entry.votes)).toEqual([3, 1, 0]);
    // The same four reach her through the Session read, which is what her screen actually renders.
    const grace = await readSession(app, conferenceId, sessionId, GRACE);
    expect(grace.rounds[0]!.tally!.map((entry) => entry.votes)).toEqual([3, 1, 0]);

    /*
     * Ada is **refused, not shown an empty tally**. A zero handed to her mid-poll would be a
     * statement about the votes, and once "not for you" and "nobody voted" look alike the absence
     * itself carries information (prd.md#fr5-poll-result-reveal).
     */
    const refused = await readTally(app, conferenceId, sessionId, poll.id, ADA);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('POLL_RESULTS_NOT_YET_AVAILABLE');
    expect(refused.json().error.message).toMatch(/appear when voting ends/i);
    expect(JSON.stringify(refused.json())).not.toMatch(/\d/);
    expect(JSON.stringify(refused.json())).not.toMatch(/tally|option/i);
  });

  // ---------- Acceptance Scenario S05 (TI06, TI07, TI09) ----------

  it('reveals the tally to every member on close, and reads zero for a poll nobody voted in', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);
    const silent = await addRound(app, conferenceId, sessionId, {
      ...POLL,
      prompt: 'And after that?',
    });
    await transition(app, conferenceId, sessionId, silent.id, 'open');

    for (const [sub, choice] of [
      [ADA, 'Yes'],
      [ROOM[0]!, 'Yes'],
      [ROOM[1]!, 'Not sure'],
    ] as const) {
      expect(
        (await castVote(app, conferenceId, sessionId, poll.id, options[choice]!, sub)).statusCode,
      ).toBe(200);
    }

    await transition(app, conferenceId, sessionId, poll.id, 'close');
    await transition(app, conferenceId, sessionId, silent.id, 'close');

    const voted = await readTally(app, conferenceId, sessionId, poll.id, ADA);
    expect(voted.statusCode, voted.body).toBe(200);
    expect(voted.json().tally.map((entry: { votes: number }) => entry.votes)).toEqual([2, 0, 1]);

    // A poll closed with no votes reads zero against every option - a result, rendered normally.
    const none = await readTally(app, conferenceId, sessionId, silent.id, ADA);
    expect(none.statusCode, none.body).toBe(200);
    expect(none.json().tally).toHaveLength(3);
    expect(none.json().tally.every((entry: { votes: number }) => entry.votes === 0)).toBe(true);

    // Somebody who never joined the Conference is refused after the close as well.
    const outside = await readTally(app, conferenceId, sessionId, poll.id, OUTSIDER);
    expect(outside.statusCode).toBe(403);
    expect(outside.json().error.code).toBe('NOT_A_MEMBER');
  });

  // ---------- Acceptance Scenario S06 (TI07, TI09) ----------

  it('shows a returning member every round’s own state and the closed poll’s result, in one read', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);
    const neverOpened = await addRound(app, conferenceId, sessionId, {
      ...POLL,
      prompt: 'Anything else?',
    });
    expect(
      (await castVote(app, conferenceId, sessionId, poll.id, options['Yes']!, ADA)).statusCode,
    ).toBe(200);
    await transition(app, conferenceId, sessionId, poll.id, 'close');

    // Days later, on a fresh process holding nothing.
    const later = newApp();
    const payload = await readSession(later, conferenceId, sessionId, ADA);

    const closed = payload.rounds.find((round) => round.id === poll.id)!;
    const unopened = payload.rounds.find((round) => round.id === neverOpened.id)!;
    expect(closed.state).toBe('closed');
    expect(closed.tally!.map((entry) => entry.votes)).toEqual([1, 0, 0]);
    expect(closed.hasVoted).toBe(true);

    // A Round that was never opened is listed with its own state, and carries a tally of zeroes it
    // is entitled to because it is closed - not an error, and not an omission.
    expect(unopened.state).toBe('closed');
    expect(unopened.hasVoted).toBe(false);
    expect(unopened.tally!.every((entry) => entry.votes === 0)).toBe(true);
  });

  // ---------- Acceptance Scenario S07 (TI05) ----------

  it('refuses a vote into a closed poll and a vote for an option from another poll, writing nothing', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);
    const other = await addRound(app, conferenceId, sessionId, {
      ...POLL,
      prompt: 'A different question',
    });
    const closed = await addRound(app, conferenceId, sessionId, { ...POLL, prompt: 'Closed one' });
    await transition(app, conferenceId, sessionId, closed.id, 'open');
    await transition(app, conferenceId, sessionId, closed.id, 'close');

    const intoClosed = await castVote(
      app,
      conferenceId,
      sessionId,
      closed.id,
      closed.options![0]!.id,
      ADA,
    );
    expect(intoClosed.statusCode).toBe(409);
    expect(intoClosed.json().error.code).toBe('VOTING_ROUND_CLOSED');

    const wrongOption = await castVote(
      app,
      conferenceId,
      sessionId,
      poll.id,
      other.options![0]!.id,
      ADA,
    );
    expect(wrongOption.statusCode).toBe(400);
    expect(wrongOption.json().error.code).toBe('VOTE_OPTION_UNKNOWN');

    // Neither refusal wrote a ballot **or** a has-voted fact – the second matters most, because a
    // has-voted row left behind would silently spend Ada's single vote on a request that failed.
    expect((await client.query('select 1 from vote')).rowCount).toBe(0);
    expect((await client.query('select 1 from round_voter')).rowCount).toBe(0);

    // And Ada can still vote properly afterwards.
    expect(
      (await castVote(app, conferenceId, sessionId, poll.id, options['Yes']!, ADA)).statusCode,
    ).toBe(200);
  });

  /** A Post-it Round reached through the voting path is "no poll here", not a 500. */
  it('refuses a vote on a post-it round as a missing round', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);
    const board = await addRound(app, conferenceId, sessionId, POST_IT);
    await transition(app, conferenceId, sessionId, board.id, 'open');

    const refused = await castVote(app, conferenceId, sessionId, board.id, options['Yes']!, ADA);
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error.code).toBe('ROUND_NOT_FOUND');

    // The tally endpoint says the same thing about the same round.
    const tally = await readTally(app, conferenceId, sessionId, board.id, GRACE);
    expect(tally.statusCode).toBe(404);
    expect(tally.json().error.code).toBe('ROUND_NOT_FOUND');
    expect(poll.id).not.toBe(board.id);
  });

  /** Membership contributes. A Role Assignment without one is not a member (S07's rule). */
  it('refuses a caller who holds no membership row, whatever else they hold', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);

    const refused = await castVote(
      app,
      conferenceId,
      sessionId,
      poll.id,
      options['Yes']!,
      OUTSIDER,
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('NOT_A_MEMBER');
    expect((await client.query('select 1 from round_voter')).rowCount).toBe(0);
  });

  // ---------- Acceptance Scenario S08 (TI08) ----------

  it('freezes a poll’s question and options once a real ballot exists, leaving post-its editable', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);
    const board = await addRound(app, conferenceId, sessionId, POST_IT);

    // Editable while nobody has voted – the trigger is a Vote existing, not the Poll being authored.
    const early = await app.inject({
      method: 'PATCH',
      url: `${roundsUrl(conferenceId, sessionId)}/${poll.id}`,
      headers: as(GRACE),
      payload: { ...POLL, prompt: 'Where should we begin?' },
    });
    expect(early.statusCode, early.body).toBe(200);

    // A real ballot, cast through the endpoint – not a port bound to `true`.
    const fresh = (await readSession(app, conferenceId, sessionId, GRACE)).rounds.find(
      (round) => round.id === poll.id,
    )!;
    const yes = fresh.options!.find((option) => option.label === 'Yes')!.id;
    expect((await castVote(app, conferenceId, sessionId, poll.id, yes, ADA)).statusCode).toBe(200);
    expect(Object.keys(options).length).toBe(3);

    for (const payload of [
      { ...POLL, prompt: 'Where should we really start?' },
      { ...POLL, prompt: 'Where should we begin?', options: ['Yes', 'No'] },
    ]) {
      const refused = await app.inject({
        method: 'PATCH',
        url: `${roundsUrl(conferenceId, sessionId)}/${poll.id}`,
        headers: as(GRACE),
        payload,
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe('POLL_CONTENT_FROZEN');
    }

    // Byte-identical afterwards, so the closed tally answers the question it was cast against.
    const stored = await client.query<{ prompt: string }>(
      'select prompt from round where id = $1',
      [poll.id],
    );
    expect(stored.rows[0]!.prompt).toBe('Where should we begin?');
    const labels = await client.query<{ label: string }>(
      'select label from round_option where round_id = $1 order by position',
      [poll.id],
    );
    expect(labels.rows.map((row) => row.label)).toEqual(['Yes', 'No', 'Not sure']);

    // The post-it round on the same session is untouched by the freeze.
    const prompt = await app.inject({
      method: 'PATCH',
      url: `${roundsUrl(conferenceId, sessionId)}/${board.id}`,
      headers: as(GRACE),
      payload: { kind: 'PostItRound', prompt: 'What slows us down, day to day?' },
    });
    expect(prompt.statusCode, prompt.body).toBe(200);
  });

  /**
   * **The freeze check and the content UPDATE are one transaction, not two statements** (TI08's
   * DECISION NOTE, `poll-freeze-toctou-discharge`).
   *
   * A separate connection opens a transaction, takes the Round's row lock, and writes a ballot
   * without committing. The edit is then fired: it must **block on that lock before asking the
   * gate**. When the ballot commits, the edit acquires the lock, asks the now-truthful gate, and
   * refuses.
   *
   * Without the `FOR UPDATE`, the gate is asked immediately on a snapshot where no ballot is
   * committed, answers `false`, and the edit lands the moment the lock is released - which is the
   * race this proves closed. The assertion that discriminates is the *stored content*, not the
   * status code: an edit that ran its check early would still block on the UPDATE and still return
   * 200, and only the row would show it.
   */
  it('refuses an edit when a vote commits between the freeze check and the write', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);

    const voter = new pg.Client({ connectionString: url });
    await voter.connect();
    try {
      const voterPid = (await voter.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows[0]!.pid;
      await voter.query('begin');
      // Exactly the lock the cast path takes, in the same order.
      await voter.query('select id from round where id = $1 for update', [poll.id]);
      await voter.query('insert into round_voter (round_id, user_sub) values ($1, $2)', [
        poll.id,
        ADA,
      ]);
      await voter.query('insert into vote (round_id, option_id) values ($1, $2)', [
        poll.id,
        options['Yes'],
      ]);

      /*
       * Wrapped in an async IIFE rather than left as a bare `app.inject(...)`: light-my-request's
       * chain is lazy and only dispatches when something awaits it, so an un-awaited call would sit
       * there having sent nothing while this test waited for a lock nobody was holding.
       */
      const edit = (async () =>
        app.inject({
          method: 'PATCH',
          url: `${roundsUrl(conferenceId, sessionId)}/${poll.id}`,
          headers: as(GRACE),
          payload: { ...POLL, prompt: 'Rewritten mid-vote', options: ['Only this', 'Or this'] },
        }))();

      // Wait until the edit is genuinely parked on the lock rather than guessing with a delay.
      await waitForWaiter(voterPid);

      await voter.query('commit');

      const refused = await edit;
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe('POLL_CONTENT_FROZEN');
    } finally {
      await voter.query('rollback').catch(() => undefined);
      await voter.end();
    }

    const stored = await client.query<{ prompt: string }>(
      'select prompt from round where id = $1',
      [poll.id],
    );
    expect(stored.rows[0]!.prompt).toBe('Where should we start?');
    const labels = await client.query<{ label: string }>(
      'select label from round_option where round_id = $1 order by position',
      [poll.id],
    );
    expect(labels.rows.map((row) => row.label)).toEqual(['Yes', 'No', 'Not sure']);
  });

  /**
   * Blocks until **the edit's own backend** is parked on the Round's row lock, held by the voter's
   * transaction - so the interleaving is real rather than timed, and real about the right row.
   *
   * `pg_locks` is cluster-wide, so a bare `where not granted` count is satisfied by any unrelated
   * backend waiting on anything, anywhere on the server. This guard proves the single highest-risk
   * requirement in the story - that the freeze check and the write are one transaction - and under
   * that predicate every assertion after it would pass against a reverted two-statement
   * implementation, because the edit would already have run to completion while some stranger's
   * lock kept the wait satisfied. Three conditions, all required:
   *
   *   - the waiter is neither this observer connection nor the voter itself;
   *   - it holds a `tuple` lock on the `round` relation - the lock a backend takes on the exact row
   *     it is about to sleep for. The *ungranted* request is a `transactionid` lock whose
   *     `relation` is null, which is how PostgreSQL records waiting for a row lock, so the relation
   *     has to be asserted through the tuple lock the same backend holds rather than on the
   *     ungranted row itself;
   *   - and the transaction blocking it is the voter's, not somebody else's.
   */
  async function waitForWaiter(voterPid: number): Promise<void> {
    const observerPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid'))
      .rows[0]!.pid;

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await client.query<{ n: string }>(
        `select count(*)::text as n
           from pg_locks blocked
           join pg_locks parked
             on parked.pid = blocked.pid
            and parked.locktype = 'tuple'
            and parked.relation = 'round'::regclass
          where not blocked.granted
            and blocked.pid <> $1::int
            and blocked.pid <> $2::int
            and $1::int = any (pg_blocking_pids(blocked.pid))`,
        [voterPid, observerPid],
      );
      if (waiting.rows[0]!.n !== '0') return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `No backend ever parked on a round row lock held by the voter's backend ${voterPid}.`,
    );
  }

  // ---------- single use under real concurrency (TI04) ----------

  /**
   * Two submissions from one Member, arriving together on two connections.
   *
   * Sequential casts cannot tell a unique constraint from a pre-read: both pass sequentially too.
   * Only genuine concurrency does, and this is the case a pre-read would let through
   * (`docs/LEARNINGS.md#concurrency`).
   */
  it('admits exactly one of two simultaneous votes from the same member', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);

    const [first, second] = await Promise.all([
      castVote(app, conferenceId, sessionId, poll.id, options['Yes']!, ADA),
      castVote(app, conferenceId, sessionId, poll.id, options['No']!, ADA),
    ]);

    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const refused = first.statusCode === 409 ? first : second;
    expect(refused.json().error.code).toBe('VOTE_ALREADY_CAST');

    expect((await client.query('select 1 from vote')).rowCount).toBe(1);
    expect((await client.query('select 1 from round_voter')).rowCount).toBe(1);
  });

  /**
   * **Single use is enforced by the database, not by the cast path's row lock.**
   *
   * The test above proves the product property - one Member, one ballot - but it cannot on its own
   * distinguish the unique constraint from a pre-read, because both casts serialise on the Round's
   * row lock and a pre-read taken *inside* that lock would look correct. So the constraint is
   * proved where it actually lives: written directly, with no lock and no application code in the
   * way, which is exactly the position a future story adding a second write path would be in.
   */
  it('refuses a second has-voted row at the storage level, with no application code involved', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);

    await client.query('insert into round_voter (round_id, user_sub) values ($1, $2)', [
      poll.id,
      ADA,
    ]);

    await expect(
      client.query('insert into round_voter (round_id, user_sub) values ($1, $2)', [poll.id, ADA]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'round_voter_once_per_round' });

    // The same person may vote in a *different* Poll: the rule is one Vote per Round, not one ever.
    const another = await addRound(app, conferenceId, sessionId, { ...POLL, prompt: 'And next?' });
    await transition(app, conferenceId, sessionId, another.id, 'open');
    const elsewhere = await castVote(
      app,
      conferenceId,
      sessionId,
      another.id,
      another.options![0]!.id,
      ADA,
    );
    expect(elsewhere.statusCode, elsewhere.body).toBe(200);
    expect(Object.keys(options)).toHaveLength(3);
  });

  // ---------- the one cursor (TI02) ----------

  /**
   * **A Vote advances no cursor, and an option write still advances the one there is** (ADR-007).
   *
   * The ballot trigger was dropped by `20260831090000000_vote-advances-no-cursor.sql`: on a Session
   * running only a Poll, `activityWatermark` is `max()` over that Session's Rounds alone, so every
   * movement of it meant "a Vote just arrived" - and the endpoint that serves it is gated on
   * Membership, which is exactly the authority an Attendee refused the tally already holds.
   *
   * This is the assertion that goes red if the trigger comes back.
   */
  it('never advances any cursor on a ballot insert, while an option write still advances the round cursor', async () => {
    const app = newApp();
    const { conferenceId, sessionId } = await autumnOffsite(app);
    const poll = await addRound(app, conferenceId, sessionId, POLL);
    await transition(app, conferenceId, sessionId, poll.id, 'open');

    const conferenceBefore = await client.query<{ at: string }>(
      'select schedule_watermark_at::text as at from conference where id = $1',
      [conferenceId],
    );
    const sessionBefore = await client.query<{ at: string }>(
      'select last_updated_at::text as at from sessions where id = $1',
      [sessionId],
    );

    // An option edit, before the first Vote, reaches every open client (the propagated Discovered
    // Requirement): `round_option` carries a trigger now, and the round trigger's WHEN clause would
    // stay false for an option-only change.
    const cursorBeforeEdit = await watermark(conferenceId, sessionId);
    const edited = await app.inject({
      method: 'PATCH',
      url: `${roundsUrl(conferenceId, sessionId)}/${poll.id}`,
      headers: as(GRACE),
      payload: { ...POLL, options: ['Yes', 'No', 'Not sure', 'Ask again later'] },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await watermark(conferenceId, sessionId)) > cursorBeforeEdit).toBe(true);

    const options = Object.fromEntries(
      (edited.json().round as WireRound).options!.map((o) => [o.label, o.id]),
    );

    const cursorBeforeVote = await watermark(conferenceId, sessionId);
    expect(
      (await castVote(app, conferenceId, sessionId, poll.id, options['Yes']!, ADA)).statusCode,
    ).toBe(200);
    const afterVote = await watermark(conferenceId, sessionId);
    expect(afterVote).toBe(cursorBeforeVote);

    // And the two-scalar poll every phone in the room hits reads the same unmoved value, which is
    // the surface the signal was actually readable on.
    const polled = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/activities/watermark`,
      headers: as(ADA),
    });
    expect(polled.statusCode, polled.body).toBe(200);
    expect(BigInt(polled.json().activityWatermark as string)).toBe(cursorBeforeVote);

    /*
     * Closing the Poll **does** advance it, through `round_change_advances_activity_watermark`'s
     * `OLD.state IS DISTINCT FROM NEW.state` - which is what carries reveal-on-close to every
     * Member near-live. Dropping the ballot trigger must not take that with it.
     */
    const cursorBeforeClose = await watermark(conferenceId, sessionId);
    await transition(app, conferenceId, sessionId, poll.id, 'close');
    expect((await watermark(conferenceId, sessionId)) > cursorBeforeClose).toBe(true);

    // Neither of the other two cursors moved: a vote must not make every attendee's phone refetch
    // the whole Schedule, nor hand an Organizer a conflict for a Session they never touched.
    const conferenceAfter = await client.query<{ at: string }>(
      'select schedule_watermark_at::text as at from conference where id = $1',
      [conferenceId],
    );
    const sessionAfter = await client.query<{ at: string }>(
      'select last_updated_at::text as at from sessions where id = $1',
      [sessionId],
    );
    expect(conferenceAfter.rows[0]!.at).toBe(conferenceBefore.rows[0]!.at);
    expect(sessionAfter.rows[0]!.at).toBe(sessionBefore.rows[0]!.at);
  });

  /**
   * **Ballots written straight into the table move the cursor by nothing at all** (ADR-007).
   *
   * Deliberately below the API: `insert into vote` on a raw connection is the shortest path there
   * is to the ballot table, so a trigger reattached to it - by a restored migration, by a hand-run
   * `CREATE TRIGGER`, or by a later story copying the old shape - is caught here whatever the route
   * layer does. Read from inside the transaction, where any advance would already be visible.
   *
   * The property this replaced - that `nextval` advances the cursor strictly per write inside one
   * transaction, where `now()` would stamp both writes identically - is not lost with the trigger:
   * it belongs to the writers that still advance the cursor, and `post-it.integration.test.ts`
   * ("produces two distinct values for two post-it writes in one transaction") proves it there.
   */
  it('leaves the cursor unmoved for two ballots written straight into the table', async () => {
    const { poll, options } = await openPoll(newApp());

    const writer = new pg.Client({ connectionString: url });
    await writer.connect();
    try {
      await writer.query('begin');
      const readCursor = async (): Promise<bigint> =>
        BigInt(
          (
            await writer.query<{ at: string }>(
              'select activity_watermark::text as at from round where id = $1',
              [poll.id],
            )
          ).rows[0]!.at,
        );

      const start = await readCursor();
      await writer.query('insert into vote (round_id, option_id) values ($1, $2)', [
        poll.id,
        options['Yes'],
      ]);
      const afterFirst = await readCursor();
      await writer.query('insert into vote (round_id, option_id) values ($1, $2)', [
        poll.id,
        options['No'],
      ]);
      const afterSecond = await readCursor();
      await writer.query('commit');

      expect(afterFirst).toBe(start);
      expect(afterSecond).toBe(start);

      // And nothing is attached to the ballot table that could move it: asked of the live catalogue
      // rather than of migration text, so a trigger created outside a migration is caught too.
      const triggers = await client.query<{ tgname: string }>(
        `select tgname from pg_trigger
          where tgrelid = 'vote'::regclass and not tgisinternal order by 1`,
      );
      expect(triggers.rows).toEqual([]);
    } finally {
      await writer.end();
    }
  });

  // ---------- no application path relates a Vote to its voter (Structural Criteria) ----------

  /**
   * The behavioural half of the anonymity Structural Criteria – the one that does not know the file
   * list (`docs/LEARNINGS.md#testing`).
   *
   * It asks the database the questions an application *could* ask over declared columns and shows
   * they yield two sets and never a pairing, and it reads every payload a caller can obtain and
   * shows no voter reaches one. It says nothing about system columns; see the file note.
   */
  it('yields the set of ballots and the set of voters, and never pairs them', async () => {
    const app = newApp();
    const { conferenceId, sessionId, poll, options } = await openPoll(app);

    const choices = [
      [ADA, 'Yes'],
      [GRACE, 'No'],
      [ROOM[0]!, 'Yes'],
      [ROOM[1]!, 'Not sure'],
    ] as const;
    for (const [sub, label] of choices) {
      expect(
        (await castVote(app, conferenceId, sessionId, poll.id, options[label]!, sub)).statusCode,
      ).toBe(200);
    }

    // The only declared columns the two tables share are `round_id` and an independently random
    // `id`. Joining on the key pairs nothing at all.
    const paired = await client.query<{ n: string }>(
      'select count(*)::text as n from vote v join round_voter rv on rv.id = v.id',
    );
    expect(paired.rows[0]!.n).toBe('0');

    // Joining on what they *do* share yields the cross product - four ballots by four voters, which
    // is sixteen possibilities and therefore no information about any one of them.
    const crossed = await client.query<{ n: string }>(
      'select count(*)::text as n from vote v join round_voter rv on rv.round_id = v.round_id',
    );
    expect(crossed.rows[0]!.n).toBe('16');

    // Nothing on the ballot names a person, in any column, under any name.
    const ballotColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'vote' order by 1`,
    );
    expect(ballotColumns.rows.map((row) => row.column_name)).toEqual([
      'id',
      'option_id',
      'round_id',
    ]);

    /*
     * And the has-voted fact holds a person and nothing else - asked of the live catalogue, the same
     * way, because the structure suite reads the migration *text* and a text reader can only ever
     * see what its regexes are shaped to see. Two column lists read from `information_schema` are
     * the backstop under both: what PostgreSQL actually created, whatever the SQL looked like.
     *
     * `user_sub` is expected *here* and forbidden on the ballot above; the guarantee has never been
     * that no table names a voter, it is that no table names a voter beside a choice.
     */
    const hasVotedColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'round_voter' order by 1`,
    );
    expect(hasVotedColumns.rows.map((row) => row.column_name)).toEqual([
      'id',
      'round_id',
      'user_sub',
    ]);

    // And no payload any actor can obtain carries a `sub` beside a Poll - not the facilitator's
    // full view, not the tally, not an attendee's own.
    for (const reader of [GRACE, ADA, PRIYA]) {
      const payload = await readSession(app, conferenceId, sessionId, reader);
      const poll0 = payload.rounds.find((round) => round.id === poll.id)!;
      const serialized = JSON.stringify(poll0);
      for (const sub of EVERYONE) expect(serialized, reader).not.toContain(sub);
      expect(serialized).not.toMatch(/voter|user_?sub|"sub"|mail/i);

      const tally = await readTally(app, conferenceId, sessionId, poll.id, reader);
      if (tally.statusCode !== 200) continue;
      for (const entry of tally.json().tally as Record<string, unknown>[]) {
        expect(Object.keys(entry).sort()).toEqual(['optionId', 'votes']);
      }
      expect(Object.keys(tally.json())).toEqual(['tally']);
    }
  });

  // ---------- the cursor is a counter, not a clock ----------

  /**
   * **The activity watermark carries no wall-clock time, and is not an instant.**
   *
   * The endpoint serving it is Membership-gated, so every Attendee in the room may poll it. While
   * it was a microsecond timestamp, an Attendee could read the precise instant of each write on the
   * Session - and, until ADR-007 dropped the ballot trigger, that included the instant each ballot
   * landed, though the live tally is deliberately withheld from them
   * (`prd.md#fr5-poll-result-reveal`). Votes no longer move it at all, and what it does still carry
   * is an opaque global sequence's `nextval` rather than a clock reading. This is the guard that
   * goes red if the instant comes back.
   *
   * Three independent readings, because "not a timestamp" can be undone three different ways:
   * the type PostgreSQL actually created, the shape on the wire, and - the one that survives a
   * numeric re-introduction such as an epoch in microseconds - that **waiting** between two writes
   * does not change how far the cursor moves.
   */
  it('serves an opaque counter that carries no wall-clock time', async () => {
    const app = newApp();
    const { conferenceId, sessionId } = await openPoll(app);

    // What PostgreSQL actually created, asked of the live catalogue rather than of migration text.
    const columns = await client.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_name = 'round' and column_name like '%watermark%' order by 1`,
    );
    expect(columns.rows.map((row) => `${row.column_name}:${row.data_type}`)).toEqual([
      'activity_watermark:bigint',
    ]);

    const polled = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/activities/watermark`,
      headers: as(ADA),
    });
    expect(polled.statusCode, polled.body).toBe(200);

    const readings: [string, string | null][] = [
      ['session read', (await readSession(app, conferenceId, sessionId, ADA)).activityWatermark],
      ['two-scalar poll', polled.json().activityWatermark as string | null],
    ];
    for (const [name, value] of readings) {
      // Digits and nothing else: no `-`, no `:`, no `T`, no `Z`, no fractional part.
      expect(value, name).toMatch(/^[0-9]+$/);
      // And not an epoch dressed as an integer - seconds, milliseconds and microseconds since 1970
      // are all past 1.7e9, and a sequence created by a migration starts at 1.
      expect(BigInt(value!) < 1_000_000_000n, name).toBe(true);
    }
    expect(readings[1]![1]).toBe(readings[0]![1]);

    const cursor = async (): Promise<bigint> =>
      BigInt((await readSession(app, conferenceId, sessionId, ADA)).activityWatermark!);

    /*
     * Measured on a **Post-it** write rather than on a Vote. A Vote advances the cursor by nothing
     * at all now (ADR-007), and a delta of zero would say nothing about what the value is - the
     * two readings would agree while the column held anything whatsoever. The Post-it Board is the
     * near-live path that remains, and it is the one an Attendee legitimately polls, so it is the
     * write this reading has to be taken on for the assertion to have any force.
     */
    const board = await addRound(app, conferenceId, sessionId, POST_IT);
    await transition(app, conferenceId, sessionId, board.id, 'open');

    const advanceOnOneContribution = async (sub: string, text: string): Promise<bigint> => {
      const before = await cursor();
      const written = await app.inject({
        method: 'POST',
        url: `${roundsUrl(conferenceId, sessionId)}/${board.id}/post-its`,
        headers: as(sub),
        payload: { text },
      });
      expect(written.statusCode, written.body).toBe(200);
      return (await cursor()) - before;
    };

    const immediately = await advanceOnOneContribution(ADA, 'Handovers');
    const WAITED_MS = 250;
    await new Promise((resolve) => setTimeout(resolve, WAITED_MS));
    const afterWaiting = await advanceOnOneContribution(ROOM[0]!, 'Waiting on approvals');

    // The reading that matters: the second write moved the cursor by exactly as much as the first,
    // though a quarter of a second passed in between. A timestamp in any unit would have moved by
    // the waiting, which is what let a poller time each write on the Session.
    expect(afterWaiting).toBe(immediately);
    expect(afterWaiting < BigInt(WAITED_MS), 'the wait must not appear in the advance').toBe(true);
  });

  // ---------- reversibility (TI01) ----------

  it('applies and rolls back cleanly, taking both tables and both triggers with it', async () => {
    const steps = await stepsToRevertThrough(client, '20260829090000000_vote');
    await migrate('down', String(steps));
    try {
      const relations = await client.query(
        `select tablename from pg_tables where schemaname = 'public'
          and tablename in ('vote', 'round_voter')`,
      );
      expect(relations.rows).toEqual([]);

      const triggers = await client.query(
        `select tgname from pg_trigger
          where tgname in ('vote_advances_activity_watermark',
                           'round_option_advances_activity_watermark')`,
      );
      expect(triggers.rows).toEqual([]);
    } finally {
      await migrate('up');
    }

    const back = await client.query<{ present: boolean }>(
      `select exists (select 1 from information_schema.tables where table_name = 'vote') as present`,
    );
    expect(back.rows[0]!.present).toBe(true);
  });

  /**
   * ADR-007's own migration, both ways.
   *
   * The down step is not decoration: it has to put back exactly the trigger
   * `20260829090000000_vote.sql` created, or that migration's own down step no longer finds what it
   * drops and the whole chain stops being reversible. So the reading is taken in both directions -
   * rolled back, the ballot trigger is on `vote` again; rolled forward, it is gone - asked of
   * `pg_trigger` rather than of migration text.
   */
  it('drops the ballot trigger going up and restores it going down', async () => {
    const ballotTriggers = async (): Promise<string[]> =>
      (
        await client.query<{ tgname: string }>(
          `select tgname from pg_trigger
            where tgrelid = 'vote'::regclass and not tgisinternal order by 1`,
        )
      ).rows.map((row) => row.tgname);

    expect(await ballotTriggers()).toEqual([]);

    const steps = await stepsToRevertThrough(client, '20260831090000000_vote-advances-no-cursor');
    await migrate('down', String(steps));
    try {
      expect(await ballotTriggers()).toEqual(['vote_advances_activity_watermark']);
    } finally {
      await migrate('up');
    }

    expect(await ballotTriggers()).toEqual([]);
  });
});
