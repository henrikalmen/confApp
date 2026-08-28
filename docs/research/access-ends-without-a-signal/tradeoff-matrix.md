# Trade-off matrix — how access ends

**Decision**: How should confApp decide that an employee's access has ended, given that no client-observable signal distinguishes a deprovisioned Google Workspace account from a merely lapsed Google session?

**Date**: 2026-08-26 · **Weighting**: Balanced (confirmed by the decision owner)

## How to read this

Scores are 1–5, higher is better, multiplied by the criterion weight. **Dealbreakered** options are scored anyway, so the rejection is visible as a judgement rather than an assertion — but a dealbreaker is disqualifying regardless of total.

Dealbreakers set at gate 1: must not purge on a mere lapse · no new external dependency or admin credentials · must not widen offline scope. A new persisted field was explicitly *not* ruled out.

## Criteria

| Criterion | Weight |
|---|---:|
| C1 Honesty of the resulting spec | 25% |
| C2 Bound on a departed employee's cached data | 25% |
| C3 Cost to a still-employed attendee | 25% |
| C4 Implementation + reconciliation cost | 15% |
| C5 Fit with the existing offline design | 10% |

## Options

| # | Option | Summary |
|---|---|---|
| **O1** | **Bound by time** *(chosen)* | Delete the classification; redefine "access ends" as token expiry; split the renewal marker by transience; evict on lapse; window = `min(endDate + 7d, lastSync + 30d)` |
| O2 | Evict only | As O1 but no second horizon — the window stays `endDate + 7d` |
| O3 | Always purge | Any failed silent renewal clears the session and purges the cache |
| O4 | Server-side authority | Admin SDK Directory API tells the API who is suspended; the API refuses them with a code the client purges on |
| O5 | Status quo | Keep the refusal classification as written |

## Scores

| | C1 (25) | C2 (25) | C3 (25) | C4 (15) | C5 (10) | **Total** | Dealbreaker |
|---|---:|---:|---:|---:|---:|---:|---|
| **O1** | **5** | **4** | **4** | **3** | **4** | **4.20** | — |
| O2 | 5 | 3 | 5 | 4 | 5 | 4.35 | — |
| O3 | 4 | 5 | 1 | 5 | 3 | 3.45 | **Purges on a mere lapse** |
| O4 | 3 | 4 | 4 | 1 | 2 | 3.10 | **New dependency + admin credentials** |
| O5 | 1 | 2 | 2 | 5 | 4 | 2.40 | — |

### Note on O2 outscoring O1

On the balanced weighting **O2 scores marginally higher than the chosen option** (4.35 vs 4.20), because it is cheaper (C4) and disturbs the existing design less (C5) while costing a still-employed attendee nothing (C3).

The decision owner chose O1 anyway, having been shown both. That is a deliberate purchase: about 0.15 of weighted score, spent to cut the worst retention case from eleven months to thirty days. Recorded here rather than smoothed over — the matrix did not pick the winner, and pretending otherwise would make the weighting look more decisive than it was.

## Score rationale

**C1 — spec honesty.** O1/O2 score 5: both delete a mechanism the protocol cannot support and force the spec to say what is actually true. O3 scores 4 — honest, but it encodes "we cannot tell, so assume the worst" without saying so. O4 scores 3: it would make the original wording literally true, at the cost of a claim the system only honours for about an hour. O5 scores 1 — the artifact asserts a capability that does not exist and is ticked as satisfied.

**C2 — departed-employee bound.** O3 scores 5 (prompt destruction). O1 and O4 score 4 (30 days; O4 adds prompt destruction but only inside the token window). O2 scores 3 — bounded by the conference, which can be arbitrarily far out. O5 scores 2: bounded only by the window, with the classification unreachable.

**C3 — cost to a still-employed attendee.** O2 scores 5 (no new way to lose access). O1 and O4 score 4 — O1 costs the >30-day joiner, O4 adds an integration that can wrongly refuse. O3 scores 1: it takes the offline schedule away on every lapsed cookie, attacking the feature's reason to exist. O5 scores 2 — `access_denied` can false-positive and purge, and a transient error latches renewal off.

**C4 — implementation and reconciliation.** O5 scores 5 (nothing to do). O3 scores 5 (delete a branch). O2 scores 4. O1 scores 3 — a second constant, eviction, and six spec surfaces. O4 scores 1: new schema field, new integration, service account, new failure modes.

**C5 — fit with the offline design.** O2 scores 5 (one predicate, one clock, unchanged shape). O1 and O5 score 4. O3 scores 3 — turns the cache into something that disappears on an ordinary event. O4 scores 2: introduces a second authority on entitlement and a server dependency into a path defined by not having one.

## Risks per option

| Option | Principal risk | Mitigation |
|---|---|---|
| O1 | The 30-day horizon is a judgement, not a measurement; if conferences are joined months ahead it bites legitimate attendees | Raise the constant; it is one named value, co-located with the first |
| O1 | Eviction is irreversible — a bug in the predicate now destroys data instead of hiding it | Review the predicate's fail-closed path (it currently answers "readable" for several malformed values) *before* wiring eviction |
| O2 | Leaves the retention case open and OC02's wording still implies a short window | Amend OC02's wording regardless |
| O3 | Destroys the feature's value in its own core scenario | None that preserves the option |
| O4 | Two authorities on entitlement that can disagree; a polling job that can silently stop | Out of scope given the dealbreaker |
| O5 | Continues to assert an impossible capability; one live false-positive purge path | None — this is the status quo being replaced |
