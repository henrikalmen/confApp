-- Up Migration

-- The activity cursor stops being a clock and becomes an opaque counter.
--
-- Plain PostgreSQL only: no CREATE EXTENSION, no provider-specific types or functions (ADR-003).
-- Sequences and `nextval` are core PostgreSQL, so nothing here ties the schema to a provider.

-- ============================================================================================
-- WHY THIS EXISTS.
--
-- `round.activity_watermark_at` was a `timestamptz`, and the API served it to microsecond
-- precision from `GET /api/conferences/:c/sessions/:s/activities/watermark`, which is gated on
-- Conference Membership alone - every person in the room may poll it, every few seconds, for as
-- long as they like.
--
-- On a Session running only a Poll, every movement of that value is a Vote. An Attendee is
-- deliberately refused the live tally so that not voting carries no signal
-- (prd.md#fr5-poll-result-reveal), and could then read the precise instant each ballot landed
-- instead. Votes are always anonymous, and that is a storage-level guarantee rather than a UI
-- convention (AGENTS.md), so the instant does not belong on the wire.
--
-- The replacement is `round.activity_watermark`: a `bigint` holding `nextval` of one global
-- sequence. A client compares it with the value it last saw and refetches the Session when the
-- two differ. That is the whole of what this cursor is asked to do - no client orders it,
-- subtracts it, or reads it as a time, and the API no longer renders it through
-- `api/src/sessions/wall-clock-time.ts`.
--
-- **ONE GLOBAL SEQUENCE, and a per-Round counter would be a defect.** A counter kept per Round
-- would make the difference between two polls the exact number of writes to that Round - on a
-- Poll, the exact number of Votes cast in between, which is information an Attendee does not have
-- today and must not gain. A sequence shared by every Round in the deployment is advanced by
-- unrelated writes too, so a difference is a floor rather than a count. For the same reason the
-- sequence is deliberately **not** owned by the column: a plain `DEFAULT nextval(...)` records no
-- ownership dependency, unlike `bigserial`, and an owned sequence would be a per-column sequence
-- in everything but name.
--
-- **WHAT THIS DOES NOT DO.** In a very quiet deployment - one active Session, nothing else being
-- written - the sequence advances only for that Session, so the difference between two polls
-- approximates the local write volume, and on a Session running only a Poll it approximates the
-- number of Votes cast in the interval. That residual is real and is accepted. This change is
-- strictly better than the microsecond timestamp it replaces, which gave the timing of each
-- individual ballot and needed no such condition attached; it does not close the channel. Stated
-- plainly here rather than reassured away, for the same reason ADR-006's residual is.
--
-- **The other two cursors are untouched, and are different mechanisms.**
-- `conference.schedule_watermark_at` drives the Schedule refetch, and `sessions.last_updated_at`
-- is S09's optimistic-concurrency base, which is compared *as an instant* by preconditions this
-- migration must not disturb. Neither is named below.
-- ============================================================================================

-- The one named home for the advance. It is no longer an expression that could be copied wrongly
-- - it is a call to `nextval` on this sequence, and every trigger below makes the same call.
--
-- `bigint` and `NO CYCLE`: 9.2e18 values, so exhaustion is not a case that needs handling, and
-- wrapping would break the "differs from what I last saw" comparison that is the point.
-- `nextval` is non-transactional and never rolls back, so a rolled-back write leaves a gap in the
-- sequence rather than reusing a value - which preserves monotonicity and adds noise rather than
-- removing any.
CREATE SEQUENCE activity_watermark_seq AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

-- Each existing Round takes its own value: `nextval` is volatile, so PostgreSQL evaluates the
-- default once per row rather than storing one shared value. Every open client then sees its
-- Session's cursor differ from the timestamp it was holding and refetches once, which is the
-- correct behaviour across this change and not a defect to design around.
ALTER TABLE round
  ADD COLUMN activity_watermark bigint NOT NULL DEFAULT nextval('activity_watermark_seq');

ALTER TABLE round DROP COLUMN activity_watermark_at;

-- --------------------------------------------------------------------------------------------
-- The two trigger functions, redefined in place.
--
-- Both are S02's (20260828120000000_post-it.sql) and both are REPLACED rather than joined by a
-- third: `advance_round_activity_watermark` is the one every child table attaches to - `post_it`
-- (S02), and `vote` and `round_option` (S03, 20260829090000000_vote.sql) - and their triggers
-- keep pointing at it untouched. `advance_watermark_on_round_change` stays separate because it
-- cannot be the same function: it is a BEFORE trigger on `round` itself, which sets `NEW` instead
-- of issuing an UPDATE, and a `round` row has no `round_id` to key on.
--
-- What the GREATEST(clock_timestamp(), previous + 1 microsecond) idiom bought was strict
-- monotonicity per row when the clock does not tick between two writes or steps backwards.
-- `nextval` gives that unconditionally and without consulting a clock at all, which is the point.
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION advance_round_activity_watermark() RETURNS trigger AS $$
BEGIN
  IF (TG_OP <> 'DELETE') THEN
    UPDATE round
       SET activity_watermark = nextval('activity_watermark_seq')
     WHERE id = NEW.round_id;
  END IF;

  -- On a delete, and on the (unsupported but expressible) case of a row moving between Rounds,
  -- the Round that lost it has changed too.
  IF (TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.round_id IS DISTINCT FROM NEW.round_id)) THEN
    UPDATE round
       SET activity_watermark = nextval('activity_watermark_seq')
     WHERE id = OLD.round_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION advance_watermark_on_round_change() RETURNS trigger AS $$
BEGIN
  NEW.activity_watermark := nextval('activity_watermark_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Down Migration

-- Puts back exactly what 20260828120000000_post-it.sql created - the `timestamptz` column and both
-- function bodies in their GREATEST/clock_timestamp form - so that migration's own down step still
-- finds what it drops. Anything less would make this reversible only until the next one ran.

ALTER TABLE round
  ADD COLUMN activity_watermark_at timestamptz NOT NULL DEFAULT clock_timestamp();

ALTER TABLE round DROP COLUMN activity_watermark;

DROP SEQUENCE activity_watermark_seq;

CREATE OR REPLACE FUNCTION advance_round_activity_watermark() RETURNS trigger AS $$
BEGIN
  IF (TG_OP <> 'DELETE') THEN
    UPDATE round
       SET activity_watermark_at =
             GREATEST(clock_timestamp(), activity_watermark_at + interval '1 microsecond')
     WHERE id = NEW.round_id;
  END IF;

  IF (TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.round_id IS DISTINCT FROM NEW.round_id)) THEN
    UPDATE round
       SET activity_watermark_at =
             GREATEST(clock_timestamp(), activity_watermark_at + interval '1 microsecond')
     WHERE id = OLD.round_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION advance_watermark_on_round_change() RETURNS trigger AS $$
BEGIN
  NEW.activity_watermark_at :=
    GREATEST(clock_timestamp(), OLD.activity_watermark_at + interval '1 microsecond');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
