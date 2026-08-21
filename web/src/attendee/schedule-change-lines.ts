import type { ChangedSession, DatedSession, ScheduleDiff } from './schedule-diff.ts';

/**
 * `diffSchedule`'s result, in the words an attendee reads.
 *
 * Presentation only – it derives nothing and compares nothing. Which Sessions moved and which
 * fields changed is `schedule-diff.ts`'s single answer (S09), and this turns that answer into
 * sentences. Both surfaces that report a change render from here: S09's in-app banner, for an
 * attendee who was online when the Schedule moved, and S10's reconnect summary, for one who was
 * not. Two wordings would eventually tell the same person two different stories about the same
 * edit, which is the failure the shared diff already exists to prevent.
 *
 * **Nothing here parses or formats a time.** Every value is the string S04 authored and the API
 * serialized, straight through.
 */

/** "09:30–11:00", from the authored strings. */
function timeRange(session: DatedSession): string {
  return `${session.startTime}–${session.endTime}`;
}

/**
 * What changed about one Session, by named field.
 *
 * Built from the fields rather than from a generic "was updated", because a silent swap is the
 * failure both surfaces exist to prevent: "Opening Keynote was updated" leaves somebody comparing
 * the screen against their memory to work out what moved.
 */
function describeChange(change: ChangedSession, includePrevious: boolean): string {
  const { session, previous, fields } = change;
  const moved = fields.includes('startTime') || fields.includes('endTime');
  const clauses: string[] = [];

  if (fields.includes('day')) clauses.push(`moved to ${session.day}`);
  /*
   * The old time is named **only** in the reconnect summary. S09's banner appears on a view the
   * attendee was already watching when it moved, so "now runs 09:30–11:00" is the whole story and
   * the previous value is one they just saw. S10's reader was offline while it happened and has the
   * *old* time written down – "instead of 13:00–14:00" is what lets them recognise the slot they
   * planned around (Acceptance Scenario S04). Same derivation, two audiences.
   */
  if (moved) {
    clauses.push(
      includePrevious
        ? `now runs ${timeRange(session)} instead of ${timeRange(previous)}`
        : `now runs ${timeRange(session)}`,
    );
  }
  if (fields.includes('location')) clauses.push(`now in ${session.location}`);
  if (fields.includes('title')) clauses.push(`is now called “${session.title}”`);
  if (fields.includes('kind')) clauses.push(`is now a ${session.kind}`);
  if (fields.includes('description')) clauses.push('has an updated description');

  // The title the attendee last saw, so a renamed Session is recognisable as the one they knew.
  const name = fields.includes('title') ? previous.title : session.title;
  return `${name} ${clauses.join(', ')}.`;
}

export interface ChangeLine {
  key: string;
  text: string;
}

/**
 * One line per change: edits, then additions, then removals.
 *
 * A removal is stated as plainly as an addition and never merely implied by absence – an attendee
 * who was offline while a Session was deleted is the person most likely to walk to a room that no
 * longer has anything in it (S10 OC02).
 *
 * `includePrevious` is the one difference between the two surfaces, and it defaults off so S09's
 * banner keeps the exact sentence it shipped with.
 */
export function changeLines(diff: ScheduleDiff, includePrevious = false): ChangeLine[] {
  return [
    ...diff.changed.map((change) => ({
      key: `changed-${change.session.id}`,
      text: describeChange(change, includePrevious),
    })),
    ...diff.added.map((session) => ({
      key: `added-${session.id}`,
      text: `${session.title} was added on ${session.day} at ${timeRange(session)}.`,
    })),
    ...diff.removed.map((session) => ({
      key: `removed-${session.id}`,
      text: `${session.title} was removed.`,
    })),
  ];
}
