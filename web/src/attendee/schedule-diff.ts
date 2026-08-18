import type { AttendeeSchedule, AttendeeSession } from '../api/client.ts';

/**
 * What changed between two schedule envelopes – the one exported "what changed" derivation.
 *
 * **There is deliberately only one of these, and S10 consumes it** (S09 TI03, Execution Contract).
 * This story renders its output as the in-app banner for an Attendee who stayed online; S10 renders
 * the same output as the reconnect summary for one who was offline, applied to its cached envelope
 * and the freshly fetched one. Two derivations would eventually disagree about the same change, and
 * the two surfaces would tell the same person different stories about their morning.
 *
 * Pure by construction: two envelopes in, a result out. It reads no clock, touches no network,
 * holds nothing between calls and knows nothing about a connection – which is what lets S10 apply
 * it to a payload that arrived from a cache rather than a response. If it ever needs a signature
 * change to serve the offline case, change it *here* and re-run this story's tests rather than
 * forking it.
 *
 * **Nothing here parses a time.** Every comparison is a string comparison on S04's naive wall-clock
 * values, exactly as they were authored and serialized. A `Date` anywhere in this file would move a
 * 09:00 session for anyone whose device is not in the API's timezone, and would do it silently –
 * the diff would report a change that never happened, or miss one that did.
 */

/** The Session fields an Attendee would notice moving. `concurrentWith` is derived, so not one. */
export const TRACKED_FIELDS = [
  'day',
  'startTime',
  'endTime',
  'location',
  'title',
  'kind',
  'description',
] as const;

export type TrackedField = (typeof TRACKED_FIELDS)[number];

/** A Session flattened onto its Conference Day, which the envelope carries one level up. */
export interface DatedSession extends AttendeeSession {
  day: string;
}

export interface ChangedSession {
  /** The Session as it stands now. */
  session: DatedSession;
  /** How it stood before, so a renderer can say "moved *from* 09:00" without a second lookup. */
  previous: DatedSession;
  /** Which of `TRACKED_FIELDS` differ, in the order they are declared above. */
  fields: TrackedField[];
}

export interface ScheduleDiff {
  added: DatedSession[];
  removed: DatedSession[];
  changed: ChangedSession[];
}

/** Every Session in an envelope, keyed by id, each carrying the day it sits on. */
function byId(envelope: AttendeeSchedule): Map<string, DatedSession> {
  const sessions = new Map<string, DatedSession>();
  for (const day of envelope.days) {
    for (const session of day.sessions) {
      sessions.set(session.id, { ...session, day: day.date });
    }
  }
  return sessions;
}

function changedFields(previous: DatedSession, current: DatedSession): TrackedField[] {
  return TRACKED_FIELDS.filter((field) => previous[field] !== current[field]);
}

/**
 * The difference between two envelopes: Sessions added, removed, and changed by named field.
 *
 * **Matching is by Session id**, which is what makes a Session moved to another Conference Day one
 * *changed* Session rather than a removal plus an addition. The distinction is the whole point on
 * the attendee's screen: "Opening Keynote moved to Thursday" is the truth, while "Opening Keynote
 * was removed / Opening Keynote was added" is two alarming half-truths about a session that never
 * went anywhere.
 *
 * Every difference is reported, including a description-only edit. FR7's trivial-edit exemption
 * exists to shape *push* volume and has nothing to govern here (S09 → What We're NOT Doing): a line
 * on an already-open view costs the attendee nothing, and silent suppression is the failure this
 * whole story exists to prevent.
 */
export function diffSchedule(previous: AttendeeSchedule, current: AttendeeSchedule): ScheduleDiff {
  const before = byId(previous);
  const after = byId(current);

  const added: DatedSession[] = [];
  const changed: ChangedSession[] = [];

  for (const [id, session] of after) {
    const was = before.get(id);
    if (was === undefined) {
      added.push(session);
      continue;
    }
    const fields = changedFields(was, session);
    if (fields.length > 0) changed.push({ session, previous: was, fields });
  }

  const removed = [...before].filter(([id]) => !after.has(id)).map(([, session]) => session);

  return { added, removed, changed };
}

/** Nothing moved. Cheaper to ask than to inspect three arrays at every call site. */
export function isEmptyDiff(diff: ScheduleDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}
