# Design tree — how access ends

The decision is multi-dimensional: "what replaces the refusal classification" is only one of four independent axes, and the options in the original framing (a/b/c) conflated them.

## Dimensions

**D1 — the refusal classification (what TI06 becomes)**
- D1.1 Delete entirely; the lenient path is the only path
- D1.2 Keep a split, but for *renewal retry* purposes only, never for "access ended"
- D1.3 Keep as written

**D2 — the cached-data bound**
- D2.1 As-is: `endDate + 7d` on the rehydrated clock, render gate only
- D2.2 Evict on first observed lapse (delete, not merely refuse to render)
- D2.3 Tighten: bound also by time since last sync
- D2.4 Tamper-resistant: monotonic high-water mark persisted with the entry

**D3 — the session bound**
- D3.1 Leave to `shared-device-session-lifetime`
- D3.2 Implement a session bound in this feature

**D4 — the renewal-refusal marker (H-1's loop-breaker)**
- D4.1 Permanent until an interactive sign-in
- D4.2 Bounded retry (per launch)
- D4.3 Split by transience — set only for codes that will not self-resolve

## Incompatible or conditional pairings

- **D1.3 is dominated.** The set holds one value that can never arrive and one that is not the signal and can false-positive. Nothing recommends it once the research lands.
- **D3.2 contradicts the feature's own stated boundary** — the FIS's "What We're NOT Doing" defers the session lifetime to the sibling feature explicitly, and implementing it here would couple two features and risk the rejected token-expiry-as-lifetime mistake.
- **D2.4 requires a new persisted field**, which amends Structural Criterion 5. Permitted (not dealbreakered), but the Critic's objection stands: the mark lives in the same IndexedDB record the adversary controls, so it raises effort from a settings change to a devtools edit and stops there.
- **D2.3 has a trap.** The natural formulation `lastSync + 7d` **breaks S10's OC01** ("joining online is enough"): an attendee who joins three weeks before a conference and never comes back online loses the primed cache before the conference starts. Any D2.3 variant must use a horizon long enough not to bite a legitimate joiner — which is what forced the separate 30-day constant rather than reusing the existing margin.

## Surviving candidates

| # | D1 | D2 | D3 | D4 | Name |
|---|---|---|---|---|---|
| **O1** | 1.1 | 2.2 + 2.3 | 3.1 | 4.3 | **Bound by time** *(chosen)* |
| O2 | 1.1 | 2.2 | 3.1 | 4.3 | Evict only |
| O3 | — (purge always) | 2.1 | 3.1 | 4.2 | Always purge |
| O4 | 1.1 + server signal | 2.2 | 3.1 | 4.3 | Server-side authority |
| O5 | 1.3 | 2.1 | 3.1 | 4.1 | Status quo |

D2.4 was offered and declined at gate 2 in favour of D2.2 + D2.3; the limitation it would have addressed remains recorded as accepted under the feature's Implementation Observations.

## The axis that mattered most

Not D1 — once the research landed, D1.1 was forced and uncontested. The live decision was **D2**: how much to spend, and on whom, to bound retained data whose sensitivity is low but non-zero. That is where the two nearest candidates (O1, O2) differ, and where the weighted matrix was closest.
