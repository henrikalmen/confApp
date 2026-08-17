import type { CalendarDate, ServerNow } from '../conferences/calendar-date.ts';
import type { LifecycleState } from '../conferences/lifecycle.ts';
import { conferenceDays } from './session-validation.ts';
import { overlapsWith } from './overlap.ts';
import type { Session } from './session-repository.ts';
import type { SessionKind } from './session-validation.ts';
import type { WallClockTime } from './wall-clock-time.ts';

/**
 * The schedule read model – **the shared decision this story produces** (S06 → Technical Overview).
 *
 * One self-contained envelope, returned by `GET /conferences/{conferenceId}/schedule`, from which
 * the whole attendee view renders with no further network call. Two later stories are built on that
 * property and neither can be satisfied by a payload that is merely "enough for today's screen":
 *
 *   - **S10** caches this object verbatim and renders from the cached copy with no connection, so
 *     nothing in it may be meaningful only while online, and every Conference Day of the span is
 *     present – including the empty ones – rather than being fetched when navigated to.
 *   - **S09** replaces it wholesale when the schedule changes, so it carries no state the client
 *     has accumulated and no field a client is expected to merge.
 *
 * ============================================================================================
 * Two kinds of time live in this envelope and they must never be confused for one another.
 *
 *   *Wall-clock*  – `days[].date`, `sessions[].startTime`, `sessions[].endTime`, and
 *                   `serverNow.{day,time}`. Naive strings, exactly as authored, with no `Z` and no
 *                   offset. Nothing here parses, formats or compares them through a `Date`: they
 *                   arrive from PostgreSQL as strings (`wallClockExpression`) and leave as the same
 *                   strings. A Session at 09:00 reads 09:00 on every device (Binding Constraint
 *                   FR4).
 *
 *   *Instants*    – `conference.lastUpdatedAt` and `serverNow.instant`, and those two only. Real
 *                   moments, ISO-8601 UTC. `lastUpdatedAt` is S04's schedule watermark, carried
 *                   through unmodified and at full microsecond precision for S09 and S10; this
 *                   story does not interpret or act on it. `serverNow.instant` exists so the client
 *                   can measure the server–device offset, and for nothing else.
 * ============================================================================================
 *
 * **`lastUpdatedAt` is an instant, to be shown as elapsed age only.** S09 and S10 render it as
 * "updated 4 minutes ago", computed as `deviceNow + offset − lastUpdatedAt` from the clock anchor.
 * Rendering it as an absolute wall clock ("last updated 09:12") is banned: deriving one on the
 * client needs a timezone conversion, and on a device set away from the venue the result would
 * disagree with every Session time on the same screen. If a product decision ever needs an absolute
 * stamp, the only permitted route is a **server-rendered naive wall-clock field added to this
 * envelope in the same frame as `serverNow.time`** – never a client-side derivation. No such field
 * exists today because elapsed age needs none.
 */

/** One Session as an Attendee reads it. No row version: an attendee edits nothing. */
export interface EnvelopeSession {
  id: string;
  title: string;
  description: string | null;
  kind: SessionKind;
  startTime: WallClockTime;
  endTime: WallClockTime;
  location: string;
  /**
   * The Sessions this one runs at the same time as – a Parallel Track
   * (`docs/UBIQUITOUS_LANGUAGE.md`). Symmetric, and empty for a Session that runs alone.
   *
   * Presentational, never an interaction. Sessions are open, attendance is neither chosen nor
   * recorded, and there is no Personal Agenda, so a control letting an Attendee pick between two
   * concurrent Sessions would contradict the product rather than help (FR4, FR6).
   */
  concurrentWith: string[];
}

export interface EnvelopeDay {
  date: CalendarDate;
  /** 1-based position in the span, so a client can label "Day 2" without calendar arithmetic. */
  dayNumber: number;
  sessions: EnvelopeSession[];
}

export interface ScheduleEnvelope {
  conference: {
    id: string;
    name: string;
    startDate: CalendarDate;
    endDate: CalendarDate;
    state: LifecycleState;
    /** S04's schedule watermark, carried through untouched. Not interpreted here. */
    lastUpdatedAt: string | null;
  };
  days: EnvelopeDay[];
  serverNow: ServerNow;
}

/** What the envelope needs to know about the Conference. Deliberately not the whole row. */
export interface EnvelopeConference {
  id: string;
  name: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  lifecycleState: LifecycleState;
}

/**
 * Composes the envelope from one Conference, its whole Session list and the server's reading of now.
 *
 * A pure function of its arguments: it issues no query, reads no clock and retains nothing between
 * calls. The API runs as several container replicas with no request affinity, so an envelope, an
 * overlap result or a clock anchor held here would be absent on the next request anyway (ADR-004).
 */
export function buildScheduleEnvelope(
  conference: EnvelopeConference,
  sessions: readonly Session[],
  scheduleWatermark: string | null,
  serverNow: ServerNow,
): ScheduleEnvelope {
  /*
   * Every Conference Day of the span, derived from the dates rather than stored (PRD → Data
   * Requirements). Emitting the empty ones is what lets the view say "nothing is scheduled on this
   * day" instead of showing a blank area, and what lets S10 answer a day navigation offline.
   *
   * Deliberately *only* the span's days, unlike the Organizer's composition view. A Session can sit
   * outside the span – S03 lets the dates be shortened past its Sessions and leaves refusing that to
   * S09 – and the Organizer needs to see such a Session in order to move it. An Attendee has nothing
   * to do about it and no day to put it on, so the attendee read shows the Conference's actual days.
   */
  const days = conferenceDays(conference);
  const byDate = new Map<CalendarDate, Session[]>(days.map((date) => [date, []]));

  for (const session of sessions) {
    byDate.get(session.day)?.push(session);
  }

  return {
    conference: {
      id: conference.id,
      name: conference.name,
      startDate: conference.startDate,
      endDate: conference.endDate,
      state: conference.lifecycleState,
      lastUpdatedAt: scheduleWatermark,
    },

    days: days.map((date, index) => ({
      date,
      dayNumber: index + 1,
      /*
       * Ascending by start time, and the ordering is the repository's – `listForConference` selects
       * `order by day, start_time, title`, and grouping preserves it. Re-sorting here would be a
       * second opinion about ordering in a second place, which is how the Organizer's view and the
       * Attendee's view come to disagree about two Sessions that start at the same minute. The
       * contract test pins the outcome, so a change to that ORDER BY fails here rather than
       * silently reshuffling an attendee's morning.
       */
      sessions: (byDate.get(date) ?? []).map((session) => ({
        id: session.id,
        title: session.title,
        description: session.description,
        kind: session.kind,
        startTime: session.startTime,
        endTime: session.endTime,
        location: session.location,
        /*
         * S04's overlap implementation, imported and called – not a second statement of
         * `start < otherEnd AND end > otherStart` (S04 TI07). One rule, one implementation:
         * changing S04's boundary decision changes this endpoint's output, which is exactly the
         * property that keeps the Organizer's warnings and the Attendee's concurrency marking
         * from ever disagreeing about the same pair.
         *
         * Recomputed on every read and never stored: a stored flag would be wrong the moment
         * either Session moved and right again only if someone remembered to recompute it.
         */
        concurrentWith: overlapsWith(session, sessions).map((other) => other.id),
      })),
    })),

    serverNow,
  };
}
