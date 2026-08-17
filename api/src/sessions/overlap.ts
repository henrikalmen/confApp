import type { CalendarDate } from '../conferences/calendar-date.ts';
import type { WallClockTime } from './wall-clock-time.ts';

/**
 * Which Sessions run at the same time as which.
 *
 * **Overlap is a warning, never an error.** Two Sessions at the same time are a Parallel Track –
 * an explicitly supported product option (FR2, REQ-029, `docs/UBIQUITOUS_LANGUAGE.md`) – so no
 * write path may reject on what this module reports. It exists so the Organizer can *see* the
 * parallel tracks they have created, and so the pre-publish "review overlap warnings" step has
 * something to review.
 *
 * Recomputed on every read and never stored. A stored overlap flag would be wrong the moment
 * either Session moved and right again only if someone remembered to recompute it; deriving it
 * from the times themselves means it cannot go stale, and it is a comparison of a handful of
 * strings over one Conference's schedule.
 */

export interface OverlapCandidate {
  id: string;
  day: CalendarDate;
  startTime: WallClockTime;
  endTime: WallClockTime;
}

/** A pair of Sessions that run at the same time. Ordered as the sessions were given. */
export interface OverlapPair {
  sessionIds: [string, string];
}

/**
 * Half-open intervals: `start < otherEnd AND end > otherStart`.
 *
 * Touching boundaries therefore do not overlap – a Session ending 10:00 and one starting 10:00 run
 * back to back, which is the ordinary shape of a schedule and would be noise if it were flagged.
 * The comparison is string-on-string: zero-padded 'HH:mm' orders chronologically as text.
 */
export function overlaps(a: OverlapCandidate, b: OverlapCandidate): boolean {
  if (a.day !== b.day) return false;
  return a.startTime < b.endTime && a.endTime > b.startTime;
}

/** Every overlapping pair in a Conference's schedule, each pair reported once. */
export function overlappingPairs(sessions: readonly OverlapCandidate[]): OverlapPair[] {
  const pairs: OverlapPair[] = [];
  for (let i = 0; i < sessions.length; i += 1) {
    for (let j = i + 1; j < sessions.length; j += 1) {
      const a = sessions[i]!;
      const b = sessions[j]!;
      if (overlaps(a, b)) pairs.push({ sessionIds: [a.id, b.id] });
    }
  }
  return pairs;
}

/** The Sessions one Session runs alongside – what a save-time warning names. */
export function overlapsWith<T extends OverlapCandidate>(
  subject: OverlapCandidate,
  others: readonly T[],
): T[] {
  return others.filter((other) => other.id !== subject.id && overlaps(subject, other));
}
