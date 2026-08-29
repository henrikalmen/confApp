# ADR-006: Vote anonymity holds against application paths, not against database credentials

**Status**: Accepted
**Date**: 2026-08-28 · **Amended**: 2026-08-29 (Decision 1 – correlation across successive responses and against out-of-band observation)
**Scope**: Vote storage – the exact reach of confApp's anonymity guarantee, and what the product documents may claim about it

---

## Context

`docs/PRODUCT.md` and `AGENTS.md` both state confApp's load-bearing rule: post-its carry their author's name, votes are anonymous, and vote anonymity is a **storage-level** guarantee rather than a UI convention. The `session-activities` PRD carries it forward as a binding constraint in the strongest available wording: *"A schema that could deanonymize is a defect even with no screen that does."*

The S03 spec designed the storage accordingly – a ballot row holding only the Round and the chosen option, with no voter reference of any kind, and a separate has-voted record enforcing one Vote per Member. On the declared columns, the two tables share only `round_id`, and no application query can join a voter to a ballot.

**A cross-cutting review on 2026-08-28 established that this is not sufficient, and that the spec's stated reason for believing it was sufficient is false.**

- Both rows are written in **one transaction**, so PostgreSQL stamps both with the same `xmin`, and that transaction id is unique to that Member's vote.
- `xmin` is a **system column present on every table**, selectable by any role holding ordinary `SELECT` and usable in `WHERE` and `JOIN`. It needs no superuser, no filesystem access and no backup.
- Therefore one ordinary query available to the API's own database role – joining the ballot table to the has-voted table on `round_id` and `xmin` – returns a complete and exact voter→ballot pairing for every Vote in a Round.
- The S03 spec asserted that such correlation "needs raw table access". That claim is **factually wrong** and was on its way into a migration comment, where it would have stood as a permanent security assurance for future readers.
- The spec's own Structural Criteria were also wrong as written: *"`round_id` is the only column the two tables have in common"* is false (`xmin`, `ctid`, `tableoid`, `cmin`, `cmax` are common to both), and a structure test asserting over **declared** columns passes green against the vulnerability because it never inspects system columns.

### What was considered

| Option | Effect | Cost |
|---|---|---|
| Revoke `SELECT` on the ballot table from the API role; insert and tally through `SECURITY DEFINER` functions owned by another role | Closes the channel against the API's own credentials while keeping one transaction | A second database role, `search_path`-pinned definer functions, friction in migrations and local development |
| Split the two writes into separate transactions | Different `xmin` values | Adjacent transaction ids still correlate strongly in a quiet or sequential poll – exact becomes highly probable, not absent – and atomicity is lost: a crash between the writes either loses a Vote with no retry path or permits a double Vote |
| Replace per-ballot rows with per-option counters | No ballot row exists to join to | No recount or audit trail; Prioritization later wants per-item granularity that would have to be rebuilt |
| **Accept the residual, stated correctly** | Anonymity holds against every application path; a holder of direct database credentials can correlate | The product documents must stop claiming more than the system delivers |

`VACUUM FREEZE` resets `xmin` to frozen and would destroy the correlation permanently, and could be run when a Round closes. It is hardening, not a control: it is asynchronous, needs maintenance rights, and does nothing during the Round while the data is live.

---

## Decision

**Accept the residual, and correct every document that overstates the guarantee.**

1. **The guarantee confApp makes is**: a Vote is unlinkable to its voter **through every application path** – no API response, screen, export, or report can associate them, and no declared column, constraint, index or query available to the application relates them.

   **Amended 2026-08-29 – the guarantee is about what a reader can accumulate, not about what one response says.** As originally written this clause reads in the singular: it asks whether *an* API response associates a Vote with a voter. That framing is too narrow, and two real findings slipped underneath it because neither is visible in any single response:

   - **Correlation across successive responses.** The Session activity cursor advanced on every ballot insert, so a Member polling it learned *when* each Vote arrived. No individual response paired a Vote with a voter; the sequence of responses did the work. See ADR-007, which closes this by removing the ballot trigger.
   - **Correlation with out-of-band observation.** A Session Assignment holder watching the live tally move, in a room where they can see who just acted, can pair a ballot with a voter using information the API never put in a response at all. This one is **inherent to US07's deliberate decision to show the holder a live tally** and is not closed by ADR-007.

   The clause is therefore to be read as: *no application path, and no sequence of application paths, may let a reader accumulate an association between a Vote and its voter that the reader is not already entitled to.* A design that leaks nothing per response but everything over ten responses does not satisfy this ADR.

   Two consequences follow for how this is applied. A signal is judged by **what it lets a reader accumulate over time**, not by its instantaneous content – so making a leaked value opaque addresses only half of it, since a channel has two dimensions, what the value says and when it moves. And **the observer is in the room**: the threat model is a company of under a hundred people who can see each other act, so an out-of-band channel that would be useless against a remote attacker can be decisive here.

2. **The guarantee confApp does not make is**: unlinkability against a holder of **direct database credentials**. PostgreSQL's MVCC system columns correlate the ballot with the has-voted record written in the same transaction, and no schema-level design removes that while keeping the write atomic.

3. **The ballot still carries no voter reference.** This decision changes what is *claimed*, not what is *stored*. The `AGENTS.md` rule – never persist a link between voter identity and ballot – stands unchanged and is still binding.

4. **No document may assert that correlation requires raw table access, superuser rights, or filesystem access.** It requires ordinary `SELECT`. A wrong reassurance in a schema comment is worse than no comment, because the next reader builds on it.

5. **Direct database credentials become the control.** The residual is bounded by who holds them, which is an operational matter rather than a schema one, and is a reasonable place to put it for an internal application under a hundred employees.

---

## Consequences

### Positive

- The documents become true. The previous state – a maximal claim in `PRODUCT.md` and the PRD alongside a schema that does not meet it – was the worst available combination, because it discouraged exactly the scrutiny that found the gap.
- The guarantee that actually matters for the product's purpose survives intact: an attendee's honest answer cannot reach a colleague, a facilitator, the report, or leadership. The threat the anonymity rule was written against is a room full of colleagues, not the ops team.
- The ballot table stays free of any voter column, so the schema remains correct-by-construction against the application, and a future tightening (definer functions or revoked `SELECT`) is additive rather than a redesign.
- Vote atomicity is preserved: no Vote can be lost or double-cast, which a split-transaction posture would have traded away.

### Negative, and accepted

- **A holder of direct database credentials can determine how any individual voted.** This is a real capability, not a theoretical one, and it is now written down rather than implied away.
- **GDPR framing weakens.** `docs/PRODUCT.md` calls anonymity a hard regulatory constraint. It remains hard against application paths; it is now explicitly operational against database access. If a future assessment treats database-holder correlation as a breach of the stated purpose, this decision is the thing to revisit first.
- **The residual is invisible to tests.** No structure test can fail on it, because the correlator is a system column that no schema assertion inspects. It survives only as documentation, which is a weaker guard than a check.
- **It grows with the data.** Every closed Round retains the correlation until frozen or dropped.

### Neutral

- S03's Structural Criteria must be reworded to assert over the surface they actually cover, and must stop claiming `round_id` is the only shared column.

---

## Alternatives considered

Recorded in the table above. The permissions posture (revoke `SELECT`, `SECURITY DEFINER` tally) was the recommendation at decision time and was **not** rejected on its merits – it was judged to cost more machinery than the residual warrants for an internal application whose database credentials sit with one or two people. It remains the natural first step if that judgement changes, and this decision is deliberately shaped so it stays additive.

Splitting the transaction was **rejected**: it degrades the correlation from exact to highly probable rather than removing it, and pays for that with the loss of vote atomicity.

---

## Implementation notes

Not implemented by this ADR. The work is:

- Amend `docs/PRODUCT.md` → Strategic Constraints and the `session-activities` PRD's constraint wording, plus the matching `verbatim` in `plan.json#bindingConstraints[FR4]`, to state the guarantee's actual reach.
- Delete the "needs raw table access" claim from `s03-anonymous-poll-voting-and-result-reveal.md` and from any planned migration comment.
- Reword S03's Structural Criteria 2 and 3 so they assert over declared columns explicitly and do not claim more.
- Record the residual in the migration comment in the terms of this ADR, so the schema itself carries the honest statement.

**Revisit when**: database access widens beyond a small ops group; a formal privacy assessment is run; or a Voting Round is ever used for something an employee could be penalised for, at which point the permissions posture should be reconsidered before the round runs.

## Project compliance

- **`AGENTS.md` § Do Not / Never** – "Never attribute a vote to a voter" is unchanged and still holds: no voter reference is persisted on a ballot. This ADR records that the rule's parenthetical – *"a schema that could deanonymize is a defect"* – is met against application paths and not against direct database access, so the rule is read with that scope rather than silently believed to be broader.
- **ADR-003** – plain portable PostgreSQL only. The residual is a property of PostgreSQL MVCC and would appear on any comparable engine; nothing here depends on provider-specific behaviour.

## References

- `docs/specs/session-activities/prd.md` → Functional Requirements FR4, and Constraints & Assumptions
- `docs/specs/session-activities/s03-anonymous-poll-voting-and-result-reveal.md`
- Cross-cutting review of the `session-activities` bundle, 2026-08-28 – finding C-1
- PostgreSQL documentation, System Columns (`xmin`, `ctid`, `tableoid`, `cmin`, `cmax`)

**Added by the 2026-08-29 amendment:**

- `docs/adrs/ADR-007-vote-arrivals-do-not-advance-the-member-visible-cursor.md` – closes the across-responses channel this amendment names. The out-of-band channel it also names is **not** closed by ADR-007 and remains open, bounded by US07's deliberate choice to show a Session Assignment holder a live tally.
- `docs/specs/session-activities/session-activities-gap-review-claude-2026-08-29.md` – findings G-02 and its sibling, which surfaced both channels
- `db/migrations/20260829120000000_activity-watermark-counter.sql` – the opaque-counter change of 2026-08-29. It removed the microsecond wall-clock reading and stopped the delta equalling a Round's vote count, and its header comment records the residual it left. Read alongside this amendment: that comment argues the residual from the delta's *magnitude*, which is only half the channel, and it should not be read as having closed the change-event half.
