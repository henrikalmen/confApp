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
import { createRoundRepository } from '../src/rounds/round-repository.ts';
import { fixedClock } from '../src/conferences/calendar-date.ts';
import type { BallotGate } from '../src/rounds/ballot-gate.ts';
import { subjectVerifier, tokenFor, unusedCodeExchange } from './fake-auth.ts';
import { stepsToRevertThrough } from './migration-depth.ts';

/**
 * S01's Round authoring and lifecycle, against the real PostgreSQL the composed stack runs.
 *
 * Every rule proved here is a storage-level guarantee or an authority decision – the two-level kind
 * / purpose constraint, the reopen rule that lives in an UPDATE predicate, the Session Assignment
 * narrowing, the untouched schedule watermark – and none is provable against a fake that answers
 * whatever the test wants.
 *
 * **The ballot gate is the production binding everywhere except the frozen-content scenario**,
 * which binds a port answering `true` because Vote storage is S03's. That is the one seam this
 * story leaves for S03 TI08 to discharge, so a test that stubbed it everywhere would hide the fact
 * that an unvoted Poll is freely editable today.
 *
 * The verifier is stubbed, because who the caller is was settled in the S02 suite and the subject
 * here is what that caller may do.
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
    '\n[integration] SKIPPED round authoring and lifecycle – no PostgreSQL at TEST_DATABASE_URL.\n' +
      '[integration] Start the stack first: docker compose up -d\n',
  );
}

async function migrate(...args: string[]): Promise<void> {
  await run(process.execPath, [join(repoRoot, 'db', 'migrate.mjs'), ...args], {
    cwd: join(repoRoot, 'db'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

/** Priya organizes; Ida facilitates one workshop; Björn is simply in the room. */
const PRIYA = 'google-sub-priya';
const IDA = 'google-sub-ida';
const BJORN = 'google-sub-bjorn';

const AUTUMN = { name: 'Autumn Offsite', startDate: '2026-09-15', endDate: '2026-09-16' };

const WAYS_OF_WORKING = {
  title: 'Ways of Working',
  kind: 'Workshop',
  day: '2026-09-15',
  startTime: '13:00',
  endTime: '15:00',
  location: 'Room 2',
};

const KEYNOTE = {
  title: 'Opening Keynote',
  kind: 'Presentation',
  day: '2026-09-15',
  startTime: '09:00',
  endTime: '10:30',
  location: 'Main Hall',
};

const POST_IT = { kind: 'PostItRound', prompt: 'What slows us down most?' };

const POLL = {
  kind: 'VotingRound',
  purpose: 'Poll',
  prompt: 'Where should we start?',
  options: ['Tooling', 'Meetings', 'Handovers'],
};

interface WireRound {
  id: string;
  kind: string;
  purpose?: string;
  prompt: string;
  state: string;
  options?: { id: string; label: string }[];
}

describe.skipIf(!reachable)('round authoring and lifecycle against a real PostgreSQL', () => {
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
    // Conference rows cascade to sessions, rounds, options, memberships and role assignments.
    await client.query('delete from conference');
    await client.query('delete from app_user');

    const users = createUserRepository(db);
    for (const sub of [PRIYA, IDA, BJORN]) {
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

  /** The app under test. `ballotGate` defaults to the production binding – see the file note. */
  function appWith(ballotGate?: BallotGate): FastifyInstance {
    const app = buildApp({
      db,
      auth: {
        verifier: subjectVerifier(),
        users: createUserRepository(db),
        codeExchange: unusedCodeExchange(),
      },
      clock: fixedClock('2026-09-15'),
      ...(ballotGate ? { ballotGate } : {}),
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
   * "Autumn Offsite", published, with two Sessions; Ida facilitates "Ways of Working" and nothing
   * else; Björn is a Member with no Role Assignment at all.
   */
  async function autumnOffsite(app: FastifyInstance): Promise<{
    conferenceId: string;
    waysOfWorking: string;
    keynote: string;
  }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conferences',
      headers: as(PRIYA),
      payload: AUTUMN,
    });
    expect(created.statusCode, created.body).toBe(200);
    const conferenceId = created.json().id as string;

    const sessionIds: string[] = [];
    for (const details of [KEYNOTE, WAYS_OF_WORKING]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/conferences/${conferenceId}/sessions`,
        headers: as(PRIYA),
        payload: details,
      });
      expect(response.statusCode, response.body).toBe(200);
      sessionIds.push(response.json().session.id as string);
    }
    const [keynote, waysOfWorking] = sessionIds as [string, string];

    for (const sub of [IDA, BJORN]) await addMember(conferenceId, sub);

    const granted = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/members/roles`,
      headers: as(PRIYA),
      payload: { email: `${IDA}@ourcompany.example`, role: 'PresenterFacilitator' },
    });
    expect(granted.statusCode, granted.body).toBe(200);

    const assigned = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions/${waysOfWorking}/assignments`,
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

    return { conferenceId, waysOfWorking, keynote };
  }

  function addRound(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    payload: Record<string, unknown>,
    sub = IDA,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds`,
      headers: as(sub),
      payload,
    });
  }

  function transition(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    move: 'open' | 'close',
    sub = IDA,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}/${move}`,
      headers: as(sub),
    });
  }

  function editRound(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    roundId: string,
    payload: Record<string, unknown>,
    sub = IDA,
  ) {
    return app.inject({
      method: 'PATCH',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}/rounds/${roundId}`,
      headers: as(sub),
      payload,
    });
  }

  async function readSession(
    app: FastifyInstance,
    conferenceId: string,
    sessionId: string,
    sub = IDA,
  ): Promise<{ session: Record<string, unknown>; rounds: WireRound[]; canRun: boolean }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
      headers: as(sub),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  // ---------- Acceptance Scenario S01 (TI01, TI02, TI03, TI05, TI07, TI09, TI10) ----------

  it('lets the assigned facilitator author a post-it round and a poll, both closed', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);

    for (const payload of [POST_IT, POLL]) {
      const response = await addRound(app, conferenceId, waysOfWorking, payload);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().round.state).toBe('closed');
    }

    const { rounds } = await readSession(app, conferenceId, waysOfWorking);

    // Authored order, the two Activity kinds the domain names, and neither running.
    expect(rounds.map((round) => round.kind)).toEqual(['PostItRound', 'VotingRound']);
    expect(rounds.map((round) => round.prompt)).toEqual([
      'What slows us down most?',
      'Where should we start?',
    ]);
    expect(rounds.map((round) => round.state)).toEqual(['closed', 'closed']);

    // A Poll is a Voting Round whose *purpose* is Poll – never a kind of its own.
    expect(rounds[0]!.purpose).toBeUndefined();
    expect(rounds[1]!.purpose).toBe('Poll');
    expect(rounds[1]!.options?.map((option) => option.label)).toEqual([
      'Tooling',
      'Meetings',
      'Handovers',
    ]);

    // A Post-it Round carries no option list at all.
    expect(rounds[0]!.options).toBeUndefined();
  });

  // ---------- Acceptance Scenario S02 (TI05, TI07) ----------

  it('refuses authoring on a session the actor is not assigned to, and keeps it readable', async () => {
    const app = appWith();
    const { conferenceId, keynote, waysOfWorking } = await autumnOffsite(app);

    // Something already on the keynote, so "the session stays readable" has content to prove.
    const seeded = await addRound(app, conferenceId, keynote, POST_IT, PRIYA);
    expect(seeded.statusCode, seeded.body).toBe(200);

    const refused = await addRound(app, conferenceId, keynote, {
      kind: 'PostItRound',
      prompt: 'Anything from the keynote?',
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');

    const stored = await client.query(
      'select count(*)::int as count from round where session_id = $1',
      [keynote],
    );
    expect(stored.rows[0].count).toBe(1);

    // Ida can still read the keynote and the round it already holds.
    const keynoteView = await readSession(app, conferenceId, keynote);
    expect(keynoteView.rounds).toHaveLength(1);
    expect(keynoteView.canRun).toBe(false);

    // …and Björn, a Member with no Role Assignment, is refused the same write on her own session.
    const bjorn = await addRound(app, conferenceId, waysOfWorking, POST_IT, BJORN);
    expect(bjorn.statusCode).toBe(403);
    expect(bjorn.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');
  });

  it('lets an admin author on any session of their conference, and refuses an archived one', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);

    const admin = await addRound(app, conferenceId, waysOfWorking, POST_IT, PRIYA);
    expect(admin.statusCode, admin.body).toBe(200);

    // Archived is read-only, and a Round write is a write like any other (FR2 → Error Handling).
    await client.query("update conference set lifecycle_state = 'archived' where id = $1", [
      conferenceId,
    ]);
    const refused = await addRound(app, conferenceId, waysOfWorking, POLL);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('CONFERENCE_NOT_EDITABLE');
  });

  // ---------- Acceptance Scenario S03 (TI03, TI06, TI07) ----------

  it('opens one round without closing another, and every member reads both states', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);

    const postIt = (await addRound(app, conferenceId, waysOfWorking, POST_IT)).json()
      .round as WireRound;
    const second = (
      await addRound(app, conferenceId, waysOfWorking, {
        kind: 'PostItRound',
        prompt: 'What should we keep?',
      })
    ).json().round as WireRound;

    expect((await transition(app, conferenceId, waysOfWorking, second.id, 'open')).statusCode).toBe(
      200,
    );
    expect((await transition(app, conferenceId, waysOfWorking, postIt.id, 'open')).statusCode).toBe(
      200,
    );

    // Björn holds Membership and no Role Assignment: he reads both states and is offered nothing.
    const seen = await readSession(app, conferenceId, waysOfWorking, BJORN);
    expect(seen.canRun).toBe(false);
    expect(seen.rounds.map((round) => round.state)).toEqual(['open', 'open']);

    // The assigned Facilitator gets the controls.
    expect((await readSession(app, conferenceId, waysOfWorking)).canRun).toBe(true);

    const closed = await transition(app, conferenceId, waysOfWorking, postIt.id, 'close');
    expect(closed.statusCode, closed.body).toBe(200);

    const after = await readSession(app, conferenceId, waysOfWorking, BJORN);
    expect(after.rounds.map((round) => round.state)).toEqual(['closed', 'open']);
  });

  it('refuses the session read to a non-member', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);
    await client.query('delete from membership where conference_id = $1 and user_sub = $2', [
      conferenceId,
      BJORN,
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/sessions/${waysOfWorking}`,
      headers: as(BJORN),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('NOT_A_MEMBER');
  });

  it('refuses a transition attempted by a caller with no session assignment', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);
    const round = (await addRound(app, conferenceId, waysOfWorking, POST_IT)).json()
      .round as WireRound;

    const refused = await transition(app, conferenceId, waysOfWorking, round.id, 'open', BJORN);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');

    const state = await client.query('select state from round where id = $1', [round.id]);
    expect(state.rows[0].state).toBe('closed');
  });

  it('refuses open and close on a round of an archived conference, leaving the state alone', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);
    const round = (await addRound(app, conferenceId, waysOfWorking, POST_IT)).json()
      .round as WireRound;
    expect((await transition(app, conferenceId, waysOfWorking, round.id, 'open')).statusCode).toBe(
      200,
    );

    await client.query("update conference set lifecycle_state = 'archived' where id = $1", [
      conferenceId,
    ]);

    for (const move of ['open', 'close'] as const) {
      const refused = await transition(app, conferenceId, waysOfWorking, round.id, move);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe('CONFERENCE_NOT_EDITABLE');
    }

    const state = await client.query('select state from round where id = $1', [round.id]);
    expect(state.rows[0].state).toBe('open');
  });

  // ---------- Acceptance Scenario S04 (TI03, TI06) ----------

  it('reopens a closed post-it round, however many times it has run', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);
    const round = (await addRound(app, conferenceId, waysOfWorking, POST_IT)).json()
      .round as WireRound;

    for (const move of ['open', 'close', 'open', 'close', 'open'] as const) {
      const response = await transition(app, conferenceId, waysOfWorking, round.id, move);
      expect(response.statusCode, `${move}: ${response.body}`).toBe(200);
      expect(response.json().round.state).toBe(move === 'open' ? 'open' : 'closed');
    }
  });

  // ---------- Acceptance Scenario S05 (TI03, TI06) ----------

  it('refuses to reopen a poll that has run, in the sentence the room needs', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);

    const ran = (await addRound(app, conferenceId, waysOfWorking, POLL)).json().round as WireRound;
    const neverOpened = (
      await addRound(app, conferenceId, waysOfWorking, {
        ...POLL,
        prompt: 'And after that?',
        options: ['Docs', 'Onboarding'],
      })
    ).json().round as WireRound;

    expect((await transition(app, conferenceId, waysOfWorking, ran.id, 'open')).statusCode).toBe(
      200,
    );
    expect((await transition(app, conferenceId, waysOfWorking, ran.id, 'close')).statusCode).toBe(
      200,
    );

    const refused = await transition(app, conferenceId, waysOfWorking, ran.id, 'open');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe(
      'A poll cannot be reopened once its results are shown.',
    );
    expect(refused.json().error.code).toBe('ROUND_TRANSITION_NOT_PERMITTED');
    expect(refused.json().error.code).not.toBe('CONFERENCE_ROLE_REQUIRED');

    const state = await client.query('select state from round where id = $1', [ran.id]);
    expect(state.rows[0].state).toBe('closed');

    // "Created closed" is not "already run": the poll nobody opened opens normally.
    const opened = await transition(app, conferenceId, waysOfWorking, neverOpened.id, 'open');
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json().round.state).toBe('open');
  });

  // ---------- Acceptance Scenario S06 (TI03, TI04, TI05) ----------

  it('edits a post-it prompt mid-round and a poll while no vote exists', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);

    const postIt = (await addRound(app, conferenceId, waysOfWorking, POST_IT)).json()
      .round as WireRound;
    const poll = (await addRound(app, conferenceId, waysOfWorking, POLL)).json().round as WireRound;

    expect((await transition(app, conferenceId, waysOfWorking, postIt.id, 'open')).statusCode).toBe(
      200,
    );

    const clarified = await editRound(app, conferenceId, waysOfWorking, postIt.id, {
      kind: 'PostItRound',
      prompt: 'What slows us down most, day to day?',
    });
    expect(clarified.statusCode, clarified.body).toBe(200);
    // The prompt is editable *at any time* – and the round keeps running across the edit.
    expect(clarified.json().round.state).toBe('open');

    const renamed = await editRound(app, conferenceId, waysOfWorking, poll.id, {
      ...POLL,
      options: ['Tooling and CI', 'Meetings', 'Handovers', 'Documentation'],
    });
    expect(renamed.statusCode, renamed.body).toBe(200);

    const { rounds } = await readSession(app, conferenceId, waysOfWorking);
    expect(rounds[0]!.prompt).toBe('What slows us down most, day to day?');
    expect(rounds[0]!.state).toBe('open');
    // Authored order kept, with the new option last.
    expect(rounds[1]!.options?.map((option) => option.label)).toEqual([
      'Tooling and CI',
      'Meetings',
      'Handovers',
      'Documentation',
    ]);
  });

  // ---------- Acceptance Scenario S07 (TI02, TI04, TI05) ----------

  it('freezes a poll question and options once a vote exists, and leaves post-its editable', async () => {
    // The one place the port is bound to `true`: Vote storage is S03's, and this is the binding
    // S03 TI08 replaces with the real existence query.
    const voted: BallotGate = { hasAnyVote: async () => true };
    const app = appWith(voted);
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);

    const poll = (await addRound(app, conferenceId, waysOfWorking, POLL)).json().round as WireRound;
    const postIt = (await addRound(app, conferenceId, waysOfWorking, POST_IT)).json()
      .round as WireRound;

    const question = await editRound(app, conferenceId, waysOfWorking, poll.id, {
      ...POLL,
      prompt: 'Where should we really start?',
    });
    expect(question.statusCode).toBe(409);
    expect(question.json().error.code).toBe('POLL_CONTENT_FROZEN');

    const options = await editRound(app, conferenceId, waysOfWorking, poll.id, {
      ...POLL,
      options: ['Tooling', 'Meetings'],
    });
    expect(options.statusCode).toBe(409);
    expect(options.json().error.code).toBe('POLL_CONTENT_FROZEN');

    // Nothing was persisted by either refusal.
    const stored = await client.query('select prompt from round where id = $1', [poll.id]);
    expect(stored.rows[0].prompt).toBe('Where should we start?');
    const labels = await client.query(
      'select label from round_option where round_id = $1 order by position',
      [poll.id],
    );
    expect(labels.rows.map((row) => row.label)).toEqual(['Tooling', 'Meetings', 'Handovers']);

    // The post-it round in the same session is untouched by the freeze.
    const prompt = await editRound(app, conferenceId, waysOfWorking, postIt.id, {
      kind: 'PostItRound',
      prompt: 'What slows us down most, day to day?',
    });
    expect(prompt.statusCode, prompt.body).toBe(200);
  });

  /**
   * Discovered while implementing TI05 – see the FIS's Discovered Requirements.
   *
   * The edit body carries `kind` because it is validated by the same rules the create path uses,
   * and the repository only ever changes the prompt and the option set. Without this refusal a Poll
   * edited as a `PostItRound` would keep its options while the caller was told the change landed.
   */
  it("refuses an edit that would change a round's kind or purpose", async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);
    const poll = (await addRound(app, conferenceId, waysOfWorking, POLL)).json().round as WireRound;

    const refused = await editRound(app, conferenceId, waysOfWorking, poll.id, {
      kind: 'PostItRound',
      prompt: 'Where should we start?',
    });
    expect(refused.statusCode).toBe(409);
    // Its own code: "fix the value you sent" and "this can never be changed" are different next
    // actions, and this story's own convention is one code per reason.
    expect(refused.json().error.code).toBe('ROUND_KIND_IMMUTABLE');
    expect(refused.json().error.details.map((detail: { field: string }) => detail.field)).toContain(
      'kind',
    );

    // A kind the domain does not name is still a field error, not an immutability refusal - the
    // caller sent a typo, not a change that is forbidden.
    const garbage = await editRound(app, conferenceId, waysOfWorking, poll.id, {
      kind: 'Poll',
      prompt: 'Where should we start?',
    });
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json().error.code).toBe('ROUND_KIND_INVALID');

    // Nothing moved: the round is still a Poll and still holds the options its ballots will use.
    const { rounds } = await readSession(app, conferenceId, waysOfWorking);
    expect(rounds[0]!.kind).toBe('VotingRound');
    expect(rounds[0]!.purpose).toBe('Poll');
    expect(rounds[0]!.options?.map((option) => option.label)).toEqual([
      'Tooling',
      'Meetings',
      'Handovers',
    ]);
  });

  it('refuses a bad round field-level, naming the offending field, and persists nothing', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);

    const cases: { payload: Record<string, unknown>; code: string; field: string }[] = [
      {
        payload: { ...POLL, options: ['Tooling'] },
        code: 'ROUND_OPTIONS_INVALID',
        field: 'options',
      },
      {
        payload: { ...POLL, options: ['Tooling', 'Tooling'] },
        code: 'ROUND_OPTIONS_INVALID',
        field: 'options',
      },
      { payload: { ...POLL, prompt: '   ' }, code: 'ROUND_PROMPT_INVALID', field: 'prompt' },
      {
        payload: { ...POLL, prompt: 'x'.repeat(501) },
        code: 'ROUND_PROMPT_INVALID',
        field: 'prompt',
      },
      {
        payload: { kind: 'VotingRound', prompt: 'Where?', options: ['A', 'B'] },
        code: 'ROUND_KIND_INVALID',
        field: 'purpose',
      },
      { payload: { ...POLL, purpose: 'Rating' }, code: 'ROUND_KIND_INVALID', field: 'purpose' },
      { payload: { ...POST_IT, purpose: 'Poll' }, code: 'ROUND_KIND_INVALID', field: 'purpose' },
      { payload: { ...POST_IT, kind: 'Poll' }, code: 'ROUND_KIND_INVALID', field: 'kind' },
    ];

    for (const { payload, code, field } of cases) {
      const response = await addRound(app, conferenceId, waysOfWorking, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      const error = response.json().error;
      expect(error.code, JSON.stringify(payload)).toBe(code);
      expect(error.details.map((detail: { field: string }) => detail.field)).toContain(field);
      expect(error.code).not.toBe('CONFERENCE_ROLE_REQUIRED');
    }

    const stored = await client.query('select count(*)::int as count from round');
    expect(stored.rows[0].count).toBe(0);

    // A post-it round needs no options at all.
    const fine = await addRound(app, conferenceId, waysOfWorking, POST_IT);
    expect(fine.statusCode, fine.body).toBe(200);
  });

  // ---------- Structural Criteria proved against the database, not the source ----------

  it('makes the kind, purpose and state constraints unwritable through SQL itself', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);

    const insert = (columns: string, values: unknown[]): Promise<unknown> =>
      client.query(
        `insert into round (conference_id, session_id, position, ${columns}) values ($1, $2, 0, ${values
          .map((_value, index) => `$${index + 3}`)
          .join(', ')})`,
        [conferenceId, waysOfWorking, ...values],
      );

    const rejected: [string, string, unknown[]][] = [
      ['a kind the domain does not name', 'kind, purpose, prompt', ['Prioritization', null, 'x']],
      ['a purpose used as a kind', 'kind, purpose, prompt', ['Poll', null, 'x']],
      ['a purpose outside the list', 'kind, purpose, prompt', ['VotingRound', 'Rating', 'x']],
      ['a purpose on a post-it round', 'kind, purpose, prompt', ['PostItRound', 'Poll', 'x']],
      ['a voting round with no purpose', 'kind, purpose, prompt', ['VotingRound', null, 'x']],
      ['a third state', 'kind, prompt, state', ['PostItRound', 'x', 'paused']],
      ['a blank prompt', 'kind, prompt', ['PostItRound', '   ']],
    ];

    for (const [what, columns, values] of rejected) {
      await expect(insert(columns, values), what).rejects.toThrow();
    }

    // …and two identically-labelled options in one round.
    const round = (await addRound(app, conferenceId, waysOfWorking, POLL)).json()
      .round as WireRound;
    await expect(
      client.query('insert into round_option (round_id, position, label) values ($1, 9, $2)', [
        round.id,
        'Tooling',
      ]),
    ).rejects.toThrow();
  });

  it('takes a session down with its rounds and their options', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);
    await addRound(app, conferenceId, waysOfWorking, POLL);

    await client.query('delete from sessions where id = $1', [waysOfWorking]);

    const rounds = await client.query('select count(*)::int as count from round');
    const options = await client.query('select count(*)::int as count from round_option');
    expect(rounds.rows[0].count).toBe(0);
    expect(options.rows[0].count).toBe(0);
  });

  /**
   * A Round belongs inside its own Conference, and the composite foreign key is what makes the
   * alternative unwritable rather than merely unwritten.
   */
  it('refuses a round naming a session that belongs to another conference', async () => {
    const app = appWith();
    const first = await autumnOffsite(app);
    const other = await app.inject({
      method: 'POST',
      url: '/api/conferences',
      headers: as(PRIYA),
      payload: { name: 'Spring Offsite', startDate: '2026-03-02', endDate: '2026-03-03' },
    });
    const otherId = other.json().id as string;

    await expect(
      client.query(
        `insert into round (conference_id, session_id, kind, prompt, position)
         values ($1, $2, 'PostItRound', 'x', 0)`,
        [otherId, first.waysOfWorking],
      ),
    ).rejects.toThrow();
  });

  // ---------- the propagation mechanisms this story must leave alone (TI07) ----------

  it('advances no schedule watermark and adds no round field to the attendee envelope', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);

    async function watermark(): Promise<string | null> {
      const response = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/schedule/watermark`,
        headers: as(BJORN),
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().lastUpdatedAt as string | null;
    }

    async function envelope(): Promise<Record<string, unknown>> {
      const response = await app.inject({
        method: 'GET',
        url: `/api/conferences/${conferenceId}/schedule`,
        headers: as(BJORN),
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    }

    const before = await watermark();
    const beforeEnvelope = await envelope();

    const round = (await addRound(app, conferenceId, waysOfWorking, POLL)).json()
      .round as WireRound;
    await transition(app, conferenceId, waysOfWorking, round.id, 'open');
    await editRound(app, conferenceId, waysOfWorking, round.id, {
      ...POLL,
      prompt: 'Where should we begin?',
    });
    await transition(app, conferenceId, waysOfWorking, round.id, 'close');

    // Confirmed against the live watermark endpoint, not only against the source.
    expect(await watermark()).toBe(before);
    // The envelope every offline cache stores verbatim is byte-identical.
    expect(JSON.stringify(await envelope())).toBe(JSON.stringify(beforeEnvelope));
    expect(JSON.stringify(beforeEnvelope)).not.toMatch(/round/i);
  });

  /**
   * **No Round carries a cursor, and the Session carries exactly one.**
   *
   * S01 asserted "no cursor of any name anywhere on this payload", because at the time the only
   * correct number of cursors was zero – S02 had not built one yet. S02 built it
   * (`plan.json#sharedDecisions` → "Near-live propagation: one cursor"), so the property this
   * story actually needs guarded is the one that survives: a **Session-level**
   * `activityWatermark`, beside the data it describes and matching the two-scalar poll, and
   * **nothing cursor-shaped on a Round**. A per-Round cursor is one a client would poll per Round,
   * which is the second mechanism that decision removed – and it is what this still refuses.
   */
  it('puts no timestamp, version or cursor field on any round, and exactly one on the session', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);
    const poll = (await addRound(app, conferenceId, waysOfWorking, POLL)).json().round as WireRound;
    await addRound(app, conferenceId, waysOfWorking, POST_IT);
    await transition(app, conferenceId, waysOfWorking, poll.id, 'open');

    const payload = await readSession(app, conferenceId, waysOfWorking);

    const expectedKeys: Record<string, string[]> = {
      /*
       * A Poll: its options, and no board - post-its and their cap belong to a Post-it Round.
       *
       * S03 adds the two fields a Poll needs and nothing more: `hasVoted`, which is about the
       * *caller* and nobody else, and `tally`, counts per option, present here because this read is
       * taken by the assigned facilitator while the Poll runs. An Attendee reading the same open
       * Poll gets `hasVoted` and no `tally` key at all - asserted in `vote.integration.test.ts`,
       * which is also where "no key names another member's vote" is pinned.
       */
      VotingRound: ['hasVoted', 'id', 'kind', 'options', 'prompt', 'purpose', 'state', 'tally'],
      /*
       * A Post-it Round: its Board **grouped**, and the text cap the compose box renders from (S02
       * TI06; facilitator-board S02 TI05).
       *
       * `categories` and `uncategorised` replaced the flat `postIts` array outright rather than
       * joining it. A Post-it appears exactly once in the payload, and `uncategorised` is here
       * whether or not any Category is - it is where every Post-it arrives and a Board archived with
       * Post-its still in it is a valid terminal state the payload has to represent.
       */
      PostItRound: [
        'categories',
        'id',
        'kind',
        'prompt',
        'state',
        'textMaxLength',
        'uncategorised',
      ],
    };

    expect(payload.rounds.length).toBe(2);
    for (const wire of payload.rounds) {
      expect(Object.keys(wire).sort()).toEqual(expectedKeys[wire.kind]!.sort());
      // Nothing instant-shaped, under any name, on a Round.
      for (const key of Object.keys(wire)) {
        expect(key, `${wire.kind}.${key}`).not.toMatch(/at$|version|watermark|cursor|updated/i);
      }
    }

    /*
     * `canRemovePermanently` is S06's second capability flag, beside `canRun` rather than folded
     * into it: `canRun` is true for an assigned Facilitator and for an Admin alike, and Permanent
     * Removal is the one act on this surface the two differ on (FR5).
     */
    expect(Object.keys(payload).sort()).toEqual(
      ['activityWatermark', 'canRemovePermanently', 'canRun', 'rounds', 'session'].sort(),
    );
  });

  // ---------- reversibility (TI01) ----------

  /**
   * `canRun` answers "will these controls work", not "do you hold the authority". An archived
   * Conference accepts no write, so a holder reading one is offered nothing to press.
   */
  it('reports canRun false on an archived conference, to the assigned facilitator', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);
    await addRound(app, conferenceId, waysOfWorking, POST_IT);

    expect((await readSession(app, conferenceId, waysOfWorking)).canRun).toBe(true);

    await client.query("update conference set lifecycle_state = 'archived' where id = $1", [
      conferenceId,
    ]);

    const archived = await readSession(app, conferenceId, waysOfWorking);
    // Readable, not invisible - archiving makes a conference read-only (FR9).
    expect(archived.rounds).toHaveLength(1);
    expect(archived.canRun).toBe(false);
  });

  /**
   * A draft has been published to nobody, so its Session read is open to its own role holders and to
   * no one else. Both halves are exercised: the branch is otherwise unreachable in this suite,
   * because every other scenario publishes.
   */
  it('lets a role holder read a draft session and refuses a plain member', async () => {
    const app = appWith();
    const created = await app.inject({
      method: 'POST',
      url: '/api/conferences',
      headers: as(PRIYA),
      payload: AUTUMN,
    });
    const conferenceId = created.json().id as string;

    const session = await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/sessions`,
      headers: as(PRIYA),
      payload: WAYS_OF_WORKING,
    });
    const sessionId = session.json().session.id as string;

    for (const sub of [IDA, BJORN]) await addMember(conferenceId, sub);
    await app.inject({
      method: 'POST',
      url: `/api/conferences/${conferenceId}/members/roles`,
      headers: as(PRIYA),
      payload: { email: `${IDA}@ourcompany.example`, role: 'PresenterFacilitator' },
    });

    // Authored ahead of publication - the whole point of US01.
    const authored = await addRound(app, conferenceId, sessionId, POST_IT, PRIYA);
    expect(authored.statusCode, authored.body).toBe(200);

    const holder = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
      headers: as(IDA),
    });
    expect(holder.statusCode, holder.body).toBe(200);
    expect(holder.json().rounds).toHaveLength(1);

    const member = await app.inject({
      method: 'GET',
      url: `/api/conferences/${conferenceId}/sessions/${sessionId}`,
      headers: as(BJORN),
    });
    expect(member.statusCode).toBe(403);
    expect(member.json().error.code).toBe('CONFERENCE_ROLE_REQUIRED');
  });

  /**
   * TI03's transaction, driven at the repository rather than through the API.
   *
   * The route can never reach it - validation refuses a duplicate label first - so this is the only
   * way to prove the Round row does not survive a failed option insert.
   */
  it('leaves no round behind when the option insert fails', async () => {
    const app = appWith();
    const { conferenceId, waysOfWorking } = await autumnOffsite(app);
    const rounds = createRoundRepository(db);

    await expect(
      rounds.create(conferenceId, waysOfWorking, {
        kind: 'VotingRound',
        purpose: 'Poll',
        prompt: 'Where should we start?',
        // Refused by round_option_unique_label, which the API's own validation mirrors.
        options: ['Tooling', 'Tooling'],
      }),
    ).rejects.toThrow();

    const stored = await client.query('select count(*)::int as count from round');
    expect(stored.rows[0].count).toBe(0);
  });

  it('reverts cleanly, leaving no round or round_option relation', async () => {
    const steps = await stepsToRevertThrough(client, '20260828090000000_round');
    await migrate('down', String(steps));
    try {
      const relations = await client.query(
        `select tablename from pg_tables where schemaname = 'public'
          and tablename in ('round', 'round_option')`,
      );
      expect(relations.rows).toEqual([]);
    } finally {
      await migrate('up');
    }
  });
});
