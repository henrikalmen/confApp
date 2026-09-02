-- Up Migration

-- The Display Link: an unguessable, revocable, read-only value scoped to one Post-it Round's Board,
-- so a room machine can project it without anybody signing in on shared hardware (FR7).
--
-- Plain PostgreSQL only: one ordinary table, ordinary CHECK and UNIQUE constraints, one composite
-- foreign key and one partial unique index. No CREATE EXTENSION, no provider-specific type or
-- function (ADR-003, Binding Constraint FR1). `gen_random_uuid()` is core PostgreSQL (13+), exactly
-- as `20260828120000000_post-it.sql` and `20260902090000000_category-and-placement.sql` use it.

-- ============================================================================================
-- THE LINK.
--
-- One row per issue, retained. Rows are never deleted except by cascade with their Round, and that
-- retention is the whole mechanism behind "a revoked value is never reissued": the row keeps the
-- token, `token` is globally UNIQUE, so a mint that collided with any value ever issued - live or
-- revoked, on this Round or any other - is refused by the database rather than by a memory of what
-- has been handed out. Nothing is remembered in process (ADR-004).
--
-- It hangs off the Round through `round_id_kind_conference_unique`, the same composite key
-- `post_it` and `category` use, and for the same reason: with `round_kind` in the key a Display
-- Link for a **Voting Round** is a foreign-key violation rather than a rule a handler remembers,
-- and with `conference_id` in it a link naming a Round in some other Conference is one too. "No
-- Display Link for anything but a Post-it Round's Board" is therefore unwritable, not merely
-- unoffered (FIS -> What We're NOT Doing).
--
-- **The token is stored readably, and that is a decision rather than an oversight.** FR7's Outputs
-- require the live value to be re-presented to its own Facilitator for copying, which a one-way
-- hash cannot do. ADR-006 already scopes confApp's guarantees to *application paths* rather than to
-- database credentials, so a readable bearer value here is consistent with the shipped position on
-- Vote anonymity rather than a new exception to it.
--
-- What is deliberately absent:
--   - **any expiry, TTL or `expires_at` column.** The time bound is the Round's Session `day`,
--     compared against the server's own calendar date at resolution time (ADR-005). A countdown
--     from issue would kill a link mid-activity for a Session several days out, which is exactly
--     the failure the PRD's edge case names.
--   - **any viewer, hit, address or user-agent column.** The projected surface is anonymous; a row
--     recording who opened it would create the attribution the anonymity of the room depends on
--     not existing, and would be personal data on confApp's only unauthenticated domain route.
--   - **any vote-derived column, and any reference to a vote or ballot table.** Nothing on this
--     path may reach Vote data in any response it can produce (ADR-006, Binding Constraint FR8).
--   - **any trigger on `advance_round_activity_watermark()`.** Issuing or revoking a link is not
--     Board activity: it changes nothing the room is looking at, and advancing the one cursor would
--     hand every phone in the Session a refetch that finds an identical Board - and would make the
--     act of revoking observable to everybody in the room.
-- ============================================================================================
CREATE TABLE display_link (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  /*
   * The bearer value itself, and the whole security boundary of the anonymous route.
   *
   * Globally UNIQUE, not unique per Round: the resolution route looks a value up by token alone,
   * with no Conference, Session or Round in the request, so two Rounds sharing a token would make
   * the lookup ambiguous. The constraint is also what makes "no mint can produce a value already
   * recorded for any Round in any state" a property of the table rather than of the minter.
   */
  token         text        NOT NULL UNIQUE,

  round_id      uuid        NOT NULL,
  conference_id uuid        NOT NULL,

  /*
   * Carried so the composite foreign key below can name it, and pinned to the one value it may ever
   * hold - the same arrangement, for the same reason, as `post_it.round_kind` and
   * `category.round_kind`.
   */
  round_kind    text        NOT NULL DEFAULT 'PostItRound',

  /*
   * Who issued it, as the OIDC subject claim and nothing else. No column here holds, keys on or
   * joins by an email address (ADR-002, AGENTS.md#do-not--never).
   *
   * It is a record of the act, not an input to any decision: resolution never reads it, and the
   * link carries none of the issuer's authority - it grants one Board, read-only, and nothing else.
   */
  issued_by_sub text        NOT NULL REFERENCES app_user (sub),
  issued_at     timestamptz NOT NULL DEFAULT clock_timestamp(),

  /*
   * NULL means live. Stamped once and never cleared: no application path clears it, and there is
   * deliberately no UPDATE anywhere that could. "Never reissued once revoked" (FR7 -> Data
   * Requirements) is that absence plus the retained row plus the UNIQUE above.
   */
  revoked_at    timestamptz,

  CONSTRAINT display_link_is_on_a_post_it_round
    CHECK (round_kind = 'PostItRound'),

  -- Removed with its Round, and so with its Session and its Conference. A link to a Board that is
  -- gone resolves to nothing, and the row is not a record worth keeping. This is also what makes
  -- the deleted-Round case reach the same neutral refusal as an unknown value: there is no row.
  CONSTRAINT display_link_round_in_conference
    FOREIGN KEY (round_id, round_kind, conference_id)
    REFERENCES round (id, kind, conference_id)
    ON DELETE CASCADE,

  /*
   * The canonical token shape, as a backstop.
   *
   * 43 base64url characters is 32 bytes of CSPRNG output - the **one unavoidable second copy** of
   * `DISPLAY_TOKEN_BYTES` / `isCanonicalDisplayToken` in api/src/rounds/display-link.ts, which is
   * the authoritative definition. It is pinned to that module by test
   * (api/test/display-link-structure.test.ts), never by this comment: changing either side alone
   * fails. Exactly the arrangement `post_it_text_present` and `category_name_present` established.
   *
   * It is a *storage* backstop only. The resolution route carries no shape check of any kind, on
   * purpose: a value refused for its shape and a real-but-dead value would answer differently, and
   * that difference is an oracle telling "not even a token" from "not a live token"
   * (FIS -> Constraints & Gotchas).
   */
  CONSTRAINT display_link_token_canonical
    CHECK (token ~ '^[A-Za-z0-9_-]{43}$')
);

/*
 * At most one live link per Round, as storage rather than as arithmetic.
 *
 * A `select count(*) where revoked_at is null` followed by an insert is precisely the check two
 * container replicas both pass (ADR-004). Expressed as a partial unique index, two concurrent
 * issues for one Round can only leave one live row: the loser is refused outright. The issue path
 * revokes-then-inserts in a single transaction so it does not *rely* on that refusal, but the index
 * is what makes "a Round holds at most one live link" true whatever any code does.
 *
 * Partial, because revoked rows are retained forever and there may be any number of them per Round.
 */
CREATE UNIQUE INDEX display_link_one_live_per_round
  ON display_link (round_id) WHERE revoked_at IS NULL;

-- Down Migration

DROP INDEX display_link_one_live_per_round;

DROP TABLE display_link;
