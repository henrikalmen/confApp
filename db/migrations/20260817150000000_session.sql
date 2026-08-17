-- Up Migration

-- The Schedule: Sessions, the Session row version, and the whole-schedule watermark.
--
-- Plain PostgreSQL only: no CREATE EXTENSION, no provider-specific types or functions (ADR-003).
--
-- ============================================================================================
-- Two kinds of time live in this migration and they must never be confused for one another.
--
--   *Wall-clock*  – `day date`, `start_time time without time zone`, `end_time time without
--                   time zone`. A Session authored at 09:00 reads 09:00 on every device,
--                   whatever its timezone. These columns have no offset to apply, which is the
--                   point: the wrong value is unrepresentable rather than merely discouraged.
--                   Storing a `timestamptz` and "just not converting" fails the moment any
--                   driver, serializer or client library applies the offset it is entitled to.
--
--   *Instants*    – `last_updated_at`, `schedule_watermark_at`. These genuinely are moments in
--                   time, are `timestamptz`, and are serialized as ISO-8601 UTC.
--
-- Keeping the two visibly different in name and type is what stops a later story from "fixing"
-- one to match the other.
-- ============================================================================================
CREATE TABLE sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id   uuid        NOT NULL REFERENCES conference (id) ON DELETE CASCADE,
  title           text        NOT NULL,
  description     text,
  kind            text        NOT NULL,
  day             date        NOT NULL,
  start_time      time without time zone NOT NULL,
  end_time        time without time zone NOT NULL,
  location        text        NOT NULL,

  -- The per-Session row version S09 uses as its optimistic-concurrency base. Maintained by the
  -- trigger below, never by an application UPDATE, so no write path can forget it.
  last_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- Exactly one of two kinds (docs/UBIQUITOUS_LANGUAGE.md). The API refuses a third with a
  -- displayable message; this is the storage-level guarantee that no other path can write one.
  CONSTRAINT session_kind_known
    CHECK (kind IN ('Presentation', 'Workshop')),

  -- End strictly after start, on one day. Together with `day` being a single date this makes a
  -- midnight-spanning Session structurally impossible rather than a rule someone has to
  -- remember: 23:15-00:45 cannot be expressed at all.
  CONSTRAINT session_ends_after_it_starts
    CHECK (end_time > start_time),

  -- The API validates these first and produces the field-level refusal a person reads; these are
  -- the backstops that keep a value out of the table through any other path (FR2).
  CONSTRAINT session_title_present
    CHECK (btrim(title) <> '' AND char_length(title) <= 200),

  CONSTRAINT session_location_present
    CHECK (btrim(location) <> '' AND char_length(location) <= 100)
);

-- The Organizer's schedule read asks for one Conference's Sessions in day-then-start-time order,
-- which is exactly this index.
CREATE INDEX sessions_by_conference_day ON sessions (conference_id, day, start_time);

-- --------------------------------------------------------------------------------------------
-- The schedule watermark.
--
-- `conference.schedule_watermark_at` is the whole-schedule cursor: S10 reconnects from it and S09
-- polls against it, so it must advance on every Session insert, update AND delete. A delete that
-- left it standing would be invisible to an offline diff -- the removed Session would simply
-- linger in the cache forever.
--
-- It is a THIRD column, not a rename of `conference.updated_at`. That one is the Conference row's
-- own version (S03) and the concurrency base for a name or date-span edit; if a Session write
-- moved it, S09 would refuse an Organizer's rename because somebody else dragged a Session an
-- hour later. The names are deliberately unalike so a reader cannot mistake one for the other.
-- --------------------------------------------------------------------------------------------
ALTER TABLE conference
  ADD COLUMN schedule_watermark_at timestamptz NOT NULL DEFAULT clock_timestamp();

-- Why clock_timestamp() and not now(): now() / CURRENT_TIMESTAMP return *transaction start*, so
-- two writes inside one transaction would be stamped identically and S09's concurrency check
-- would not see the second. GREATEST(..., old + 1 microsecond) then guarantees strict
-- monotonicity per row even when the clock does not tick between two writes, or steps backwards.
CREATE FUNCTION session_stamp_row_version() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    NEW.last_updated_at := clock_timestamp();
  ELSE
    NEW.last_updated_at := GREATEST(clock_timestamp(), OLD.last_updated_at + interval '1 microsecond');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_stamp_row_version
  BEFORE INSERT OR UPDATE ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION session_stamp_row_version();

-- Note what this function does NOT write: `conference.updated_at`. A Session write is mechanically
-- an UPDATE on the parent Conference row, so an ordinary "touch updated_at on any update" trigger
-- would bump it here and hand S09 a concurrency base as noisy as the watermark. The watermark is
-- written explicitly, by name, and nothing else on that row is touched.
CREATE FUNCTION advance_conference_schedule_watermark() RETURNS trigger AS $$
BEGIN
  IF (TG_OP <> 'DELETE') THEN
    UPDATE conference
       SET schedule_watermark_at =
             GREATEST(clock_timestamp(), schedule_watermark_at + interval '1 microsecond')
     WHERE id = NEW.conference_id;
  END IF;

  -- On a delete, and on the (unsupported but expressible) case of a Session moving between
  -- Conferences, the Conference that lost the Session has a schedule change too.
  IF (TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.conference_id IS DISTINCT FROM NEW.conference_id)) THEN
    UPDATE conference
       SET schedule_watermark_at =
             GREATEST(clock_timestamp(), schedule_watermark_at + interval '1 microsecond')
     WHERE id = OLD.conference_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_advance_conference_watermark
  AFTER INSERT OR UPDATE OR DELETE ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION advance_conference_schedule_watermark();

-- A change to the Conference's own fields is a schedule change too, so the watermark advances for
-- it as well. The WHEN clause is load-bearing twice over: it keeps this trigger off the
-- watermark-only UPDATE the Session trigger above issues (which would otherwise bump the value a
-- second time), and it states in the schema itself that this trigger is interested only in the
-- Conference's own columns.
CREATE FUNCTION advance_watermark_on_conference_change() RETURNS trigger AS $$
BEGIN
  NEW.schedule_watermark_at :=
    GREATEST(clock_timestamp(), OLD.schedule_watermark_at + interval '1 microsecond');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conference_change_advances_watermark
  BEFORE UPDATE ON conference
  FOR EACH ROW
  WHEN (
    OLD.name IS DISTINCT FROM NEW.name
    OR OLD.start_date IS DISTINCT FROM NEW.start_date
    OR OLD.end_date IS DISTINCT FROM NEW.end_date
    OR OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state
  )
  EXECUTE FUNCTION advance_watermark_on_conference_change();

-- Down Migration

DROP TRIGGER conference_change_advances_watermark ON conference;
DROP FUNCTION advance_watermark_on_conference_change();

DROP TRIGGER sessions_advance_conference_watermark ON sessions;
DROP FUNCTION advance_conference_schedule_watermark();

DROP TRIGGER sessions_stamp_row_version ON sessions;
DROP FUNCTION session_stamp_row_version();

ALTER TABLE conference DROP COLUMN schedule_watermark_at;

DROP TABLE sessions;
