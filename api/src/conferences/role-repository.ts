import type { Database, Queryable } from '../db.ts';
import { AppError, ERROR_CODES } from '../errors.ts';
import type { ConferenceRole } from './authorization.ts';
import { sessionExistsInConference } from '../sessions/session-repository.ts';

/**
 * The `role_assignment`, `membership` and `session_assignment` tables, behind one seam.
 *
 * Two rules shape everything here.
 *
 * **The member list is derived from Membership**, never from Role Assignments. Membership means
 * "is in this Conference" for every role without exception – S03 seeds the creator's alongside
 * their Admin grant, S05's join endpoint writes the rest – so listing members means listing
 * `membership` rows and decorating them with whatever grants exist. Deriving the list from
 * `role_assignment` instead would silently drop every plain Attendee, and building it from a union
 * of the two would reintroduce the member-by-implication this model exists to remove.
 *
 * **Nothing here is keyed on an email address.** Every row identifies its user by `sub` (ADR-002).
 * An address reaches this module only as a lookup input, resolved to a `sub` before any write, and
 * is never stored, compared or joined on.
 */

/** The two roles an Admin can hand out. Attendee is not among them: Attendee *is* Membership. */
export const GRANTABLE_ROLES = ['Admin', 'PresenterFacilitator'] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export interface ConferenceMember {
  sub: string;
  displayName: string;
  /** Display data, so an Admin can tell two people apart. Never a key (ADR-002). */
  email: string;
  joinedAt: string;
  /** Every role held here, most authoritative first. Always contains Attendee – see below. */
  roles: ConferenceRole[];
  /** The Sessions this member may run and edit. Empty unless they hold Presenter/Facilitator. */
  sessionIds: string[];
}

interface MemberRow {
  user_sub: string;
  display_name: string;
  email: string;
  joined_at: Date;
}

/**
 * Ordered by display name so the list reads like a roster rather than like a table scan. The
 * tie-break on `user_sub` is not decoration: two employees can share a display name, and an untied
 * ORDER BY would let the same data come back in a different order on different reads.
 */
const MEMBERS = `
  select m.user_sub, m.joined_at, u.display_name, u.email
    from membership m
    join app_user u on u.sub = m.user_sub
   where m.conference_id = $1
   order by u.display_name, m.user_sub
`;

const ROLES = 'select user_sub, role from role_assignment where conference_id = $1';

const ASSIGNMENTS =
  'select user_sub, session_id from session_assignment where conference_id = $1 order by session_id';

/** Most authoritative first, so a row reads "Admin, Attendee" rather than in insertion order. */
const ROLE_ORDER: Record<ConferenceRole, number> = {
  Admin: 0,
  PresenterFacilitator: 1,
  Attendee: 2,
};

/**
 * Serializes every role change for one Conference behind the Conference row.
 *
 * The last-Admin rule cannot survive without it. Two Admins revoking each other at the same moment
 * would each read a second Admin, each proceed, and leave a Conference nobody can administer – a
 * read-then-write implementation passes every sequential test and fails exactly here. Exported
 * because S08 applies the same rule to leaving and to removal, and must queue behind the same lock
 * rather than take one of its own.
 */
export async function lockConference(tx: Queryable, conferenceId: string): Promise<void> {
  const rows = await tx.query<{ id: string }>(
    'select id from conference where id = $1 for update',
    [conferenceId],
  );
  if (rows[0] === undefined) {
    throw new AppError(ERROR_CODES.CONFERENCE_NOT_FOUND, 404, 'That conference no longer exists.');
  }
}

/**
 * The last-Admin rule, stated as a post-condition: after whatever this transaction just did, does
 * the Conference still have an Admin?
 *
 * Asking it *after* the write rather than before is what makes it exact. "Is there another Admin
 * besides this one" has to reason about who is being removed and whether they held the role at
 * all; "is there an Admin left" is the invariant itself, and throwing here rolls the write back.
 *
 * Exported for S08, which applies the same rule to leaving and to Admin removal. It must not
 * re-derive it: two copies of a rule that already needs a lock to be correct is how the third
 * caller gets it subtly wrong.
 */
export async function assertConferenceKeepsAnAdmin(
  tx: Queryable,
  conferenceId: string,
  /**
   * How the refusal finishes: what the caller does *after* appointing another Admin.
   *
   * A parameter rather than a second copy of the rule. S08 revokes whole Memberships through this
   * same function, and "then remove this role" is the wrong next step for somebody who was trying
   * to leave the conference – the rule is identical, only the sentence it ends with differs. The
   * default reproduces S07's own wording exactly, so every existing call site is unchanged.
   */
  nextStep = 'then remove this role.',
): Promise<void> {
  const rows = await tx.query<{ count: number }>(
    "select count(*)::int as count from role_assignment where conference_id = $1 and role = 'Admin'",
    [conferenceId],
  );
  if ((rows[0]?.count ?? 0) > 0) return;

  throw new AppError(
    ERROR_CODES.CONFERENCE_LAST_ADMIN,
    409,
    'A conference must always have at least one admin, and this is the last one. ' +
      `Make somebody else an admin first, ${nextStep}`,
  );
}

export interface RoleRepository {
  /** Every member of the Conference, with their roles and Session assignments. */
  listMembers(conferenceId: string): Promise<ConferenceMember[]>;
  /** Is this `sub` in this Conference? The precondition every grant target must satisfy. */
  isMember(conferenceId: string, userSub: string): Promise<boolean>;
  grant(conferenceId: string, userSub: string, role: GrantableRole): Promise<void>;
  revoke(conferenceId: string, userSub: string, role: GrantableRole): Promise<void>;
  assignSession(conferenceId: string, sessionId: string, userSub: string): Promise<void>;
  unassignSession(conferenceId: string, sessionId: string, userSub: string): Promise<void>;
}

export function createRoleRepository(db: Database): RoleRepository {
  return {
    /**
     * Three fixed queries, stitched here rather than one aggregate join.
     *
     * Fixed is the load-bearing word: the count does not grow with the number of members, sessions
     * or grants, so this is three round trips for a conference of eighty people exactly as it is
     * for one of three. A per-member lookup for roles would be the N+1 the schedule read was
     * already corrected for (docs/LEARNINGS.md).
     */
    async listMembers(conferenceId: string): Promise<ConferenceMember[]> {
      const members = await db.query<MemberRow>(MEMBERS, [conferenceId]);
      const roles = await db.query<{ user_sub: string; role: string }>(ROLES, [conferenceId]);
      const assignments = await db.query<{ user_sub: string; session_id: string }>(ASSIGNMENTS, [
        conferenceId,
      ]);

      const granted = new Map<string, ConferenceRole[]>();
      for (const row of roles) {
        const held = granted.get(row.user_sub) ?? [];
        held.push(row.role as ConferenceRole);
        granted.set(row.user_sub, held);
      }

      const covered = new Map<string, string[]>();
      for (const row of assignments) {
        const sessions = covered.get(row.user_sub) ?? [];
        sessions.push(row.session_id);
        covered.set(row.user_sub, sessions);
      }

      return members.map((row) => ({
        sub: row.user_sub,
        displayName: row.display_name,
        email: row.email,
        joinedAt: row.joined_at.toISOString(),
        /*
         * Attendee comes from the Membership row this list is built on, and is present for
         * everybody – the creator included. Everyone who is in a conference is an attendee of it
         * and the other roles are additive (FR5), so a member showing only "Admin" would be
         * describing a permission set rather than a person in a room.
         */
        roles: [...(granted.get(row.user_sub) ?? []), 'Attendee' as ConferenceRole].sort(
          (a, b) => ROLE_ORDER[a] - ROLE_ORDER[b],
        ),
        sessionIds: covered.get(row.user_sub) ?? [],
      }));
    },

    async isMember(conferenceId: string, userSub: string): Promise<boolean> {
      const rows = await db.query<{ id: string }>(
        'select id from membership where conference_id = $1 and user_sub = $2',
        [conferenceId, userSub],
      );
      return rows[0] !== undefined;
    },

    /**
     * One Role Assignment row, or none if it is already there.
     *
     * Idempotent against the `(conference_id, user_sub, role)` unique constraint, so granting a
     * role somebody already holds is the same fact rather than a constraint violation the Admin
     * would read as "something went wrong". No Membership is written: this story reads Membership
     * and never writes it (S03 seeds the creator's, S05 writes joiners').
     */
    async grant(conferenceId: string, userSub: string, role: GrantableRole): Promise<void> {
      await db.query(
        `insert into role_assignment (conference_id, user_sub, role) values ($1, $2, $3)
         on conflict (conference_id, user_sub, role) do nothing`,
        [conferenceId, userSub, role],
      );
    },

    /**
     * Removes one Role Assignment, and nothing else.
     *
     * The Membership survives, and so does every historical record – revoking a role is not
     * removing a person from the conference (FR6 is S08's). What does go with it is that role's
     * Session Assignments, because an assignment held by somebody who is no longer a
     * Presenter/Facilitator is an orphan that would keep passing a Session scope check.
     */
    async revoke(conferenceId: string, userSub: string, role: GrantableRole): Promise<void> {
      await db.transaction(async (tx) => {
        await lockConference(tx, conferenceId);

        const deleted = await tx.query<{ id: string }>(
          `delete from role_assignment
            where conference_id = $1 and user_sub = $2 and role = $3
           returning id`,
          [conferenceId, userSub, role],
        );

        if (deleted[0] === undefined) {
          throw new AppError(
            ERROR_CODES.ROLE_ASSIGNMENT_NOT_FOUND,
            404,
            'That person does not currently hold that role in this conference, so there is ' +
              'nothing to remove.',
          );
        }

        if (role === 'PresenterFacilitator') {
          await tx.query(
            'delete from session_assignment where conference_id = $1 and user_sub = $2',
            [conferenceId, userSub],
          );
        }

        // Asked after the delete, so the answer is about the conference as this transaction would
        // leave it. Throwing rolls the delete back.
        await assertConferenceKeepsAnAdmin(tx, conferenceId);
      });
    },

    /**
     * Assigns a Session to a holder of the Presenter/Facilitator role.
     *
     * Inside the same lock the revocation takes, so a concurrent revoke cannot slip between the
     * role check and the insert and leave an assignment nobody holds the role for. The Session's
     * `kind` is not read: presenting and facilitating are one role, so a Presentation and a
     * Workshop are assigned identically.
     */
    async assignSession(conferenceId: string, sessionId: string, userSub: string): Promise<void> {
      await db.transaction(async (tx) => {
        await lockConference(tx, conferenceId);

        // Asked through the sessions module rather than by reading its table: the schedule is
        // S04's to own, and the composite foreign key below is the structural backstop under this.
        if (!(await sessionExistsInConference(tx, conferenceId, sessionId))) {
          throw new AppError(
            ERROR_CODES.SESSION_NOT_FOUND,
            404,
            'That session no longer exists in this conference.',
          );
        }

        const held = await tx.query<{ id: string }>(
          `select id from role_assignment
            where conference_id = $1 and user_sub = $2 and role = 'PresenterFacilitator'`,
          [conferenceId, userSub],
        );
        if (held[0] === undefined) {
          throw new AppError(
            ERROR_CODES.SESSION_ASSIGNMENT_ROLE_REQUIRED,
            409,
            'Only a presenter/facilitator can be assigned to a session. Give this person the ' +
              'presenter/facilitator role in this conference first.',
          );
        }

        await tx.query(
          `insert into session_assignment (conference_id, session_id, user_sub)
           values ($1, $2, $3)
           on conflict (session_id, user_sub) do nothing`,
          [conferenceId, sessionId, userSub],
        );
      });
    },

    /**
     * Removes one Session Assignment. Idempotent: unassigning a Session somebody does not cover
     * already leaves the intended state, and reporting that as a failure would make a double-click
     * look like a fault. The role itself is untouched.
     */
    async unassignSession(conferenceId: string, sessionId: string, userSub: string): Promise<void> {
      await db.query(
        `delete from session_assignment
          where conference_id = $1 and session_id = $2 and user_sub = $3`,
        [conferenceId, sessionId, userSub],
      );
    },
  };
}
