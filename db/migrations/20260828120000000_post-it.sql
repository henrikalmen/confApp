-- Up Migration

-- Named Post-it contribution, and the one near-live cursor the whole Session Activities bundle
-- polls: `round.activity_watermark_at`.
--
-- Plain PostgreSQL only: no CREATE EXTENSION, no provider-specific types or functions (ADR-003).
-- `gen_random_uuid()` is core PostgreSQL (13+), not pgcrypto, so no extension is needed for it.

-- ============================================================================================
-- Needed so `post_it` can hang off a composite foreign key rather than a bare `round_id`.
--
-- Same idiom as `sessions_id_conference_unique` (20260817210000000_session-assignment.sql), and
-- it carries one column more than that one does. A Post-it belongs to a **Post-it Round of the
-- route's Conference**, and both halves of that sentence are made unwritable here rather than
-- checked by a handler: with `kind` in the key, a Post-it on a Poll is a foreign-key violation,
-- and with `conference_id` in it, a Post-it naming a Round in some *other* Conference is one too.
-- `id` is already the primary key, so this adds guarantees rather than a new uniqueness rule.
-- ============================================================================================
ALTER TABLE round
  ADD CONSTRAINT round_id_kind_conference_unique UNIQUE (id, kind, conference_id);

-- --------------------------------------------------------------------------------------------
-- The activity watermark.
--
-- One cursor for the whole bundle (plan.json#sharedDecisions -> "Near-live propagation: one
-- cursor"). It hangs off the **Round** row, deliberately, and not off `sessions` or `conference`:
--
--   - on `sessions` it would fire S09's `session_stamp_row_version` trigger, so every Post-it
--     landing during a workshop would move an Organizer's optimistic-concurrency base and hand
--     them a spurious EDIT_VERSION_CONFLICT for a Session they had not touched;
--   - on `conference` it would move `schedule_watermark_at`, so every Post-it would make every
--     attendee's phone refetch the whole Schedule and fire S09's "what changed" banner with
--     nothing schedule-shaped to report.
--
-- It is a THIRD kind of instant on this row and is not `closed_at`. That one records when a Round
-- last stopped *running* and is what tells "created closed" apart from "already run"; this one is
-- a cursor and moves on any write at all. The names are deliberately unalike.
--
-- `clock_timestamp()` and not `now()`: the latter is transaction-start time, so two writes inside
-- one transaction would be stamped identically and a poll would never see the second
-- (docs/LEARNINGS.md#postgresql-datetime-via-node-postgres).
-- --------------------------------------------------------------------------------------------
ALTER TABLE round
  ADD COLUMN activity_watermark_at timestamptz NOT NULL DEFAULT clock_timestamp();

-- One named contribution, under its author's name.
--
-- Authorship is `author_sub`, the OIDC subject claim, and nothing else. No column here holds,
-- keys on, or joins by an email address: addresses change and are reissued to different people
-- (ADR-002, AGENTS.md#do-not--never). The **display name is not copied here either** - it is
-- joined from `app_user.display_name` at read time, so somebody correcting the spelling of their
-- own name sees every Post-it they ever wrote corrected with it.
--
-- What is deliberately absent:
--   - any per-author or per-Round count column or constraint. "A Member may contribute any number
--     of Post-its to one Round" and "No per-Member count limit" are the PRD's words (FR3), so a
--     limit is not a rule that happens not to be configured - there is nowhere to configure one.
--   - any tombstone, soft-delete flag or `deleted_at`. Removing a Post-it leaves *no trace that it
--     existed* (prd.md#edge-cases), which a flagged row would not.
--   - any late-arrival or pending marker. Offline queueing is S04's, inside S10's existing
--     boundary, and this story widens offline support by nothing at all (Binding Constraint FR6).
CREATE TABLE post_it (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id      uuid        NOT NULL,
  conference_id uuid        NOT NULL,

  /*
   * Carried so the composite foreign key below can name it, and pinned to the one value it may
   * ever hold. Together the CHECK and the FK are what make "a Post-it on a Poll" unwritable
   * through any path, rather than a rule an application remembers to apply: the CHECK refuses any
   * other value here, and the FK refuses a Round whose own `kind` does not match this column.
   */
  round_kind    text        NOT NULL DEFAULT 'PostItRound',

  author_sub    text        NOT NULL REFERENCES app_user (sub),
  text          text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- NULL until the author corrects it. A separate column rather than an "edited" boolean because
  -- the instant is the fact; the flag is derivable from it and the reverse is not.
  edited_at     timestamptz,

  CONSTRAINT post_it_is_on_a_post_it_round
    CHECK (round_kind = 'PostItRound'),

  -- Removed with its Round, and so with its Session and its Conference. A Post-it whose Round is
  -- gone is not a record worth keeping.
  CONSTRAINT post_it_round_in_conference
    FOREIGN KEY (round_id, round_kind, conference_id)
    REFERENCES round (id, kind, conference_id)
    ON DELETE CASCADE,

  /*
   * The API validates the text first and produces the field-level refusal a person reads, naming
   * the limit it enforces; this is the backstop that keeps a blank or over-long value out of the
   * table through any other path.
   *
   * The 280 here is the **one unavoidable second copy** of `POST_IT_MAX_LENGTH` in
   * api/src/rounds/post-it-validation.ts, which is the authoritative definition. It is pinned to
   * that constant by test (api/test/post-it-structure.test.ts and the boundary assertion in
   * api/test/post-it.integration.test.ts), never by this comment: changing either side alone
   * fails.
   *
   * `char_length` counts code points, which is what the API counts too - a string of 300 emoji
   * measures 600 in JavaScript's `.length` and 300 here, and the two layers have to state the same
   * limit for stating it twice to mean anything.
   */
  CONSTRAINT post_it_text_present
    CHECK (btrim(text) <> '' AND char_length(text) <= 280)
);

-- The board read asks for one Round's Post-its oldest first, which is exactly this index. `id`
-- breaks the tie so the order is total and stable rather than whatever the plan produced - two
-- Post-its can share a `clock_timestamp()` reading under a coarse clock.
CREATE INDEX post_it_by_round ON post_it (round_id, created_at, id);

-- --------------------------------------------------------------------------------------------
-- Advancing the cursor.
--
-- ONE named home for the GREATEST expression, and it takes its Round from `round_id` on the row
-- that changed. That is the point: S03's ballot table must advance this same cursor on insert
-- (plan.json#sharedDecisions -> "one cursor", finding H-4), and it does so by attaching a trigger
-- to this function - not by copying the expression a second time.
--
-- `AFTER INSERT OR UPDATE OR DELETE`, and the DELETE is the load-bearing one. A removed Post-it
-- leaves no row behind to notice, so a cursor that did not move on a delete would leave it on
-- every other participant's board until something else happened to write.
--
-- GREATEST(clock_timestamp(), old + 1 microsecond) guarantees strict monotonicity per row even
-- when the clock does not tick between two writes, or steps backwards.
-- --------------------------------------------------------------------------------------------
CREATE FUNCTION advance_round_activity_watermark() RETURNS trigger AS $$
BEGIN
  IF (TG_OP <> 'DELETE') THEN
    UPDATE round
       SET activity_watermark_at =
             GREATEST(clock_timestamp(), activity_watermark_at + interval '1 microsecond')
     WHERE id = NEW.round_id;
  END IF;

  -- On a delete, and on the (unsupported but expressible) case of a row moving between Rounds,
  -- the Round that lost it has changed too.
  IF (TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.round_id IS DISTINCT FROM NEW.round_id)) THEN
    UPDATE round
       SET activity_watermark_at =
             GREATEST(clock_timestamp(), activity_watermark_at + interval '1 microsecond')
     WHERE id = OLD.round_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER post_it_advances_activity_watermark
  AFTER INSERT OR UPDATE OR DELETE ON post_it
  FOR EACH ROW
  EXECUTE FUNCTION advance_round_activity_watermark();

-- A change to the Round's own fields is an activity change too, so S01's open, close and prompt
-- edit move the cursor without S01 knowing this story exists.
--
-- The WHEN clause is load-bearing twice over, exactly as `conference_change_advances_watermark`'s
-- is: it keeps this trigger off the watermark-only UPDATE the function above issues - which would
-- otherwise bump the value a second time on every Post-it write - and it states in the schema
-- itself that this trigger is interested only in the Round's own columns.
CREATE FUNCTION advance_watermark_on_round_change() RETURNS trigger AS $$
BEGIN
  NEW.activity_watermark_at :=
    GREATEST(clock_timestamp(), OLD.activity_watermark_at + interval '1 microsecond');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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

-- Down Migration

DROP TRIGGER round_change_advances_activity_watermark ON round;
DROP FUNCTION advance_watermark_on_round_change();

DROP TRIGGER post_it_advances_activity_watermark ON post_it;
DROP FUNCTION advance_round_activity_watermark();

DROP INDEX post_it_by_round;

DROP TABLE post_it;

ALTER TABLE round DROP COLUMN activity_watermark_at;

ALTER TABLE round
  DROP CONSTRAINT round_id_kind_conference_unique;
