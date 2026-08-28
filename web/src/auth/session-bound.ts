import { withinConferenceHorizon, READABILITY_MARGIN_DAYS } from '../offline/readability-window.ts';
import type { CachedSchedule } from '../offline/schedule-cache.ts';
import type { DeviceClock } from '../clock/effective-clock.ts';
import type { StoredSession } from './session.ts';

/**
 * How long a stored session stays valid – the single definition of that rule.
 *
 * **The bound exists because nothing else ends a session any more.** ADR-005 removed the
 * refusal-code classification after establishing that no client-observable signal distinguishes a
 * deprovisioned Workspace account from a merely lapsed Google session, which left explicit sign-out
 * as the only thing that ever cleared one. A phone that is never signed out stayed signed in for
 * the life of the installation.
 *
 * **A session lives until the latest of two horizons**: any conference the person joined, still
 * inside its span plus the shared margin; or, failing that, the margin measured from their sign-in.
 * The first honours S02 OC01 across a multi-day event; the second is what bounds somebody who has
 * joined nothing, and the fallback when no conference data is available.
 *
 * Expressed as "any conference still in horizon, else the sign-in term" rather than an explicit
 * `max`, which for a boolean predicate is the same statement and needs no ordering over days.
 */
const MILLIS_PER_DAY = 86_400_000;

/**
 * Whether this stored session is still within its lifetime.
 *
 * **Two terms, two clocks, deliberately.** The conference term delegates to
 * `withinConferenceHorizon`, which evaluates on the entry's own rehydrated effective clock exactly
 * as the readability window does – it gates data that renders offline, so a device clock wrong *at*
 * sync must be cancelled by the anchor rather than believed. The sign-in term compares raw device
 * milliseconds, because in that state nothing is cached and nothing renders offline: there is no
 * anchor to rehydrate from and no offline data for a skewed clock to expose. That is the one place
 * this feature departs from S10's "no raw device clock as now on any offline path", and it is a
 * departure into a state where the rule has nothing to protect.
 *
 * **Sharing `withinConferenceHorizon` rather than restating it is load-bearing.** Readability is
 * that predicate *and* the sync horizon, so a readable entry always satisfies it, and any entry
 * satisfying it makes this return true – which is what makes "a cached schedule can never outlive
 * the session it was read under" true by construction rather than by two copies of the same
 * arithmetic happening to agree.
 *
 * **Fails closed, term by term.** A malformed entry does not extend the bound (its horizon
 * predicate answers false), and a session whose sign-in reading is missing or non-finite falls
 * through to expired rather than to forever. No combination of absent or corrupt inputs yields a
 * session that never ends – the clarification's Error Handling table forbids exactly that.
 *
 * `entries` must be the **raw** per-subject cache rows, not `listCachedConferences`'s output: that
 * one filters on the full readability window and evicts what it filters, so an entry withheld by
 * the 30-day sync horizon – a conference joined well in advance – would be missing here and could
 * take the largest `endDate` on the device with it.
 */
export function withinSessionBound(
  session: StoredSession,
  entries: readonly CachedSchedule[],
  deviceClock: DeviceClock = Date.now,
): boolean {
  if (entries.some((entry) => withinConferenceHorizon(entry, deviceClock))) return true;

  const { signedInAt } = session;
  if (typeof signedInAt !== 'number' || !Number.isFinite(signedInAt)) return false;

  const now = deviceClock();
  if (!Number.isFinite(now)) return false;

  return now <= signedInAt + READABILITY_MARGIN_DAYS * MILLIS_PER_DAY;
}
