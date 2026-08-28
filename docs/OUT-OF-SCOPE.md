# Out of Scope Registry

<!-- One `## <Concept>` section per rejected concept – match on the concept, not the wording.
     Poisoning rule: never record a request closed as already-implemented. That closure points at the
     implementation; it is not a rejection, and recording it here would falsely block the real feature. -->

## Free-text answers on a Voting Round

**Decision**: Rejected on the anonymity guarantee, not deferred. A typed answer is self-identifying
in a company of under a hundred people – content, writing style, and who is known to be in the room
all narrow it – so allowing one would undo the storage-level unlinkability that is the whole reason
Votes exist as a separate function from Post-its (`docs/PRODUCT.md` → Strategic Constraints, and the
load-bearing rule in `AGENTS.md`). Named free text already has a home: the Post-it Round.

This covers the concept under any wording – a comment box beside a Poll, an "other, please specify"
option, an optional note on a Rating, a free-text reason attached to a Prioritization. Expect it to
resurface when the Rating and Prioritization purposes are specced. _(2026-08-28)_

**Prior requests**:

- `docs/specs/session-activities/requirements-clarification.md` – Discovery & Ideation, poll answer
  shape (2026-08-28).
