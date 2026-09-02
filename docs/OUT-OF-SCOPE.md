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

## Conference-level default Category sets

**Decision**: Rejected as a concept, not deferred. A **Category** belongs to one Post-it Round's
Board and nowhere else. Defining a starting set at conference setup creates a second place
Categories are defined, and with it an inheritance question that has no good answer — whether a
later edit to the conference set propagates into Boards that have already diverged. The saving is a
facilitator typing three words. This closes the question `docs/PRODUCT.md` had carried open since
2026-08-16: *"Are post-it categories defined during conference setup, or created ad hoc by the
organizer while sorting?"* — the answer is neither exactly; they are created on the Board itself.

This covers the concept under any wording — a conference-wide category template, an Admin-managed
default list, a "standard themes" setting, an organisation-level taxonomy. The milder variant
(seeding one Board's Categories by copying another Board's) is a **deferral**, not a rejection, and
stays in the feature's own Not Doing list. _(2026-08-30)_

**Prior requests**:

- `docs/specs/facilitator-board-and-categorisation/requirements-clarification.md` – Discovery &
  Ideation, Category ownership scope, dimension D6 (2026-08-30).

## Attendees choosing a Category when contributing a Post-it

**Decision**: Rejected as a concept, not deferred. Post-its arrive **Uncategorised** and only the
Facilitator/Organizer places them. Offering a contributor a set of buckets while they are writing
anchors their thinking to categories somebody else already decided, which is the opposite of what a
brainstorm is for — and it quietly removes the sorting conversation, which `docs/PRODUCT.md` records
(2026-08-16) as the reason the projected Board View exists at all: *"sorting post-its into categories
is a group activity visible to the room"*.

This covers the concept under any wording — a category picker on the compose form, a default column
selection, tagging your own note, dragging your own Post-it on the Board. Note that this rejection
is what removed the justification for REQ-038's original clause that a Board's layout is editable
only while the Board holds no Post-its: that constraint was load-bearing only if Categories had to
exist before contribution. _(2026-08-30)_

**Prior requests**:

- `docs/specs/facilitator-board-and-categorisation/requirements-clarification.md` – Discovery &
  Ideation, who places a Post-it, dimension D2 (2026-08-30).
