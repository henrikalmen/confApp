import type { AuthenticatedCaller } from '../auth/with-auth.ts';
import type { Queryable } from '../db.ts';
import { AppError, ERROR_CODES } from '../errors.ts';

/**
 * The one per-conference authorization check.
 *
 * S03 landed this module in provisional form so that S04 and S05 could express their checks
 * through it before the real role model existed. S07 replaces the body and leaves the signature
 * and every call site exactly where they were – which is the whole reason the seam was created
 * this early (`plan.json` → sharedDecisions → "Per-conference authorization primitive").
 *
 * Three inputs decide every request: the verified `sub` from S02's wrapper, the Conference named
 * in the route, and the role the handler declares it needs. Authority is resolved from confApp's
 * own rows for that Conference and from nothing else. No Google Workspace directory group is read,
 * no `groups` claim is consulted, and none is requested in the OIDC scope: a directory cannot
 * express "facilitates one workshop, attends the rest" (ADR-002).
 *
 * Nothing is cached. The rows are re-read on every call, because a role revoked a moment ago must
 * take effect on the next request and the API runs as several container replicas with no request
 * affinity (ADR-004). A module-level, global or static role cache would be wrong on the next
 * replica even if it were fresh on this one.
 */

export const CONFERENCE_ROLES = ['Admin', 'PresenterFacilitator', 'Attendee'] as const;

/**
 * Three roles, not four. Presenting and facilitating are the same role – the two words describe
 * what the holder is doing, not different permissions (FR5, REQ-025, docs/UBIQUITOUS_LANGUAGE.md).
 * A Session's `kind` therefore plays no part in any decision this module makes, and there is no
 * branch anywhere below that reads one.
 */
export type ConferenceRole = (typeof CONFERENCE_ROLES)[number];

/**
 * The fixed authority order: `Attendee < PresenterFacilitator < Admin`.
 *
 * A single ordering rather than a permission table per role, because that is what the product
 * actually says: an Admin has conference-wide authority, a Presenter/Facilitator has authority
 * over their own Sessions, and an Attendee is simply in the room. Session scope is expressed as a
 * *narrowing* of this one check (see `sessionId` below) rather than as a fourth role, which is
 * what keeps Presenter/Facilitator from quietly splitting in two.
 */
const ROLE_RANK: Record<ConferenceRole, number> = {
  Attendee: 0,
  PresenterFacilitator: 1,
  Admin: 2,
};

export interface RequireConferenceRoleOptions {
  /**
   * Narrows the check to one Session, for the Presenter/Facilitator scope – "may run and edit
   * *these* sessions".
   *
   * An Admin passes it unconditionally, on conference-wide authority. Anyone else must hold both
   * the Presenter/Facilitator role in this Conference and a Session Assignment for this Session.
   */
  sessionId?: string;
}

export interface ConferenceAuthorization {
  requireConferenceRole(
    caller: AuthenticatedCaller,
    conferenceId: string,
    required: ConferenceRole,
    options?: RequireConferenceRoleOptions,
  ): Promise<void>;
  /**
   * "Is this caller *in* this Conference" – the attendee read's decision (S06).
   *
   * A second entry point on the same seam rather than a second seam. What it cannot be is
   * `requireConferenceRole(..., 'Attendee')`: its refusal is CONFERENCE_ROLE_REQUIRED – a sentence
   * about permission to *act*, where an attendee opening a schedule needs to be told they have not
   * joined (FIS S06 → Acceptance Scenario S06).
   *
   * Membership only. No role satisfies it, deliberately: Membership is universal – every role
   * holder has one, including a creator, who is seeded one on create – so nothing is a member by
   * implication (`docs/UBIQUITOUS_LANGUAGE.md`, S03's migration).
   */
  requireMembership(caller: AuthenticatedCaller, conferenceId: string): Promise<void>;
}

interface GrantRow {
  role: string;
  /** True for the Membership row, so a Role Assignment can never impersonate one. */
  is_membership: boolean;
}

/**
 * Both grant sources in one round trip, kept distinguishable.
 *
 * The Attendee role *is* Membership and needs no Role Assignment
 * (`docs/UBIQUITOUS_LANGUAGE.md`), so Membership contributes `Attendee` here. The `is_membership`
 * flag is what stops that from working in reverse: the schema can express a Role Assignment whose
 * role happens to be 'Attendee', and without the flag such a row would let a caller pass a
 * Membership requirement on the strength of a grant. Membership is a row in `membership` or it is
 * not a fact – which is the member-by-implication the Structural Criteria rule out.
 */
const GRANTS = `
  select role, false as is_membership from role_assignment where conference_id = $1 and user_sub = $2
  union all
  select 'Attendee' as role, true as is_membership from membership where conference_id = $1 and user_sub = $2
`;

/** Does this `sub` hold a Session Assignment for this Session of this Conference? */
const SESSION_SCOPE = `
  select 1 as held from session_assignment
   where conference_id = $1 and session_id = $2 and user_sub = $3
`;

/**
 * Refuses without confirming or denying that the Conference exists.
 *
 * A caller with no grant is told they cannot act on it and nothing else – not its name, not its
 * state, not whether the id is real. An unknown id and someone else's draft therefore produce the
 * identical answer, which is what stops this endpoint from being a way to enumerate conferences
 * (S03 → Acceptance Scenario S07).
 *
 * The same sentence answers "you hold no role here", "your role is not high enough" and "this is
 * not one of your sessions", for the same reason: distinguishing them would tell a caller which
 * Sessions of a Conference they cannot see exist.
 */
function refusal(): AppError {
  return new AppError(
    ERROR_CODES.CONFERENCE_ROLE_REQUIRED,
    403,
    'You do not have permission to do this in this conference.',
  );
}

/**
 * Refuses without confirming or denying that the Conference exists, exactly as `refusal()` does.
 *
 * An unknown id and a Conference the caller has not joined produce the identical answer, so this
 * endpoint cannot be used to discover which conference ids are real. That is also why the reason is
 * checked *before* the lifecycle state: telling a non-member that a conference is "not published
 * yet" would disclose both that it exists and what it is doing.
 */
function notAMember(): AppError {
  return new AppError(
    ERROR_CODES.NOT_A_MEMBER,
    403,
    'You have not joined this conference, so its schedule is not available to you. ' +
      'Ask the organizer for the join code.',
  );
}

function isConferenceRole(value: string): value is ConferenceRole {
  return (CONFERENCE_ROLES as readonly string[]).includes(value);
}

export function createConferenceAuthorization(db: Queryable): ConferenceAuthorization {
  return {
    async requireConferenceRole(
      caller: AuthenticatedCaller,
      conferenceId: string,
      required: ConferenceRole,
      options: RequireConferenceRoleOptions = {},
    ): Promise<void> {
      // Read per call, never cached: a role revoked by S08 must take effect on the next request,
      // and this API has several replicas with no request affinity.
      const rows = await db.query<GrantRow>(GRANTS, [conferenceId, caller.sub]);

      /*
       * Membership first, and it is not a formality. Membership means "is in this Conference" for
       * every role without exception – S03 seeds the creator's alongside their Admin Role
       * Assignment, S05's join endpoint writes the rest, and a grant target must already hold one –
       * so a Role Assignment with no Membership behind it is a corrupted state, not a shortcut to
       * honour. Refusing here is what keeps "no authority without a Membership row" a property of
       * the code rather than of the data happening to be tidy.
       */
      if (!rows.some((row) => row.is_membership)) throw refusal();

      const held = rows
        .filter((row) => !row.is_membership)
        .map((row) => row.role)
        .filter(isConferenceRole);

      // Membership itself is the Attendee grant, and it is already established above.
      const rank = held.reduce((highest, role) => Math.max(highest, ROLE_RANK[role]), 0);
      if (rank < ROLE_RANK[required]) throw refusal();

      if (options.sessionId === undefined) return;

      /*
       * The Session scope, as a narrowing of this same decision rather than a second "session
       * role". An Admin passes on conference-wide authority and holds no Session Assignment; a
       * Presenter/Facilitator passes only against a row for this Session. The Session's `kind` is
       * never read – a Presentation and a Workshop authorize identically.
       */
      if (rank >= ROLE_RANK.Admin) return;

      const scope = await db.query<{ held: number }>(SESSION_SCOPE, [
        conferenceId,
        options.sessionId,
        caller.sub,
      ]);
      if (scope[0] === undefined) throw refusal();
    },

    async requireMembership(caller: AuthenticatedCaller, conferenceId: string): Promise<void> {
      // Joined on `sub` against the same column every other grant lookup uses. `userId` is
      // confApp's local surrogate for the `app_user` row and is never a join key here; email is
      // never a key at all (ADR-002, AGENTS.md#do-not--never).
      const rows = await db.query<{ id: string }>(
        'select id from membership where conference_id = $1 and user_sub = $2',
        [conferenceId, caller.sub],
      );

      if (rows[0] === undefined) throw notAMember();
    },
  };
}
