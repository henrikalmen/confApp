# ADR-008: Facilitator Discard is stored outside the `post_it` row

**Status**: Accepted
**Date**: 2026-08-31 (proposed and accepted)
**Scope**: Post-it removal – how a restorable Facilitator Discard is stored without weakening the shipped guarantee that an author's own deletion leaves no trace

---

## Context

confApp has, from this story onward, **three** ways a Post-it can leave a Board, and they are three different acts with three different guarantees:

| Act | Who | Guarantee |
|---|---|---|
| **Author deletion** | the Post-it's own author, while its Round is open | leaves **no trace that it existed** |
| **Facilitator Discard** | a holder of sorting authority, at any Round state | leaves **a trace** – who discarded it and when – and is **restorable until the Conference is archived** |
| **Admin permanent removal** (S06) | conference-wide Admin | leaves nothing, and takes any Discard trace with it |

The middle one is new, and it appears to contradict a decision the schema already took explicitly. `db/migrations/20260828120000000_post-it.sql` states, under *What is deliberately absent*:

> any tombstone, soft-delete flag or `deleted_at`. Removing a Post-it leaves *no trace that it existed* (prd.md#edge-cases), which a flagged row would not.

`docs/specs/facilitator-board-and-categorisation/prd.md#constraints` names the tension as a Binding Constraint on FR4 rather than leaving it to be discovered:

> Facilitator-initiated Discard must not reuse the author-deletion path. The shipped `post_it` migration deliberately carries no tombstone, soft-delete flag or `deleted_at`, because author deletion must leave no trace. Discard is a different concept with the opposite requirement; the two must stay apart in storage.

### The contradiction is only apparent

The shipped comment is a statement about **author deletion**, not about every way a Post-it can leave a Board. Its reasoning is that a person who removes their own contribution must not leave a flagged row behind that says an idea was withdrawn – a marker in front of the room reading "somebody took something back" is worse for that person than the Post-it never having been written.

Facilitator Discard has the **opposite** requirement and is asked for by a different person for a different reason. FR4 requires that a Discard *"leaves a trace – it is distinct from the Post-it never having existed – and remains restorable until the Conference is archived"*, precisely because a misdrag in front of the room must not destroy a named colleague's idea.

Both requirements can hold at once **only if the two facts are stored in different places**. A single `discarded_at`-style column on `post_it` would make "no trace" and "a trace" the same storage decision, and any later relaxation of one would silently relax the other.

### The accepted precedent

`db/migrations/20260901090000000_post-it-delivery-record.sql` already established the shape this decision needs: a fact **about** a Post-it, kept outside the `post_it` row precisely so it can outlive that row, with an explicit cascade and an explicit "what it deliberately is not" note. That migration keeps a delivery identity outside the row so that a withdrawn Post-it cannot silently reappear. This decision keeps a Discard trace outside the row so that author deletion's no-trace guarantee is untouched by it.

### Decision criteria

- **The shipped `post_it` migration is not edited and not relaxed.** It is applied; a forward migration is the only permitted mechanism, and its "no tombstone" comment must remain true as written for the act it describes.
- **An author's delete that races a Discard has a *defined* outcome**, and the definition must be provable from the schema alone rather than from a predicate somebody remembered to add to the delete path.
- **Restore is not a second concept.** Reversal must fall out of the storage shape rather than being a write that has to remember where a Post-it used to sit.
- **Plain PostgreSQL** (ADR-003), no in-process state between requests (`AGENTS.md`), and no widening of offline scope.

---

## Decision

**Discard state is stored as one row in a new table, `post_it_discard`, keyed on the Post-it and cascading from it. The presence of the row *is* the Discard; its absence *is* not-discarded.**

1. **`post_it` gains nothing.** No column, no flag, no instant. The shipped migration's *What is deliberately absent* comment stays true for author deletion exactly as written, and `api/test/post-it-structure.test.ts`'s tombstone guard stays green unweakened.

2. **`post_it_id` is the primary key and references `post_it (id) ON DELETE CASCADE.`** That single clause is the whole of the author-delete race outcome: the author's hard delete removes the row, and the database removes the trace with it. `post-it-repository.ts#remove` learns nothing about Discard, keeps its `author_sub` and `r.state = 'open'` guards, and gains no Discard-aware branch. The outcome is provable from the schema rather than from application code.

3. **The primary key is also the idempotence rule.** A second Discard of the same Post-it conflicts on the key and does nothing, so the first discarder and the first instant survive; a restore of a never-discarded Post-it deletes nothing and is a success. Neither needs a read taken first, which two container replicas would each pass.

4. **Restore is the deletion of the trace, and "returns to Uncategorised" is a consequence rather than a rule.** The Discard clears the Post-it's placement in the same statement, and Uncategorised is the *absence* of a placement (`prd.md#fr2-the-uncategorised-holding-area`, `db/migrations/20260902090000000_category-and-placement.sql`). So there is no former Category to remember and no path that could restore one – which is what FR4's *"a restored Post-it returns to Uncategorised, never to the Category it was in"* asks for.

   This holds **only because the placement statement itself refuses a discarded Post-it**. Without the not-discarded conjunct in `post-it-repository.ts#place`'s predicate, a Post-it could be placed while invisible and a later restore would hand it back to that Category.

5. **Exclusion is by anti-join in the statement, never by post-filtering in a handler.** Every read that returns Post-its excludes those carrying a trace. Exactly two reads select *on* the trace's presence: the Facilitator's discarded-Post-its list, and the future Report slice (REQ-023 / REQ-024).

6. **The trace carries `round_id`, pinned to the Post-it's own Round by composite foreign key**, so an `AFTER INSERT OR DELETE` trigger attaches to the shipped `advance_round_activity_watermark()` – which keys on `NEW.round_id` / `OLD.round_id` – rather than restating the advance a second time.

7. **A discarded Post-it still counts as a contribution and still blocks Session deletion.** `countPostItsForSession` keeps no state condition. The guard protects rows that still hold a named colleague's text, and a Discard leaves that text intact and restorable. The delivery-record migration chose the opposite for a *withdrawn* submission because there the `post_it` row is already gone and nothing remains to protect – the same rule applied to different facts.

---

## Consequences

### Positive

- **The two removal paths cannot be confused, because they are not the same storage.** A change that relaxed one could not silently relax the other; they are in different files, different tables and different tests.
- **The race has one answer and the schema states it.** "The author's delete wins and takes the trace with it" is a foreign-key clause, not a code path that could be forgotten in a later refactor.
- **Restore needs no memory.** There is no former-placement column to keep correct, and therefore no way for a restore to put a Post-it back where FR4 says it must not go.
- **Idempotence is free.** Both directions are expressed as the presence or absence of one row.
- **The Report slice is already served.** The trace outlives archival with the Conference, which is what REQ-023 / REQ-024 need, and it is reachable without any read of the Board having to know about it.

### Negative, and accepted

- **Every Board read grows an anti-join.** One extra `not exists` against a table keyed by the primary key it is joining on – cheap, but it is now a thing that must be present on every read that returns Post-its, and a read added later that forgets it will show discarded Post-its. Mitigated by structure guards and by keeping the exclusion inside the shared read seams rather than at call sites.
- **A second table to reason about on deletion paths.** Round, Session and Conference deletion all reach it through the Post-it's own cascade, so no path leaves an orphan – but it is one more row type in the schema.
- **The refusal surface for placement has two sites, not one.** The `place` predicate and `diagnosePlacement` must change together, or a discarded Post-it is refused with the wrong sentence. This is a real sharp edge, is named here so it is not rediscovered, and is pinned by a test that names the discarded case.

### Neutral

- ADR-006 is untouched: nothing on any Discard path reads, joins to, or exposes Vote data. This feature handles Post-its only.
- ADR-007 is untouched: the Discard trace advances the same Member-visible cursor every other Board write advances, and no vote-derived value is involved.

---

## Alternatives considered

| Option | Score against the criteria | Outcome |
|---|---|---|
| **A `discarded_at` / `discarded_by` column pair on `post_it`** | Fails the first criterion outright: it is the one shape the shipped migration explicitly refuses, and it makes "no trace" and "a trace" the same decision. It also puts a Discard-shaped column on the row the author-delete path writes, so the two acts stop being separable in storage | **Rejected** – it is the constraint FR4 names |
| **An `is_discarded` boolean plus a separate audit table for who and when** | Splits one fact across two places, so the row and the audit can disagree; the boolean is still a soft-delete flag on `post_it` and still fails the shipped migration's refusal; and it makes idempotence an update rather than a key conflict | **Rejected** – all of the first option's costs plus a consistency problem |
| **An append-only event log of discard/restore events, current state derived** | Meets the trace requirement, but makes every Board read derive current state from a fold over events (or maintain a projection), and makes idempotence a query rather than a constraint. Materially more structure for a fact that is one bit plus its provenance | **Rejected** – disproportionate; revisit only if Post-it lifecycle grows more states |
| **Move the Post-it row to a `discarded_post_it` table and move it back on restore** | Would keep every Board read unchanged, but the Post-it's id would have to survive a move across tables while `post_it_delivery` and future foreign keys point at it, and an author's in-flight delete would meet no row at all – turning a defined race outcome into a silent no-op | **Rejected** – breaks referential identity and the race outcome |

---

## Implementation notes

The work this decision authorises (S05 TI02–TI07):

- A forward migration creating `post_it_discard` with `post_it_id` as primary key referencing `post_it (id) ON DELETE CASCADE`, `round_id` pinned to the Post-it's Round by composite foreign key, `discarded_by_sub` referencing `app_user (sub)`, and `discarded_at timestamptz NOT NULL DEFAULT clock_timestamp()` – `clock_timestamp()` and never `now()` (`docs/LEARNINGS.md`). A reversible down step, and an `AFTER INSERT OR DELETE` trigger attached to `advance_round_activity_watermark()`. Do **not** edit `db/migrations/20260828120000000_post-it.sql`; it is applied.
- The discarder's display name is joined from `app_user` at read time, never copied – the same rule `post_it` already follows for its author.
- A new module under `api/src/rounds/` owning the discard, restore and discarded-list statements. It is a separate module because `api/test/post-it-structure.test.ts` caps `post-it-repository.ts` at exactly one `count(` and forbids `deleted_at|is_deleted|tombstone|soft` in it; the guard is the module boundary and weakening it to make room is out of bounds.
- The not-discarded conjunct inside `post-it-repository.ts#place`'s existing predicate **and** the matching branch in `diagnosePlacement`, changed together, with `PlacementOutcome` widened for the discarded case.

**Revisit when**: a Post-it acquires a fourth lifecycle state, or the Report slice needs more of a Discard than who and when.

## Project compliance

- **`AGENTS.md` § Do Not / Never** – "Never key a user on their email address": `discarded_by_sub` is the OIDC `sub`, referencing `app_user (sub)`. The display name is joined, never copied.
- **`AGENTS.md` § Do Not / Never** – "Never tie the schema to a managed provider's proprietary features": one ordinary table, one composite foreign key, one trigger attached to a function that already exists. No `CREATE EXTENSION`.
- **`AGENTS.md` § Do Not / Never** – "Never rely on in-process state between requests": the Discard is a row, its idempotence is a primary key, and nothing is retained between calls.
- **`AGENTS.md` § Do Not / Never** – "Never widen offline support beyond schedule reads and post-it queueing": discard and restore both require connectivity and add no queue item kind.
- **ADR-003** – plain, portable PostgreSQL.
- **ADR-006** – untouched; no Discard path reaches Vote data.
- **`plan.json#sharedDecisions` → "Discard state is stored outside the post_it row"** – this ADR is the record of that shared decision, which S06, S07 and S08 consume.

## References

- `db/migrations/20260828120000000_post-it.sql` – the shipped decision this ADR does not relax, and the `advance_round_activity_watermark()` function the trace's trigger attaches to
- `db/migrations/20260901090000000_post-it-delivery-record.sql` – the accepted precedent: a fact about a Post-it, kept outside its row so it outlives that row
- `db/migrations/20260902090000000_category-and-placement.sql` – the placement column whose absence is Uncategorised, which is what makes restore-to-Uncategorised structural
- `docs/specs/facilitator-board-and-categorisation/prd.md#fr4-discard-and-restore` – the requirement
- `docs/specs/facilitator-board-and-categorisation/prd.md#constraints` – Binding Constraint FR4, which names the tension this ADR resolves
- `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md` – untouched by this decision
