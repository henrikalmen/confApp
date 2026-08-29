# Trade-off matrix: closing the vote-arrival side channel

**Date**: 2026-08-29
**Decision topic**: How should the vote-arrival side channel in the Session activity watermark be closed, and how should ADR-006 be amended to model it?

## How to read this

Two of the four criteria were set as **gates** rather than weighted dimensions: the user fixed the success bar at *closing* the channel, and near-live Board propagation is a shipped requirement (S03 OC02). An option failing either is rejected outright regardless of how it scores elsewhere. The remaining two criteria – architectural simplicity and implementation cost – were the user's chosen deciders and are what separate the survivors.

Scores are 1–5, higher is better. A `–` means the option was eliminated at a gate and was not scored further; scoring a rejected option invites false precision.

## Gates

| Option | Closes the channel? | Keeps ~5s Board propagation? | Survives? |
|---|---|---|---|
| 1. Split the cursor by authority | Yes | Yes | **Yes** |
| 2. PostgreSQL-backed rate limit | No – slows an observer, does not remove the signal | Yes | No |
| 3. Coarsen or debounce the signal | No – reduces resolution only | Trades directly against the target | No |
| 4. Accept and document | No – by construction | Yes | No |
| 5. Drop the ballot trigger; holder refetches on the shared tick | Yes – no vote-derived value exists to read | Yes – Post-it writes and Round state changes still advance the cursor | **Yes** |

## Deciding criteria (survivors only)

| Criterion | Weight | Option 1 – authority split | Option 5 – drop the trigger |
|---|---|---|---|
| Architectural simplicity | High | **2** – adds a second cursor against `plan.json#sharedDecisions`; the watermark's value becomes reader-dependent, so a role change mid-Session compares two series | **5** – one cursor survives, one fewer trigger, no reader-dependent values; the cursor's meaning narrows to "something a Member may see changed", which is more coherent |
| Implementation and migration cost | High | **3** – new column, migration, trigger repoint, endpoint branching by authority, tests for both audiences, plus the role-change edge case | **4** – one forward migration dropping one trigger, one client condition, inverted assertions; no new column |
| **Weighted outcome** | | **Rejected** | **Chosen** |

## Why the gap is wider than the scores suggest

The numbers understate the difference, and the reason is worth recording separately.

Option 1 leaves a vote-derived value in the system and protects it with an authority check. That is a permanent obligation: every future endpoint, export, report or debug surface that touches the Round row has to re-derive the same check correctly, and getting it wrong re-opens the channel silently. Option 5 removes the value. There is nothing left to guard, so no future mistake can expose it.

That asymmetry – *guarding a secret* versus *not having one* – is the substance of the decision. The criteria scores merely agree with it.

## Risks carried by the chosen option

| Risk | Severity | Mitigation |
|---|---|---|
| Assignment holders refetch the Session each tick rather than on change | Low | Bounded by holder count (typically one or two per Session), not by activity. Rides the existing cadence; adds no timer |
| A holder's tally can lag by up to one tick | Low | Still inside the ~5s propagation target the PRD sets |
| S02's cursor-writer enumeration and S03's TI02 assert behaviour that changes | Medium | Both stories are shipped, so the amendment goes through the ADR-audited `design-change` form rather than a quiet edit |
| Inverted tests could be written to pass vacuously | Medium | Assert the Facilitator's *rendered* tally still moves, not the requests issued – `docs/LEARNINGS.md` records a guard that watched requests and stayed green while the payload was wrong |
