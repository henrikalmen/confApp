-- Up Migration

-- Anonymous Poll voting: the ballot, the has-voted fact, and the cursor a cast Vote advances.
--
-- Plain PostgreSQL only: no CREATE EXTENSION, no provider-specific types or functions (ADR-003).
-- `gen_random_uuid()` is core PostgreSQL (13+), not pgcrypto, so no extension is needed for it.

-- ============================================================================================
-- HOW FAR THIS ANONYMITY REACHES, STATED EXACTLY.
--
-- Authority: docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md
--
-- **What confApp guarantees**: a Vote is unlinkable to its voter through *every application
-- path*. No API response, screen, export or report can associate the two, and no declared
-- column, constraint, index, trigger or query available to the application relates `vote` to
-- `round_voter` beyond the `round_id` they share - which yields the set of ballots for a Round
-- and the set of people who voted in it, and never a pairing between them.
--
-- **What confApp does not guarantee**: unlinkability against a holder of direct database
-- credentials. The `round_voter` row and the `vote` row are written in one transaction, so
-- PostgreSQL stamps both with the same `xmin`. `xmin` is a system column present on every table
-- and readable by an ordinary `SELECT`, so joining these two tables on `round_id` and `xmin`
-- returns an exact voter-to-ballot pairing for every Vote in a Round. Any role able to read
-- these two tables can do that, needing no right beyond the ones it already holds to read them.
--
-- That residual is **accepted**, and the control for it is who holds those credentials - an
-- operational matter rather than a schema one, for an internal application under a hundred
-- employees. ADR-006 weighed splitting the two writes across transactions, SECURITY DEFINER
-- tally functions with SELECT revoked from the API role, and per-option counters in place of
-- ballot rows, and chose none of them; do not reintroduce one here without reopening that
-- decision. The single transaction is what stops a crash between the two writes from either
-- losing a Vote with no retry path or admitting a second one from the same person.
--
-- No structure test can fail on this residual, because no schema assertion inspects a system
-- column. It survives as this comment and as the ADR, which is a weaker guard than a check and
-- is why the wording above is precise rather than reassuring.
-- ============================================================================================

-- ============================================================================================
-- Needed so a ballot can hang off a composite foreign key rather than a bare `option_id`.
--
-- Same idiom as `round_id_kind_conference_unique` (20260828120000000_post-it.sql): with
-- `round_id` in the key, an `option_id` naming an option of some *other* Poll is a foreign-key
-- violation rather than a rule a handler remembers to apply. `id` is already the primary key, so
-- this adds a guarantee rather than a new uniqueness rule.
-- ============================================================================================
ALTER TABLE round_option
  ADD CONSTRAINT round_option_id_round_unique UNIQUE (id, round_id);

-- --------------------------------------------------------------------------------------------
-- The ballot.
--
-- Two columns and nothing else: which Round, and which option. There is no third column, and the
-- absence is the guarantee - a voter reference cannot be "left null for now" or added "just in
-- case" because there is nowhere for one to live, and the API cannot leak what the row does not
-- hold (AGENTS.md: never attribute a vote to a voter).
--
-- What is deliberately absent, and why each absence is load-bearing:
--
--   - **No timestamp of any kind.** `created_at` would order the ballots of a Round by the
--     instant they were written, and `round_voter` would only have to be ordered the same way for
--     the two to be lined up. There is no product need for when a ballot was cast, so there is no
--     column for it.
--   - **No `serial`, `bigserial`, identity or sequence-defaulted column.** A sequence orders rows
--     by write time exactly as a timestamp does; a random `gen_random_uuid()` does not. This is
--     why the primary key is a uuid rather than the integer key a counting table would take.
--   - **No `conference_id` and no `session_id`.** Both are reachable through the Round, and
--     neither would add a guarantee - the composite key below already makes a cross-Poll ballot
--     unwritable. A column that only ever restates a join is a column a later query can group by.
--   - **No `user_sub`, `app_user` reference, email, device, client or auth-session identifier**,
--     hashed, encrypted, derived or defaulted. See the ADR block above for the exact reach of
--     that statement.
--
-- Removed with its Poll, and so with its Session and its Conference: a ballot whose Round is gone
-- is not a record worth keeping, and S05's contribution-safe deletion turns on the Round's own
-- rules rather than on a ballot outliving it.
-- --------------------------------------------------------------------------------------------
CREATE TABLE vote (
  id        uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id  uuid NOT NULL REFERENCES round (id) ON DELETE CASCADE,
  option_id uuid NOT NULL,

  CONSTRAINT vote_option_on_this_round
    FOREIGN KEY (option_id, round_id) REFERENCES round_option (id, round_id)
    ON DELETE CASCADE
);

-- The tally reads every ballot of a Round grouped by the option it points at; the freeze check
-- asks whether a Round has one at all. Neither index carries a uniqueness rule: two ballots for
-- the same option in the same Round are the ordinary case, and anything unique per ballot would
-- be a value `round_voter` could be matched against.
CREATE INDEX vote_by_option ON vote (option_id);
CREATE INDEX vote_by_round ON vote (round_id);

-- --------------------------------------------------------------------------------------------
-- The has-voted fact.
--
-- "This person has voted in this Round" - the whole of what is recorded, and the reason a Vote
-- can be single-use without the ballot knowing who cast it. It is a *separate table* rather than
-- a column on `vote` precisely so that no row anywhere holds both facts.
--
-- The uniqueness rule is the single-use gate, and it is enforced here rather than by a check the
-- API makes first: two submissions from one person arriving together both pass a pre-read, and
-- only one of them can win a unique constraint (docs/LEARNINGS.md#concurrency). The API attempts
-- the insert and reads the violation as "you have already voted".
--
-- Identity is `user_sub`, the OIDC subject claim, and nothing else. No column here holds, keys on
-- or joins by an email address: addresses change and are reissued to different people (ADR-002,
-- AGENTS.md#do-not--never).
--
-- The same three absences as the ballot, for the same reason: no timestamp, no sequence, and a
-- random primary key. Recording *when* somebody voted, beside a ballot table recording what was
-- voted, would be a declared join waiting for a reader - and unlike the residual named above it
-- would be one this schema chose to create.
--
-- Because a Vote is final once cast (prd.md#decisions-log) there is nothing to update here, which
-- is what lets the fact be stored with no declared path back to the ballot. Supporting a change
-- of Vote would need exactly the link this table exists to avoid.
-- --------------------------------------------------------------------------------------------
CREATE TABLE round_voter (
  id        uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id  uuid NOT NULL REFERENCES round (id) ON DELETE CASCADE,
  user_sub  text NOT NULL REFERENCES app_user (sub),

  CONSTRAINT round_voter_once_per_round UNIQUE (round_id, user_sub)
);

-- --------------------------------------------------------------------------------------------
-- A cast Vote advances the Round's activity cursor, so a building tally has a producer.
--
-- It attaches to `advance_round_activity_watermark()` - S02's one named home for the GREATEST
-- expression (20260828120000000_post-it.sql) - rather than copying that expression a third time
-- (plan.json#sharedDecisions -> "Near-live propagation: one cursor").
--
-- **AFTER INSERT only, and Round-level only.** It reads no identity, writes to no
-- identity-bearing table, and does not relate `vote` to `round_voter`. What it reveals is the
-- instant of the most recent Vote *in a Round*, which the moving tally the Facilitator is
-- watching already reveals. There is no UPDATE or DELETE branch because a ballot is never updated
-- and is only ever removed by the cascade that removes its Poll, at which point there is no Round
-- left to notify. Any wider trigger on this table is a defect.
--
-- It writes the Round row while a Facilitator may be updating that same row directly; both sides
-- go through `api/src/db.ts`, whose existing SQLSTATE 40P01 retry is the one deadlock policy this
-- API has. It must not, and does not, touch `conference.schedule_watermark_at` or
-- `sessions.last_updated_at`.
-- --------------------------------------------------------------------------------------------
CREATE TRIGGER vote_advances_activity_watermark
  AFTER INSERT ON vote
  FOR EACH ROW
  EXECUTE FUNCTION advance_round_activity_watermark();

-- --------------------------------------------------------------------------------------------
-- Editing a Poll's options advances the same cursor.
--
-- `round_option` carried no trigger, and `round_change_advances_activity_watermark`'s WHEN clause
-- stays false when only the option set changed - so until now an option edit was invisible to
-- every polling client, and a room could be reading stale labels while voting against them. That
-- gap only becomes a failure once options are load-bearing, which is what this story makes them:
-- a ballot points at an option, so what an option *says* is now part of the answer.
--
-- The window that matters is the one before the first Vote, because from that moment the Poll's
-- content is frozen and this case is unreachable. Insert, update and delete alike, because
-- `updateContent` replaces an option set by deleting it and writing it again, and the delete is
-- the half that leaves no row behind to notice.
--
-- The related mechanism - that `round_change_advances_activity_watermark`'s WHEN clause is a
-- hand-maintained allow-list of columns, so a column added later is silently outside the cursor -
-- is S02's migration to change and is recorded in that story's reconciliation ledger. It is
-- deliberately not widened here.
-- --------------------------------------------------------------------------------------------
CREATE TRIGGER round_option_advances_activity_watermark
  AFTER INSERT OR UPDATE OR DELETE ON round_option
  FOR EACH ROW
  EXECUTE FUNCTION advance_round_activity_watermark();

-- Down Migration

DROP TRIGGER round_option_advances_activity_watermark ON round_option;

DROP TRIGGER vote_advances_activity_watermark ON vote;

DROP TABLE round_voter;

DROP INDEX vote_by_round;

DROP INDEX vote_by_option;

DROP TABLE vote;

ALTER TABLE round_option
  DROP CONSTRAINT round_option_id_round_unique;
