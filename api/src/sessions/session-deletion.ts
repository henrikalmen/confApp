import { AppError, ERROR_CODES } from '../errors.ts';

/**
 * The single authority on whether a Session may be deleted now (S05 FR7).
 *
 * Shaped exactly like `api/src/conferences/lifecycle.ts#joinRefusalReason` – a pure reason
 * predicate, a record mapping each reason to the sentence a person reads, and an `assert…` that
 * throws. "May this be deleted now" is answered here and nowhere else, so a client may hide the
 * Delete button but the refusal is reproducible by calling the endpoint directly.
 *
 * The module holds no state. Everything is a pure function of the counts the caller has just read
 * from the database inside the delete's own transaction. The API runs as several container
 * replicas with no request affinity (ADR-004, ARCHITECTURE.md#key-constraints), so a remembered
 * count would be wrong on the next request – and worse than wrong here, because a stale zero
 * deletes a Board.
 *
 * ---
 *
 * **What this module is given, and what it is deliberately not given.**
 *
 * Two numbers: how many Post-its, and how many Votes. It is handed no row, no id and no identity,
 * and it is not able to ask for one. That is what keeps the anonymity constraint intact on this
 * path: the guard establishes *that* ballots exist for a Session and can express nothing about
 * *whose* they are, because a ballot's voter is not a thing this code can reach (Binding
 * Constraint FR4, scoped by
 * `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md`).
 *
 * The counts do reach the Organizer, in the sentence below, and that is FR7's own criterion – the
 * refusal must name what would be lost. It discloses nothing new: the delete requires `Admin`, and
 * a live tally is withheld only from somebody who does not run the Session
 * (`POLL_RESULTS_NOT_YET_AVAILABLE`), so the reader of this sentence could already read one. The
 * Vote number is also a per-Session total across every Round, never a per-option figure.
 */

/** How much collected output a Session is holding, counted per contribution kind. */
export interface SessionContributions {
  postIts: number;
  votes: number;
}

export type SessionDeletionRefusalReason = 'holds-contributions';

/**
 * The whole rule: *any* contribution under *any* Round of the Session blocks deletion
 * (`prd.md#fr7-contribution-safe-session-deletion` → Validation).
 *
 * A Round's own open/closed state is deliberately not consulted. S01 owns that state, and it says
 * nothing about whether contributions exist – a closed Post-it Round holds its Board just as a
 * Session that is over holds its Poll's ballots.
 */
export function sessionDeletionRefusalReason(
  contributions: SessionContributions,
): SessionDeletionRefusalReason | null {
  if (contributions.postIts > 0 || contributions.votes > 0) return 'holds-contributions';
  return null;
}

export function isSessionDeletable(contributions: SessionContributions): boolean {
  return sessionDeletionRefusalReason(contributions) === null;
}

function plural(count: number, singular: string, many: string): string {
  return `${count} ${count === 1 ? singular : many}`;
}

/**
 * What was collected, in the words the Organizer reads.
 *
 * Both halves are named when both are present, because they are two different losses: the named
 * ideas that feed categorization and the report, and the anonymous sentiment reading. A single
 * "contributions" would tell the Organizer neither.
 */
function collected(contributions: SessionContributions): string {
  const parts: string[] = [];
  if (contributions.postIts > 0) parts.push(plural(contributions.postIts, 'post-it', 'post-its'));
  if (contributions.votes > 0) parts.push(plural(contributions.votes, 'vote', 'votes'));
  return parts.join(' and ');
}

/** The refusal each reason produces, in the words the Organizer reads. */
const SESSION_DELETION_REFUSALS: Record<
  SessionDeletionRefusalReason,
  (contributions: SessionContributions) => AppError
> = {
  'holds-contributions': (contributions) =>
    new AppError(
      ERROR_CODES.SESSION_HOLDS_CONTRIBUTIONS,
      409,
      `This session has collected ${collected(contributions)} and cannot be deleted. ` +
        'Edit the session, or move it to another day or time, instead.',
    ),
};

/**
 * Refuses the delete with the reason named, or returns having decided the Session may go.
 *
 * Throws rather than returning a result, unlike the repository's `GuardedWrite` outcomes, because
 * there is nothing for the caller to decide between: `AppError` already carries the code, the
 * status and the displayable sentence, and it travels out through the envelope the DELETE handler
 * already uses.
 */
export function assertSessionDeletable(contributions: SessionContributions): void {
  const reason = sessionDeletionRefusalReason(contributions);
  if (reason === null) return;
  throw SESSION_DELETION_REFUSALS[reason](contributions);
}
