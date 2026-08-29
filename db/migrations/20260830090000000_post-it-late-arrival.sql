-- Up Migration

-- What a Post-it composed with no connection needs the row to carry: whether it arrived after its
-- Round had closed, and the identity of the submission that produced it.
--
-- Plain PostgreSQL only: two ordinary columns and one ordinary unique constraint. No extension, no
-- provider-specific type or function (ADR-003, Binding Constraint FR1).

-- ============================================================================================
-- THE LATE-ARRIVAL MARKER.
--
-- A Post-it typed in a dead spot is held on the device and sent when the signal returns, and the
-- Facilitator may have closed the Round in between. Such an arrival is **accepted and marked**
-- rather than refused: the idea still belongs in the report, and the marking is what keeps the
-- board honest about when it landed (prd.md#decisions-log). A grace window was rejected there -
-- it needs a duration nobody can derive and leaves a second refusal path behind it.
--
-- **Set inside the INSERT, from the Round's own state at the instant of the write**, and never
-- from anything the client sent. There is no client timestamp, no device clock reading and no
-- second open/closed model anywhere in this: `api/src/rounds/post-it-repository.ts` computes it as
-- `r.state <> 'open'` in the INSERT's source query, which is the same discipline the Round-is-open
-- guard already uses (docs/LEARNINGS.md#concurrency: the check *is* the write). A close committing
-- while an arrival waits on the row therefore cannot produce a row whose marker disagrees with the
-- state it was written against.
--
-- `NOT NULL DEFAULT false`, so every row S02 already wrote - and every ordinary live contribution
-- after this - reads as what it is: an arrival while the Round was open.
-- ============================================================================================
ALTER TABLE post_it
  ADD COLUMN arrived_after_close boolean NOT NULL DEFAULT false;

-- --------------------------------------------------------------------------------------------
-- THE SUBMISSION IDENTITY.
--
-- Minted on the device when the Post-it is queued, stored *with* the queued item, and sent
-- unchanged on every attempt - so a send whose response never came back and the retry that
-- follows it are one submission rather than two. "A retried send produces one Post-it, not two"
-- is FR6's own bolded criterion.
--
-- NULL for a live contribution that was never queued, which is what makes the constraint below
-- free: PostgreSQL treats NULLs as distinct in a unique constraint, so any number of live
-- contributions coexist and only queued ones are ever compared.
-- --------------------------------------------------------------------------------------------
ALTER TABLE post_it
  ADD COLUMN submission_id uuid;

-- --------------------------------------------------------------------------------------------
-- AND THE CONSTRAINT THAT MAKES A RETRY HARMLESS.
--
-- **This is the enforcement point, and an application check could not be one.** The API runs as
-- several container replicas with no request affinity (ADR-004, Binding Constraint FR2), so the
-- first attempt at a queued item and its retry may be served by different processes - and a
-- read-then-insert in either of them sees no duplicate, because the other's row is not there yet.
-- Two Post-its under a real name, from one idea. The database is the only place both attempts
-- meet, so the refusal lives here and the route maps it onto the row that is already stored.
--
-- Scoped `(round_id, submission_id)` rather than `submission_id` alone: the identity is minted per
-- queued item, so a collision across Rounds is not a case that arises, and keying on the Round
-- keeps the index aligned with every query that uses it.
-- --------------------------------------------------------------------------------------------
ALTER TABLE post_it
  ADD CONSTRAINT post_it_submission_unique UNIQUE (round_id, submission_id);

-- Down Migration

ALTER TABLE post_it
  DROP CONSTRAINT post_it_submission_unique;

ALTER TABLE post_it DROP COLUMN submission_id;

ALTER TABLE post_it DROP COLUMN arrived_after_close;
