import { stalenessLabel } from '../attendee/staleness.ts';

/**
 * How old a cached Schedule is, as an **elapsed age** and never as a time of day.
 *
 * Online, S09 measures the age of the watermark against the corrected clock. Offline there is no
 * corrected clock to measure *against* that is independent of the anchor, and there does not need
 * to be: the question is "how long since this device received this data", which is
 *
 *     deviceNow − deviceClockAtReceipt
 *
 * – a difference of two readings of the *same* clock. Any error in that clock cancels, and no
 * timezone appears anywhere in it.
 *
 * **The watermark instant is deliberately not rendered here.** It is a `timestamptz`, and turning
 * one into a wall clock on the device needs a conversion nobody specified; on a phone set away from
 * the venue the result would print a time disagreeing with every Session time on the same screen
 * (Binding Constraint FR4). If an absolute "last updated" time is ever wanted it must arrive as a
 * naive wall-clock string in the envelope beside `serverNow.time`, never be derived here.
 */

/**
 * The sentence shown above a cached Schedule: that it is cached, and how old it is.
 *
 * Both halves matter. "Cached" is what stops an attendee reading a three-day-old programme as
 * current; the age is what lets them judge how much to trust it. Neither is a reason to withhold
 * the Schedule – a stale cache is labelled, never hidden or replaced by a refusal (OC03).
 */
export function cachedScheduleLabel(deviceClockAtReceipt: number, deviceNow: number): string {
  // Clamped: a device clock moved backwards since the sync would otherwise report a Schedule
  // cached in the future, which is alarming and actionable by nobody.
  const age = Math.max(0, deviceNow - deviceClockAtReceipt);
  return `Offline – showing the schedule saved on this device. ${stalenessLabel(age)}.`;
}
