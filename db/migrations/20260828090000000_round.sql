-- Up Migration

-- Session Activities: the Round a Session runs, and a Poll's ordered options.
--
-- Plain PostgreSQL only: no CREATE EXTENSION, no provider-specific types or functions (ADR-003).
-- `gen_random_uuid()` is core PostgreSQL (13+), not pgcrypto, so no extension is needed for it.
--
-- ============================================================================================
-- The Activity model reaches the schema at BOTH of its levels, exactly as
-- docs/UBIQUITOUS_LANGUAGE.md#session-activities names them:
--
--   *kind*     – which Activity this is. A Post-it Round, or a Voting Round. Two values, and the
--                product describes no third.
--   *purpose*  – what a Voting Round is *for*. Poll today; Prioritization and Rating are deferred
--                purposes, not deferred kinds.
--
-- Flattening the two into a single `kind IN ('PostItRound', 'Poll')` would put a purpose where a
-- kind belongs, and would make each deferred purpose an alteration of a shipped kind constraint.
-- Kept apart, adding Prioritization or Rating widens `round_purpose_known` below and touches
-- nothing else.
--
-- What this migration deliberately does NOT add is a row-version or watermark column, and no
-- trigger that stamps one. Near-live propagation for Rounds is `round.activity_watermark_at` and
-- its triggers, owned by S02 (plan.json#sharedDecisions -> "Near-live propagation: one cursor").
-- A second timestamp on this row with the same semantics is exactly the duplication that decision
-- removed. `closed_at` is the only instant here, and it is not a cursor: it records when a Round
-- last stopped running, which is what tells "created closed" apart from "already run".
-- ============================================================================================
CREATE TABLE round (
  id            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id uuid    NOT NULL,
  session_id    uuid    NOT NULL,
  kind          text    NOT NULL,

  -- Nullable, and constrained below to be present exactly when the kind is 'VotingRound'.
  -- Prioritization and Rating are deferred *purposes*: adding one widens this CHECK, never the
  -- kind CHECK above it (PRD -> MVP Boundary, docs/UBIQUITOUS_LANGUAGE.md#session-activities).
  purpose       text,

  -- The Post-it Round's prompt, or the Poll's question. One column, because it is one thing: the
  -- text the room is answering. The API validates it first and produces the field-level refusal a
  -- person reads; this is the backstop that keeps a blank or over-long value out of the table
  -- through any other path (FR1 -> Validation).
  prompt        text    NOT NULL,

  -- Created closed, always (FR1). A Round is authored ahead of the Session and starts running only
  -- when its Facilitator opens it, so the default is the state, not a convenience.
  state         text    NOT NULL DEFAULT 'closed',

  -- Authored order, so the Session lists its Rounds as the Facilitator wrote them. Reordering is
  -- not a stated need and no path here changes it.
  position      integer NOT NULL,

  -- When this Round last stopped running. NULL for a Round that has never been opened and closed,
  -- which is precisely the distinction the reopen rule turns on: a Poll refuses to reopen once it
  -- has *run*, and "created closed" is not "already run" (FR2).
  closed_at     timestamptz,

  -- A Round is reachable only inside its own Conference. The composite foreign key is what makes a
  -- row naming a Session that belongs to some *other* Conference unwritable, rather than leaving
  -- "conference-scoped" a field the application remembers to populate correctly. Same idiom as
  -- session_assignment; cascades from the Session, and so from the Conference through it.
  CONSTRAINT round_session_in_conference
    FOREIGN KEY (session_id, conference_id) REFERENCES sessions (id, conference_id)
    ON DELETE CASCADE,

  CONSTRAINT round_kind_known
    CHECK (kind IN ('PostItRound', 'VotingRound')),

  CONSTRAINT round_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('Poll')),

  -- The two-level rule itself: a Voting Round has a purpose, and nothing else may carry one. This
  -- is what makes "a purpose on a Post-it Round" and "a Voting Round with no purpose" unwritable
  -- through any path rather than merely refused by a handler.
  CONSTRAINT round_purpose_matches_kind
    CHECK ((kind = 'VotingRound') = (purpose IS NOT NULL)),

  CONSTRAINT round_state_known
    CHECK (state IN ('open', 'closed')),

  CONSTRAINT round_prompt_present
    CHECK (btrim(prompt) <> '' AND char_length(prompt) <= 500),

  CONSTRAINT round_position_ordered
    CHECK (position >= 0)
);

-- The Session read asks for one Session's Rounds in authored order, which is exactly this index.
CREATE INDEX round_by_session ON round (session_id, position);

-- A Poll's answer options, ordered as they were authored.
--
-- A separate table rather than an array column: an option is a row a Vote will point at (S03), and
-- an array offers nothing for a ballot to reference.
CREATE TABLE round_option (
  id       uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id uuid    NOT NULL REFERENCES round (id) ON DELETE CASCADE,
  position integer NOT NULL,
  label    text    NOT NULL,

  CONSTRAINT round_option_label_present
    CHECK (btrim(label) <> '' AND char_length(label) <= 120),

  CONSTRAINT round_option_position_ordered
    CHECK (position >= 0),

  -- Two options in the same position is not an order; two options with the same label is not a
  -- choice. Both are refused by the API with a field-level message first; these keep them out of
  -- the table through any other path.
  CONSTRAINT round_option_unique_position UNIQUE (round_id, position),
  CONSTRAINT round_option_unique_label UNIQUE (round_id, label)
);

-- Down Migration

DROP TABLE round_option;

DROP INDEX round_by_session;

DROP TABLE round;
