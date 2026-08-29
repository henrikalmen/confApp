import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { createBallotGate } from '../src/rounds/ballot-gate.ts';
import { fakeDatabase } from './fake-db.ts';
import { fakeAuth } from './fake-auth.ts';

/**
 * S01's Structural Criteria – the ones that are properties of the source itself rather than of a
 * request.
 *
 * They read the files on disk on purpose. Each guards a decision a later story could undo by
 * writing perfectly working code: a second Round cursor, a poll loop of its own, a Round field on
 * the cached schedule envelope, an inline role check, a watermark advanced "so attendees see it".
 * None of those would fail a behavioural test, and every one of them would cost the bundle a
 * mechanism it has already decided to have exactly one of.
 *
 * Every marker is asserted **found** rather than skipped when absent (`docs/LEARNINGS.md#testing`),
 * and the file-list assertions are paid for behaviourally in `round.integration.test.ts`, which
 * drives the same properties through real requests against real PostgreSQL.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, '..', 'src');
const repoRoot = join(here, '..', '..');
const webSrc = join(repoRoot, 'web', 'src');

const MIGRATION = '20260828090000000_round.sql';

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

/** Comments explain the rules; matching them would make these tests assert their own prose. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function withoutSqlComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, '');
}

/** Every `.ts`/`.tsx` file under a directory, as repo-relative paths. */
function sourcesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

// ---------- the migration (TI01) ----------

describe('the round migration', () => {
  const raw = read(repoRoot, 'db', 'migrations', MIGRATION);
  const sql = withoutSqlComments(raw);
  const [up, down] = raw.split(/^-- Down Migration$/m) as [string, string];

  /** Plain PostgreSQL only – portability is why PostgreSQL was chosen (ADR-003). */
  it('uses no extension and no provider-specific feature', () => {
    expect(sql).not.toMatch(/create\s+extension/i);
    expect(sql).not.toMatch(/pgcrypto|uuid-ossp|azure|citus|timescale|aurora/i);
  });

  it('is reversible – every table and index it creates, the down step removes', () => {
    const created = {
      tables: [...up.matchAll(/create table (\w+)/gi)].map((m) => m[1]),
      indexes: [...up.matchAll(/create index (\w+)/gi)].map((m) => m[1]),
    };
    const dropped = {
      tables: [...down.matchAll(/drop table (\w+)/gi)].map((m) => m[1]),
      indexes: [...down.matchAll(/drop index (\w+)/gi)].map((m) => m[1]),
    };

    expect(new Set(created.tables)).toEqual(new Set(['round', 'round_option']));
    for (const kind of ['tables', 'indexes'] as const) {
      expect(created[kind].length, `${kind} should be created`).toBeGreaterThan(0);
      expect(new Set(dropped[kind]), kind).toEqual(new Set(created[kind]));
    }
  });

  /**
   * A Round is reachable only inside its own Conference. A bare `session_id` would leave
   * "conference-scoped" a field the application remembers to populate correctly.
   */
  it('hangs the round off (session_id, conference_id), cascading, never a bare session_id', () => {
    expect(sql).toMatch(
      /FOREIGN KEY \(session_id, conference_id\) REFERENCES sessions \(id, conference_id\)\s*\n?\s*ON DELETE CASCADE/i,
    );
    expect(sql).not.toMatch(/session_id\s+uuid\s+NOT NULL\s+REFERENCES/i);
    expect(sql).toMatch(/round_id\s+uuid\s+NOT NULL REFERENCES round \(id\) ON DELETE CASCADE/i);
  });

  /** Kind, purpose and state are storage-level guarantees, not handler conventions (FR1). */
  it('constrains kind, purpose and state in SQL, at both levels of the activity model', () => {
    expect(sql).toMatch(/CHECK \(kind IN \('PostItRound', 'VotingRound'\)\)/);
    expect(sql).toMatch(/CHECK \(purpose IS NULL OR purpose IN \('Poll'\)\)/);
    // purpose IS NOT NULL exactly when the kind is VotingRound – the two-level rule itself.
    expect(sql).toMatch(/CHECK \(\(kind = 'VotingRound'\) = \(purpose IS NOT NULL\)\)/);
    expect(sql).toMatch(/CHECK \(state IN \('open', 'closed'\)\)/);
    expect(sql).toMatch(/state\s+text\s+NOT NULL DEFAULT 'closed'/);
    // A Poll is never a kind, at any point in the schema.
    expect(sql).not.toMatch(/kind IN \([^)]*'Poll'/);
  });

  /**
   * **This story adds no cursor.** `round.activity_watermark` and its triggers are S02's
   * (`plan.json#sharedDecisions` → "Near-live propagation: one cursor"); a second timestamp of
   * identical semantics is the duplication that decision removed.
   */
  it('declares no timestamp column beyond closed_at and no trigger at all', () => {
    const timestamps = [...sql.matchAll(/^\s*(\w+)\s+timestamptz/gim)].map((match) => match[1]);
    expect(timestamps).toEqual(['closed_at']);

    expect(sql).not.toMatch(/create\s+trigger/i);
    expect(sql).not.toMatch(/create\s+function/i);
    expect(sql).not.toMatch(/watermark|row_version|last_updated_at|updated_at/i);
  });

  /** Moving the schedule watermark would fire S09's change banner for a schedule that did not change. */
  it('never touches conference.schedule_watermark_at', () => {
    expect(sql).not.toMatch(/schedule_watermark_at/);
    expect(sql).not.toMatch(/ALTER TABLE conference/i);
  });
});

// ---------- the ballot-existence port (TI04) ----------

describe('the poll freeze has exactly one port and exactly one guard', () => {
  const gate = withoutComments(read(apiSrc, 'rounds', 'ballot-gate.ts'));

  it('declares the port in one file, and that file names the story that discharges it', () => {
    const declaring = sourcesUnder(apiSrc).filter((path) =>
      /interface BallotGate\b/.test(readFileSync(path, 'utf8')),
    );
    expect(declaring.map((path) => path.replace(apiSrc, '').replace(/\\/g, '/'))).toEqual([
      '/rounds/ballot-gate.ts',
    ]);

    // The obligation is legible from the code, not only from the two FIS files.
    const raw = read(apiSrc, 'rounds', 'ballot-gate.ts');
    expect(raw).toMatch(/S03 TI08/);
  });

  it('is consumed by exactly one guard, and by no second freeze rule anywhere', () => {
    expect(gate).toMatch(/export async function assertPollContentEditable/);

    const consumers = sourcesUnder(apiSrc).filter((path) =>
      /hasAnyVote\(/.test(withoutComments(readFileSync(path, 'utf8'))),
    );
    expect(consumers.map((path) => path.replace(apiSrc, '').replace(/\\/g, '/'))).toEqual([
      '/rounds/ballot-gate.ts',
    ]);

    const callers = sourcesUnder(apiSrc).filter((path) =>
      /assertPollContentEditable\(/.test(withoutComments(readFileSync(path, 'utf8'))),
    );
    expect(callers.map((path) => path.replace(apiSrc, '').replace(/\\/g, '/')).sort()).toEqual([
      '/rounds/ballot-gate.ts',
      '/routes/rounds.ts',
    ]);
  });

  /** No flag, no environment switch, no second rule the freeze could be turned off with. */
  it('reads no feature flag and carries no unfinished marker', () => {
    expect(gate).not.toMatch(/process\.env/);
    expect(gate).not.toMatch(/TODO|FIXME|feature.?flag/i);
  });

  /** Proved by driving it, not only by reading it: the guard consumes the port's answer. */
  it('refuses a poll edit exactly when the port says a vote exists', async () => {
    const { assertPollContentEditable } = await import('../src/rounds/ballot-gate.ts');
    const poll = {
      id: 'round-1',
      kind: 'VotingRound' as const,
      purpose: 'Poll' as const,
      conferenceId: 'c',
      sessionId: 's',
      prompt: 'Where?',
      state: 'closed' as const,
      position: 0,
      closedAt: null,
      options: [],
    };

    await expect(
      assertPollContentEditable({ hasAnyVote: async () => true }, poll),
    ).rejects.toMatchObject({ code: 'POLL_CONTENT_FROZEN' });

    await expect(
      assertPollContentEditable({ hasAnyVote: async () => false }, poll),
    ).resolves.toBeUndefined();

    // A post-it round's prompt never consults it – FR1 keeps that prompt editable at any time.
    let asked = 0;
    await assertPollContentEditable(
      {
        hasAnyVote: async () => {
          asked += 1;
          return true;
        },
      },
      { ...poll, kind: 'PostItRound', purpose: null },
    );
    expect(asked).toBe(0);
  });

  /**
   * The shipped binding is the real existence query over the ballot table – S03 TI08 discharged
   * S01's obligation, and this is where "no stub or constant answering `false` remains" is pinned.
   *
   * Two things are asserted rather than one, because either alone would stay green against the
   * regression this exists to catch: that `buildApp` binds the production gate by default, and that
   * the gate actually *asks the database* about the Round it was given. A body that returned a
   * constant would pass the first and fail the second.
   */
  it('is the default binding the app builds with, and asks the ballot table', async () => {
    expect(withoutComments(read(apiSrc, 'app.ts'))).toMatch(/ballotGate \?\? createBallotGate\(\)/);

    const db = fakeDatabase();
    await createBallotGate().hasAnyVote('round-1', db);

    expect(db.calls).toHaveLength(1);
    // An `exists` over the ballot table, parameterised by the Round – never a ballot row, and never
    // a constant standing in for one.
    expect(db.calls[0]!.text).toMatch(/select exists \(select 1 from vote where round_id = \$1\)/);
    expect(db.calls[0]!.values).toEqual(['round-1']);

    // No stub, constant or flag survives anywhere on the path.
    const gateSource = withoutComments(read(apiSrc, 'rounds', 'ballot-gate.ts'));
    expect(gateSource).not.toMatch(/return (false|true)\s*;/);
  });
});

// ---------- the round routes and modules (TI03, TI05, TI06, TI07) ----------

describe('the round routes', () => {
  const code = withoutComments(read(apiSrc, 'routes', 'rounds.ts'));

  it('makes no inline role, membership or assignment comparison', () => {
    expect(code).not.toMatch(/===\s*caller\.sub/);
    expect(code).not.toMatch(/caller\.sub\s*===/);
    expect(code).not.toMatch(/\.role\s*===/);
    expect(code).not.toMatch(/lifecycleState\s*===/);
    expect(code).not.toMatch(/role_assignment|session_assignment|\bmembership\b/);
  });

  it('routes every decision through requireConferenceRole and requireMembership', () => {
    expect(code).toMatch(/authorization\.requireMembership\(/);

    // No role other than PresenterFacilitator is ever asked for here.
    const roles = [...code.matchAll(/requireConferenceRole\([\s\S]{0,80}?'(\w+)'/g)].map(
      (match) => match[1],
    );
    expect(roles.length).toBeGreaterThan(0);
    expect(new Set(roles)).toEqual(new Set(['PresenterFacilitator']));

    /*
     * The Session narrowing, asserted **per function** rather than once for the file. A single
     * file-wide `{ sessionId }` match is satisfied by either of the two functions that carry one,
     * so deleting it from the write path alone would leave the guard green while every write
     * became conference-wide (`docs/LEARNINGS.md#testing` - a file-list grep is only as good as
     * its longest omission).
     */
    const bodyOf = (name: string): string => {
      // Sliced rather than matched, so each assertion is about that function's own body and
      // cannot be satisfied by the other one's.
      const at = code.indexOf(`async function ${name}(`);
      expect(at, `${name} should be found`).toBeGreaterThan(-1);
      const next = code.indexOf('async function ', at + 1);
      const handler = code.indexOf('app.get(', at);
      const ends = [next, handler].filter((index) => index > -1);
      return code.slice(at, ends.length === 0 ? code.length : Math.min(...ends));
    };

    /*
     * `holdsAssignment` rather than `mayRun` since S03: the canonical question is asked in exactly
     * one place now and read by two callers – `mayRun`, which additionally requires the Conference
     * to be editable before it offers run controls, and the open-Poll tally gate, which does not.
     * Naming the asker keeps this assertion on the function that actually carries the check.
     */
    for (const name of ['authorizeWrite', 'holdsAssignment'] as const) {
      const body = bodyOf(name);
      expect(body, `${name} must go through the canonical check`).toContain(
        'requireConferenceRole',
      );

      /*
       * The narrowing has to be *in the call*, not merely somewhere in the function. `sessionId` is
       * a route parameter and is destructured, logged and passed around all over these bodies, so a
       * whole-body `toContain` stays green with the authority check widened to the whole Conference
       * - which is the exact regression this criterion exists to catch.
       */
      const fromCall = body.slice(body.indexOf('requireConferenceRole'));
      const call = fromCall.slice(0, fromCall.indexOf(');') + 2);
      expect(call, `${name} must narrow its authority check to this session`).toContain(
        'sessionId',
      );
    }

    // The draft read is the one place a conference-wide check is correct: a draft's rounds are for
    // the people composing it, whichever session they hold.
    expect(code).toMatch(/isDraft\(conference\)[\s\S]{0,240}requireConferenceRole\(/);
  });

  /** The archived-conference refusal is S03's guard, not a second definition of "archived". */
  it('refuses writes on an archived conference through the lifecycle guard', () => {
    expect(code).toMatch(/assertEditable\(/);
    expect(code).not.toMatch(/'archived'|"archived"|'draft'|"draft"/);
  });

  /** The reopen rule lives in the repository's UPDATE predicate, never in a handler. */
  it('re-implements no transition rule of its own', () => {
    expect(code).not.toMatch(/closed_at/);
    expect(code).toMatch(/rounds\.open\(/);
    expect(code).toMatch(/rounds\.close\(/);
  });

  /** No body field may name or influence the acting identity (Binding Constraint FR3). */
  it('takes the acting identity only from the verified caller', () => {
    expect(code).not.toMatch(/body[\s\S]{0,80}(userSub|\bsub\b|email|author)/);
    const body = /const roundBodySchema = \{[\s\S]*?\} as const;/.exec(code)?.[0];
    expect(body, 'the round body schema should be found').toBeDefined();
    expect(body).toMatch(/additionalProperties: false/);
    expect(body).not.toMatch(/sub|email|author|user/i);
  });

  /**
   * **No cursor of any name** on the payload – S02 owns `round.activity_watermark` and the
   * cheap two-scalar poll beside this read.
   */
  it('puts no timestamp, version or cursor on the round wire shape', () => {
    const wire = /function toRoundWire\([\s\S]*?\n\}/.exec(code)?.[0];
    expect(wire, 'toRoundWire should be found').toBeDefined();
    expect(wire).not.toMatch(/At\b|version|watermark|cursor|updated/i);
    expect(code).not.toMatch(/activity_watermark|roundsLastUpdatedAt/);
  });

  /** No in-process state between requests (Binding Constraint FR2, ADR-004). */
  it.each([
    ['routes/rounds.ts', join(apiSrc, 'routes', 'rounds.ts')],
    ['rounds/round-repository.ts', join(apiSrc, 'rounds', 'round-repository.ts')],
    ['rounds/round-validation.ts', join(apiSrc, 'rounds', 'round-validation.ts')],
    ['rounds/ballot-gate.ts', join(apiSrc, 'rounds', 'ballot-gate.ts')],
  ])('%s holds no mutable module-level state', (_name, path) => {
    const source = withoutComments(readFileSync(path, 'utf8'));
    expect(source, 'a module-level let is request state waiting to happen').not.toMatch(
      /^(let|var)\s/m,
    );
    expect(source, 'a module-level Map/Set is a cache').not.toMatch(
      /^const\s+\w+\s*=\s*new (Map|Set|WeakMap|WeakSet)\b/m,
    );
  });

  /** The round tables are reached from the round modules and from nowhere else. */
  it('reaches the round tables only from the rounds modules', () => {
    const offenders = sourcesUnder(apiSrc)
      .filter((path) => {
        const relative = path.replace(apiSrc, '').replace(/\\/g, '/');
        if (relative.startsWith('/rounds/')) return false;
        /*
         * The votes module reads `round_option` too, and has to: a tally is a count grouped by
         * option, produced by a left join *from* the options so an option nobody chose still reads
         * zero. Allow-listed by exact directory rather than by widening the pattern, and it earns
         * the exemption by owning every statement that touches the ballot table in return - which
         * `vote-structure.test.ts` pins from the other side.
         */
        if (relative.startsWith('/votes/')) return false;
        return /from round\b|from round_option\b/.test(withoutComments(readFileSync(path, 'utf8')));
      })
      .map((path) => path.replace(apiSrc, '').replace(/\\/g, '/'));

    expect(offenders).toEqual([]);
  });

  /** No round source advances the whole-schedule watermark, from any path. */
  it('never writes conference.schedule_watermark_at', () => {
    for (const path of sourcesUnder(join(apiSrc, 'rounds')).concat(
      join(apiSrc, 'routes', 'rounds.ts'),
    )) {
      expect(withoutComments(readFileSync(path, 'utf8')), path).not.toMatch(
        /schedule_watermark_at/,
      );
    }
  });

  /** Offline support does not widen: the cached envelope knows nothing about a Round (FR6). */
  it('adds no round field to the attendee schedule envelope or the offline cache', () => {
    expect(withoutComments(read(apiSrc, 'sessions', 'schedule-envelope.ts'))).not.toMatch(/round/i);
    for (const path of sourcesUnder(join(webSrc, 'offline'))) {
      expect(withoutComments(readFileSync(path, 'utf8')), path).not.toMatch(/\bround\b/i);
    }
  });

  /** Every S01 refusal carries a displayable message and a machine code (S01's envelope). */
  it('declares every round refusal through the shared error envelope', () => {
    const errors = read(apiSrc, 'errors.ts');
    const declared = [...errors.matchAll(/^\s{2}((?:ROUND|POLL)_\w+):/gm)].map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(0);

    const raised = new Set(
      [
        read(apiSrc, 'routes', 'rounds.ts'),
        read(apiSrc, 'rounds', 'round-validation.ts'),
        read(apiSrc, 'rounds', 'ballot-gate.ts'),
        read(apiSrc, 'rounds', 'round-repository.ts'),
      ]
        .join('\n')
        .match(/ERROR_CODES\.((?:ROUND|POLL)_\w+)/g)
        ?.map((match) => match.replace('ERROR_CODES.', '')) ?? [],
    );
    expect(raised.size).toBeGreaterThan(0);
    for (const code of raised) expect(declared).toContain(code);

    // Nothing constructs a bare response shape of its own.
    for (const file of ['routes/rounds.ts', 'rounds/round-repository.ts']) {
      const source = withoutComments(readFileSync(join(apiSrc, ...file.split('/')), 'utf8'));
      expect(source, file).not.toMatch(/reply\.(status|code|send)/);
    }
  });
});

// ---------- the single propagation mechanism (TI11, plan.json#sharedDecisions) ----------

describe('this story leaves exactly one propagation mechanism standing', () => {
  const web = sourcesUnder(webSrc);

  /**
   * The counts are pinned, not merely "not increased".
   *
   * S01 pinned them to the shape that existed then: one poll loop, living inside
   * `AttendeeSchedulePanel`. S02 extracted that loop into `poll/use-watermark-poll.ts` and made the
   * activities view its second call site, which is what the decision this guard exists for actually
   * asked for. The property is unchanged and the addresses moved: **one** cadence constant and
   * **one** watermark-poll interval in the whole of `web/src`, wherever they live.
   *
   * The second `setInterval` in the attendee panel is not a poll at all - it is the running-Session
   * highlight's minute heartbeat, which fetches nothing.
   */
  it('has exactly one cadence constant and one poll interval under web/src', () => {
    const timers = web.flatMap((path) =>
      [...withoutComments(readFileSync(path, 'utf8')).matchAll(/setInterval\(/g)].map(() =>
        path.replace(webSrc, '').replace(/\\/g, '/'),
      ),
    );
    expect(timers.sort()).toEqual(
      [
        // The highlight's minute heartbeat (S09) - a re-render, not a request.
        '/attendee/AttendeeSchedulePanel.tsx',
        // The one watermark-poll loop, shared by every polling view (S02 TI08).
        '/poll/use-watermark-poll.ts',
      ].sort(),
    );

    const cadences = web.flatMap((path) =>
      [
        ...withoutComments(readFileSync(path, 'utf8')).matchAll(
          // `export const` too: the one cadence is exported now, because it is shared.
          /^(?:export\s+)?const\s+\w*(?:INTERVAL|CADENCE|POLL)\w*\s*=/gim,
        ),
      ].map(() => path.replace(webSrc, '').replace(/\\/g, '/')),
    );
    expect(cadences).toEqual(['/poll/use-watermark-poll.ts']);
  });

  /**
   * The activities surface owns **no loop** – it is a call site of the shared one.
   *
   * S01 could state this as "no watermark, no cursor, no in-flight guard", because the panel was
   * driven by a tick handed down to it. S02 gave it the cursor to compare, so the property that
   * survives is the one that matters: no interval, no cadence and no in-flight flag of its own. It
   * asks `useWatermarkPoll` and gets out of the way.
   */
  it('gives the session activities panel no timer, cadence or in-flight guard of its own', () => {
    const activities = sourcesUnder(join(webSrc, 'activities'));
    expect(activities.length).toBeGreaterThan(0);

    const callSite = activities.filter((path) =>
      /useWatermarkPoll\(/.test(withoutComments(readFileSync(path, 'utf8'))),
    );
    expect(callSite.length, 'the activities view should poll through the shared loop').toBe(1);

    for (const path of activities) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, path).not.toMatch(/setInterval|setTimeout/);
      expect(source, path).not.toMatch(/INTERVAL_MS|CADENCE/);
      /*
       * The loop's overlap latch, as an **exact identifier** rather than a substring: JavaScript
       * identifiers are case-sensitive, and a bare `inFlight` here would be this panel keeping its
       * own "a tick is already out" flag. `voteInFlight` is a different identifier and a different
       * mechanism - a write guard on the Vote submit that starts on a tap, ends on a response and
       * schedules nothing, so a double-tap cannot turn one intent into two casts (S03). Narrowed,
       * not dropped: a loop hiding behind a compound name would still need the timer, cadence or
       * listener the two lines around this one deny.
       */
      expect(source, path).not.toMatch(/\binFlight\b|pollingRef/);
      expect(source, path).not.toMatch(/addEventListener\(\s*'(visibilitychange|focus|online)'/);
    }
  });
});

// ---------- registration and authentication ----------

describe('the round routes are registered and authenticated', () => {
  it('registers the read, the two writes and the two transitions, all through withAuth', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const urls = app.confappRoutes.map((route) => `${route.method} ${route.url}`);
      const base = '/api/conferences/:conferenceId/sessions/:sessionId';

      for (const url of [
        `GET ${base}`,
        `POST ${base}/rounds`,
        `PATCH ${base}/rounds/:roundId`,
        `POST ${base}/rounds/:roundId/open`,
        `POST ${base}/rounds/:roundId/close`,
      ]) {
        expect(urls).toContain(url);
      }

      for (const route of app.confappRoutes.filter((entry) => /\/rounds/.test(entry.url))) {
        expect(route.authenticated, `${route.method} ${route.url}`).toBe(true);
      }
      const read = app.confappRoutes.find((route) => route.method === 'GET' && route.url === base);
      expect(read?.authenticated).toBe(true);
    } finally {
      await app.close();
    }
  });
});
