import type { AuthenticatedCaller } from '../auth/with-auth.ts';
import type { Queryable } from '../db.ts';
import { AppError, ERROR_CODES } from '../errors.ts';

/**
 * The one per-conference authorization check, in provisional form.
 *
 * **S07 replaces the body of this function, not its call sites.** That is the whole point of it
 * existing this early: S03, S04 and S05 all land before the full role model does, and if each of
 * them grew its own `conference.createdBySub === caller.sub` inline, S07 would be a hunt through
 * scattered comparisons instead of one substitution. The signature is already S07's canonical one
 * (`plan.json` → sharedDecisions → "Per-conference authorization primitive").
 *
 * `options.sessionId` is accepted and deliberately ignored. S07 gives it meaning for the
 * Presenter/Facilitator session scope – "may run and edit *these* sessions". It is in the
 * signature now so adding the scope later changes one implementation rather than every caller.
 *
 * Roles are confApp's own per-conference data, read from `role_assignment` on every call. They
 * are never derived from a Google Workspace directory group (ADR-002): a directory cannot express
 * "facilitates one workshop, attends the rest".
 */

export const CONFERENCE_ROLES = ['Admin', 'PresenterFacilitator', 'Attendee'] as const;

/**
 * Three roles, not four. Presenter/Facilitator is **one** role – the two words describe what the
 * holder is doing, not different permissions (FR5, REQ-025). This story only ever writes 'Admin',
 * but the type is complete from the start because splitting it later costs a migration.
 */
export type ConferenceRole = (typeof CONFERENCE_ROLES)[number];

export interface RequireConferenceRoleOptions {
  /** Reserved for S07's Presenter/Facilitator session scope. Ignored here. */
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
   * A second entry point on the same seam rather than a second seam, for the same reason the first
   * one exists: S07 replaces the bodies in this module and every handler keeps calling. What it
   * cannot be is `requireConferenceRole(..., 'Attendee')`, for two reasons. That one short-circuits
   * on Admin, so a role holder with no Membership would pass a check whose whole question is
   * Membership. And its refusal is CONFERENCE_ROLE_REQUIRED – a sentence about permission to *act*,
   * where an attendee opening a schedule needs to be told they have not joined (FIS S06 → Acceptance
   * Scenario S06).
   *
   * Membership only. No role satisfies it, deliberately: Membership is universal – every role holder
   * has one, including a creator, who is seeded one on create – so nothing is a member by
   * implication (`docs/UBIQUITOUS_LANGUAGE.md`, S03's migration).
   */
  requireMembership(caller: AuthenticatedCaller, conferenceId: string): Promise<void>;
}

interface GrantRow {
  role: string;
}

/**
 * Both grant sources in one round trip. Membership is included because the Attendee role *is*
 * Membership – it needs no Role Assignment (`docs/UBIQUITOUS_LANGUAGE.md`) – and asking for it
 * separately would let a caller be "an attendee" on the strength of a role row alone, which is
 * the member-by-implication the Structural Criteria rule out.
 */
const GRANTS = `
  select role from role_assignment where conference_id = $1 and user_sub = $2
  union all
  select 'Attendee' as role from membership where conference_id = $1 and user_sub = $2
`;

/**
 * Refuses without confirming or denying that the Conference exists.
 *
 * A caller with no grant is told they cannot act on it and nothing else – not its name, not its
 * state, not whether the id is real. An unknown id and someone else's draft therefore produce the
 * identical answer, which is what stops this endpoint from being a way to enumerate conferences
 * (Acceptance Scenario S07).
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

function satisfies(held: ReadonlySet<string>, required: ConferenceRole): boolean {
  // An Admin has conference-wide authority, so it satisfies every requirement. Provisional
  // exactly like the rest of this module: S07 owns what the role model finally means.
  if (held.has('Admin')) return true;
  return held.has(required);
}

export function createConferenceAuthorization(db: Queryable): ConferenceAuthorization {
  return {
    async requireConferenceRole(
      caller: AuthenticatedCaller,
      conferenceId: string,
      required: ConferenceRole,
      _options: RequireConferenceRoleOptions = {},
    ): Promise<void> {
      // Read per call, never cached: a role revoked by S08 must take effect on the next request,
      // and this API has several replicas with no request affinity.
      const rows = await db.query<GrantRow>(GRANTS, [conferenceId, caller.sub]);
      const held = new Set(rows.map((row) => row.role));

      if (!satisfies(held, required)) throw refusal();
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
