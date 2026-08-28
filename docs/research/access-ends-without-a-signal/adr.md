# ADR-005: Bound ended access by time, not by a refusal code

**Status**: Proposed
**Date**: 2026-08-26
**Scope**: Identity and access – how an employee's access ends, across the ID token, the stored session, and the offline schedule cache

---

## Context

`docs/specs/conference-setup-and-schedule/prd.md#edge-cases` states: *"Employee leaves the company mid-conference | Google sign-in fails at next token refresh; access ends."* The `offline-session-expiry` feature implemented that literally. Its TI06 classifies the `error` code on a refused silent renewal: `invalid_grant`/`access_denied` mean the grant was refused, so the session is cleared and the offline cache purged; every other code means the Google session merely lapsed, so both stand and the person is asked to sign in again. That split was ratified in the feature's Decisions Log on 2026-08-24.

**The split rests on a distinction that does not exist.** A documentation lookup on 2026-08-26 established:

- Google **does not document** what the authorization endpoint returns for a suspended or deleted Workspace account — not in the OAuth web-server guide, the GIS "Handle Errors" guide, or the RISC page. The implied answer is `login_required`, identical to an ordinary lapsed cookie: OIDC Core §3.1.2.1 requires an error under `prompt=none` when the end-user is not authenticated, §3.1.2.6 defines `login_required` as exactly that, and disabling an account terminates its sessions.
- **`invalid_grant` can never arrive on an authorization redirect.** RFC 6749 §4.1.2.1 defines seven values and does not include it; §5.2 defines it as a *token-endpoint* error; OIDC Core §3.1.2.6 adds nine more and does not include it; Google's own documentation places it under the token endpoint. It is dead code in the classification set.
- **`access_denied` is not a deprovisioning signal**, and Google's Handle Errors guide widens it to cover a user who "is not already authenticated and has not pre-configured consent" — a `prompt=none` case that could fire for a still-employed attendee and purge her cache.
- **The token endpoint is not an oracle either.** It answers `invalid_grant` for many unrelated causes with an undocumented `error_description`, and an auth-code + PKCE SPA doing `prompt=none` never runs a refresh grant, so that path does not exist in confApp at all.
- **Cross-Account Protection (RISC)** — the mechanism Google recommends for precisely this problem — states in writing that it *"does not currently send security events for Google Workspace (formerly G Suite) users."* confApp is Workspace-only by design (ADR-002).

A security review of the whole feature (`.agent_temp/reviews/offline-session-expiry-security-review-claude-2026-08-26.md`) independently found that two individually-correct remediations had composed to make the classification permanently unreachable, and that lapsed cache entries are never deleted. Both are real; but with the above, the classification could never have delivered what the PRD asked for even working perfectly.

### Constraints and dealbreakers

Confirmed with the decision owner:

- **Must not purge on a mere lapse.** An attendee whose Workspace cookie expires mid-conference must not lose her offline schedule — the ratified position, and the scenario the offline feature exists for.
- **No new external dependency or admin credentials.** No Admin SDK integration, no directory-read service account, no polling job.
- **Must not widen offline scope** beyond schedule reads and post-it queueing (`AGENTS.md`).
- A new persisted field on the cache entry was *not* ruled out.

### What is actually cached

One thing: the read-only attendee schedule envelope, keyed `(sub, conferenceId)` — conference name, date span, lifecycle state, and each day's sessions (title, description, kind, start/end time, location, concurrency), plus the server's clock reading at last sync. No post-its, no votes, no workshop group membership. Session content is visible to every attendee anyway; the parts not otherwise public to someone holding the device are **the fact of membership** and, for a conference that has not happened yet, **titles and descriptions of an unannounced internal event**.

### Weighted criteria

| Criterion | Weight | Why it moves this decision |
|---|---:|---|
| Honesty of the resulting spec | 25% | The whole episode came from a specification asserting a capability the protocol does not have. An artifact that keeps claiming it is the primary risk. |
| Bound on a departed employee's cached data | 25% | The requirement being reinterpreted. Must end up with a real, stated bound rather than an implied one. |
| Cost to a still-employed attendee | 25% | Dealbreaker-adjacent. False purges and forced interactive sign-ins attack the feature's own reason to exist. |
| Implementation and reconciliation cost | 15% | Includes amending six spec surfaces and closing two ledger entries. |
| Fit with the existing offline design | 10% | One window predicate, one clock, no widened scope. |

---

## Decision

**Stop trying to detect that access has ended, and bound it by time instead.**

1. **Delete the refusal classification.** `GRANT_REFUSED` is removed. No `error` code on an authorization redirect causes the session to be cleared or the cache purged. The lenient path becomes the only path.

2. **Redefine "access ends" as server-side access ending within roughly one hour.** A suspended account cannot be issued a new ID token; the stored one expires within the hour; `apiRequest` refuses to send an expired token. The API therefore becomes unreachable to a departed employee within the token's remaining lifetime, with no client cooperation required. This was already true and is the only part that was ever enforceable.

3. **Keep the renewal-refusal marker, split by transience.** The durable `confapp.auth.renewalRefused` marker that stops a refused silent renewal from looping is retained, but written **only** for codes that will not resolve on their own — `login_required`, `interaction_required`, `consent_required`, `account_selection_required`. A transient `server_error` or `temporarily_unavailable` no longer latches silent renewal off for the life of the installation.

4. **Evict lapsed cache entries rather than merely refusing to render them.** When the readability window is first observed to have closed, the entry is deleted from IndexedDB.

5. **Bound the window by the earlier of two horizons**: `min(endDate + READABILITY_MARGIN_DAYS, lastSync + SYNC_MARGIN_DAYS)`, with `READABILITY_MARGIN_DAYS = 7` (unchanged, co-owned with `shared-device-session-lifetime`) and a new `SYNC_MARGIN_DAYS = 30`. Both operands come from data already in the entry; no new persisted field is required.

6. **Leave the session's own lifetime to `docs/specs/shared-device-session-lifetime/`**, which this decision promotes from a sibling feature to a load-bearing one: with the classification gone, it is the only mechanism that will ever end a stored session other than an explicit sign-out.

---

## Consequences

### Positive

- The specification stops asserting a capability that does not exist. TI06, S08, part of OC03 and Structural Criterion 4 currently describe an impossible mechanism and are ticked as satisfied.
- Three real bounds replace one imaginary one: token lifetime (server-side access), the readability window (cached data), and the sibling session bound (the stored session).
- A still-employed attendee can no longer lose her offline schedule to a cancelled sign-in dialog or a transient Google error — both live defects the security review found.
- The eleven-month exposure case is cut to about thirty days. Verified against the existing acceptance scenarios: S01, S02, both margin boundaries and the archived-conference case are unaffected.
- Lapsed data is deleted rather than retained indefinitely behind a render gate.

### Negative, and accepted

- **Joining more than 30 days before a conference and never coming online again loses offline access to it.** Verified: joining 25 days early still works, 35 days early does not. This narrows S10's OC01 ("joining online is enough") to a 30-day horizon, and is the deliberate price of bounding SEC-12.
- **A second margin constant** must be kept in step alongside the first. Structural Criterion 5 needs amending to permit it.
- **OC04's distinguishability weakens on the second launch.** Once a lapsed entry is evicted, a later launch can no longer tell "you had this and it expired" from "you never had this" and will say "not available offline". The sign-in-required state still shows on the launch where the lapse is first observed — the one the attendee is actually looking at. Accepted deliberately over a tombstone, which would retain per-conference bookkeeping after deleting the data.
- **Local cleanup is no longer prompt.** A departed employee's stored session and any in-window cached entry persist on the device until the relevant horizon passes or they sign out. Nothing the company does removes them sooner. This is a direct consequence of the missing signal, not of this decision.
- **The window remains advisory against a tampered device clock**, as already recorded under the feature's accepted limitation. A client-side window over client-side storage cannot be made hard by any persisted field; only a server-side check could, and offline by definition has none.

### Neutral

- Two OPEN reconciliation-ledger entries close with the spec amendments this decision requires.

---

## Alternatives considered

**Always purge on any failed silent renewal.** Simple, conservative, and needs no signal at all. **Rejected** on the stated dealbreaker: it costs every attendee her offline schedule whenever a Workspace cookie lapses mid-conference, which is precisely the scenario the offline feature was built for. It scores well on the departed-employee bound and worst of all options on cost to a still-employed attendee — the criterion weighted equally with it.

**Introduce a server-side authority** — Admin SDK Directory API polling or audit-log events, so confApp's own API knows who is deprovisioned and can refuse them with a distinguishable code the client purges on. **Rejected** on the stated dealbreaker (no new external dependency or admin credentials), and on scope: no per-user suspended concept exists anywhere in the API or the schema today, so this is a new field, a new integration, a service account with directory-read scope, and a new failure mode.

A structural objection was raised against it and tested rather than assumed: *a revocation notification requires the client to make a successful authenticated request to receive it, which a deprovisioned user cannot do.* This is **partly refuted** — the stored token stays valid for up to an hour, so there is a real window in which the API could signal the client. The objection holds only after that window. So the option is not structurally impossible; it is bounded to roughly the same hour that token expiry already covers, which is what makes its cost disproportionate rather than its mechanism unworkable.

**Keep the classification as-is.** **Rejected**: it holds one value that can never arrive and one that is not the signal and may false-positive against a still-employed attendee, and the security review showed the branch is unreachable in practice.

**Evict without tightening the window.** Would close the retention finding while leaving a conference eleven months out readable for eleven months. **Rejected** in favour of the 30-day horizon, after an earlier proposal — bounding by `lastSync + 7d` — was found to break S10's OC01 outright by expiring a primed cache before the conference began.

---

## Implementation notes

Not implemented by this ADR. The work is:

- `web/src/auth/session.ts` — delete `GRANT_REFUSED` and the `grantRefused` branch; restrict the `RENEWAL_REFUSED_KEY` write to the four non-self-resolving codes.
- `web/src/offline/readability-window.ts` — add `SYNC_MARGIN_DAYS = 30`; return the earlier of the two horizons.
- `web/src/offline/schedule-data.ts` — evict on the first observed lapse.
- Amend **TI06**, **Acceptance Scenario S08**, **OC03**, **Structural Criterion 4**, **Structural Criterion 5** and the clarification's Decisions Log line, via the ADR-audited `design-change` form.
- Close both OPEN entries in `docs/specs/offline-session-expiry/offline-session-expiry.reconciliation-ledger.md`.
- Record in `docs/specs/shared-device-session-lifetime/` that it is now the only bound on a stored session.

**Risks.** The 30-day horizon is a judgement, not a measurement — if conferences are routinely joined months ahead, it will bite legitimate attendees and should be raised. Eviction is irreversible, so a bug in the window predicate now destroys data rather than hiding it; the predicate's existing fail-closed path should be reviewed for the class of malformed values that currently answer "readable" before eviction is wired to it.

**Confidence**: high on the evidence (documented and specification-level), medium on the 30-day constant (a judgement about joining behaviour that no data currently supports).

---

## Project compliance

- **ADR-002** — unchanged and unchallenged. This decision refines a consequence of it: Workspace OIDC gives no deprovisioning signal to a client, so access must be bounded by time.
- **`AGENTS.md` § Do Not / Never** — no widening of offline scope, no new persisted field, no directory-derived roles, no email as key.
- **`docs/PRODUCT.md` § Anti-Goals** — "Not fully offline" is preserved; this narrows offline reading rather than extending it.

## References

- `docs/research/access-ends-without-a-signal/` — trade-off artifacts (`design-tree.md`, `research.md`, `tradeoff-matrix.md`, `recommendation.md`)
- `docs/specs/offline-session-expiry/offline-session-expiry.md` → `## Implementation Observations` → `#### SETTLED FACT` (evidence base, sources, retrieval date)
- `.agent_temp/reviews/offline-session-expiry-security-review-claude-2026-08-26.md` — SEC-1, SEC-3, SEC-12
- OpenID Connect Core 1.0 §3.1.2.1, §3.1.2.6; RFC 6749 §4.1.2.1, §5.2
- Google — "Using OAuth 2.0 for Web Server Applications"; GIS "Handle Errors"; "Protect user accounts with Cross-Account Protection"
