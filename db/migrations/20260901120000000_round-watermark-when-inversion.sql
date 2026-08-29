-- Up Migration

-- The Round cursor trigger stops naming the columns it cares about and starts naming the one it
-- must not react to.
--
-- Plain PostgreSQL only: one trigger dropped and recreated, no function touched (ADR-003).

-- ============================================================================================
-- WHY AN ALLOW-LIST OF COLUMNS IS THE WRONG SHAPE HERE.
--
-- `20260828120000000_post-it.sql` created this trigger with
-- `WHEN (OLD.prompt IS DISTINCT FROM NEW.prompt OR OLD.state ... OR OLD.closed_at ... OR
-- OLD.position ...)` - an enumeration of the Round columns that were interesting on the day it was
-- written. It is correct today and silently wrong the moment somebody adds a column.
--
-- Any column added to `round` later is outside that list, so an UPDATE that changes only the new
-- column advances no cursor and reaches no open client. Nothing fails: the write succeeds, the
-- suite stays green, and the room simply does not see the change. That is the mechanism behind the
-- option-edit gap recorded against S02 - `round_option` had no trigger *and* a prompt-unchanged
-- UPDATE left this clause false - and it will produce the same class of gap again for whatever the
-- next column turns out to be.
--
-- **The clause has only ever had one job it could not do without naming columns**, and it is not
-- "notice interesting changes". It is: do not fire on the watermark-only UPDATE that
-- `advance_round_activity_watermark()` issues from the `post_it`, `round_option` and (until
-- ADR-007) ballot triggers, which would otherwise bump the value a second time on every write.
--
-- Stating that directly is both narrower and complete: fire on any UPDATE that is **not** the
-- cursor writing to itself. A new column is inside the rule by construction, because the rule no
-- longer has an inside.
-- --------------------------------------------------------------------------------------------

DROP TRIGGER round_change_advances_activity_watermark ON round;

CREATE TRIGGER round_change_advances_activity_watermark
  BEFORE UPDATE ON round
  FOR EACH ROW
  -- The inversion. True for every ordinary UPDATE of a Round, and false for exactly one thing:
  -- the statement that is already setting the cursor, which is `advance_round_activity_watermark()`
  -- reaching in from a contribution, an option write, or any later writer attached to it. No
  -- recursion is possible either way - this is a BEFORE trigger that assigns to NEW rather than
  -- issuing an UPDATE of its own.
  WHEN (OLD.activity_watermark IS NOT DISTINCT FROM NEW.activity_watermark)
  EXECUTE FUNCTION advance_watermark_on_round_change();

-- Down Migration

-- Puts back exactly the four-column allow-list `20260828120000000_post-it.sql` created, so that
-- migration's own down step still finds the trigger it drops. Note the column name: by the time
-- this runs, `20260829120000000_activity-watermark-counter.sql` has not yet been reversed, so the
-- cursor is still `activity_watermark` and the restored clause names the same four Round columns it
-- always did - none of which is the cursor itself.

DROP TRIGGER round_change_advances_activity_watermark ON round;

CREATE TRIGGER round_change_advances_activity_watermark
  BEFORE UPDATE ON round
  FOR EACH ROW
  WHEN (
    OLD.prompt IS DISTINCT FROM NEW.prompt
    OR OLD.state IS DISTINCT FROM NEW.state
    OR OLD.closed_at IS DISTINCT FROM NEW.closed_at
    OR OLD.position IS DISTINCT FROM NEW.position
  )
  EXECUTE FUNCTION advance_watermark_on_round_change();
