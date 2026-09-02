import { randomBytes } from 'node:crypto';
import { AppError, ERROR_CODES } from '../errors.ts';
import { compareDates, type CalendarDate, type Clock } from '../conferences/calendar-date.ts';

/**
 * The Display Link: how one is minted, whether one resolves, and the single sentence said when it
 * does not (FR7).
 *
 * Module-shaped like `api/src/conferences/join-code.ts` - one minter, one canonical-form predicate,
 * no state - and **deliberately not its alphabet or its length**. The two values have opposite
 * requirements, which is the whole reason this is a separate module rather than a second call into
 * that one:
 *
 *   - a Join Code is read off a slide and typed on a phone, so its alphabet excludes the characters
 *     people confuse and its length is chosen for transcribability. It documents in its own header
 *     that it is **not a security boundary**: Google Workspace sign-in already restricts confApp to
 *     employees, and the code only selects *which* Conference to join.
 *   - a Display Link is copied, not typed, and it is the **entire** boundary on confApp's only
 *     unauthenticated route over domain content. Post-its carry their authors' names, so the value
 *     has to be unguessable rather than legible.
 *
 * Nothing here is derived from a Conference, Session, Round or Post-it identifier - there is no
 * parameter one could arrive through. A token that were a function of the Round it names would be
 * derivable by anyone holding that Round's id, which every Member of the Conference does.
 *
 * The module holds no state. Nothing is remembered between mints or between resolutions: the API
 * runs as several container replicas with no request affinity (ADR-004), so a remembered token
 * would be wrong on the next replica even if it were fresh on this one.
 *
 * **No path in this module, or anything it imports, reaches a vote or ballot table** (ADR-006,
 * Binding Constraint FR8).
 */

/**
 * 32 bytes of CSPRNG output - 256 bits.
 *
 * Sized against a bearer credential's threat model rather than against a transcription one: the
 * value is guessed at, not typed, and the route it opens is answerable to anybody on the internet.
 * `randomBytes` is `node:crypto`'s CSPRNG; `Math.random` and `randomInt` over an alphabet are both
 * the wrong tool here, and the Join Code's use of the latter is explicitly justified by its *not*
 * being a boundary.
 */
export const DISPLAY_TOKEN_BYTES = 32;

/** 32 bytes, base64url-encoded and unpadded: 43 characters. */
export const DISPLAY_TOKEN_LENGTH = 43;

/**
 * The canonical stored form, as a shape. The same rule is a CHECK constraint on the column.
 *
 * It is **not** a gate on the resolution path, and that is load-bearing: a value refused here would
 * answer differently from a real-but-dead token, and that difference tells a holder "not even a
 * token" apart from "not a live token". The resolution route carries no shape schema at all and
 * lets an unknown value simply match no row (FIS -> Constraints & Gotchas).
 */
const CANONICAL = new RegExp(`^[A-Za-z0-9_-]{${DISPLAY_TOKEN_LENGTH}}$`);

/** How a Display Link's value is produced. Injected so a test can pin the value it expects. */
export type DisplayTokenMinter = () => string;

/**
 * A fresh value, from the CSPRNG and from nothing else.
 *
 * base64url so the value survives a URL path unescaped - it is carried in the **path** and never in
 * a query string, because a navigate-mode service-worker cache branch caches the query string and a
 * query string is where credentials habitually end up in logs
 * (docs/LEARNINGS.md#service-workers--cache-storage).
 */
export function mintDisplayToken(): string {
  return randomBytes(DISPLAY_TOKEN_BYTES).toString('base64url');
}

/** Whether a value could be a token at all. For the minter and the tests to state the shape once. */
export function isCanonicalDisplayToken(value: string): boolean {
  return CANONICAL.test(value);
}

/**
 * What a token lookup found: the Board it names, and the three facts that decide whether it may be
 * read right now.
 *
 * All four are read in one statement at resolution time. None is remembered, and none may be
 * cached: a revocation has to take effect at the room machine's next poll, within the near-live
 * window, without anybody touching that machine (FR7 -> NFR).
 */
export interface DisplayLinkCandidate {
  roundId: string;
  conferenceId: string;
  sessionId: string;
  /**
   * The Round's prompt, carried out of the **same statement** that found the link.
   *
   * Not fetched through `RoundRepository`: that seam hydrates a Round with its `round_option` rows,
   * which would put the Poll's option table on the anonymous route's reach for a payload that can
   * never contain one - and would make the written closure in `api/src/routes/display.ts` false
   * (review 2026-08-31, M2). One statement also removes the window in which the Round could vanish
   * between two reads.
   */
  prompt: string;
  /** Pinned to 'PostItRound' by the table's own CHECK; carried so the route can assert it. */
  roundKind: string;
  /** The Round's Session `day`, a bare calendar date. Never routed through `new Date`. */
  sessionDay: CalendarDate;
  /** The Conference's lifecycle state. Only `published` resolves. */
  lifecycleState: string;
  /** `null` means live. */
  revokedAt: string | null;
}

/**
 * The one answer, and **the failure branch carries no discriminator of any kind** - not a code, not
 * an enum, not a boolean pair, not an optional reason.
 *
 * That is the mechanism, not a convention: a caller that *cannot* tell the reasons apart cannot
 * leak them, however the handler is later edited. Revoked, past its Session day, Conference still
 * Draft, Round deleted and never issued all arrive here as the same value, so the route above has
 * nothing to branch on and the byte-identical refusal is structural (FR7 -> Error Handling).
 */
export type DisplayLinkResolution =
  { resolved: true; link: DisplayLinkCandidate } | { resolved: false };

const UNRESOLVED: DisplayLinkResolution = { resolved: false };

/**
 * Whether this token may be read right now: it matched a row, the row is live, its Conference is
 * Published, and the server's own calendar date has not passed the Round's Session day.
 *
 * **The time bound is the Session's own `day`, not a countdown from issue** (ADR-005 - access that
 * cannot be signalled as ended is bounded by time instead; cited, not re-derived). Its shape here
 * is the Session's date rather than a rolling timer precisely so the bound cannot fire mid-activity:
 * a link issued five days before its Session is valid immediately and dies after that Session's day.
 *
 * Compared as calendar dates through `compareDates`, against an injected `Clock`, and never through
 * a `Date`: `api/src/conferences/calendar-date.ts` exists because a bare date routed through
 * `new Date(string)` becomes UTC midnight and reports back through local getters. No instant, no
 * device clock and no elapsed interval takes part in this decision.
 *
 * `sessions.day` carries no timezone and none is stored anywhere in confApp, so a link may stay
 * live up to about a day longer, or die up to about a day earlier, than a viewer in another
 * timezone expects. The PRD accepts that rather than widening the schedule's design; do not add a
 * timezone, an offset or an instant to "fix" it.
 */
export function resolveDisplayLink(
  candidate: DisplayLinkCandidate | null,
  clock: Clock,
): DisplayLinkResolution {
  if (candidate === null) return UNRESOLVED;
  if (candidate.revokedAt !== null) return UNRESOLVED;
  /*
   * A Draft Conference has been published to nobody, so its Board renders to nobody either. The
   * link is still a perfectly good row: once the Conference is Published the very next poll from
   * the room machine resolves, with no reissue and nobody touching that machine
   * (prd.md#edge-cases). That is a consequence of deciding this per request rather than at issue.
   */
  if (candidate.lifecycleState !== 'published') return UNRESOLVED;
  if (compareDates(clock.today(), candidate.sessionDay) > 0) return UNRESOLVED;
  return { resolved: true, link: candidate };
}

/**
 * The one thing a holder of a dead link is ever told.
 *
 * Deliberately the **exception** to this codebase's one-code-per-reason convention: see the comment
 * on `DISPLAY_LINK_UNAVAILABLE` in `api/src/errors.ts`. One status, one code, one message, no
 * `details`, and nothing that varies between the reasons - because any difference at all is the
 * disclosure this guards against.
 */
export function displayLinkUnavailable(): AppError {
  return new AppError(
    ERROR_CODES.DISPLAY_LINK_UNAVAILABLE,
    404,
    'This board is no longer available.',
  );
}
