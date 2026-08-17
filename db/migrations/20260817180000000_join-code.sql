-- Up Migration

-- The Join Code, and the failed-attempt store the limiter counts from.
--
-- Plain PostgreSQL only: no CREATE EXTENSION, no provider-specific types or functions, and no
-- managed cache service anywhere in this path (ADR-003). gen_random_uuid() is core since
-- PostgreSQL 13, not pgcrypto.

-- --------------------------------------------------------------------------------------------
-- conference.join_code
--
-- Nullable, because a Conference has no code until it is published (PRD -> Data Requirements):
-- a draft is visible only to holders of a Role Assignment and there is nothing to circulate yet.
-- The column holds the canonical **uppercase** form; every lookup normalizes the submitted value
-- to that form before comparing, so case-insensitivity is a property of one normalization
-- function rather than of a lower(...) call somebody has to remember at each call site.
-- --------------------------------------------------------------------------------------------
ALTER TABLE conference
  ADD COLUMN join_code text;

-- The alphabet, as a storage-level guarantee: digits 0/1 and letters I, L, O and U are excluded
-- because a person transcribes this code off a slide (https://www.crockford.com/base32.html).
-- The API mints from the same alphabet; this constraint is what keeps a value out of the column
-- through any other path, and it doubles as the length guarantee.
ALTER TABLE conference
  ADD CONSTRAINT conference_join_code_canonical
    CHECK (join_code IS NULL OR join_code ~ '^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$');

-- Unique across **every** Conference row, archived and ended ones included.
--
-- The absence of a WHERE clause here is the whole point and is load-bearing: a partial index
-- scoped to published Conferences would let a code circulated for last year's conference be
-- reissued, and the employee who kept the old slide would silently land in a different
-- Conference than the one the code was printed for (FR3 -> Validation). Drafts are not an
-- exception that needs a predicate either -- a unique index ignores NULLs, so every unpublished
-- Conference coexists without one.
CREATE UNIQUE INDEX conference_join_code_unique ON conference (join_code);

-- --------------------------------------------------------------------------------------------
-- The failed-attempt store.
--
-- One appended row per **failed** attempt, keyed on the authenticated `sub`. Three decisions are
-- pinned here and each has a failure mode that passes a local test and breaks in production:
--
--   *No client address.* There is deliberately no column for one. The venue fronts ~100
--   employees behind a single NAT egress address at exactly the moment of peak joining, so an
--   IP-keyed limiter locks out the scenario the rule exists to protect (FR3, ADR-002).
--
--   *Server-side, not in-process.* The API is a long-running container but scales horizontally
--   with no request affinity (ADR-004), so a module-level counter is per-replica and enforces
--   nothing. The count lives in this table and nowhere else (AGENTS.md -> never rely on
--   in-process state).
--
--   *Append, not increment.* A row per attempt is atomic by construction -- there is no counter
--   to read-modify-write, so ten concurrent failures by one `sub` record ten rows rather than
--   losing increments to a lost update. It also makes window rollover trivially correct: the
--   window is a predicate on `attempted_at`, not a field a handler has to reset.
--
-- clock_timestamp() rather than now(): now() returns *transaction start*, so several attempts
-- inside one transaction would be stamped identically.
--
-- ON DELETE CASCADE: an attempt by a user row that no longer exists is not a fact worth keeping,
-- and it keeps `delete from app_user` a usable teardown.
-- --------------------------------------------------------------------------------------------
CREATE TABLE failed_join_attempt (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub     text        NOT NULL REFERENCES app_user (sub) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The limiter's question is "how many failures for this sub inside the window", which is exactly
-- this index, leading on the key and ordered by time.
CREATE INDEX failed_join_attempt_by_user_time ON failed_join_attempt (user_sub, attempted_at);

-- The retention sweep's question is "which rows are older than the window", across all subs. It
-- runs on every recorded attempt, so it gets its own index rather than a scan.
CREATE INDEX failed_join_attempt_by_time ON failed_join_attempt (attempted_at);

-- Down Migration

DROP TABLE failed_join_attempt;

-- The index and the check constraint belong to the column and go with it.
ALTER TABLE conference DROP COLUMN join_code;
