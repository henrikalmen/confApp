# ADR-007: Vote arrivals do not advance the Member-visible activity cursor

**Status**: Accepted
**Date**: 2026-08-29 (proposed and accepted)
**Scope**: Near-live propagation – what the Session activity watermark is permitted to carry, and how a Facilitator's live tally reaches them instead

---

## Context

`round.activity_watermark` is the `session-activities` bundle's single near-live cursor (`plan.json#sharedDecisions` → *Near-live propagation: one cursor*). A client polls two scalars, compares the watermark to the value it last saw, and refetches the Session only when it moved. `GET /api/conferences/:conferenceId/sessions/:sessionId/activities/watermark` is gated on `requireMembership`, because every Conference Member legitimately needs near-live updates to the Post-it Board.

An `AFTER INSERT` trigger on the ballot table advances that cursor when a Vote is cast, so a Facilitator's live tally moves without user action (US07, S03 OC02).

**The final gap review of the bundle (finding G-02) established that this makes the cursor a vote-arrival oracle for anyone who may not see the tally.**

- `api/src/rounds/round-repository.ts#activityWatermark` returns `max(activity_watermark) … where conference_id = $1 and session_id = $2` – scoped to a **single Session**. Writes anywhere else in the system advance the underlying sequence but never change this Session's value.
- On a Session running only a Poll, there is therefore nothing else that can move it. The *event* of the value changing means "a Vote just arrived", with no noise at any deployment volume.
- The endpoint is unthrottled, so the observer chooses the resolution.
- `prd.md#fr5-poll-result-reveal` refuses an Attendee the running tally *precisely so that absence carries no information*. The same Attendee could poll vote arrivals freely.

### The prior attempt, and why it was not enough

On 2026-08-29 the exposed value was changed from a microsecond `timestamptz` to an opaque global monotonic counter (`db/migrations/20260829120000000_activity-watermark-counter.sql`). That was a real improvement and is **not** revisited here: it removed the wall-clock reading, and because the sequence is global rather than per-Round, the delta no longer equals a Round's vote count.

It addressed **what the value says**. It did not address **when the value moves**, and the Session-scoped `max()` means the change event carries no noise to hide behind. The ledger entry closed on that reasoning was re-opened when the gap review refuted it:
`api/src/routes/rounds.ts:spec-stale:the-activity-watermark-hands-every-member-the-instant-of-each-vote`.

The general lesson, recorded in `docs/LEARNINGS.md`: a side channel has two dimensions – what the value says and when it moves – and obscuring the first leaves the second intact.

### Decision criteria

The success bar was set at **closing** the channel rather than raising its cost: no vote-arrival signal to a Member without a Session Assignment, at any polling rate. That eliminated rate-limiting and coarsening, which slow a signal without removing it, and eliminated documenting the residual, which leaves it open.

Among the options that clear that bar, the deciding criteria were **architectural simplicity** and **implementation cost**. Two constraints were treated as gates neither option may fail:

- Attendees keep near-live Post-it Board propagation within the ~5s target (S03 OC02, `prd.md#non-functional-requirements`).
- No second polling mechanism under `web/src` – `web/src/poll/use-watermark-poll.ts` owns the only cadence constant, in-flight latch and visibility/focus/online registration, enforced by shipped guards.

---

## Decision

**Remove the ballot trigger. A Vote no longer advances any cursor, and a Session Assignment holder's tally reaches them by refetching on the shared tick.**

1. **`vote_advances_activity_watermark` is dropped.** No vote-derived value is exposed to any caller, so there is nothing for a future endpoint to re-expose by accident. The channel is closed at its source rather than hidden behind an authority check.

2. **The cursor's meaning becomes narrower and more honest**: *something a Member is entitled to see has changed*. Votes are exactly what a Member is not entitled to see, so excluding them makes the cursor more coherent, not less.

3. **Attendee propagation is unaffected.** Post-it writes still advance the cursor, and `round_change_advances_activity_watermark` fires `BEFORE UPDATE ON round` `WHEN (… OR OLD.state IS DISTINCT FROM NEW.state …)` – so a Poll **closing** still advances it, and reveal-on-close still reaches every Member near-live.

4. **The Facilitator's live tally is delivered by refetch, not by signal.** A client holding a Session Assignment refetches the Session on each tick of the existing loop rather than only when the watermark moves. The tally already rides the Session read payload (`tally: OptionTally[] | null`), so no new endpoint is involved.

5. **The one-cursor shared decision stands.** This adds no second cursor, no second column and no second cadence. It removes a trigger.

---

## Consequences

### Positive

- **The oracle is gone rather than gated.** An authority-scoped split would have left a vote-derived value in the system, one endpoint mistake away from exposure. Here there is no such value.
- **One fewer trigger and no new column**, against an alternative that needed both.
- **No authority-dependent cursor values.** The rejected split would have made the watermark's meaning depend on the reader's role, so a Member whose role changed mid-Session would compare values from two different series – a silent staleness bug with no analogue in the current design.
- **The change is small and reversible**: one forward migration dropping one trigger, one client condition, and the inversion of the assertions that currently prove a Vote moves the cursor.

### Negative, and accepted

- **Assignment holders trade change-detection for polling.** A holder's client refetches the Session each tick instead of only on change. Bounded – typically one or two holders per Session, one Session payload, riding the existing cadence with no new timer – but it is a real increase in read volume for those clients, and it scales with holders rather than with activity.
- **A spec amendment is owed against shipped stories.** S02's Structural Criterion enumerating the cursor's writers drops from three to two, and S03's TI02 and its Verify currently assert that a Vote advances the watermark. Those must be amended through the ADR-audited `design-change` form, not edited quietly.
- **The tally is no longer event-driven**, so a Facilitator's tally can lag by up to one tick even when the server has the Vote. Within the ~5s target, but it is a latency the trigger previously avoided.

### Neutral

- The global `activity_watermark_seq` and the opaque-counter shape from the prior change are untouched and remain correct; this decision narrows what advances the cursor, not what the cursor is.

---

## Alternatives considered

| Option | Score against the criteria | Outcome |
|---|---|---|
| **Split the cursor by authority** – ballot inserts advance a watermark only a Session Assignment holder may read; Post-it and Round writes advance the Member-visible one | Clears the success bar, but poor on both deciding criteria: adds a second cursor against the one-cursor shared decision, needs a new column plus migration plus endpoint branching, and makes the watermark's value depend on the reader's role, introducing a role-change staleness failure with no current analogue | **Rejected** – same outcome as the chosen option for materially more structure |
| **PostgreSQL-backed rate limit** on the watermark endpoint | Fails the success bar: slows an observer without removing the signal. Also adds shared rate-limiter state, which must live in PostgreSQL under `AGENTS.md`'s no-in-process-state rule | **Rejected** on the bar |
| **Coarsen or debounce the signal** | Fails the success bar for the same reason, and trades directly against the ~5s propagation target that S03 OC02 depends on | **Rejected** on the bar |
| **Accept the residual and document it** | Fails the success bar by construction. It also sits badly beside `prd.md#fr5-poll-result-reveal`, which refuses an Attendee the tally specifically so absence carries no information | **Rejected** on the bar – though the ADR-006 amendment it implied is adopted anyway, below |

---

## Implementation notes

Not implemented by this ADR. The work is:

- A forward migration dropping `vote_advances_activity_watermark`, with a reversible down step. Do **not** edit `db/migrations/20260829090000000_vote.sql` – it is applied.
- A client condition so a Session Assignment holder refetches the Session on each tick of `web/src/poll/use-watermark-poll.ts`'s existing loop. It must ride that tick: no new cadence constant, no new timer, no new visibility/focus/online registration, or the shipped guards in `api/test/round-structure.test.ts`, `api/test/vote-structure.test.ts` and `web/test/watermark-poll.test.tsx` will fail – correctly.
- Invert the assertions that currently prove a Vote advances the watermark (S03 TI02's Verify and its integration coverage) into assertions that it does **not**, and add a behavioural test that a Facilitator's rendered tally still moves within the propagation target without user action. Assert rendered state, not requests issued (`docs/LEARNINGS.md` → Testing).
- Amend S02's cursor-writer enumeration and S03's TI02 through `andthen:ops update-fis … design-change`, since both stories are shipped.
- On landing, reconcile the re-opened ledger entry `api/src/routes/rounds.ts:spec-stale:the-activity-watermark-hands-every-member-the-instant-of-each-vote`.

**Revisit when**: a Session Assignment holder count grows enough that per-tick refetches matter; or a future feature wants a genuinely vote-derived near-live signal, at which point this decision is the thing to reopen rather than to work around.

## Project compliance

- **`AGENTS.md` § Do Not / Never** – "Never attribute a vote to a voter", read with ADR-006's scope. This decision removes an application path that carried vote information to a reader entitled to none, which is squarely inside the part of the guarantee that binds.
- **`AGENTS.md` – no in-process state between requests.** The chosen option adds no shared state; the rejected rate-limit option would have required PostgreSQL-backed counters precisely because of this rule.
- **ADR-003** – plain portable PostgreSQL. Dropping a trigger uses nothing provider-specific.
- **`plan.json#sharedDecisions` → one cursor.** Preserved. The rejected authority-split would have contradicted it; this decision reduces the number of writers to that one cursor.

## References

- `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md` – amended alongside this ADR to model correlation across successive responses
- `docs/specs/session-activities/session-activities-gap-review-claude-2026-08-29.md` – finding G-02
- `docs/specs/session-activities/s03-anonymous-poll-voting-and-result-reveal.reconciliation-ledger.md` – the re-opened entry this decision closes
- `docs/research/vote-arrival-side-channel/` – `research.md`, `tradeoff-matrix.md`, `recommendation.md`
- `db/migrations/20260829120000000_activity-watermark-counter.sql` – the prior, partial change
