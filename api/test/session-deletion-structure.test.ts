import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * S05's Structural Criteria – the properties of the source itself, which no request can prove.
 *
 * Two of them are the reason this file exists:
 *
 *   - **The guard counts ballots and never voters.** A handler that never displays a voter proves
 *     nothing about whether the rows *could* be joined; the anonymity criterion is a property of
 *     the query text and the schema, so it needs a source-level assertion beside the behavioural
 *     one. Binding Constraint FR4, scoped by
 *     `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md`
 *     – the part that binds here is unchanged by that ADR: no application-level path from a ballot
 *     to a Member.
 *   - **The lock sequence is the guard, and its order is the mechanism.** The race suite can pass
 *     with the statements reordered whenever its timing happens not to hit the window, so the
 *     order is asserted here as text.
 *
 * Every region these assertions search is required to be *found* – `docs/LEARNINGS.md#testing`
 * records a structure test that silently no-opped for a whole pass because its marker had moved.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, '..', 'src');
const repoRoot = join(here, '..', '..');

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

/** Comments explain the rules; matching them would make these tests assert their own prose. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The source from `marker` onwards, having established that `marker` is there at all.
 *
 * Never `if (at > -1)`. A region that cannot be located is a failure, not a skip.
 */
function regionFrom(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, `the region "${marker}" should be found`).toBeGreaterThan(-1);
  return source.slice(at);
}

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

/** Anything a ballot must never be relatable to on this path. */
const IDENTITY_TABLES = ['app_user', 'round_voter', 'membership', 'role_assignment'];

/** Every file this story's contribution guard is spread across, and the region of each. */
const GUARD_MODULE = withoutComments(read(apiSrc, 'sessions', 'session-deletion.ts'));
const DELETE_TRANSACTION = regionFrom(
  withoutComments(read(apiSrc, 'sessions', 'session-repository.ts')),
  'async remove(',
);
const VOTE_COUNT = regionFrom(
  withoutComments(read(apiSrc, 'votes', 'vote-repository.ts')),
  'export async function countVotesForSession(',
);
const POST_IT_COUNT = regionFrom(
  withoutComments(read(apiSrc, 'rounds', 'post-it-repository.ts')),
  'export async function countPostItsForSession(',
);
const ROUND_LOCK = regionFrom(
  withoutComments(read(apiSrc, 'rounds', 'round-repository.ts')),
  'export async function lockRoundsOfSession(',
);

// ---------- Structural Criterion: no application path from a ballot to a Member (TI05) ----------

describe('the deletion guard counts ballots and never voters', () => {
  /**
   * The whole guard path, region by region. The Vote count reaches ballots through the Round and
   * through nothing else, so satisfying the guard adds no *application-level* path from a ballot
   * to the Member who cast it – which is the part of the anonymity constraint ADR-006 leaves
   * fully binding.
   */
  it.each([
    ['the guard module', GUARD_MODULE],
    ['the delete transaction', DELETE_TRANSACTION],
    ['the vote count', VOTE_COUNT],
    ['the post-it count', POST_IT_COUNT],
    ['the round lock', ROUND_LOCK],
  ])('%s names no identity-bearing table and no identifying column', (name, region) => {
    for (const table of IDENTITY_TABLES) {
      expect(region, `${name} names ${table}`).not.toMatch(new RegExp(`\\b${table}\\b`, 'i'));
    }
    expect(region, name).not.toMatch(/user_sub|author_sub|\bsub\b|display_name|mail|voter/i);
  });

  /**
   * The Vote count's statement, pinned exactly.
   *
   * Reaching a Vote through the has-voted record would produce a number that usually looks the
   * same, and would put a Member reference in the guard's own query. Rewriting the join to
   * `round_voter`, or adding a `user_sub` predicate, fails here.
   */
  it('counts ballots by round, in one statement that joins round and nothing else', () => {
    const statement = /`([^`]*from vote[^`]*)`/.exec(VOTE_COUNT)?.[1];
    expect(statement, 'the ballot count statement should be found').toBeDefined();

    expect(statement).toMatch(/select count\(\*\)::int as count/);
    expect(statement).toMatch(/from vote v\s+join round r on r\.id = v\.round_id/);
    expect(statement).toMatch(/where r\.conference_id = \$1 and r\.session_id = \$2/);
    // One join, and it is the Round. Any second join is a path this guard must not open.
    expect([...statement!.matchAll(/\bjoin\b/gi)]).toHaveLength(1);
    // No ballot row leaves the statement, so nothing per-ballot can be correlated with anything.
    expect(statement).not.toMatch(/v\.id|select v\.|select \*|returning/i);
  });

  /**
   * **The counting path cannot be handed a voter identity, because it has no parameter for one.**
   *
   * A count that was merely *able* to see a `sub` would be the defect even while it ignored one –
   * the same property `vote-structure.test.ts` pins on the ballot writer.
   */
  it('gives the ballot count no parameter an identity could arrive through', () => {
    const signature = /export async function countVotesForSession\(([^)]*)\)/.exec(VOTE_COUNT)?.[1];
    expect(signature, 'the ballot count signature should be found').toBeDefined();
    expect(signature!.replace(/\s+/g, ' ').trim()).toBe(
      'tx: Queryable, conferenceId: string, sessionId: string,',
    );

    const guard = /export function assertSessionDeletable\(([^)]*)\)/.exec(GUARD_MODULE)?.[1];
    expect(guard, 'assertSessionDeletable should be found').toBeDefined();
    expect(guard!.replace(/,?\s+/g, ' ').trim()).toBe('contributions: SessionContributions');
  });

  /**
   * The guard is handed two numbers and can ask for nothing more – it holds no database handle at
   * all, so there is no path from it back to a row of any kind.
   */
  it('gives the guard module no database access', () => {
    expect(GUARD_MODULE).not.toMatch(/\bQueryable\b|\bDatabase\b|\.query\(|\bselect\b|\bpg\b/i);
    expect(GUARD_MODULE).toMatch(/import \{ AppError, ERROR_CODES \} from '\.\.\/errors\.ts';/);
  });
});

// ---------- Structural Criterion: the lock sequence, in order (TI03, TI04) ----------

describe('the delete takes every lock before the count it protects', () => {
  /**
   * The order fixed in the FIS's *Constraints & Gotchas*, asserted as text because the race suite
   * cannot be relied on to hit the window: **conference `for update` → the session row
   * `for update` → that session's round rows `for update` → the contribution count → the
   * sole-session count → the delete.**
   */
  it('locks conference, then session, then rounds, then counts, then deletes', () => {
    const steps: [string, RegExp][] = [
      ['the conference lock', /from conference where id = \$1 for update/],
      ['the session lock', /from sessions where id = \$2 and conference_id = \$1 for update/],
      ['the round lock', /lockRoundsOfSession\(tx, conferenceId, sessionId\)/],
      ['the contribution guard', /assertSessionDeletable\(\{/],
      ['the sole-session count', /count\(\*\)::int as count from sessions where conference_id/],
      ['the delete', /delete from sessions where id = \$2 and conference_id = \$1/],
    ];

    let previous = -1;
    let previousName = 'the start of the transaction';
    for (const [name, pattern] of steps) {
      const at = DELETE_TRANSACTION.search(pattern);
      expect(at, `${name} should be found in the delete transaction`).toBeGreaterThan(-1);
      expect(at, `${name} must come after ${previousName}`).toBeGreaterThan(previous);
      previous = at;
      previousName = name;
    }

    /*
     * The two counts themselves, pinned separately - and this is the assertion the loop above
     * cannot make. They are written as inline `await` arguments to `assertSessionDeletable`, so
     * they sit after the Round lock only *incidentally*: hoisting either to a `const` above the
     * lock leaves every step of the sequence above in its right order while reopening exactly the
     * window Acceptance Scenario S06 names.
     */
    const roundLock = DELETE_TRANSACTION.search(
      /lockRoundsOfSession\(tx, conferenceId, sessionId\)/,
    );
    for (const count of ['countPostItsForSession', 'countVotesForSession']) {
      const at = DELETE_TRANSACTION.search(new RegExp(`${count}\\(`));
      expect(at, `${count} should be called in the delete transaction`).toBeGreaterThan(-1);
      expect(
        at,
        `${count} must be called after the round lock, never hoisted above it`,
      ).toBeGreaterThan(roundLock);
    }
  });

  /** The version comparison still sits between the session lock and the contribution guard. */
  it('answers existence and the row version before the contribution guard', () => {
    const version = DELETE_TRANSACTION.search(/found\.last_updated_at !== expectedVersion/);
    expect(version, 'the version comparison should be found').toBeGreaterThan(-1);
    expect(version).toBeLessThan(DELETE_TRANSACTION.search(/assertSessionDeletable\(\{/));
    expect(version).toBeGreaterThan(
      DELETE_TRANSACTION.search(/from sessions where id = \$2 and conference_id = \$1 for update/),
    );
  });

  /**
   * **`for update`, never `for no key update`.**
   *
   * A contribution insert takes `FOR KEY SHARE` on its parent row for the foreign key.
   * `FOR UPDATE` conflicts with that mode; `FOR NO KEY UPDATE` does not, and would leave both
   * windows open while reading like a lock.
   */
  it('takes the session and round locks in a mode that conflicts with FOR KEY SHARE', () => {
    expect(DELETE_TRANSACTION).not.toMatch(/for no key update|for share/i);
    expect(ROUND_LOCK).toMatch(
      /select id from round where conference_id = \$1 and session_id = \$2 order by id for update/,
    );
    expect(ROUND_LOCK).not.toMatch(/for no key update|for share/i);
  });

  /** Plain PostgreSQL row locking only – no advisory lock, no isolation-level escalation. */
  it('uses no advisory lock and no serializable escalation', () => {
    for (const region of [DELETE_TRANSACTION, ROUND_LOCK, VOTE_COUNT, POST_IT_COUNT]) {
      expect(region).not.toMatch(/advisory|serializable|set transaction|repeatable read/i);
      expect(region).not.toMatch(/create extension|pgcrypto|citus|timescale|aurora/i);
    }
  });
});

// ---------- Structural Criteria: no in-process state, and the words this story may not use ------

describe('the deletion guard keeps nothing between requests', () => {
  /**
   * The count is a database read taken inside the request that refuses. The API runs as several
   * container replicas with no request affinity (ADR-004), so a remembered count would be wrong on
   * the next replica – and a stale zero deletes a Board.
   */
  it.each([
    ['sessions/session-deletion.ts', join(apiSrc, 'sessions', 'session-deletion.ts')],
    ['sessions/session-repository.ts', join(apiSrc, 'sessions', 'session-repository.ts')],
  ])('%s holds no mutable module-level state', (_name, path) => {
    const source = withoutComments(readFileSync(path, 'utf8'));
    expect(source, 'a module-level let is request state waiting to happen').not.toMatch(
      /^(let|var)\s/m,
    );
    expect(source, 'a module-level Map/Set is a cache').not.toMatch(
      /^const\s+\w+\s*=\s*new (Map|Set|WeakMap|WeakSet)\b/m,
    );
  });

  /**
   * **Discard** is reserved: `docs/UBIQUITOUS_LANGUAGE.md#session-activities` defines it as
   * removing a Post-it from consideration *during sorting*, which is not this story. Using it for
   * a refused deletion would give one word two meanings in one domain.
   */
  it('never calls this refusal a discard', () => {
    for (const region of [GUARD_MODULE, DELETE_TRANSACTION, VOTE_COUNT, POST_IT_COUNT, ROUND_LOCK])
      expect(region).not.toMatch(/discard/i);
    expect(read(apiSrc, 'errors.ts')).not.toMatch(/SESSION_\w*DISCARD/i);
  });

  /**
   * **No comment or message added by this story may reassure anybody about ADR-006's residual.**
   *
   * Correlating a ballot with a voter needs no right beyond an ordinary `SELECT` over MVCC system
   * columns (ADR-006 → Decision, point 4), so a claim that it requires raw table access,
   * superuser rights or filesystem access would be worse than saying nothing at all. This guard is
   * an application path and says nothing about who holds database credentials.
   */
  it('claims nothing about what correlating a ballot with a voter would require', () => {
    /*
     * Read **raw**, comments and all: a comment is precisely where such a reassurance would be
     * written, so stripping them would leave this assertion looking at the half that could not
     * carry the defect.
     *
     * This file alone is scanned with its comments stripped, and the exemption is narrow and
     * unavoidable: the assertion has to name the phrases it forbids, and no regex can tell a
     * prohibition from the claim it prohibits. Every other surface this story adds - the guard
     * module, the delete, the two counts, the round lock and both behavioural suites - is scanned
     * with its prose intact.
     */
    const raw = [
      read(apiSrc, 'sessions', 'session-deletion.ts'),
      regionFrom(read(apiSrc, 'sessions', 'session-repository.ts'), 'async remove('),
      regionFrom(read(apiSrc, 'votes', 'vote-repository.ts'), 'export async function countVotes'),
      regionFrom(
        read(apiSrc, 'rounds', 'post-it-repository.ts'),
        'export async function countPost',
      ),
      regionFrom(read(apiSrc, 'rounds', 'round-repository.ts'), 'export async function lockRounds'),
      // The two smaller surfaces this story adds prose to, and the ones easiest to forget: the
      // error code's own doc block, and the DELETE handler's comment about the transaction.
      regionFrom(read(apiSrc, 'errors.ts'), 'SESSION_HOLDS_CONTRIBUTIONS'),
      regionFrom(read(apiSrc, 'routes', 'sessions.ts'), "app.delete('/api/conferences"),
      read(here, 'session-deletion.test.ts'),
      read(here, 'session-deletion.integration.test.ts'),
    ].join('\n');
    // The scan must have something to look at - an empty join would pass everything below.
    expect(raw.length, 'the scanned surfaces should be found').toBeGreaterThan(5000);

    expect(raw).not.toMatch(
      /superuser|raw table access|filesystem access|elevated (rights|privil)/i,
    );
    expect(raw).not.toMatch(/(only|requires).{0,40}(direct )?database credentials/i);
  });
});

// ---------- Structural Criterion: one refusal shape, declared in the shared envelope -----------

describe('the refusal travels through the shared envelope', () => {
  it('declares one new session code and raises it from the guard alone', () => {
    const errors = read(apiSrc, 'errors.ts');
    expect(errors).toMatch(/^ {2}SESSION_HOLDS_CONTRIBUTIONS: 'SESSION_HOLDS_CONTRIBUTIONS',$/m);

    const raising = sourcesUnder(apiSrc)
      .filter((path) => /ERROR_CODES\.SESSION_HOLDS_CONTRIBUTIONS/.test(readFileSync(path, 'utf8')))
      .map((path) => path.replace(apiSrc, '').replace(/\\/g, '/'));
    expect(raising).toEqual(['/sessions/session-deletion.ts']);
  });

  /**
   * The refusal is a reason predicate, a record of sentences and an `assert…` – the idiom
   * `api/src/conferences/lifecycle.ts#joinRefusalReason` already uses. No second refusal shape,
   * and no per-endpoint error format.
   */
  it('follows the join-refusal idiom rather than inventing a second one', () => {
    expect(GUARD_MODULE).toMatch(/export function sessionDeletionRefusalReason\(/);
    expect(GUARD_MODULE).toMatch(
      /const SESSION_DELETION_REFUSALS: Record<\s*SessionDeletionRefusalReason,/,
    );
    expect(GUARD_MODULE).toMatch(/export function assertSessionDeletable\(/);
    expect(GUARD_MODULE).toMatch(/throw SESSION_DELETION_REFUSALS\[reason\]\(contributions\);/);
    expect(GUARD_MODULE).not.toMatch(/reply\.(status|code|send)|statusCode:\s*\d/);
  });

  /** The DELETE handler grows no second refusal path – the AppError travels out as it is. */
  it('adds no branch to the delete handler', () => {
    const routes = withoutComments(read(apiSrc, 'routes', 'sessions.ts'));
    expect(routes).not.toMatch(/SESSION_HOLDS_CONTRIBUTIONS/);
    expect(routes).not.toMatch(/post_it|\bvote\b|postIts|contributionCount/i);
  });
});

// ---------- Structural Criterion: the retained conference cascade, at the schema level ----------

describe('the conference cascade chain is declared in the schema', () => {
  /**
   * `conference → sessions → round → {round_option, post_it, vote, round_voter}`, asserted link by
   * link, so that **editing one of these shipped migrations** cannot quietly break the Conference
   * deletion FR7 keeps available.
   *
   * That is the whole of what a source-level assertion can promise here, and it is deliberately
   * less than it first looks: migrations in this repository are append-only, so a *later* one
   * doing `ALTER TABLE vote DROP CONSTRAINT … ADD … ON DELETE RESTRICT` leaves every row below
   * green. The half that catches *that* is the live `pg_constraint` assertion in
   * `session-deletion.integration.test.ts`, which reads the cascade rules the database actually
   * holds after every migration has run. The two halves are not redundant - this one runs with no
   * database at all.
   *
   * Each row is searched from its own `create table`, because more than one of these migrations
   * declares `round_id uuid NOT NULL REFERENCES round (id)` and a whole-file search would answer
   * about the first table rather than the named one.
   */
  it.each([
    [
      'sessions → conference',
      '20260817150000000_session.sql',
      'sessions',
      /references conference/i,
    ],
    [
      'round → sessions',
      '20260828090000000_round.sql',
      'round',
      /references sessions \(id, conference_id\)/i,
    ],
    [
      'round_option → round',
      '20260828090000000_round.sql',
      'round_option',
      /references round \(id\)/i,
    ],
    [
      'post_it → round',
      '20260828120000000_post-it.sql',
      'post_it',
      /references round \(id, kind, conference_id\)/i,
    ],
    ['vote → round', '20260829090000000_vote.sql', 'vote', /references round \(id\)/i],
    [
      'round_voter → round',
      '20260829090000000_vote.sql',
      'round_voter',
      /round_id\s+uuid NOT NULL REFERENCES round \(id\)/i,
    ],
  ])('%s cascades on delete', (_name, migration, table, reference) => {
    const file = read(repoRoot, 'db', 'migrations', migration).replace(/^\s*--.*$/gm, '');
    const start = file.search(new RegExp(`create table ${table} \\(`, 'i'));
    expect(start, `create table ${table} should be found in ${migration}`).toBeGreaterThan(-1);
    const sql = file.slice(start);

    const at = sql.search(reference);
    expect(at, `${_name} should be declared in ${migration}`).toBeGreaterThan(-1);
    // The cascade clause belongs to this reference, so look only at the text that follows it.
    expect(sql.slice(at, at + 200)).toMatch(/ON DELETE CASCADE/i);
  });
});
