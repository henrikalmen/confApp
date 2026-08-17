import type { Queryable } from '../db.ts';

/**
 * "Does this Conference have at least one Session yet?" – the publish gate's only question.
 *
 * S03 introduced this as a port because Sessions did not exist yet, and bound it to an
 * implementation that answered `false`: truthfully, since a Conference cannot have a Session when
 * no Session can exist. **S04 discharges that binding obligation** – the body below is the real
 * count over the `sessions` table, and there is no stub, constant or feature flag left anywhere in
 * the publish path.
 *
 * Nothing else about publishing changed. The state machine, the authorization check, the endpoint
 * and the refusal message are S03's, untouched; only the implementation behind the port is new,
 * which is what lets S03's publish scenario be re-run against it unmodified.
 */

export interface ScheduleGate {
  hasAtLeastOneSession(conferenceId: string): Promise<boolean>;
}

export function createScheduleGate(db: Queryable): ScheduleGate {
  return {
    async hasAtLeastOneSession(conferenceId: string): Promise<boolean> {
      // `exists` rather than `count(*)`: the question is whether there is one, and PostgreSQL can
      // stop at the first row instead of walking a schedule that may hold a hundred Sessions.
      const rows = await db.query<{ present: boolean }>(
        'select exists (select 1 from sessions where conference_id = $1) as present',
        [conferenceId],
      );
      return rows[0]?.present === true;
    },
  };
}
