import type { Queryable } from '../db.ts';
import { AppError, ERROR_CODES } from '../errors.ts';
import { voteExistsForRound } from '../votes/vote-repository.ts';
import type { Round } from './round-repository.ts';

/**
 * "Does this Round have a Vote yet?" – the Poll-freeze rule's only question.
 *
 * S01 introduced this as a port because Vote storage did not exist yet, and bound it to an
 * implementation that answered `false`: truthfully, since a Round cannot have a Vote when no Vote
 * can exist. **S03 TI08 discharges that binding obligation** – the body below is the real `exists`
 * check over the ballot table, and there is no stub, constant or feature flag left anywhere in the
 * Poll edit path. The same move `api/src/conferences/schedule-gate.ts` records for the publish gate.
 *
 * S01's guard is untouched: the frozen-content refusal, its code, the endpoint that raises it and
 * the Round state machine are all exactly as S01 wrote them, which is what lets S01's Poll-freeze
 * scenario be re-run against this binding unmodified. The injection through `buildApp` stays too,
 * so a test can still bind a port answering `true`.
 *
 * **One thing S03 could not inherit**, and did not pretend to: S01 asked the gate and wrote the
 * option replacement in two separate statements. That is safe only while the answer is a constant.
 * Once the port reads real ballot storage the gap is a race – a Vote landing between the question
 * and the write lets a Poll edit through after the freeze should have applied, leaving a closed
 * tally answering a question it was never cast against. Decided during exec-plan triage on
 * 2026-08-29 (`s03-anonymous-poll-voting-and-result-reveal.md` -> Implementation Observations,
 * `poll-freeze-toctou-discharge`): the check and the content UPDATE run in **one transaction**,
 * with the Round row locked `FOR UPDATE` before the check.
 *
 * That is why `hasAnyVote` is handed a `Queryable`. It has to run on the *transaction's* client:
 * asked on the pool it would be answering about a snapshot the write does not share, and the lock
 * would be protecting nothing. `createBallotGate` therefore takes no database of its own - the one
 * it should use is decided per call, by the caller that holds the lock. The identical value cast
 * a Vote takes the same row lock in the same order (`api/src/votes/vote-repository.ts#cast`), so
 * the two serialise rather than deadlock.
 *
 * There is exactly **one** guard consuming this port, immediately below, and no second statement of
 * the freeze rule anywhere. A Post-it Round's prompt never consults it: FR1 keeps that prompt
 * editable at any time, including after contributions exist.
 */

export interface BallotGate {
  /**
   * `tx` is the transaction the caller has already locked the Round row on. See the module note –
   * an answer read outside that transaction is stale the instant it is returned.
   */
  hasAnyVote(roundId: string, tx: Queryable): Promise<boolean>;
}

export function createBallotGate(): BallotGate {
  return {
    async hasAnyVote(roundId: string, tx: Queryable): Promise<boolean> {
      // The statement itself lives in `api/src/votes/vote-repository.ts`, which is the one module
      // that reaches the ballot table. It returns a boolean and never a ballot row.
      return voteExistsForRound(roundId, tx);
    },
  };
}

/**
 * The single guard: a Poll's question **and** its options are frozen from the moment its first Vote
 * exists.
 *
 * The question freezes on the same trigger as the options because a ballot is an answer *to* it: a
 * question edited after voting began makes a closed tally unverifiable after the fact. Confirmed
 * during preflight on 2026-08-28 (`s01-round-authoring-and-lifecycle.md` -> Implementation
 * Observations, `poll-question-freeze-scope`), so it is the specified rule rather than an
 * interpretation. An unvoted Poll stays fully editable – the trigger is that a Vote exists, not
 * that the Poll was authored.
 *
 * Called from inside the edit's transaction, after the Round row is locked. See the module note.
 */
export async function assertPollContentEditable(
  gate: BallotGate,
  round: Round,
  tx: Queryable,
): Promise<void> {
  if (round.kind !== 'VotingRound') return;
  if (!(await gate.hasAnyVote(round.id, tx))) return;

  throw new AppError(
    ERROR_CODES.POLL_CONTENT_FROZEN,
    409,
    'Votes have already been cast in this poll, so its question and its options can no longer be ' +
      'changed. The ballots point at these options, and the question is what they answer.',
  );
}
