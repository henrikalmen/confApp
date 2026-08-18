import type { Database, Queryable } from '../db.ts';
import { assertConferenceKeepsAnAdmin, lockConference } from './role-repository.ts';

/**
 * Ending one person's Membership of one Conference – the single write path behind both leaving and
 * being removed.
 *
 * One operation, not two, and that is the whole design. The two endpoints differ only in who the
 * target is and who is allowed to ask; what actually happens to the rows is identical, so a second
 * implementation would be a second place for the last-Admin rule and the no-cascade guarantee to
 * drift apart.
 *
 * **Nothing cascades.** The deletes below are explicit, scoped statements naming exactly three
 * things: this Membership, this user's Role Assignments *in this Conference*, and their Session
 * Assignments *in this Conference*. No foreign key from `app_user` or `membership` carries a
 * cascading delete rule (asserted against the database catalog in the integration suite), so the
 * record of what somebody did while they were in a Conference is not the Membership's child and
 * cannot be swept away with it (FR6).
 *
 * **The standing goes with the Membership.** Deleting the Membership alone would leave a departed
 * Admin still satisfying `requireConferenceRole` – authority over a Conference they are no longer
 * in. Deleting the role but not its Session Assignments would leave the orphan rows S07's own role
 * revocation already removes for the same reason, and would silently restore a re-joining member to
 * the Sessions they used to run – a trace of having left, which the PRD's edge case rules out.
 *
 * **Nothing here is keyed on an email address.** The target is a `sub` (ADR-002), resolved by the
 * caller from S02's verified caller context or picked off the member list.
 */

/**
 * Which of the two paths asked, used for one thing only: how the last-Admin refusal finishes.
 *
 * It selects a sentence, never a rule. Both values run byte-identical SQL in the same order – if a
 * branch on this ever guards a *write*, the two paths have stopped being one operation.
 */
export type Departure = 'left' | 'removed';

const NEXT_STEP: Record<Departure, string> = {
  left: 'then leave this conference.',
  removed: 'then remove this person from the conference.',
};

export interface MembershipRepository {
  /**
   * Ends `userSub`'s Membership of this Conference, with their standing in it.
   *
   * Answers whether there was a Membership to end. `false` is a success: a target with no
   * Membership is not in the Conference at all, and under the seeded model that also means no Role
   * Assignment, so there is nothing to delete and nothing was (FR6 → Error Handling). The caller
   * reports it as success rather than as an error.
   */
  revoke(conferenceId: string, userSub: string, departure: Departure): Promise<boolean>;
}

export function createMembershipRepository(db: Database): MembershipRepository {
  return {
    async revoke(conferenceId: string, userSub: string, departure: Departure): Promise<boolean> {
      return db.transaction(async (tx: Queryable) => {
        /*
         * S07's lock, taken here rather than a lock of this story's own. Every role change and
         * every revocation for one Conference queues behind the same Conference row, which is what
         * makes the count below a statement about the conference rather than about one snapshot of
         * it: two Admins leaving at the same moment cannot each observe the other still standing.
         */
        await lockConference(tx, conferenceId);

        const ended = await tx.query<{ id: string }>(
          'delete from membership where conference_id = $1 and user_sub = $2 returning id',
          [conferenceId, userSub],
        );

        // Not a member: nothing to end, nothing ended. The Role Assignment tables are not touched
        // either, because under the seeded model a target with no Membership holds no role here.
        if (ended[0] === undefined) return false;

        await tx.query('delete from role_assignment where conference_id = $1 and user_sub = $2', [
          conferenceId,
          userSub,
        ]);

        await tx.query(
          'delete from session_assignment where conference_id = $1 and user_sub = $2',
          [conferenceId, userSub],
        );

        /*
         * S07's rule, evaluated inside this transaction with the Conference locked – not a check
         * the handler ran a round trip ago. Asked *after* the deletes, so it answers about the
         * conference as this transaction would leave it; throwing rolls all three deletes back
         * together, which is what makes "the membership is gone but the admin role survived"
         * unobservable rather than merely unlikely.
         */
        await assertConferenceKeepsAnAdmin(tx, conferenceId, NEXT_STEP[departure]);
        return true;
      });
    },
  };
}
