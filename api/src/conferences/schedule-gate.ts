import type { Queryable } from '../db.ts';

/**
 * "Does this Conference have at least one Session yet?" – the publish gate's only question.
 *
 * It is a port because Sessions do not exist yet. S04 owns the Session table, and until it lands
 * there is nothing to count. Rather than block this story on that one, publishing asks through
 * this seam: the refusal path is proved against the real binding below (which answers `false`,
 * truthfully – a Conference cannot have a Session when no Session can exist), and the success
 * path is proved against a stubbed gate.
 *
 * **Binding obligation on S04**: replace the body of `createScheduleGate` with a real count over
 * the Session table, and re-run S03's publish scenario end to end. Nothing else about publishing
 * changes – the state machine, the authorization check and the endpoint all stay as they are.
 */

export interface ScheduleGate {
  hasAtLeastOneSession(conferenceId: string): Promise<boolean>;
}

export function createScheduleGate(_db: Queryable): ScheduleGate {
  return {
    async hasAtLeastOneSession(_conferenceId: string): Promise<boolean> {
      // Not a stub standing in for a missing answer – this *is* the answer until S04 exists.
      return false;
    },
  };
}
