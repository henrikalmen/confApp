-- Up Migration

-- The three tables everything else in this theme hangs off: the Conference itself, the
-- Membership that says a person is in it, and the Role Assignment that says what they may do.
--
-- Plain PostgreSQL only: no CREATE EXTENSION, no provider-specific types or functions
-- (ADR-003). gen_random_uuid() is core since PostgreSQL 13, not pgcrypto.

-- start_date and end_date are `date`, never `timestamptz`. A conference day is a calendar day,
-- not an instant: "14 September" means the 14th to everyone, and routing it through a type that
-- carries an offset is how it silently becomes the 13th for somebody. The driver is configured
-- to hand `date` back as a 'YYYY-MM-DD' string rather than a JS Date for the same reason
-- (api/src/db.ts) – a Date would re-introduce the offset the column type just avoided.
--
-- updated_at is the Conference row's OWN version – the base version S09 sends back with a name
-- or date-span edit. It is advanced only by writes to this row. S04 adds a separate
-- schedule_watermark_at column for the whole-schedule watermark that every Session insert,
-- update and delete advances; that column is deliberately NOT created here, and the two names
-- are kept visibly different so a reader cannot mistake one for the other. Advancing updated_at
-- from a Session write would make S09's conflict detection fire on every unrelated schedule
-- change (plan.json -> sharedDecisions -> "three fields, four consumers", field 3).
--
-- There is no join_code column yet: a code is minted on publish and S05 owns that.
CREATE TABLE conference (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  start_date      date        NOT NULL,
  end_date        date        NOT NULL,
  lifecycle_state text        NOT NULL DEFAULT 'draft',
  created_by_sub  text        NOT NULL REFERENCES app_user (sub),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- The lifecycle states, as data. The state machine in api/src/conferences/lifecycle.ts is the
  -- authority on which *transitions* are legal; this constraint is the narrower guarantee that
  -- no fourth state can ever exist in the table, whatever writes it.
  CONSTRAINT conference_lifecycle_state_known
    CHECK (lifecycle_state IN ('draft', 'published', 'archived')),

  -- The 1-4 consecutive-day span (FR1), enforced where it cannot be bypassed. The API validates
  -- it first and produces the displayable, field-level refusal a person reads; this is the
  -- storage-level backstop that keeps an out-of-range span from reaching the table through any
  -- other path.
  CONSTRAINT conference_span_is_one_to_four_days
    CHECK (end_date >= start_date AND end_date <= start_date + 3),

  CONSTRAINT conference_name_present
    CHECK (btrim(name) <> '' AND char_length(name) <= 120)
);

-- Membership is the fact of being in a Conference, and it is universal: every role holder has
-- one, including the creator, who is seeded a Membership alongside their Admin Role Assignment
-- (docs/UBIQUITOUS_LANGUAGE.md). Nothing is a member by implication of holding a role -- without
-- a row here a creator could never be listed in their own member list, removed, or leave once a
-- second Admin exists (FR6).
--
-- S05 inserts join rows into this table and S08 revokes them; this story creates the table and
-- writes exactly one row.
CREATE TABLE membership (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id uuid        NOT NULL REFERENCES conference (id) ON DELETE CASCADE,
  user_sub      text        NOT NULL REFERENCES app_user (sub),
  joined_at     timestamptz NOT NULL DEFAULT now(),

  -- Joining twice is the same fact, not a second one.
  CONSTRAINT membership_unique_per_conference UNIQUE (conference_id, user_sub)
);

-- Role Assignments are confApp's own per-conference data. They are never derived from a Google
-- Workspace directory group (ADR-002): a directory cannot express "facilitates one workshop,
-- attends the rest".
--
-- The role set has THREE members, not four. Presenter/Facilitator is one role -- the two words
-- describe what the holder is doing, not different permissions (FR5, REQ-025). It is listed here
-- even though this story only ever writes 'Admin', because splitting it later costs a migration
-- and a rewrite of S07.
--
-- Keyed on user_sub, the OIDC subject claim, and on nothing else. No column here keys, joins on,
-- or uniquely identifies a person by email: addresses change and are reissued (app_user).
CREATE TABLE role_assignment (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id uuid        NOT NULL REFERENCES conference (id) ON DELETE CASCADE,
  user_sub      text        NOT NULL REFERENCES app_user (sub),
  role          text        NOT NULL,
  assigned_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT role_assignment_role_known
    CHECK (role IN ('Admin', 'PresenterFacilitator', 'Attendee')),
  CONSTRAINT role_assignment_unique_per_conference UNIQUE (conference_id, user_sub, role)
);

-- The Organizer list (GET /conferences) asks "which Conferences does this sub hold a role for",
-- so the index leads on user_sub. The unique constraints above already cover the
-- conference-first direction.
CREATE INDEX role_assignment_by_user ON role_assignment (user_sub);
CREATE INDEX membership_by_user ON membership (user_sub);

-- Down Migration

-- Dropped in dependency order: both child tables reference conference.
DROP TABLE role_assignment;
DROP TABLE membership;
DROP TABLE conference;
