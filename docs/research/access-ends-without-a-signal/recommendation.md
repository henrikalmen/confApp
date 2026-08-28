# Recommendation — bound access by time, not by a refusal code

**Date**: 2026-08-26 · **Confidence**: high on the evidence, medium on the 30-day constant
**Outcome**: accepted by the decision owner; formalized as [ADR-005](../../adrs/ADR-005-bound-access-by-time-not-by-refusal-code.md) (Status: Accepted, 2026-08-26)

## In one paragraph

confApp cannot detect that an employee has been deprovisioned, because Google does not tell it: a suspended Workspace account and an ordinary lapsed cookie both come back as `login_required`, the code the current implementation treats as "merely lapsed". The classification TI06 performs is therefore unimplementable in principle, not merely wrong in its code list — and the mechanism Google recommends for this exact problem excludes Workspace users in writing. The recommendation is to stop detecting and start bounding: delete the classification, redefine "access ends" as the ~1h server-side bound that token expiry already enforces, evict lapsed cache entries instead of merely refusing to render them, and cap the offline window by the earlier of `endDate + 7 days` and `lastSync + 30 days`. The stored session's own lifetime passes to `shared-device-session-lifetime`, which this promotes from a sibling feature to a load-bearing one.

## Why this over the nearest alternative

The nearest alternative — evict, but do not tighten the window — **scored marginally higher** on the agreed weighting (4.35 vs 4.20): it is cheaper, disturbs less, and costs a still-employed attendee nothing. It was not chosen. The decision owner elected to spend that margin to cut the worst retention case from eleven months to thirty days, having been shown both scores.

That is worth stating plainly because it is the honest shape of this decision: the matrix did not select the winner. It narrowed five options to two that are close, and the choice between them was a judgement about how much to pay to bound low-sensitivity retained data. Presenting the weighted total as decisive would misrepresent what happened.

## Implementation path

1. `web/src/auth/session.ts` — delete `GRANT_REFUSED` and the `grantRefused` branch; restrict the `RENEWAL_REFUSED_KEY` write to `login_required`, `interaction_required`, `consent_required`, `account_selection_required`.
2. `web/src/offline/readability-window.ts` — add `SYNC_MARGIN_DAYS = 30`; return the earlier of the two horizons.
3. `web/src/offline/schedule-data.ts` — evict on the first observed lapse.
4. Amend TI06, Acceptance Scenario S08, OC03, Structural Criteria 4 and 5, and the clarification's Decisions Log line — via the ADR-audited `design-change` form, not `observations`.
5. Close both OPEN reconciliation-ledger entries.
6. Record in `docs/specs/shared-device-session-lifetime/` that it is now the only bound on a stored session.

**Sequencing constraint.** Do step 3 *after* reviewing the window predicate's fail-closed path. It currently answers "readable" for several malformed values (`NaN` and out-of-range days sort before real dates in the lexicographic compare — security review SEC-14). While the window only gates rendering, that is a disclosure bug; once eviction is wired to it, the same values become a data-destruction bug.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| 30 days is a judgement, not a measurement | Medium | One named constant beside the first; raise it if joining behaviour proves earlier |
| Eviction turns a predicate bug into data loss | Medium | Fix SEC-14 before wiring eviction (sequencing constraint above) |
| Second-launch wording weakens OC04 | Low | Accepted deliberately at gate 3 over a tombstone |
| Local cleanup is never prompt | Low | Inherent to the missing signal; recorded in the ADR rather than mitigated |

## Reconsider if

- **Conferences are routinely joined more than a month ahead.** The 30-day horizon then bites legitimate attendees and should be raised or dropped, reverting to the nearest alternative.
- **Google ships Workspace support for Cross-Account Protection.** That would supply the signal this whole decision routes around, and would make the server-side-authority option cheap rather than disproportionate.
- **The cached payload grows beyond the schedule** — post-it queueing is in the product's offline scope and not yet built. If anything more sensitive than a schedule lands in local storage, the balance between "cost to a still-employed attendee" and "bound on a departed employee" shifts, and this decision should be re-run rather than extended by analogy.
