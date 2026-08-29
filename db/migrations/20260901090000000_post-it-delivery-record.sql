-- Up Migration

-- A record of which queued submissions have already been delivered, kept where deleting the
-- Post-it cannot take it away.
--
-- Plain PostgreSQL only: one ordinary table, one composite primary key, one foreign key with a
-- cascade (ADR-003, Binding Constraint FR1). No extension, no provider-specific type or function.

-- ============================================================================================
-- WHY THE IDENTITY CANNOT LIVE ONLY ON THE ROW.
--
-- `20260830090000000_post-it-late-arrival.sql` put `submission_id` on `post_it` and made a retry
-- harmless with `UNIQUE (round_id, submission_id)`. That is correct for as long as the row exists,
-- and it stops being correct the moment the row does not.
--
-- The sequence that breaks it is ordinary. A queued Post-it is sent; the API writes the row; the
-- answer is lost on the way back, so the device still holds the item as undelivered. Its author
-- sees the Post-it on the board, decides against it, and removes it - which is their right while
-- the Round is open (FR3). The row goes, and `submission_id` goes with it. The queue then drains,
-- the constraint finds nothing to refuse, and the withdrawn Post-it reappears on the board **under
-- its author's real name**, with nothing on screen to explain why it came back.
--
-- That is worse than a duplicate. A duplicate is visibly a mistake; this is a deliberate
-- withdrawal being silently undone, and post-its always carry their author (`AGENTS.md`), so the
-- room reads it as something that person chose to say twice.
--
-- The delivery record is therefore kept **separately from the Post-it it produced**, so that
-- "this submission has been dealt with" outlives "this Post-it is on the board". It holds no text,
-- no author and no time: only the fact that a submission identity has been used on a Round.
-- --------------------------------------------------------------------------------------------
CREATE TABLE post_it_delivery (
  round_id      uuid NOT NULL REFERENCES round (id) ON DELETE CASCADE,
  submission_id uuid NOT NULL,

  -- The same key the `post_it` constraint uses, for the same reason: the identity is minted per
  -- queued item, so a collision across Rounds is not a case that arises, and keying on the Round
  -- keeps this aligned with every query that reads it.
  PRIMARY KEY (round_id, submission_id)
);

-- --------------------------------------------------------------------------------------------
-- WHAT IT DELIBERATELY IS NOT.
--
-- **Not a tombstone for the Post-it, and not a soft delete.** S05 rejected a soft-delete model for
-- Sessions outright, and the same reasoning holds here: a withdrawn Post-it is gone, its text is
-- not retained anywhere, and nothing about it can be recovered from this table. What survives is a
-- uuid that means "already used", which is the minimum that closes the hole.
--
-- **Not a contribution.** S05's deletion guard counts `post_it` and `vote` rows, and a row here is
-- neither. A Session whose only Post-it was withdrawn holds no contributions and stays deletable,
-- which is the behaviour that story specified - and the cascade below is what then clears these.
--
-- **Not author-scoped.** A submission identity is minted on a device before anyone knows which
-- credential will eventually send it (a shared tablet may change hands first, S04), so binding an
-- author here would record a guess. The author is enforced on the `post_it` row, from the
-- credential presented on the request that actually wrote it (Binding Constraint FR3).
--
-- The cascade follows `round_option`'s idiom in `20260828090000000_round.sql`: deleting a Round -
-- or the Session that carries it, through the Round's own cascade - clears its delivery records
-- with it. Nothing outlives the Round it belonged to.
-- --------------------------------------------------------------------------------------------

-- Backfill, so the invariant holds from the moment this lands rather than from the next write:
-- every submission already stored on a Post-it has, by definition, already been delivered.
INSERT INTO post_it_delivery (round_id, submission_id)
SELECT round_id, submission_id
  FROM post_it
 WHERE submission_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Down Migration

DROP TABLE post_it_delivery;
