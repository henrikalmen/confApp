-- Up Migration

-- A cast Vote stops advancing the Session activity cursor. The trigger is removed, not gated.
--
-- Plain PostgreSQL only: one DROP TRIGGER here and one CREATE TRIGGER in the down step. No
-- extension, no provider-specific type or function (ADR-003).

-- ============================================================================================
-- WHY THE BALLOT TRIGGER IS GONE.
--
-- Authority: docs/adrs/ADR-007-vote-arrivals-do-not-advance-the-member-visible-cursor.md
--
-- `GET /api/conferences/:c/sessions/:s/activities/watermark` is gated on Conference Membership
-- alone, because every Member legitimately needs near-live updates to the Post-it Board. It answers
-- `max(activity_watermark)` across the Rounds of **one Session**, so a write anywhere else in the
-- deployment advances the shared sequence without changing what this Session's poller reads. On a
-- Session running only a Poll there was therefore nothing else that could move the value, and every
-- movement of it meant "a Vote just arrived" - readable by any Member, at whatever resolution they
-- chose to poll at, while prd.md#fr5-poll-result-reveal refuses an Attendee the running tally
-- precisely so that not voting, and nobody voting, carry no signal.
--
-- Making the value opaque (20260829120000000_activity-watermark-counter.sql) addressed what the
-- value *says*. It did not address *when it moves*, and the Session-scoped `max()` leaves that
-- change event with no noise to hide in. A channel has both dimensions, so the signal is removed at
-- its source instead: a Vote advances no cursor at all, and no vote-derived value is left in the
-- system for a later endpoint to re-expose by accident.
--
-- The cursor's meaning becomes narrower and more honest: *something a Member is entitled to see has
-- changed*. Votes are exactly what a Member is not entitled to see.
--
-- **WHAT THIS DOES NOT DO.** It does not close the correlation a Session Assignment holder can
-- make from the live tally they are deliberately shown. A holder watching the counts move, in a
-- room where they can see who just acted, pairs a ballot with a voter using information the API
-- never put in a response at all; that is inherent in US07's decision to show a holder a live
-- tally, and ADR-006's amended Decision 1 names it as accepted and open rather than closed. Nor
-- does anything here touch ADR-006's other residual: the `vote` row and the `round_voter` row are
-- still written in one transaction and still share an `xmin`, which an ordinary `SELECT` correlates
-- - no elevated right is involved, and the control for it remains who holds direct database
-- credentials.
--
-- **THE OTHER THREE TRIGGERS ON THIS CURSOR ARE DELIBERATELY UNTOUCHED**, and they are what keeps
-- Attendee propagation working:
--
--   - `post_it_advances_activity_watermark` (20260828120000000_post-it.sql), on every Post-it
--     insert, update and delete - the Board's own near-live path;
--   - `round_option_advances_activity_watermark` (20260829090000000_vote.sql), on every option
--     write, so a room never reads stale labels while voting against them;
--   - `round_change_advances_activity_watermark` (20260828120000000_post-it.sql), BEFORE UPDATE ON
--     round, whose WHEN clause includes `OLD.state IS DISTINCT FROM NEW.state` - so **closing a
--     Poll still advances the cursor**, and reveal-on-close still reaches every Member near-live.
--
-- Removing any of those would break the ~5s propagation the Board and the reveal both depend on.
--
-- **HOW A HOLDER'S TALLY MOVES NOW.** By refetch rather than by signal: a client holding a Session
-- Assignment re-reads the Session on each tick of the one poll loop it already runs
-- (web/src/poll/use-watermark-poll.ts) instead of only when the cursor moves. The tally already
-- rides the Session read payload, so no endpoint changes, no second cursor appears and no second
-- cadence is introduced. The price is up to one tick of latency on a holder's tally, which is
-- inside the ~5s target the trigger previously beat.
-- ============================================================================================

DROP TRIGGER vote_advances_activity_watermark ON vote;

-- Down Migration

-- Puts back exactly the trigger 20260829090000000_vote.sql created, on the same function and with
-- the same AFTER INSERT / FOR EACH ROW shape, so that migration's own down step still finds what it
-- drops. Reversing this reopens the vote-arrival signal described above.

CREATE TRIGGER vote_advances_activity_watermark
  AFTER INSERT ON vote
  FOR EACH ROW
  EXECUTE FUNCTION advance_round_activity_watermark();
