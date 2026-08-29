import type { Database, Queryable } from '../db.ts';

/**
 * The `vote` and `round_voter` tables, behind one seam.
 *
 * **This module is the only place in `api/src` that reaches the ballot table**, and everything it
 * does with it is shaped by one rule: a Vote is unlinkable to its voter through every application
 * path. Four properties carry that, and none of them is a convention a caller has to remember.
 *
 *   - **The voter's `sub` and the chosen option never appear in the same statement, and never in
 *     the same function.** `claimTheVote` is handed a `sub` and no option; `writeTheBallot` is
 *     handed an option and has no parameter a `sub` could arrive through. `cast` below sequences
 *     the two and is the only place both values are in scope at once. A ballot writer that was
 *     merely *able* to see a `sub` would be the defect even while it ignored one.
 *   - **The ballot table is read two ways only**: as a count grouped by option, and as an `exists`
 *     boolean per Round. No query here selects a ballot row individually, returns one to a caller,
 *     or joins the ballot table to anything that identifies a person.
 *   - **Single-use is a database uniqueness constraint**, never a check made first. Two
 *     submissions from one person arriving together both pass a pre-read, and only one of them can
 *     win `round_voter_once_per_round` (`docs/LEARNINGS.md#concurrency`). The insert is attempted
 *     and the violation *is* the refusal. It is also why nothing is retained between requests: the
 *     API runs as several container replicas with no request affinity (ADR-004), so an in-process
 *     record of who had voted would be wrong on the next replica even if it were fresh on this one.
 *   - **Both writes are one transaction.** A crash between them would otherwise either lose a Vote
 *     with no retry path or let the same person vote twice.
 *
 * The price of that last property, stated exactly rather than implied away: both rows carry the
 * same `xmin`, so a holder of direct database credentials can pair them. See the ADR block at the
 * top of `db/migrations/20260829090000000_vote.sql` and
 * `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md`.
 * It is accepted, it is invisible to every test in this repository, and the alternatives were
 * weighed there and not chosen - do not reintroduce one here.
 */

/** One option's count. The only Vote-shaped value this API can produce, for any actor. */
export interface OptionTally {
  optionId: string;
  votes: number;
}

/**
 * What a cast attempt did.
 *
 * Kept apart because each is a different sentence and a different next move: the Round is not
 * there, it has stopped taking votes, that option is not on this ballot, or you have already
 * voted. Returned rather than thrown so the error envelope stays in the route, where the rest of
 * this API's refusals are built - and so that no refusal can accidentally carry a tally with it.
 */
export type CastOutcome =
  | { outcome: 'cast' }
  | { outcome: 'already-voted' }
  | { outcome: 'unknown-option' }
  | { outcome: 'round-closed' }
  | { outcome: 'missing' };

export interface VoteRepository {
  /**
   * One Vote, or the reason there is none. The `voterSub` establishes eligibility and single use,
   * and is never carried onto the ballot.
   */
  cast(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    optionId: string,
    voterSub: string,
  ): Promise<CastOutcome>;
  /**
   * One Poll's counts, one entry per option in authored order.
   *
   * A Poll that collected no Votes answers zero against every option rather than an empty list:
   * "nobody voted" is a result, and a room reading a closed Poll needs to see it rendered rather
   * than an error (Acceptance Scenario S05).
   */
  tallyFor(roundId: string): Promise<OptionTally[]>;
  /**
   * Every Poll's counts for one Session, keyed by Round id - one statement, not one per Round.
   *
   * A handler looping per Round is the N+1 this project has been bitten by, and the PRD requires
   * one read to answer a Session and everything in it.
   */
  tallyForSession(conferenceId: string, sessionId: string): Promise<Map<string, OptionTally[]>>;
  /**
   * Which of this Session's Rounds this caller has already voted in.
   *
   * The **only** question the API ever asks of `round_voter`, and it is asked about the caller's
   * own `sub`. There is no path here that lists who voted in a Round.
   */
  votedRoundsFor(conferenceId: string, sessionId: string, voterSub: string): Promise<Set<string>>;
}

/**
 * Does this Round have a Vote yet? The Poll-freeze rule's only question.
 *
 * Lives here because this module owns every statement that touches the ballot table;
 * `api/src/rounds/ballot-gate.ts` is the port that asks it. It takes a `Queryable` rather than the
 * pool because the freeze check and the Poll content UPDATE run in **one** transaction under a row
 * lock - asked outside it, the answer would be stale the instant it was returned.
 *
 * `exists` rather than `count(*)`: the question is whether there is one, so PostgreSQL can stop at
 * the first row instead of counting a hall's worth of ballots. It returns a boolean and no ballot.
 */
export async function voteExistsForRound(roundId: string, tx: Queryable): Promise<boolean> {
  const rows = await tx.query<{ present: boolean }>(
    'select exists (select 1 from vote where round_id = $1) as present',
    [roundId],
  );
  return rows[0]?.present === true;
}

interface TallyRow {
  round_id: string;
  option_id: string;
  votes: number;
}

/**
 * The counts, always one row per option.
 *
 * A `left join` from the options rather than a group over the ballots, so an option nobody chose
 * still answers - and a Poll closed with no Votes reads zero against every option instead of
 * coming back empty. `count(v.id)` counts matched ballots only, so an unmatched option counts 0
 * rather than 1. Cast to `int` because PostgreSQL's `count` is a `bigint`, which the driver would
 * otherwise hand back as a string.
 *
 * The join is to `round_option`, which identifies nobody. There is no join anywhere in this module
 * between the ballot table and `round_voter`, `app_user`, `membership`, `role_assignment` or
 * `session_assignment` - see the module note.
 */
const TALLY = `
  select o.round_id, o.id as option_id, count(v.id)::int as votes
    from round_option o
    left join vote v on v.option_id = o.id
`;

/** The unique constraint that is the single-use gate, by name. */
const ALREADY_VOTED = 'round_voter_once_per_round';

function isUniqueViolationOf(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const violation = error as { code?: unknown; constraint?: unknown };
  return violation.code === '23505' && violation.constraint === constraint;
}

/**
 * A refusal decided inside the transaction, carried out through the rollback.
 *
 * The field is assigned in the body rather than declared as a constructor parameter property:
 * Node's type-stripping loader runs this file directly in a few test probes, and a parameter
 * property is TypeScript that has to be *emitted* rather than erased
 * (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
 */
class CastRefused extends Error {
  readonly outcome: CastOutcome;

  constructor(outcome: CastOutcome) {
    super('The vote was refused.');
    this.name = 'CastRefused';
    this.outcome = outcome;
  }
}

/**
 * Records that this person has voted in this Round, and nothing else.
 *
 * **Takes the `sub` and no option**, deliberately. Whatever it is handed cannot reach the ballot,
 * because it has no way to write one.
 *
 * No pre-read: the insert is attempted and `round_voter_once_per_round` is what refuses a second
 * one. A "have you voted?" query followed by an insert is passed by both of two concurrent
 * submissions from the same person.
 */
async function claimTheVote(tx: Queryable, roundId: string, voterSub: string): Promise<void> {
  await tx.query('insert into round_voter (round_id, user_sub) values ($1, $2)', [
    roundId,
    voterSub,
  ]);
}

/**
 * Writes the ballot: which Round, which option.
 *
 * **There is no parameter here a voter's identity could arrive through**, which is the point. The
 * composite foreign key `vote_option_on_this_round` is what makes an option belonging to another
 * Poll unwritable whatever this code believes.
 */
async function writeTheBallot(tx: Queryable, roundId: string, optionId: string): Promise<void> {
  await tx.query('insert into vote (round_id, option_id) values ($1, $2)', [roundId, optionId]);
}

export function createVoteRepository(db: Database): VoteRepository {
  return {
    async cast(
      conferenceId: string,
      sessionId: string,
      roundId: string,
      optionId: string,
      voterSub: string,
    ): Promise<CastOutcome> {
      try {
        await db.transaction(async (tx) => {
          /*
           * The Round, locked, and whether the chosen option is on it - one statement, before
           * either write.
           *
           * `for update of r` is what makes the two answers still true when the writes land: a
           * Facilitator closing this Round, or replacing its options, blocks here until this
           * transaction commits. Without it this would be a read followed by a write with a gap
           * between them, which is the shape `docs/LEARNINGS.md#concurrency` names. It is the same
           * row lock the Poll content edit takes, in the same order, so the two serialise rather
           * than deadlock.
           *
           * It carries the option id and **not** the voter's `sub`.
           */
          const rows = await tx.query<{ state: string; option_on_poll: boolean }>(
            `select r.state, (o.id is not null) as option_on_poll
               from round r
               left join round_option o on o.round_id = r.id and o.id = $4
              where r.id = $3 and r.session_id = $2 and r.conference_id = $1
                and r.kind = 'VotingRound'
              for update of r`,
            [conferenceId, sessionId, roundId, optionId],
          );

          const round = rows[0];
          // A Post-it Round reached through the voting path is reported the same way a missing one
          // is: there is no Poll here, which is what the caller's next read will find anyway.
          if (round === undefined) throw new CastRefused({ outcome: 'missing' });
          if (round.state !== 'open') throw new CastRefused({ outcome: 'round-closed' });
          if (!round.option_on_poll) throw new CastRefused({ outcome: 'unknown-option' });

          // The claim first, so its uniqueness constraint is the gate; then the ballot. One
          // transaction, so a refusal at either step leaves neither row behind (Acceptance
          // Scenario S07) and a crash between them cannot lose or double a Vote.
          await claimTheVote(tx, roundId, voterSub);
          await writeTheBallot(tx, roundId, optionId);
        });
        return { outcome: 'cast' };
      } catch (error) {
        if (error instanceof CastRefused) return error.outcome;
        if (isUniqueViolationOf(error, ALREADY_VOTED)) return { outcome: 'already-voted' };
        throw error;
      }
    },

    async tallyFor(roundId: string): Promise<OptionTally[]> {
      const rows = await db.query<TallyRow>(
        `${TALLY} where o.round_id = $1 group by o.round_id, o.id, o.position order by o.position, o.id`,
        [roundId],
      );
      return rows.map((row) => ({ optionId: row.option_id, votes: row.votes }));
    },

    async tallyForSession(
      conferenceId: string,
      sessionId: string,
    ): Promise<Map<string, OptionTally[]>> {
      const rows = await db.query<TallyRow>(
        `${TALLY}
           join round r on r.id = o.round_id
          where r.conference_id = $1 and r.session_id = $2
          group by o.round_id, o.id, o.position
          order by o.position, o.id`,
        [conferenceId, sessionId],
      );

      const byRound = new Map<string, OptionTally[]>();
      for (const row of rows) {
        const entry = { optionId: row.option_id, votes: row.votes };
        const existing = byRound.get(row.round_id);
        if (existing === undefined) byRound.set(row.round_id, [entry]);
        else existing.push(entry);
      }
      return byRound;
    },

    async votedRoundsFor(
      conferenceId: string,
      sessionId: string,
      voterSub: string,
    ): Promise<Set<string>> {
      const rows = await db.query<{ round_id: string }>(
        `select rv.round_id
           from round_voter rv
           join round r on r.id = rv.round_id
          where r.conference_id = $1 and r.session_id = $2 and rv.user_sub = $3`,
        [conferenceId, sessionId, voterSub],
      );
      return new Set(rows.map((row) => row.round_id));
    },
  };
}

/**
 * How many ballots one Session has collected, across every Poll it holds (S05 TI02).
 *
 * Exported, and taking a `Queryable`, so the Session-deletion transaction can ask without reaching
 * into the ballot table itself – which is what keeps that table owned by this module, the
 * exemption `vote-structure.test.ts` grants and pins.
 *
 * **The count reaches the ballots through the Round and through nothing else.** It names no
 * identity-bearing table, takes no `sub` – there is no parameter one could arrive through – and
 * selects no ballot column, so satisfying S05's deletion guard adds no application-level path from
 * a ballot to the Member who cast it. Counting through `round_voter` instead would produce a
 * number that usually looks the same and would put a Member reference in the guard's own query,
 * which is the exact defect the anonymity constraint names.
 *
 * A third read shape for this table, beside the grouped tally and the per-Round `exists`: a count
 * per Session. Like those two it yields a number about a set of ballots and never a ballot.
 */
export async function countVotesForSession(
  tx: Queryable,
  conferenceId: string,
  sessionId: string,
): Promise<number> {
  const rows = await tx.query<{ count: number }>(
    `select count(*)::int as count
       from vote v
       join round r on r.id = v.round_id
      where r.conference_id = $1 and r.session_id = $2`,
    [conferenceId, sessionId],
  );
  return rows[0]?.count ?? 0;
}
