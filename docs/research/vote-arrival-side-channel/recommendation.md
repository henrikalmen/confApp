# Recommendation: close the vote-arrival channel at its source

**Date**: 2026-08-29
**Confidence**: High
**Outcome**: Formalized as [ADR-007](../../adrs/ADR-007-vote-arrivals-do-not-advance-the-member-visible-cursor.md) (Proposed), with an amendment to [ADR-006](../../adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md)

## Recommendation

Drop the `vote_advances_activity_watermark` trigger. A Vote stops advancing any cursor, and a Session Assignment holder's live tally reaches them by refetching the Session on each tick of the existing poll loop instead of on a change signal.

## Rationale

The channel exists because a value every Member may read moves exactly when a Vote lands. Two families of fix follow from that: stop the value being readable by the wrong people, or stop Votes moving it.

The first family – an authority-scoped cursor – works, and was the obvious candidate going in. It was rejected because it leaves a vote-derived value in the system behind a permission check. Every future endpoint, export, report or debug surface touching the Round row would have to re-derive that check correctly, and a single omission re-opens the channel with nothing failing loudly. The second family removes the value entirely, so no future mistake can expose what no longer exists.

The propagation requirement survives intact, which is what made the second family viable at all:

- Attendees keep near-live Board updates, because Post-it writes still advance the cursor.
- Reveal-on-close still reaches every Member, because `round_change_advances_activity_watermark` fires on a Round state change, and closing a Poll is one.
- The Facilitator's tally already rides the Session read payload, so refetching delivers it with no new endpoint.

## Implementation path

1. Forward migration dropping `vote_advances_activity_watermark`, with a reversible down step. Do not edit the applied migration that created it.
2. A client condition so a Session Assignment holder refetches the Session on each tick of `web/src/poll/use-watermark-poll.ts`'s existing loop – riding that tick, never adding a cadence.
3. Invert the assertions proving a Vote advances the watermark; add a behavioural test that the holder's *rendered* tally still moves within the target without user action.
4. Amend S02's cursor-writer enumeration and S03's TI02 through `andthen:ops update-fis … design-change`, both stories being shipped.
5. Reconcile the re-opened ledger entry once it lands.

## What this does not fix

**A Session Assignment holder can still correlate.** They see the live tally move and they are in the room. Nothing here changes that, and nothing should: showing the holder a running tally is US07's deliberate product decision. It is now named explicitly in ADR-006's amended Decision 1 as an accepted, open channel rather than an oversight – which is the honest position, and the one the previous wording was too narrow to express.

## Reconsider if

- The number of Session Assignment holders per Session grows enough that per-tick refetches become a real cost.
- A future feature genuinely needs a vote-derived near-live signal, at which point ADR-007 is the decision to reopen rather than work around.
- A formal privacy assessment treats the holder's correlation path as a breach of the stated purpose, in which case the live tally itself – not the cursor – is the thing to revisit.
