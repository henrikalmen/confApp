-- Up Migration

-- Session Assignment: which Sessions a Presenter/Facilitator may run and edit.
--
-- Plain PostgreSQL only: no CREATE EXTENSION, no provider-specific types or functions (ADR-003).
--
-- The role model itself needs no change. S03's `role_assignment.role` check constraint already
-- carries exactly 'Admin', 'PresenterFacilitator', 'Attendee', and it stays at three: a
-- Presenter/Facilitator is ONE role, and the two words describe what the holder is doing rather
-- than different permissions (FR5, ADR-002, docs/UBIQUITOUS_LANGUAGE.md). This migration
-- deliberately does not touch that constraint, because widening it is the one way the single role
-- could quietly become two.

-- Needed so `session_assignment` can carry a composite foreign key rather than a bare `session_id`.
-- Without it "conference-scoped" would be a field the application remembers to populate correctly;
-- with it, a row naming a Session that belongs to some *other* Conference is unwritable. `id` is
-- already the primary key, so this index adds a guarantee rather than a new uniqueness rule.
ALTER TABLE sessions
  ADD CONSTRAINT sessions_id_conference_unique UNIQUE (id, conference_id);

-- One row means "this user may run and edit this Session".
--
-- Keyed on user_sub, the OIDC subject claim, and on nothing else. No column here keys, joins on,
-- or uniquely identifies a person by email: addresses change and are reissued (ADR-002,
-- AGENTS.md#do-not--never). An email is at most a *lookup input* the API resolves to a `sub`
-- before anything is written.
--
-- What this table deliberately does NOT reference is `role_assignment`. The grant that makes
-- someone a Presenter/Facilitator is a separate fact from the Sessions they cover, and the API
-- removes a holder's assignments in the same transaction as their revocation. Hanging the FK off
-- the role row would make the assignment disappear as a side effect of an unrelated re-grant.
CREATE TABLE session_assignment (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id uuid        NOT NULL,
  session_id    uuid        NOT NULL,
  user_sub      text        NOT NULL REFERENCES app_user (sub),
  assigned_at   timestamptz NOT NULL DEFAULT now(),

  -- Removed with its Session, and with its Conference: an assignment to a Session that no longer
  -- exists is not a record worth keeping, it is an orphan that would let a deleted Session's
  -- holder pass a scope check against a recycled id.
  CONSTRAINT session_assignment_session_in_conference
    FOREIGN KEY (session_id, conference_id) REFERENCES sessions (id, conference_id)
    ON DELETE CASCADE,

  -- Assigning the same holder to the same Session twice is the same fact, not a second one.
  CONSTRAINT session_assignment_unique_per_session UNIQUE (session_id, user_sub)
);

-- The authorization check asks "does this sub hold an assignment for this Session in this
-- Conference", and the member list asks "which Sessions does this sub cover here". The unique
-- constraint above already serves the first; this index serves the second.
CREATE INDEX session_assignment_by_conference_user
  ON session_assignment (conference_id, user_sub);

-- Down Migration

DROP TABLE session_assignment;

ALTER TABLE sessions
  DROP CONSTRAINT sessions_id_conference_unique;
