-- Up Migration

-- The Facilitator's Discard: a fact **about** a Post-it, kept outside the `post_it` row, so that
-- author deletion still leaves no trace at all (ADR-008, Binding Constraint FR4).
--
-- Plain PostgreSQL only: one ordinary table, one ordinary UNIQUE constraint, three foreign keys
-- and one trigger attached to a function that already exists. No CREATE EXTENSION, no
-- provider-specific type or function (ADR-003, Binding Constraint FR1).

-- ============================================================================================
-- WHY THIS IS NOT A COLUMN ON `post_it`, AND WHY THAT IS NOT A CONTRADICTION.
--
-- `20260828120000000_post-it.sql` says, under *What is deliberately absent*:
--
--     any tombstone, soft-delete flag or `deleted_at`. Removing a Post-it leaves *no trace that
--     it existed* (prd.md#edge-cases), which a flagged row would not.
--
-- That sentence is about **author deletion**, and it stays true exactly as written. A person who
-- takes back their own contribution must not leave a marker in front of the room saying somebody
-- withdrew something - that is worse for them than never having written it.
--
-- A Facilitator's Discard is a different act, asked for by a different person, with the **opposite**
-- requirement: FR4 wants it to leave a trace precisely because it is distinct from the Post-it never
-- having existed, and it must be reversible until the Conference is archived. A misdrag in front of
-- the room must not destroy a named colleague's idea.
--
-- Both hold at once **only if the two facts live in different places**. One `discarded_at` column on
-- `post_it` would make "no trace" and "a trace" the same storage decision, and relaxing one would
-- silently relax the other. `20260901090000000_post-it-delivery-record.sql` already established the
-- shape: a fact about a Post-it, kept outside its row expressly so it outlives that row, with an
-- explicit cascade. This follows it.
--
-- The presence of a row here **is** the Discard; its absence **is** not-discarded. There is no
-- boolean, no state column and no second representation anywhere.
-- ============================================================================================

-- Needed so `post_it_discard` can pin its `round_id` to the Post-it's own Round rather than
-- carrying a bare copy of it. Same idiom, for the same reason, as `category_id_round_unique` in
-- `20260902090000000_category-and-placement.sql`: `id` is already the primary key, so this adds a
-- guarantee rather than a new uniqueness rule - a trace naming a Post-it on one Round while
-- claiming another is a foreign-key violation rather than a comparison a handler remembers to make.
ALTER TABLE post_it
  ADD CONSTRAINT post_it_id_round_unique UNIQUE (id, round_id);

CREATE TABLE post_it_discard (
  /*
   * The Post-it, and the primary key.
   *
   * **`ON DELETE CASCADE` is the whole of the author-delete race outcome**, and it is deliberately
   * the schema's answer rather than the delete path's. `post-it-repository.ts#remove` knows nothing
   * about Discard and gains nothing here: an author's delete that reaches a Discarded Post-it while
   * the Round is still open removes the row, and the database removes this with it. Nothing anywhere
   * then records that the Post-it existed, which is FR4's stated outcome for that race - provable
   * from this clause alone.
   *
   * **The primary key is also the idempotence rule.** A second Discard of the same Post-it conflicts
   * here and does nothing, so the first discarder and the first instant survive; a restore of a
   * never-discarded Post-it deletes nothing and is a success. Neither needs a read taken before the
   * write, which two container replicas would each pass (ADR-004).
   */
  post_it_id       uuid        PRIMARY KEY REFERENCES post_it (id) ON DELETE CASCADE,

  /*
   * Carried so the trigger below has a Round to key on, and pinned to the Post-it's own Round by the
   * composite foreign key at the bottom of this table.
   *
   * `advance_round_activity_watermark()` reads `round_id` off the changed row
   * (`20260828120000000_post-it.sql`, redefined by `20260829120000000_activity-watermark-counter.sql`
   * to call `nextval` on the one global sequence). A trace table without this column could not attach
   * to it, and the alternative - restating the advance a fifth time - is exactly what that function
   * exists to prevent.
   */
  round_id         uuid        NOT NULL,

  /*
   * Who discarded it: the OIDC subject claim, and nothing else. No column here holds, keys on or
   * joins by an email address (ADR-002, AGENTS.md#do-not--never), and the **display name is not
   * copied** - it is joined from `app_user.display_name` at read time, exactly as `post_it` joins its
   * author's, so somebody correcting the spelling of their own name has every trace they left
   * corrected with it.
   *
   * It is written from the verified credential on the request and from nowhere else; there is no
   * body field and no query parameter anywhere on the discard path that could reach this column
   * (Binding Constraint FR6).
   */
  discarded_by_sub text        NOT NULL REFERENCES app_user (sub),

  /*
   * When. `clock_timestamp()` and not `now()`: the latter is transaction-start time, so two writes
   * inside one transaction would be stamped identically
   * (docs/LEARNINGS.md#postgresql-datetime-via-node-postgres).
   */
  discarded_at     timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- The Round named here is the Post-it's own. Unwritable otherwise, rather than checked by a
  -- handler; and the cascade means a trace cannot outlive the Post-it through this key either.
  CONSTRAINT post_it_discard_on_its_own_round
    FOREIGN KEY (post_it_id, round_id)
    REFERENCES post_it (id, round_id)
    ON DELETE CASCADE
);

-- The Facilitator's discarded-Post-its surface reads "everything discarded on this Board, in the
-- order it was discarded in", which is exactly this index - oldest first, as
-- `docs/wireframes/facilitator-board-and-categorisation/discarded-postits.html` draws it.
-- `post_it_id` breaks the tie so the order is total and stable rather than whatever the plan
-- produced - two Discards can share a `clock_timestamp()` reading under a coarse clock.
CREATE INDEX post_it_discard_by_round ON post_it_discard (round_id, discarded_at, post_it_id);

-- --------------------------------------------------------------------------------------------
-- WHAT IT DELIBERATELY IS NOT.
--
-- **Not a tombstone for author deletion, and not a soft delete on `post_it`.** The row it describes
-- is still there, still holds its author's text and their name, and comes back in full on a restore.
-- Nothing here survives the Post-it: when an author removes their own, this goes with it and the
-- guarantee `20260828120000000_post-it.sql` states is untouched.
--
-- **Not a state machine.** There is no `state`, no `restored_at` and no history of reversals. A
-- restore is the deletion of this row, so the table holds only what is discarded *now*. The trace
-- FR4 asks for is who and when for a Discard that currently stands - not an audit log of every time
-- a Facilitator changed their mind.
--
-- **Not a record of where the Post-it used to be.** The Discard clears the Post-it's placement in the
-- same statement, and Uncategorised is the *absence* of a placement
-- (`20260902090000000_category-and-placement.sql`). So a restore has no former Category to return to
-- and no column here could name one - which is how "a restored Post-it returns to Uncategorised,
-- never to the Category it was in" becomes a structural consequence rather than a rule the restore
-- path has to remember.
--
-- **Not Report data.** It holds who and when, and nothing about why. The Report slice
-- (REQ-023 / REQ-024) reads this table; it does not get a column of its own here to read.
--
-- **Not reachable from any Vote path.** Nothing in this migration names `vote`, `ballot` or anything
-- derived from one; ADR-006 and ADR-007 are untouched.
-- --------------------------------------------------------------------------------------------

-- --------------------------------------------------------------------------------------------
-- THE CURSOR ADVANCE, ATTACHED AND NEVER COPIED.
--
-- `AFTER INSERT OR DELETE`, and both halves are load-bearing: a Discard takes a Post-it off every
-- open Board and a restore puts it back, and neither leaves anything on the `post_it` row for the
-- existing trigger to notice. Without this, a Discard would sit on every other participant's Board
-- until something else happened to write.
--
-- There is no UPDATE branch because there is no update: every column on this row is written once and
-- a reversal is a delete. Naming an operation the table cannot perform would be a claim about a path
-- that does not exist.
--
-- ADR-007 is untouched: a Vote still advances nothing, and no vote-derived value appears here.
-- --------------------------------------------------------------------------------------------
CREATE TRIGGER post_it_discard_advances_activity_watermark
  AFTER INSERT OR DELETE ON post_it_discard
  FOR EACH ROW
  EXECUTE FUNCTION advance_round_activity_watermark();

-- Down Migration

DROP TRIGGER post_it_discard_advances_activity_watermark ON post_it_discard;

DROP INDEX post_it_discard_by_round;

DROP TABLE post_it_discard;

ALTER TABLE post_it
  DROP CONSTRAINT post_it_id_round_unique;
