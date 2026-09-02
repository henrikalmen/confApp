import type { Database } from '../db.ts';
import { instantExpression } from '../sessions/wall-clock-time.ts';
import type { DisplayLinkCandidate } from './display-link.ts';

/**
 * The `display_link` table's one write seam, and the anonymous route's one read.
 *
 * Four operations and no fifth. Three of them name a Round and are reached only through the
 * sorting-authority gate; the fourth names a token and nothing else, and is what the room machine's
 * poll reaches.
 *
 * **There is no operation that clears `revoked_at`, and there is no UPDATE below that could.** The
 * only statement that touches that column stamps it, and its predicate is `revoked_at is null`, so
 * it cannot run backwards even by accident. "A revoked value is never reissued" (FR7 -> Data
 * Requirements) is that absence, plus the retained row, plus the global UNIQUE on `token`.
 *
 * Nothing is retained between calls: no token, no candidate, no live-link cache. The API runs as
 * several container replicas with no request affinity (ADR-004), so a cached link would be wrong on
 * the next replica even if it were fresh on this one - and revocation has to take effect at the
 * room machine's next poll, which a cache anywhere on this path would defeat.
 *
 * **No statement in this file names a vote or ballot table, and none joins to one** (ADR-006,
 * Binding Constraint FR8). The resolution read below reaches `display_link`, `round`, `sessions`
 * and `conference`, and stops there.
 */

/** The live link as its own Facilitator reads it back: the value, and when it was issued. */
export interface IssuedDisplayLink {
  token: string;
  issuedAt: string;
}

/**
 * What an issue did, or why it matched nothing.
 *
 * `round-missing` is the Round having been deleted, or never having been a Post-it Round of this
 * Session - one sentence, because the Facilitator's next move is the same either way. Returned
 * rather than thrown so the error envelope stays in the route, where the rest of this API's
 * refusals are built.
 */
export type DisplayLinkIssueOutcome =
  { outcome: 'issued'; link: IssuedDisplayLink } | { outcome: 'round-missing' };

export interface DisplayLinkRepository {
  /**
   * Issues a link for this Round, revoking whatever live one it had - **in one transaction**.
   *
   * The two statements are one write, so a concurrent double-issue cannot leave two live rows part
   * way through. The partial unique index `display_link_one_live_per_round` is the backstop that
   * makes the guarantee true whatever this code does.
   *
   * The token is a parameter rather than minted here, so the minter stays injectable and this seam
   * stays a seam over storage.
   */
  issue(
    conferenceId: string,
    sessionId: string,
    roundId: string,
    issuedBySub: string,
    token: string,
  ): Promise<DisplayLinkIssueOutcome>;

  /**
   * Revokes this Round's live link, if it has one.
   *
   * **Names the Round, never a link.** A Round holds at most one live link, so there is nothing to
   * disambiguate and no identifier for a caller to send - which is also why revoking twice is a
   * success both times rather than a "no such link" on the second. Idempotent and irreversible.
   */
  revoke(conferenceId: string, sessionId: string, roundId: string): Promise<void>;

  /** This Round's live link, or `null` where it has none. Read fresh; never cached. */
  current(
    conferenceId: string,
    sessionId: string,
    roundId: string,
  ): Promise<IssuedDisplayLink | null>;

  /**
   * The row a token names, with the three facts that decide whether it resolves - or `null`.
   *
   * **The decision is not made here.** This returns what was found; `resolveDisplayLink` in
   * `display-link.ts` decides, so there is exactly one predicate and it is unit-testable against a
   * pinned clock. Filtering revoked or unpublished rows out *in the statement* would scatter the
   * rule across two files and make the reason for a miss depend on which one refused it.
   */
  findByToken(token: string): Promise<DisplayLinkCandidate | null>;
}

interface IssuedRow {
  token: string;
  issued_at: string;
}

interface CandidateRow {
  round_id: string;
  conference_id: string;
  session_id: string;
  prompt: string;
  round_kind: string;
  session_day: string;
  lifecycle_state: string;
  revoked_at: string | null;
}

/**
 * Stamps the live link of a Round that really is a Post-it Round of this Session of this Conference.
 *
 * The Round predicate is on the statement rather than in a read taken first: a Round deleted in the
 * same instant simply matches nothing, and a `roundId` naming some other Conference's Round can
 * never be reached by a caller authorized only for this one. `revoked_at is null` is what makes it
 * idempotent - a second run matches no row and changes nothing.
 */
const REVOKE_LIVE = `
  update display_link dl
     set revoked_at = clock_timestamp()
    from round r
   where dl.round_id = r.id
     and dl.revoked_at is null
     and r.id = $1
     and r.conference_id = $2
     and r.session_id = $3
     and r.kind = 'PostItRound'
`;

/** PostgreSQL `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * The one-live-link-per-Round index, and only that one.
 *
 * A `display_link_token_key` collision is deliberately **not** matched here: 256 bits of CSPRNG
 * output repeating is not a condition to absorb quietly, and it must stay loud.
 */
function isLiveLinkConflict(error: unknown): boolean {
  const detail = (error ?? {}) as { code?: unknown; constraint?: unknown };
  return (
    detail.code === UNIQUE_VIOLATION && detail.constraint === 'display_link_one_live_per_round'
  );
}

export function createDisplayLinkRepository(db: Database): DisplayLinkRepository {
  const repository: DisplayLinkRepository = {
    async issue(
      conferenceId: string,
      sessionId: string,
      roundId: string,
      issuedBySub: string,
      token: string,
    ): Promise<DisplayLinkIssueOutcome> {
      return db
        .transaction(async (tx) => {
          await tx.query(REVOKE_LIVE, [roundId, conferenceId, sessionId]);

          /*
           * Insert-from-select, so "the Round is a Post-it Round of this Session in this Conference"
           * is the INSERT's own source rather than a read taken before it - the same idiom as
           * `post-it-repository.ts`'s contribution. A Round deleted in the same instant inserts
           * nothing, and the whole transaction (including the revoke above) rolls back on the empty
           * result rather than leaving the Facilitator's previous link dead for a link that was never
           * created.
           */
          const rows = await tx.query<IssuedRow>(
            `insert into display_link (token, round_id, conference_id, issued_by_sub)
           select $4, r.id, r.conference_id, $5
             from round r
            where r.id = $1 and r.conference_id = $2 and r.session_id = $3
              and r.kind = 'PostItRound'
           returning token, ${instantExpression('issued_at', 'issued_at')}`,
            [roundId, conferenceId, sessionId, token, issuedBySub],
          );

          const row = rows[0];
          if (row === undefined) {
            // Aborts the transaction, so the revoke above is undone with it. Caught immediately
            // below and turned into the outcome the route refuses on - never surfaced as an error.
            throw new VanishedRound();
          }

          return {
            outcome: 'issued' as const,
            link: { token: row.token, issuedAt: row.issued_at },
          };
        })
        .catch(async (error: unknown) => {
          if (error instanceof VanishedRound) return { outcome: 'round-missing' as const };

          /*
           * The partial unique index did its job and refused a concurrent second issue - two
           * holders of sorting authority on one Round, or one fast double-tap that beat React's
           * re-render past `disabled={busy}`. The **data** is right either way; what was wrong was
           * telling the loser "the server encountered an unexpected problem"
           * (review 2026-08-31, finding 5).
           *
           * The honest answer is the one that is now true: this Round has a live link, and here it
           * is. Re-read rather than guessed, because the winner's value is the one that resolves.
           *
           * The driver's error object is deliberately not logged anywhere on this path either:
           * PostgreSQL's `detail` for a token collision is literally
           * `Key (token)=(<value>) already exists.`, which would be a second route past
           * `redactDisplayToken` (Structural Criterion 4).
           */
          if (isLiveLinkConflict(error)) {
            const live = await repository.current(conferenceId, sessionId, roundId);
            if (live !== null) return { outcome: 'issued' as const, link: live };
          }
          throw error;
        });
    },

    async revoke(conferenceId: string, sessionId: string, roundId: string): Promise<void> {
      // No outcome, deliberately. "There was nothing live to revoke" and "there is nothing live
      // now" are the same end state, and a Facilitator pressing revoke twice has succeeded twice.
      await db.query(REVOKE_LIVE, [roundId, conferenceId, sessionId]);
    },

    async current(
      conferenceId: string,
      sessionId: string,
      roundId: string,
    ): Promise<IssuedDisplayLink | null> {
      const rows = await db.query<IssuedRow>(
        `select dl.token, ${instantExpression('dl.issued_at', 'issued_at')}
           from display_link dl
           join round r on r.id = dl.round_id
          where dl.revoked_at is null
            and r.id = $1 and r.conference_id = $2 and r.session_id = $3
            and r.kind = 'PostItRound'`,
        [roundId, conferenceId, sessionId],
      );
      const row = rows[0];
      return row === undefined ? null : { token: row.token, issuedAt: row.issued_at };
    },

    async findByToken(token: string): Promise<DisplayLinkCandidate | null> {
      /*
       * One statement, four tables, and **none of them a vote table** - and deliberately not a
       * call into `RoundRepository`, which would hydrate the Round's `round_option` rows and put the
       * Poll's option table on this route's reach for a payload that can never carry one (review
       * 2026-08-31, M2). Reading the prompt here also removes the window in which the Round could
       * vanish between two reads. `sessions.day` is a bare
       * `date` and is read as the string PostgreSQL stores (`api/src/db.ts` disables the driver's
       * DATE parser), so it never becomes a `Date` and never acquires a timezone on the way here.
       *
       * The token is compared as an ordinary equality on a UNIQUE column - not by prefix, not by
       * `like`, not case-insensitively. Anything looser would let a partial value match.
       */
      const rows = await db.query<CandidateRow>(
        `select dl.round_id,
                dl.conference_id,
                r.session_id,
                r.prompt,
                r.kind   as round_kind,
                s.day    as session_day,
                c.lifecycle_state,
                ${instantExpression('dl.revoked_at', 'revoked_at')}
           from display_link dl
           join round r      on r.id = dl.round_id
           join sessions s   on s.id = r.session_id
           join conference c on c.id = dl.conference_id
          where dl.token = $1`,
        [token],
      );

      const row = rows[0];
      if (row === undefined) return null;
      return {
        roundId: row.round_id,
        conferenceId: row.conference_id,
        sessionId: row.session_id,
        prompt: row.prompt,
        roundKind: row.round_kind,
        sessionDay: row.session_day,
        lifecycleState: row.lifecycle_state,
        revokedAt: row.revoked_at,
      };
    },
  };

  return repository;
}

/** Internal control flow only – it names the empty insert so the transaction can roll back. */
class VanishedRound extends Error {
  constructor() {
    super('The round named by this display link issue no longer exists.');
    this.name = 'VanishedRound';
  }
}
