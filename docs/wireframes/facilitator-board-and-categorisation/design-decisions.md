# Board surface design decisions

Three decisions settled by drawing the surfaces, recorded here because five later stories cite them
as required context rather than deciding them again. **The three `##` headings below are cited by
S02, S03, S05 and S07 by anchor and must not be renamed.**

Each decision states what was settled, why, and which wireframe demonstrates it. Options that were
considered and not taken are recorded only where a later story would otherwise re-open them.

Wireframes: `docs/wireframes/facilitator-board-and-categorisation/` (`index.html` is the hub).
Requirements: `docs/specs/facilitator-board-and-categorisation/prd.md`.

*Editorial note, 2026-09-02: this file's em dashes were normalised to en dashes across the whole
document to satisfy `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md` (gap review G09). That is the
one respect in which the amendments' "left exactly as it was written" and "byte-intact" claims are to
be read as being about wording rather than about bytes. No word, decision or reason was changed.*

---

## The non-drag placement interaction model

**Demonstrated by**: `facilitator-sorting.html` (validated at 375 / 768 / 1280 px).

**The decision.** A Post-it is placed by choosing its destination by name from a labelled control on
the Post-it itself, and confirming. Every Post-it on the Facilitator's sorting surface carries:

- a visible label naming the Post-it and the act – `Move "The coffee machine on floor 3…" to`;
- a destination control listing **Uncategorised and every Category by name**, with the Post-it's
  current home marked in words (`Tooling gaps — where it is now`);
- a `Move` control that commits it.

The same three keystrokes place a Post-it out of Uncategorised, move it between two Categories, and
move it back to Uncategorised. There is no separate mechanism per direction, and no direction is
reachable only by pointer.

**No drag affordance is drawn at any width, 1280 px included.** The PRD's constraint permits drag as
an *additional* wide-viewport affordance, but S02 and S03 both decline to build it, so drawing a
handle, a drop-target hint or a "drag to sort" instruction would put an unimplementable control into
an artifact five stories treat as authoritative. A wireframe that acquires one is redrawn, not
annotated.

**Category management lives on the same surface and follows the same rule.** Create, rename, reorder
and remove are all non-drag, all keyboard-reachable, and all present at 375 px:

- **Reorder is an explicit control that names its own outcome** – `Move up – to position 1` – and the
  region states its position in words (`Position 2 of 3`). Position is never carried by where a
  region sits on screen: at 375 px the regions are one across, so layout cannot express order at the
  width that decides the interaction model. The control at the end of the order is **marked
  unavailable rather than removed**, so the control set does not change shape as a Category moves.
  It is marked with `aria-disabled="true"` and **not** the `disabled` attribute: a `disabled` button
  leaves the tab order, so the sequence a keyboard user has learned would change shape exactly when a
  Category reaches the end of the order – the opposite of what this control set is for. The control
  stays focusable and is announced as unavailable; the server refuses the press.
- **Removing an occupied Category asks where its Post-its go**, with Uncategorised offered as the
  default, and says they are not deleted. Removing an empty Category has no prompt.
- **Uncategorised carries no rename, reorder or remove control**, and says so in words rather than
  leaving the absence to be read as an oversight. It is not a Category and cannot become one.

**Why.** The 375 px case decides the model (`prd.md#fr3-placing-post-its-into-categories`), and drag
does not survive it – nor does it reach keyboard or assistive-technology users, which is an
accessibility requirement in the PRD's NFR table and not a styling preference. Naming the destination
in a label rather than implying it by position is what makes the same control legible to someone
reading the screen, someone hearing it announced, and someone using it one-handed on a phone.

**What this settles for later stories.** S03 implements placement against this model. S02 implements
Category management against it – including that reorder is a control and not a gesture, and that
Uncategorised is not offered the three Category controls.

---

## The discarded Post-its surface

**Demonstrated by**: `discarded-postits.html`, reached from the toolbar of `facilitator-sorting.html`.

**The decision.** The discarded Post-its of one Board are a **page with an address**, linked from a
permanent entry point on the sorting surface's toolbar – `Discarded post-its (3)` – which is present
whether or not anything has just been discarded. It is not a toast, not a timed undo, and not the
aftermath of the Discard control.

The page shows, for each discarded Post-it on this Board:

- the Post-it's text and **its own author's name**;
- **who discarded it and when** – the trace that is the whole difference between a Discard and an
  author deleting their own Post-it, which leaves nothing at all;
- a per-Post-it restore control that **names its destination in the control itself** –
  `Restore to Uncategorised` – so the rule is read before it is exercised rather than discovered
  after.

The page states the three facts that shape it: a restore returns a Post-it to **Uncategorised** and
never to the Category it was in; a Discard can be reversed **at any time until the Conference is
archived**; and while a Post-it is here it is absent from every other surface – the Board, the
projected screen, every Attendee's phone and its own author's – with no marker and no notification
anywhere.

**Why a page and not an undo.** The reversal window runs to archival
(`prd.md#fr4-discard-and-restore`). A toast or a timed affordance cannot express a window measured in
days, and an undo that expires would quietly convert a reversible act into an irreversible one. The
entry point is permanent for the same reason: a Facilitator who wants something back an hour later
has nowhere to start from if the only route was the moment of discarding.

**What is deliberately absent.** No permanent-removal control, and no wording anywhere on this
surface that reads as deletion or as a removal that cannot be undone. Permanent removal is Admin-only
and belongs to S06; a Facilitator reaching this page must not find the irreversible act sitting
beside the reversible one.

> **Amended 2026-08-31.** The paragraph above is superseded in one respect: a permanent-removal
> control **is** offered on this surface, to an Admin only. Read *Amendment – 2026-08-31: permanent
> removal is offered here, to an Admin only* at the end of this section before implementing against
> the paragraph above.

**What this settles for later stories.** S05 builds Discard, restore and this surface against this
shape. The per-Post-it Discard control that S05 places on the Facilitator's Board is drawn on
`facilitator-sorting.html`: it sits on every Post-it, in Uncategorised and in every Category alike,
is reachable without a pointer, and is visibly distinct from the author's own delete control where
both are offered on the same Post-it.

### Amendment – 2026-08-31: permanent removal is offered here, to an Admin only

*An amendment to the decision above, not a restatement of it. Everything before this heading is what
was settled on the day the wireframes were drawn and is left exactly as it was written; this section
records what building it revealed and what was decided in consequence. Owner decision, 2026-08-31,
during S06.*

**Why it was needed.** The paragraph above kept permanent removal off this page so that a Facilitator
would not find the irreversible act sitting beside the reversible one. S06 implemented that literally
and put its control on the Board's regions only. But S05 had already moved discarded Post-its **off**
the Board, so the one place a Post-it most likely to need removing actually sits – discarded, awaiting
a possible restore – had no control at all. `prd.md#fr5-admin-permanent-removal`'s own OC01 names three
places a Post-it can be when an Admin has to remove it, and "already Discarded" is the third.

The only route left was to **restore first and remove second**: republishing abusive or confidential
text to every Attendee's Board and to the projected room screen on the next poll, in order to take it
away. That is the operational path FR5 exists to prevent, arriving through the very absence this
paragraph asked for.

**The decision.** A permanent-removal control **is** rendered on this surface, per discarded Post-it,
**beside the restore control and never instead of it**. It is gated on the server-supplied
`canRemovePermanently` flag, within this surface's own `canRun` – so an assigned Facilitator without
conference-wide Admin is answered `false` and still sees the restore control alone, exactly the page
the paragraph above describes. Its confirmation names the Post-it's author and states that the act
cannot be undone, so the surface does now carry wording that reads as an irreversible removal – in
one place, behind one flag, behind a confirmation.

**Why the flag and not the absence.** The concern the paragraph above states is still the right
concern; what changed is the mechanism that answers it. The absence protected every Facilitator by
protecting nobody in particular, and it did so at the cost of making the abusive-content case
unreachable without broadcasting the content first. The flag protects exactly the person the concern
is about – the Facilitator with no Admin authority – and leaves the Admin the one route that does not
put the content back in front of the room. Nobody's access widens: `canRemovePermanently` is the same
question the API enforces with, consumed and never re-derived on the client.

**What is unchanged, deliberately.** Restore is still per Post-it, still names Uncategorised in the
control itself, and is still the surface's primary act. The page is still a page with an address and
a permanent entry point, not a toast and not a timed undo. The trace – who discarded it and when – is
untouched. Nothing about the reversal window changes: a Discard is still reversible until the
Conference is archived, and permanent removal is a *different act*, not the expiry of that window.

**What this settles for later stories.** S06 renders the control on both surfaces – the Board's
regions and this page – from one flag, one confirmation component and one wording. Anyone reading the
paragraph above and finding the control on the shipped surface should read this section, not remove
the control.

---

## The projected view's overflow behaviour

**Demonstrated by**: `projected-board-view.html` at the projection viewport class (1920×1080),
populated at the design ceiling – 20 Categories plus Uncategorised, 200 Post-its. Its three states
are `projected-board-empty.html`, `projected-board-unavailable.html` and
`projected-board-stale.html`.

**The decision.** The projected Board is **always exactly one screen**. Nothing pages, nothing
scrolls, nothing cycles, and no input of any kind reveals content – there is nobody at the room
machine to provide any. Two rules produce that:

1. **The Category grid is sized to the number of regions.** Every Category and Uncategorised are on
   screen at once whatever the Board holds. At the ceiling that is a 7 × 3 grid of 21 tiles; on an
   empty pre-Round Board with four Categories it is a 3 × 2 grid of five much larger ones.
2. **Post-it detail is the only thing that degrades.** Each region renders its Post-its at the
   richest of three tiers that lets **all** of them fit its tile, chosen **per Category** – so a
   Category holding two stays rich while its neighbour holding eleven does not:

   | Tier | Applies at | Post-it renders as |
   |---|---|---|
   | Full | ≤ 2 Post-its | Text wrapping freely, author name on its own line |
   | Clamped | 3–4 Post-its | Text clamped to two lines, author name on its own line |
   | Condensed | ≥ 5 Post-its | Text on one line, ending in an ellipsis if it must; author name beside it |

> **Amended 2026-09-01.** Rule 2 now has a floor under it: there is a size below which a projected
> Post-it is not drawn at all. Read *Amendment – 2026-09-01: the legibility floor* at the end of
> this section before implementing against the rule or the table above.

**The ordering of what survives, stated as a rule.** The **Category name, its count and its boundary
never degrade** – they hold the same size whatever the tile holds, because they are what a reader at
the back of the room is actually reading. Below them, **a Post-it's text is the only thing that is
ever clipped**. Its author's name never is: a Post-it always displays its author's name – that is
what a Post-it is – so at the Condensed tier the name keeps its width and the text gives up its tail
instead.

**What "legible at several metres" means here, honestly.** At the design ceiling, what a person at
the back of the room reads is the **structure** – which Categories exist, in what order, and how many
Post-its each holds. Individual Post-it wording at 200-across-20 is legible from nearer the screen,
not from the back row. That is the trade the PRD's own degradation ordering asks for, and it is why
the Category name and count are drawn large and fixed while Post-it text is allowed to shrink and
clip. A typical Board holds nearer ten Post-its per Category, where the Clamped and Condensed tiers
are comfortable; the ceiling is the bound the layout must not break, not the case it is tuned for.
The Facilitator's own surface always shows everything in full, at every width.

**Not taken, and why.** *Paging or auto-cycling* – a Post-it reachable only by waiting is reachable
only by a kind of input the room does not have, and it makes reading unreliable at distance.
*Facilitator-driven focus* – it would make the projected screen a thing the Facilitator drives
moment to moment, and the surface is a mirror of Board state, never a control surface. *Scaling the
whole layout down uniformly* – it degrades the Category name and count, which are the two things
that must not degrade.

**No control appears on this class at all** – not on the populated screen, not on the empty one, and
not on the two failure states. The staleness indicator is a **statement, not a retry button**: it
says the connection is lost, names the time the Board was last true, and says it will catch up on
its own. The unavailable state is one neutral message for revoked, expired, Draft, deleted-Round and
never-existed alike, saying nothing about which.

**What this settles for later stories.** S07 renders the projected surface against this behaviour and
is validated at the projection class, not by enlarging the 1280 px layout. S07 also inherits the
absence of controls and the two failure states drawn here.

### Amendment – 2026-09-01: the legibility floor

*An amendment to the decision above, not a restatement of it. Everything before this heading is what
was settled on the day the wireframes were drawn and is left exactly as it was written; this section
records what building it revealed and what was decided in consequence. Owner decision, 2026-09-01,
during S07.*

**Why it was needed.** Rule 2 is stated as a sentence – each region renders its Post-its at the
richest tier **that lets all of them fit its tile** – with the count-keyed table as its
approximation. At the near-uniform distribution drawn here the two agree. At the distribution a real
sorting session produces they do not: a Category or two accumulate most of the Board, the tier is
chosen from the count, and the rows do not fit. S07 made the sentence binding by capping Post-it type
at the height a row can actually have, which fixed the geometry – but the cap had no lower bound.

At an **in-ceiling but skewed** Board – 200 Post-its across 20 Categories with 80 in one of them –
that cap produced a type size of about **a fifth of a pixel**. The region rendered as a grey striped
band beside a count pill reading 80, while every other tile on the wall read fine at several metres
(`screenshots/display-board-projection-1920-skewed-80.png`). Nothing was unreachable, so the decision
as written above was literally satisfied. The room still got nothing at all from that tile, and worse,
the band reads as a rendering fault rather than as a limit.

**The decision.** A projected Post-it has a **minimum size below which it is not drawn**:

> **0.7 rem – 11.2 px at a 16 px root, at the 1920 × 1080 projection class.**

A region that cannot draw **all** of its Post-its at or above that size draws **none** of them, and
states what it holds in its place – `80 post-its – too many to show at this size` – in type sized like
the tile's own "No post-its yet", well above the floor. Its Category name, its count pill and its
boundary are untouched, exactly as at every tier.

**Why that number, and not another.** Three independent readings land on the same value, which is why
it is the one taken:

- **It is the design's own declared minimum.** The Condensed tier is specified as
  `clamp(0.7rem, 0.7vw, 1.3rem)`, and its lower bound is the smallest size this design has ever named
  for a projected Post-it – the size the tier falls back to on the narrowest viewport it is drawn at.
  Anything below it is a size the type scale never sanctioned anywhere; the cap was inventing sizes
  no tier declares.
- **It is the size at which this decision's own ceiling still renders.** The Board drawn above – 200
  across 20, about eleven to a tile – renders its Post-its at roughly 13.4 px, comfortably clear of
  the floor. So the floor refuses exactly what was never drawn or looked at here, and nothing that
  was. The signed-off ceiling is unaffected by the amendment.
- **It is the size at which the honest claim two paragraphs up is still true.** That claim is that
  individual Post-it wording at the ceiling is "legible from nearer the screen, not from the back
  row". On a 2.4 m-wide projection at 1920 px, 0.7 rem is about 10 mm of character height, which
  reads from roughly two and a half metres – near the screen, not from the back row, precisely as
  claimed. Below the floor the claim is simply false, and a tile that cannot honour it says what it
  holds instead of drawing something nobody in the room can read.

**What is unchanged, deliberately.** This adds no overflow mechanism, because the decision above
forbids one and it was not reopened. Nothing scrolls, nothing pages, nothing cycles, and **no input
of any kind reveals content** – there is still nobody at the room machine to provide any. Rule 1 is
untouched: every Category and Uncategorised are on screen at once, each with its name, its boundary
and its server-supplied count at full size. The degradation ordering is untouched: Post-it detail is
still the only thing that gives way, and a drawn Post-it still never loses its author's name. The
tier table is untouched – the floor sits under it, and does not replace it.

**What it costs, stated plainly.** At the 20-Category ceiling grid a tile holds about **thirteen**
Post-its at the floor; a region holding more states its count instead of drawing it. That is a real
loss of detail, and it is the right one: a Board where one Category has run away is exactly the Board
whose *structure* – which Categories exist, in what order, and how many each holds – is the thing the
room is reading anyway, and that structure is what the amendment protects. The Facilitator's own
surface still shows everything in full, at every width.

**What this settles for later stories.** S07 implements the floor and is validated against it at the
projection class, with a region either side of the line proved separately. The wireframes in this
directory were **not** redrawn: they demonstrate the decision above, and the shipped surface plus its
projection-class captures are the demonstration of this amendment
(`screenshots/display-board-projection-1920-floor.png` for the boundary, `-skewed-80.png` for the
case that prompted it).
