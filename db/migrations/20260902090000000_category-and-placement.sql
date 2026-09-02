-- Up Migration

-- Categories on a Post-it Round's Board, and the placement column whose **absence** is
-- Uncategorised.
--
-- Plain PostgreSQL only: one ordinary table, ordinary CHECK and UNIQUE constraints, one ordinary
-- foreign key and one trigger attached to a function that already exists. No CREATE EXTENSION, no
-- provider-specific type or function (ADR-003, Binding Constraint FR1). `gen_random_uuid()` is core
-- PostgreSQL (13+), exactly as `20260828120000000_post-it.sql` uses it.

-- ============================================================================================
-- THE CATEGORY.
--
-- A named bucket belonging to exactly one Post-it Round's Board (prd.md#fr1-categories-on-a-board).
-- There is no conference-level set and no second place a Category can be defined, so this table
-- hangs off the Round the same way `post_it` does - through the composite key
-- `round_id_kind_conference_unique` - rather than off a bare `round_id`.
--
-- With `round_kind` in the key a Category on a Poll is a **foreign-key violation** rather than a
-- rule a handler remembers, and with `conference_id` in it a Category naming a Round in some other
-- Conference is one too. Both halves of "a Category belongs to a Post-it Round of this Conference"
-- are made unwritable here.
--
-- What is deliberately absent:
--   - **any row, id, flag or sentinel for Uncategorised.** Uncategorised is the *state of a Post-it
--     having no placement* (prd.md#data-requirements), and `post_it.category_id IS NULL` is its only
--     representation. A row for it would be addressable, and every rename, reorder and remove path
--     would then need a refusal for a row that should not exist.
--   - **any tombstone, soft-delete flag or `deleted_at` on `post_it`.** This migration adds one
--     column to that row and nothing else, so author deletion still leaves no trace at all
--     (Binding Constraint FR4). Discard is S05's and is stored elsewhere.
--   - **any colour, description or per-Category setting.** "Carries a name and an explicit order,
--     and nothing else in this release" are the PRD's words.
-- ============================================================================================
CREATE TABLE category (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id      uuid        NOT NULL,
  conference_id uuid        NOT NULL,

  /*
   * Carried so the composite foreign key below can name it, and pinned to the one value it may ever
   * hold - the same arrangement, for the same reason, as `post_it.round_kind`.
   */
  round_kind    text        NOT NULL DEFAULT 'PostItRound',

  name          text        NOT NULL,

  /*
   * The Facilitator's explicit order, 1-based and contiguous.
   *
   * **The 20-per-Board cap is this CHECK plus the UNIQUE below, and it is not an application
   * count.** A `select count(*)` followed by an `insert` is precisely the check two container
   * replicas both pass (ADR-004), which is the failure `prd.md#non-functional-requirements` names
   * with "the cap cannot be raced past". Expressed as storage, two concurrent creates at 19
   * Categories can only produce 20 rows: both take position 20, and the deferred unique constraint
   * refuses one of them at COMMIT.
   */
  position      integer     NOT NULL,

  CONSTRAINT category_is_on_a_post_it_round
    CHECK (round_kind = 'PostItRound'),

  -- Removed with its Round, and so with its Session and its Conference - the same cascade
  -- `post_it` takes, because a Category whose Round is gone is not a record worth keeping.
  CONSTRAINT category_round_in_conference
    FOREIGN KEY (round_id, round_kind, conference_id)
    REFERENCES round (id, kind, conference_id)
    ON DELETE CASCADE,

  /*
   * The API validates the name first and produces the field-level refusal a person reads, naming
   * the limit it enforces and the length that broke it; this is the backstop that keeps a blank or
   * over-long name out of the table through any other path.
   *
   * The 60 here is the **one unavoidable second copy** of `CATEGORY_NAME_MAX_LENGTH` in
   * api/src/rounds/category-validation.ts, which is the authoritative definition. It is pinned to
   * that constant by test (api/test/category-structure.test.ts and the boundary assertion in
   * api/test/category.integration.test.ts), never by this comment: changing either side alone
   * fails. Exactly the arrangement `post_it_text_present` established.
   *
   * `char_length` counts code points, which is what the API counts too - a name of 60 emoji
   * measures 120 in JavaScript's `.length` and 60 here, and the two layers have to state the same
   * limit for stating it twice to mean anything. `btrim` on both sides, so the stored value and the
   * measured value are the same string.
   */
  CONSTRAINT category_name_present
    CHECK (btrim(name) <> '' AND char_length(btrim(name)) <= 60),

  -- Half of the cap, and the half that refuses a 21st Category outright: there is no 21st position
  -- for it to take. The API maps this violation onto the refusal that names the limit and the
  -- current count.
  CONSTRAINT category_position_within_cap
    CHECK (position BETWEEN 1 AND 20),

  /*
   * The other half of the cap, and the reason the order can be renumbered at all.
   *
   * **DEFERRABLE INITIALLY DEFERRED is load-bearing twice over.** A reorder and an occupied-Category
   * removal both renumber the whole ordering in one statement, and an immediately-checked unique
   * index makes any such pass collide with itself mid-update - row 2 taking position 1 before row 1
   * has left it. Deferred to COMMIT, the statement is judged on the ordering it produced rather than
   * on the order PostgreSQL happened to visit the rows in.
   *
   * And it is what makes the cap unraceable: two creates that both read `max(position) = 19` both
   * insert position 20, neither blocks the other, and the loser is refused at COMMIT. The API
   * catches that 23505 **around the commit** as well as around the statement, because a deferred
   * constraint does not raise where the failing statement was.
   */
  CONSTRAINT category_position_unique
    UNIQUE (round_id, position) DEFERRABLE INITIALLY DEFERRED,

  /*
   * Not a new uniqueness rule - `id` is already the primary key - but the key `post_it` needs so a
   * placement can name `(category_id, round_id)` together. That is what makes "a Post-it placed in a
   * Category of some other Round" unwritable through any path rather than a comparison a handler
   * remembers to make.
   */
  CONSTRAINT category_id_round_unique
    UNIQUE (id, round_id)
);

-- Every Board read asks for one Round's Categories in the Facilitator's order, and this index
-- carries that read's whole sort key - `order by c.position, c.id` - so the ordered read never
-- sorts. `id` is the third column for exactly that reason and is what makes this more than a
-- duplicate of the btree `category_position_unique` already builds on `(round_id, position)`.
CREATE INDEX category_by_round ON category (round_id, position, id);

-- --------------------------------------------------------------------------------------------
-- PLACEMENT, AND THE ABSENCE THAT IS UNCATEGORISED.
--
-- One nullable column on the row that is being placed. NULL means the Post-it is in Uncategorised,
-- and that is the *only* representation of Uncategorised anywhere in this system - schema, API or
-- SPA (prd.md#fr2-the-uncategorised-holding-area). Every Post-it already stored reads as what it
-- is: unsorted, waiting for a Facilitator.
--
-- **The foreign key is `NO ACTION` (the default) and deliberately not `RESTRICT`**, and the
-- difference is not cosmetic. Deleting a Round cascades to `post_it` and `category` in one
-- statement; `RESTRICT` fires immediately and would break Round - and therefore Session and
-- Conference - deletion, while `NO ACTION` is checked at end of statement, by which time both sides
-- are gone. `NO ACTION` is also what makes "a Category holding Post-its cannot be removed" a
-- storage guarantee rather than a handler's promise: the API moves the Post-its first, and a delete
-- that skipped that step is refused by the database.
--
-- `(category_id, round_id)` and not `category_id` alone, against `category_id_round_unique`: a
-- placement into a Category of a *different* Round is then unwritable, which is
-- prd.md#edge-cases' "Placing a Post-it into a Category on a different Board | Refused" expressed
-- as a constraint. A NULL `category_id` matches nothing and is simply not checked, which is what
-- keeps Uncategorised free of any special case.
-- --------------------------------------------------------------------------------------------
ALTER TABLE post_it
  ADD COLUMN category_id uuid;

ALTER TABLE post_it
  ADD CONSTRAINT post_it_placed_on_its_own_round
  FOREIGN KEY (category_id, round_id) REFERENCES category (id, round_id);

-- The occupied-Category removal reads "which Post-its are in this Category", and the Board read
-- groups by this column. Partial, because a NULL placement is Uncategorised and is never looked up
-- by category id - it is found by the Round it is on, which `post_it_by_round` already serves.
CREATE INDEX post_it_by_category ON post_it (category_id) WHERE category_id IS NOT NULL;

-- --------------------------------------------------------------------------------------------
-- THE CURSOR ADVANCE, ATTACHED AND NEVER COPIED.
--
-- `advance_round_activity_watermark()` is the one named home for the advance
-- (20260828120000000_post-it.sql, redefined by 20260829120000000_activity-watermark-counter.sql to
-- call `nextval` on the one global sequence). It already keys on `NEW.round_id` / `OLD.round_id`,
-- which is exactly what a `category` row carries, so this story attaches a trigger to it rather
-- than restating the expression a fourth time.
--
-- `AFTER INSERT OR UPDATE OR DELETE`, and the DELETE is the load-bearing one for the same reason it
-- is on `post_it`: a removed Category leaves no row behind to notice, so a cursor that did not move
-- on a delete would leave it on every other participant's Board until something else happened to
-- write.
--
-- **A placement change needs no trigger of its own.** It is an UPDATE on `post_it`, which
-- `post_it_advances_activity_watermark` has covered since S02; that is confirmed by test rather
-- than by a second trigger.
--
-- ADR-007 is untouched: a Vote still advances nothing, and no vote-derived value appears here.
-- --------------------------------------------------------------------------------------------
CREATE TRIGGER category_advances_activity_watermark
  AFTER INSERT OR UPDATE OR DELETE ON category
  FOR EACH ROW
  EXECUTE FUNCTION advance_round_activity_watermark();

-- Down Migration

DROP TRIGGER category_advances_activity_watermark ON category;

DROP INDEX post_it_by_category;

ALTER TABLE post_it
  DROP CONSTRAINT post_it_placed_on_its_own_round;

ALTER TABLE post_it DROP COLUMN category_id;

DROP INDEX category_by_round;

DROP TABLE category;
