# S07 – The Projected Board View

**Plan**: docs/specs/facilitator-board-and-categorisation/plan.json
**Story-ID**: S07

## Feature Overview and Goal

**Intent**: Sorting only becomes something the room does together if the Board is on the wall where everyone can read it – so the link S04 hands to a projector has to render a Board that is legible at several metres, keeps itself current, and cannot be touched.

**Expected Outcomes** (scenarios anchor to these via `[OC<NN>]`):

- [OC01] A room machine opened on a live Display Link shows that one Board – Categories in the Facilitator's chosen order with their Post-its and their authors' names, Uncategorised alongside, counts on every region – legible at several metres at the design ceiling, with nobody signed in and nobody touching the machine, for a Post-it Round in a Presentation as readily as in a Workshop.
- [OC02] The screen keeps up on its own: placements, Category changes, Discards, restores and permanent removals appear within the near-live window, and a link that has stopped resolving replaces the Board with the neutral unavailable message at the next poll.
- [OC03] The surface is a mirror and nothing else: it offers no input that changes Board state, and no response it can reach carries Vote data, Member data beyond author names, or anything belonging to another Round.
- [OC04] Losing the venue network leaves the last-rendered Board on the wall with a visible staleness indicator, and it resumes on reconnect – nothing is queued from this surface and there is nothing to reconcile.


## Required Context

- `docs/specs/facilitator-board-and-categorisation/prd.md#fr8-the-projected-board-view` – the contract this FIS implements in full: ten acceptance criteria, the Inputs/Outputs (the Display Link value is the *only* input), the two Validation rules, and both Error Handling rules. Read it there; do not work from a restatement.
- `docs/specs/facilitator-board-and-categorisation/prd.md#user-stories` – **US01** is this story's acceptance row: "A Display Link opened on a room machine renders the Board read-only, with author names, without a signed-in session."
- `docs/specs/facilitator-board-and-categorisation/prd.md#constraints` – the constraints that bind this story, applied unnarrowed and at full force. `plan.json#bindingConstraints` carries four entries at this anchor – **FR8**, **FR3**, **FR1** and **FR4** – and each binds this story exactly as worded there; read them there, not from a restatement. FR4 is consumed here as S05's read-exclusion, never re-implemented. Also binding: "No Workspace session on shared hardware", and "Responsiveness is a four-class problem here, not three."
- `docs/specs/facilitator-board-and-categorisation/prd.md#non-functional-requirements` – the rows this story is measured by. `plan.json#bindingConstraints` carries two entries at this anchor – **FR8** (the *Vote anonymity is untouched* row) and **FR7** (the *A Display Link is time-bounded* row) – and each binds this story exactly as worded there. Also binding: the ~5s near-live window; one read per Board with no per-Category request; the ~200 Post-its across ~20 Categories design ceiling; "A Display Link is scoped and powerless"; revocation effective "within the near-live window, at the next poll" with no action on the room machine; the projected view readable at several metres; and *"The projected view is validated as its own viewport class | Validated separately at projection scale – not the 1280 px layout with a larger font."*
- `docs/specs/facilitator-board-and-categorisation/prd.md#edge-cases` – four rows are this story's observable contract: a link revoked while the room screen is open (stops at its next poll, within the near-live window); a Board projected with zero Post-its (shows the empty Board and its Categories – a legitimate pre-Round state); a Board projected with more Post-its than fit one screen (every Category and its count stay visible, Post-it detail degrades before any Post-it becomes unreachable, the surface never requires input to reveal content); and a discarded Post-it being simply absent, with no marker and no notification.
- `docs/specs/facilitator-board-and-categorisation/prd.md#fr7-display-link-issuance-and-revocation` – `plan.json#bindingConstraints` carries the **FR7** Vote-data entry at this anchor, and it binds this story exactly as worded there. S04 implements the link; this story must not widen what it can reach.
- `docs/specs/facilitator-board-and-categorisation/prd.md#open-questions` – the projected-view overflow question, and the fact that it is closed by wireframing at ~200 Post-its rather than decided here. The second open question (Admin overriding Session Assignment generally) is untouched by this story.
- `docs/specs/facilitator-board-and-categorisation/s04-display-link-issuance-and-revocation.md#architecture-decision` and `#implementation-tasks` – the settled resolution contract this story renders through and **adds nothing to**: a 32-byte `randomBytes` base64url token (43 chars) in a `display_link` row with `revoked_at` and a partial unique index (TI01–TI03); one undiscriminated resolvability predicate (TI04); the anonymous `GET /api/display/:token`, third `ANONYMOUS_ROUTES` entry, `Cache-Control: no-store` (TI05); one byte-identical neutral refusal `This board is no longer available.` (TI06); the Board payload for that one Round with nothing vote-derived (TI07); the second Vite HTML input `web/display.html` plus `web/src/display/main-display.tsx` with no `AuthProvider` and no service-worker registration (TI09–TI11); the service worker's `/display/` exclusion (TI12); and the credential-free resolution call in `web/src/api/client.ts` (TI14). **No second resolution path and no second entry point.**
- `docs/specs/facilitator-board-and-categorisation/s02-categories-uncategorised-and-sorting-authority.md#technical-overview` – the Board read projection contract this surface renders: `categories` in the Facilitator's order, each `{ id, name, postIts, postItCount }`; `uncategorised: { postIts, postItCount }` **always present, even when empty and even when `categories` is empty**; counts computed server-side and consumed, never re-derived by a client; Uncategorised carries no id, name or position and is the *absence* of a placement, never a row.
- `docs/specs/facilitator-board-and-categorisation/s05-discard-and-restore.md#technical-overview` – the read-exclusion rule this surface consumes: a Post-it with a `post_it_discard` row is excluded by anti-join **in the statement itself, never by post-filtering in a handler**, from every read that returns Post-its. This surface adds no second filtering site.
- `docs/specs/facilitator-board-and-categorisation/plan.json#sharedDecisions` – the five decisions S07 participates in, all as a **consumer**: the Board read projection contract; the Display Link as an anonymous surface with its own SPA entry point; Discard state stored outside the `post_it` row; wireframes as the source of the interaction model; and *"Board writes advance the activity watermark; the projected view uses none of it"* – the cursor is Session-scoped and Membership-gated, so this surface polls the whole Board instead. Permanent removal (S06) is consumed the same way: a removed Post-it is simply absent from every projected response.
- `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-projected-views-overflow-behaviour` – S01 TI08's third settled decision, *the projected view's overflow behaviour at the design ceiling*, recorded at that stable anchor precisely so this story can cite it. The wireframe it names is `docs/wireframes/facilitator-board-and-categorisation/projected-board-view.html` (S01 TI01/TI04), carrying the populated, empty-Board, link-unavailable and stale-connectivity states. **This is where the overflow mechanism comes from. Do not invent one here.**
- `docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md` – the guarantee this surface must leave exactly as it is. It is not restated on screen and not relied on: this story handles Post-its only, and nothing it adds may read, join to, or expose Vote data.
- `web/src/attendee/staleness.ts#stalenessLabel` – the shipped staleness sentence, coarse on purpose because "what they need to know is whether the screen is current or has quietly stopped updating". `stalenessLabel` takes an age in milliseconds and no clock; the projected surface reuses it and needs no `EffectiveClock`, because its age is the elapsed time between two events on the same machine.
- `web/src/tick/foreground-tick.ts#onForegroundTick` – **the re-render source for the staleness indicator** (TI04), and the reason this story needs no interval of its own: the shipped seam that hangs a second consumer off the one cadence loop's tick, owning no timer, cadence constant or event registration. The indicator must keep advancing precisely while polls are failing, which is exactly when nothing else re-renders this surface. **S08 – this story's W6 parallel sibling – anchors and re-renders its indicator the same way**; the two converge on this one mechanism rather than building it twice.
- `web/src/offline/use-online.ts` – `navigator.onLine` is *a hint, never a gate on rendering*: it stays `true` behind a captive portal and on dead venue wifi. What decides whether this screen is stale is whether the **request** succeeded.
- `web/src/poll/use-watermark-poll.ts` – the one cadence loop: 5s interval, at most one request in flight (a tick arriving while one is outstanding is skipped, never queued), nothing asked while the view is not being read, abort on unmount. "There are to be no more mechanisms – only more call sites." This surface is a third call site; it knows nothing about a watermark and asks for none.
- `web/public/sw.js` – every navigation is filed under one shell key and answered from it, which is why S04 TI12 excludes `/display/`. Nothing in this story may re-cache a projected navigation or a Board response; `Cache-Control: no-store` on the resolution response (S04 TI05) is what makes revocation land at the next poll.
- `visual/session-activities.spec.ts` and `playwright.config.ts` – the shipped viewport-suite pattern: a `VIEWPORTS` table, the API served from fixtures, and an unbroken non-hyphenated token fixture. The three shipped widths are 375/768/1280; this story's class is a **fourth** entry in its own spec, not a fourth row bolted onto that table.
- `docs/LEARNINGS.md#css--responsive-layout` and `docs/LEARNINGS.md#testing` – page-level `scrollWidth - clientWidth` misses text overflowing its own box (compare each element's own `scrollWidth` with its `clientWidth`); a hyphenated token is not an unbroken token; a file-list grep is only as good as its longest omission, so pair every file-list assertion with a behavioural one; never pipe Playwright through `tail`.
- `docs/UBIQUITOUS_LANGUAGE.md#output` – **Board View**, **Display Link**, **Uncategorised** are the canonical terms. "Projector mode", "big screen", "presenter view", "TV mode", "share link", "public link", "inbox", "unsorted category", "default column" and "backlog" are registered synonyms to avoid – in component names, testids, CSS classes and copy as well as in prose.
- `AGENTS.md` – the Do Not / Never list: no fixed-width or desktop-only layout, no vote attributed to a voter, no widening of offline support, no in-process state between requests.


## Deeper Context

- `docs/adrs/ADR-005-bound-access-by-time-not-by-refusal-code.md` – why the link dies with its Session day. S04 implements the bound; this surface only observes it as a link that stops resolving, indistinguishably from a revoked one.
- `docs/adrs/ADR-007-vote-arrivals-do-not-advance-the-member-visible-cursor.md` and `docs/LEARNINGS.md#architecture` – "making a leaked value opaque hides its magnitude, not its change event": part of why the Member-visible cursor is not something an anonymous surface should be able to read.
- `web/src/activities/SessionActivitiesPanel.tsx` – the shipped `Board` component; read for vocabulary and structure, but **do not reuse its layout** – the projected class is a different design, not this one enlarged.
- `web/src/styles.css` – the token set (`--surface`, `--surface-sunken`, `--border`) and the light/dark blocks the projection styles map onto.
- `docs/KEY_DEVELOPMENT_COMMANDS.md#visual-validation` – driving the capture suite against the composed stack or the Vite dev server.


## Acceptance Scenarios

- [x] **S01 [OC01] [TI01,TI09] A room machine opens a live link and projects the full Board at the design ceiling, legibly and with nobody signed in**
  - **Given** a room machine with no Workspace session and no stored credential, and a Board holding 20 Categories plus Uncategorised and ~200 Post-its by named authors
  - **When** the Display Link URL is opened on it at the projection viewport class and nobody touches the machine afterwards
  - **Then** all 20 Categories render in the Facilitator's chosen order with their names, their Post-its and their server-supplied counts, Uncategorised renders alongside with its own count, every Post-it carries its author's name, and no sign-in is offered or required
  - **And** every Category and every count stays visible, any degradation falls on Post-it detail rather than on Category or count visibility, and no scroll, page, tab or other input is needed to reveal content – per S01's settled overflow decision

- [x] **S02 [OC01] [TI01,TI10] An empty Board is a legitimate pre-Round state, and a Presentation projects exactly like a Workshop**
  - **Given** a Post-it Round in a **Presentation** whose Board holds three Categories and no Post-its at all, and the same Board content under a Workshop Session
  - **When** each is projected
  - **Then** both render the three Categories with counts of zero and Uncategorised with a count of zero – an empty Board, not an error, not a spinner and not an "unavailable" message – and the two renderings are indistinguishable

- [x] **S03 [OC02] [TI02,TI07] Sorting on the Facilitator's phone reaches the wall within the near-live window with nobody touching the machine**
  - **Given** the Board is projected and a Facilitator is sorting from her own phone
  - **When** she places a Post-it into "Tooling", renames "Process", discards a Post-it out of "People", restores it, and an Admin permanently removes a different one
  - **Then** each change is on the wall within the ~5s near-live window with the affected counts updated, nobody having touched the room machine
  - **And** the discarded and the permanently removed Post-its are simply absent – no "set aside" marker, no notification, and nothing on the surface filtered them out client-side

- [x] **S04 [OC02] [TI03] A link that has stopped resolving replaces the Board at the next poll, whatever the reason**
  - **Given** four room machines with the Board on screen, whose links are respectively revoked, past their Round's Session day, pointed at a deleted Round, and never issued at all
  - **When** each machine's next poll runs, with nobody touching any of them
  - **Then** all four replace the Board with exactly "This board is no longer available." within the near-live window, no Board content remains rendered on any of them, and none discloses which of the four reasons applied
  - **And** a link whose Conference was still Draft starts rendering the Board on its own once the Conference is Published, with no reissue and no reload

- [x] **S05 [OC03] [TI05] Nothing on the projected screen can change what the Board holds**
  - **Given** the projected surface in each of its four states – populated at the ceiling, empty, unavailable, and stale
  - **When** every element on each state is enumerated and every one that looks interactive is activated by pointer and by keyboard
  - **Then** no element issues any request other than the resolution `GET`, no request is a write verb, no rendered Board state changes as a result, and the staleness indicator is an indicator rather than a retry control

- [x] **S06 [OC03] [TI06,TI08] Nothing the surface can reach carries Vote data, other Members, or another Round**
  - **Given** the linked Round's Session also runs a Voting Round whose Poll holds cast ballots, and carries a second Post-it Round; the Conference holds a second Session, a Join Code, a Membership list and role assignments
  - **When** the projected surface runs through every state it can reach – rendering, refused, and reconnecting
  - **Then** no response it issued carries a tally, an option, a ballot, a vote count or any field derived from one; nothing about the sibling Round, the other Session, the Join Code, the Membership list or any role appears in a payload or on screen; and the only Member data present is Post-it author display names
  - **And** the assertion is made against the response bodies **and** against the display bundle's import graph, because a file-list guard alone is only as good as its longest omission (`docs/LEARNINGS.md#testing`)

- [x] **S07 [OC04] [TI04] Venue wifi dies mid-Session and the wall keeps the last Board with an honest staleness indicator**
  - **Given** the Board is projected and current, and the venue network then fails in the way it actually fails – the link stays up and only reachability is gone, so `navigator.onLine` never goes false
  - **When** several polls in a row fail, and connectivity then returns
  - **Then** the last-rendered Board stays on the wall throughout, a staleness indicator appears and its elapsed age advances, and on the first successful poll the Board updates and the indicator clears
  - **And** nothing was written, queued or reconciled from this surface, and a *refusal* arriving instead of a transport failure replaces the Board rather than being treated as staleness

- [x] **S08 [OC01] [TI09] The projected surface is signed off at its own viewport class, and the 1280px capture does not discharge it**
  - **Given** the shipped visual suite covering 375, 768 and 1280 px
  - **When** the projected surface's validation evidence is assembled
  - **Then** it consists of captures at the projection viewport class for the populated-at-the-ceiling, empty, unavailable and stale states, with no element whose own `scrollWidth` exceeds its `clientWidth` – including a Post-it whose text is an unbroken, non-hyphenated run
  - **And** removing every projection-class capture leaves the story unproven: no 1280px capture, and no 1280px layout at a larger root font size, satisfies it


## Structural Criteria

- [x] The surface reaches the Board only through S04's `GET /api/display/:token` and only through `web/display.html`: no second resolution route, no second SPA entry point, no routing dependency added to `web/package.json`, and no change to `ANONYMOUS_ROUTES`.
- [x] No activity cursor is read: nothing in the display bundle imports, requests or receives `activity_watermark` or the `…/activities/watermark` endpoint, and no cursor, `If-None-Match` or delta parameter is carried between polls.
- [x] No module reachable from the display entry point imports an auth provider, issues a sign-in or token request, registers a service worker, or reaches the offline Post-it queue or the schedule cache – and the shipped `web/test/service-worker.test.ts` shell assertions plus S04 TI12's `/display/` exclusion stay green and unweakened.
- [x] No module reachable from the display entry point, and no field of any response it can receive, is a vote, ballot, tally, option or count derived from one (ADR-006 unaffected).
- [x] Nothing on the projected surface issues a non-`GET` request or a state-changing request of any kind, and no element on any of its four states is a Board-state control.
- [x] No discarded or permanently removed Post-it is filtered out in TypeScript anywhere in this story – the exclusion is S05's and S06's statement-level anti-join, consumed unchanged.
- [x] This story adds no migration, no schema change, no API route and no server-side state; the room machine's poll state is client state and never crosses a request boundary (Binding Constraint FR1).
- [x] No Board response and no projected navigation is cached anywhere – no service-worker entry, no in-memory response cache, no TTL – so `Cache-Control: no-store` remains the whole story.
- [x] The projected surface has its own layout and type scale rather than `web/src/styles.css`'s 1280px rules at a larger root font, and nothing in it is fixed-width.
- [x] Terminology follows `docs/UBIQUITOUS_LANGUAGE.md#output` in component names, testids, CSS classes and copy: Board View, Display Link, Category, Uncategorised – no "projector mode", "big screen", "TV mode", "inbox", "column" or "backlog".


## Scope & Boundaries

### Work Areas

- `web/src/display/` – the projected Board rendering that replaces S04's plain placeholder: Categories in order with their Post-its, author names and counts, Uncategorised alongside, and the empty, unavailable and stale states.
- `web/src/display/` poll call site – the third call site of `web/src/poll/use-watermark-poll.ts`, re-requesting the whole Board with the path token as its only carried state.
- The projection-class stylesheet for `web/src/display/` – type scale, contrast and Category boundaries as their own viewport class, mapping onto `web/src/styles.css`'s token names without inheriting its 1280px layout.
- `web/src/api/client.ts` – the credential-free resolution call from S04 TI14, consumed unchanged; no second call shape.
- `visual/display-board.spec.ts` – the projection-class capture suite, separate from the shipped 375/768/1280 spec.
- `web/test/` – rendering at the ceiling, poll behaviour, the refusal-versus-failure split, the no-input guard, and the no-Vote-data / no-auth import-graph guards.

### What We're NOT Doing

- **Issuing or revoking the Display Link, and everything behind the route** – S04 owns the token, the `display_link` row, the resolvability predicate, the anonymous route, the neutral refusal, the entry point, the nginx and Vite serving rules and the service-worker exclusion. This story renders into all of it and changes none of it.
- **The Category model, placement, Discard, restore and permanent removal** – S02, S03, S05 and S06. This surface reads their output; it writes nothing and re-implements no exclusion rule.
- **The Attendee's live Board** – S08. It is Membership-gated and rides the activity watermark, which is precisely what this surface cannot use; sharing a component between them would drag one of those properties into the other.
- **Any near-live mechanism beyond the shipped cadence loop** – no server-sent events, no websocket, no second interval, no anonymous cursor endpoint. The near-live window is ~5s and a whole-Board re-read of a bounded payload meets it.
- **Any caching, queueing or offline capability on the room machine** – the projected view requires connectivity (Binding Constraint FR3). A lost connection shows the last Board and says so; it does not persist one.


## Architecture Decision

**Approach**: The projected surface is its own component tree under `web/src/display/`, rendering S02's Board projection as returned by S04's `GET /api/display/:token`, re-requesting the **whole Board** on the shipped `useWatermarkPoll` cadence with the path token as the only state it carries between polls – so revocation, expiry, Draft gating and Round deletion all land as the absence of a Board rather than as events to subscribe to.
**Why this over alternatives**: the surface holds no Membership, and the shipped cursor is Session-scoped and Membership-gated (`plan.json#sharedDecisions`), so giving this screen a cursor would mean a second, anonymously-reachable change signal over attributed content – strictly more attack surface than re-reading a payload the PRD already caps at ~200 Post-its every five seconds.


## Technical Overview

**Why revocation and expiry are free.** The surface subscribes to nothing and remembers nothing but its token. Every poll re-asks the same question, and S04's predicate answers it fresh; a link that has stopped resolving simply returns the neutral refusal, so "revocation takes effect without user action on the room machine" is a property of the loop's shape rather than a code path anyone has to remember to write. `Cache-Control: no-store` on the response (S04 TI05) is the other half – anything answering from a copy would defeat it.

**Refusal and failure are different things, and the split is load-bearing.** A *resolved refusal* means the link is dead: the Board is replaced. A *transport failure* means the venue wifi is gone: the last Board stays on the wall with a staleness indicator. Collapsing the two either blanks a working room on a network blip, or leaves a revoked Board projected indefinitely – the two failures this story most has to avoid, from one omission.

**Staleness is local elapsed time, and it advances on the one tick.** The age is the interval between two events on the same machine – anchored on `Date.now()` at the last **successful** poll – so `stalenessLabel` from `web/src/attendee/staleness.ts` is reused directly: no envelope watermark, no `EffectiveClock`, no timezone, no skew correction. The indicator is driven by poll outcomes, not by `navigator.onLine`, because on dead venue wifi the link never drops.

There is a second half to that, and leaving it unsaid makes the indicator a lie: **a label whose age is a function of `Date.now()` does not advance unless something re-renders it, and while polls are failing nothing does.** The re-render source is `web/src/tick/foreground-tick.ts#onForegroundTick` – subscribing to it is therefore not the second interval *What We're NOT Doing* forbids; it is the one cadence with one more consumer. **S08 anchors and re-renders its indicator identically** – both W6, both parallel, deliberately one mechanism rather than two independently-invented ones.

**The fourth viewport class.** Reading distance is metres, there is no pointer, and the content is fixed at the ceiling rather than scrollable – a different design problem from desktop. Layout and overflow both come from S01's projected wireframes and `design-decisions.md`; the standing 375/768/1280 bar does not discharge them.


## Code Patterns & External References

```
# type | path#anchor                                                | why needed (intent)
file   | web/src/display/main-display.tsx                           | S04 TI09's entry: token read from the path, no AuthProvider, no service worker – the mount point this story renders into
file   | web/src/api/client.ts                                      | S04 TI14's credential-free resolution call and the neutral-refusal mapping; reuse, do not add a second call shape
file   | web/src/poll/use-watermark-poll.ts#useWatermarkPoll        | Cadence, one-in-flight, visibility and abort-on-unmount – a third call site, never a second mechanism
file   | web/src/attendee/staleness.ts#stalenessLabel               | The staleness sentence, taking an age in ms and no clock
file   | web/src/tick/foreground-tick.ts#onForegroundTick           | The indicator's re-render source: a periodic nudge off the one tick, with no timer, interval or cadence of its own — the same seam S08 uses
file   | web/src/offline/use-online.ts                              | Why `navigator.onLine` is a hint and never the decision that the screen is stale
file   | web/src/activities/SessionActivitiesPanel.tsx              | Vocabulary and structure to stay recognisable against – NOT a layout to enlarge
file   | web/src/styles.css                                         | Token names and the light/dark blocks the projection styles map onto
file   | visual/session-activities.spec.ts                          | Viewport-suite shape: VIEWPORTS table, fixture-served API, unbroken-token fixture
wire   | docs/wireframes/facilitator-board-and-categorisation/projected-board-view.html | S01 TI01/TI04's projected Board View wireframe and its four states
doc    | docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-projected-views-overflow-behaviour | The settled overflow behaviour at the design ceiling – consume it, do not re-decide it
```


## Constraints & Gotchas

- **Critical**: a failed request and a refused link must not share a branch. A transport failure keeps the Board and raises staleness (TI04); a resolved neutral refusal replaces it (TI03). Getting this backwards either blanks a working wall on a blip or leaves a revoked Board projected until someone notices – Must be handled by: branching on whether the response *resolved*, never on `navigator.onLine` and never on a timeout alone.
- **Critical**: `navigator.onLine` stays `true` on dead venue wifi and behind captive portals (`docs/LEARNINGS.md#offline`, `web/src/offline/use-online.ts`), which is exactly the venue condition this story is written for. It may prompt an extra attempt; it may never decide whether the screen is stale.
- **Critical**: the staleness label ages while nothing is arriving, which is exactly when nothing re-renders this surface. Must be handled by: subscribing to `web/src/tick/foreground-tick.ts#onForegroundTick` – **never a `setInterval`**, which would be the second cadence *What We're NOT Doing* forbids. The seam is not a scheduler and holds no interval; it is the one loop's tick with one more consumer. S08 uses it for the same indicator – do not invent a second mechanism here. Cross-cutting between TI02 and TI04.
- **Critical**: nothing may cache a Board response or a `/display/` navigation. S04 TI12 excludes the path from the shell cache and TI05 sends `Cache-Control: no-store`; adding a client-side response cache or a TTL here would reintroduce exactly the staleness those two exist to prevent, and revocation would stop landing. Cross-cutting between TI02, TI03 and TI08.
- **Constraint**: `useWatermarkPoll` skips a tick while `document.hidden`. A projected tab is visible by definition, so this is correct behaviour here – but it means the surface must refresh immediately on becoming visible again (which the shipped loop already does) rather than waiting out a full interval, and a validation run must keep the page foregrounded or it will read as frozen.
- **Constraint**: counts come from the payload (`postItCount`), never from `postIts.length` – S02 computes them server-side precisely so no surface re-derives them, and a re-derivation would drift the moment the projection ever renders a subset at the ceiling.
- **Avoid**: judging horizontal overflow from the page's `scrollWidth - clientWidth` – an ancestor absorbs the scroll (`docs/LEARNINGS.md#css--responsive-layout`). Instead: compare each element's own `scrollWidth` with its `clientWidth`, and use a camelCase or digit run as the fixture, since a hyphenated token breaks on its own and proves nothing. Applies to TI01 and TI09 alike.
- **Avoid**: `flex-shrink: 0` with a rem `min-width` on a Category or Post-it container – fine at a 16px root, off-screen at 24px. Instead: `min-width: min(Xrem, 100%)` (`docs/LEARNINGS.md#css--responsive-layout`).
- **Avoid**: piping the Playwright run through `tail` – it masks the exit code and eats the `N failed` line (`docs/LEARNINGS.md#testing`). Redirect to a file instead.
- **Constraint**: **five** of the plan's binding constraints have no expression in this read-only surface. **Explicit narrowing note, not a silent one** – each is closed elsewhere, none is dropped. **FR3**'s drag-and-drop rule binds sorting, and nothing here sorts (S03, over S02's model). **FR6**'s "actor identity always taken from the credential" binds authenticated writes; this surface has no credential and no actor (S02 TI06, S03 TI02, S04 TI08, S05 TI04, S06 TI03). **FR5**'s Admin-only permanent removal is enforced server-side (S06 TI03); S07 renders only the resulting absence. **FR4**'s Discard-storage separation is S05's; S07 consumes its read-exclusion and adds no storage. **FR1**'s plain-PostgreSQL half has nothing to bind to, since this story adds no schema (S02 TI01, S04 TI01, S05 TI02); its no-in-process-state half is honoured by adding no server-side state at all – the poll's state lives on the room machine, which is a client and never a request.
- **Constraint**: the projection viewport class is the one **S01 recorded (1920×1080)**, and S01's overflow decision is taken as given. The PRD requires a distinct fourth class and legibility at several metres but names no pixel size; re-deciding either here would split the wireframe from its implementation. Take the decision from `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-projected-views-overflow-behaviour` – S01 TI08 pins that heading and slug verbatim and its Verify asserts them – as demonstrated by `projected-board-view.html` in the same directory. Do not invent an overflow mechanism, and do not close the PRD's open question here.
- **Constraint**: a permanently removed Post-it leaves this surface for free – S06 removes the `post_it` row itself, so it disappears from S02's Board projection with nothing added here. TI07's second half proves the behaviour rather than implementing it.


## Implementation Plan

### Implementation Tasks

- [x] **TI01** The projected Board renders S02's Board projection at projection scale as its own viewport class
  - Under `web/src/display/`, mounted by S04 TI09's `main-display.tsx`. Categories in payload order with their names, Post-its, author display names and `postItCount`; `uncategorised` always rendered, even when empty and even with no Categories. Layout, type scale, contrast, Category boundaries and the overflow behaviour at the ~200/~20 ceiling all come from S01's projected wireframe and `design-decisions.md` – not from `SessionActivitiesPanel.tsx` at a larger root font.
  - **Verify**: `Test: a payload of 20 Categories plus Uncategorised and ~200 Post-its renders every Category name and every count with no element requiring input to become visible and no Post-it unreachable; a payload with no Categories and no Post-its renders the empty Board with Uncategorised at zero; counts render from postItCount and not from postIts.length`

- [x] **TI02** The surface reaches the Board only by re-requesting the whole Board on the shipped cadence, holding no Membership and no cursor
  - A third call site of `web/src/poll/use-watermark-poll.ts` (one cadence, one request in flight, skip-don't-queue, abort on unmount), calling S04 TI14's credential-free resolution call in `web/src/api/client.ts`. The path token is the only thing carried between polls: no watermark request, no cursor or delta parameter, no response cache, no second interval.
  - **Verify**: `Test: the mounted display issues repeated resolution GETs on the shared interval with at most one in flight and no Authorization header; it issues no request to any activities or watermark endpoint; a Board changed between two polls is on screen after the second`

- [x] **TI03** A link that has stopped resolving replaces the Board with the neutral message at the next poll
  - Consumes S04 TI06's single undiscriminated refusal – the client branches on the refusal itself and has nothing to branch on for *why*. Renders exactly `This board is no longer available.` and removes all Board content. A Draft Conference's link needs no special handling: it simply starts resolving once Published.
  - **Verify**: `Test: with a Board rendered, a poll returning the neutral refusal replaces it with exactly that sentence and leaves no Category, Post-it, count or author name rendered; revoked, past-day, deleted-Round and never-issued cases are indistinguishable on screen; a link that begins resolving mid-session renders the Board with no reload`

- [x] **TI04** A failed poll keeps the last Board with a staleness indicator, and a refusal is not a failure
  - Depends on TI02 for the loop and TI03 for the refusal branch. A transport failure leaves the last-rendered Board and shows `stalenessLabel` from `web/src/attendee/staleness.ts` over the elapsed time since the last **successful** poll; a resolved refusal replaces the Board instead. `navigator.onLine` may prompt an attempt and never decides (`web/src/offline/use-online.ts`). The indicator is an indicator, never a retry control, and nothing is queued or reconciled.
  - The age is anchored on the device's `Date.now()` at the last successful poll, and the label is **re-rendered by subscribing to `web/src/tick/foreground-tick.ts#onForegroundTick` – never a timer of its own**. Without a named re-render source the label freezes at the last success; with a `setInterval` it is the second cadence *What We're NOT Doing* forbids. S08's TI06 consumes the same seam for the same indicator.
  - **Verify**: `Test: with requests failing while navigator.onLine stays true, the Board stays rendered and the indicator's age advances across successive shared ticks; on the first successful poll the indicator clears and the Board updates; a refusal replaces the Board even while offline reads as true; no display source creates a setInterval or setTimeout; no write, queue entry or cache entry is produced from this surface`

- [x] **TI05** The projected surface offers no input that changes Board state
  - Applies to all four states from TI01, TI03 and TI04. Nothing rendered issues anything but the resolution `GET`; the staleness state carries no retry button (S01's projected wireframes settle this).
  - **Verify**: `Test: enumerating every element across the populated, empty, unavailable and stale states yields none whose pointer or keyboard activation issues a non-GET request, any request other than the resolution GET, or any change to rendered Board state`

- [x] **TI06** No response the surface can reach carries Vote data, Member data beyond author names, or anything from another Round
  - Consumes S04 TI07's projection rather than widening it; asserted here at the surface, over both the received payloads and the rendered tree. Written as a paired module-graph plus behavioural assertion, because a file-list guard is only as good as its longest omission (`docs/LEARNINGS.md#testing`).
  - **Verify**: `Test: with a Poll holding cast ballots and a second Post-it Round in the same Session, no field of any response the display issues is a tally, option, ballot or vote-derived count, nothing from the sibling Round or a second Session renders, the only Member data present is author display names, and the display bundle's import graph reaches no vote or ballot module`

- [x] **TI07** Discarded and permanently removed Post-its are absent from the projected Board, with no client-side filtering
  - Consumes S05's statement-level anti-join and S06's permanent removal; this surface filters nothing in TypeScript and shows no marker, badge or notification for either.
  - **Verify**: `Test: a Post-it discarded between two polls is gone at the next poll with its Category's count fallen, and likewise for a permanently removed one; no display source filters a Post-it out of a result set or renders a discarded/removed state`

- [x] **TI08** The display bundle carries no auth, no service worker, no offline queue and no schedule cache
  - S04 TI09 established the entry point with none of them and TI12 excluded `/display/` from the shell cache; this task guards that adding the rendering did not reintroduce any of it, and that no second entry point or resolution path appeared. Structural guard in the register of `api/test/post-it-structure.test.ts`, paired with a behavioural assertion.
  - **Verify**: `Test: the display entry's import graph reaches no AuthProvider, sign-in call, service-worker registration, offline queue or schedule cache; web/package.json gains no routing dependency; ANONYMOUS_ROUTES is unchanged by this story; the shipped service-worker shell assertions stay green and a /display/ navigation still leaves the cached shell untouched`

- [x] **TI09** The projected surface is captured and signed off at its own viewport class
  - New `visual/display-board.spec.ts` following `visual/session-activities.spec.ts` (API from fixtures, its own `VIEWPORTS` entry at the projection class S01 recorded), covering the populated-at-the-ceiling, empty, unavailable and stale states. Deliberately a separate spec from the shipped three-width suite. Compare each element's own `scrollWidth` with its `clientWidth`, include an unbroken non-hyphenated token fixture, and do not pipe the run through `tail`.
  - **Verify**: `Test: a projection-class capture exists for each of the four states with no element whose own scrollWidth exceeds its clientWidth, including a Post-it whose text is an unbroken non-hyphenated run; deleting the projection-class captures fails the story, and no 375/768/1280 capture satisfies it`

- [x] **TI10** A Post-it Round in a Presentation projects exactly as one in a Workshop
  - No Session-kind branch exists on this surface; the projection is of a Board, and a Board belongs to a Post-it Round in either Session kind (`docs/UBIQUITOUS_LANGUAGE.md#output` → Board View).
  - **Verify**: `Test: the same Board payload under a Presentation Session and under a Workshop Session renders identically, and no display source reads or branches on session kind`

### Testing Strategy

- **[TI04] Drive staleness by poll outcome, never by `navigator.onLine`.** The venue failure this story is written for keeps `onLine` true, so a test that toggles `onLine` proves nothing about the real case. Fail the requests instead and leave `onLine` true.
- **[TI06,TI08] Pair every import-graph assertion with a behavioural one that does not know the file list** (`docs/LEARNINGS.md#testing`). The vote guard also needs a Session that genuinely holds a Poll with cast ballots, not a fixture that merely omits the field.
- **[TI09] Assert rendered geometry, not the requests issued** – and revert each guarded property to confirm the guard actually falls before believing it (`docs/LEARNINGS.md#testing`).

### Validation

- **The standing 375/768/1280 visual gate does not discharge this story.** The projection-class captures from TI09 are the evidence; signing this surface off on the 1280px capture, or on the 1280px layout at a larger root font, is an explicit failure (`plan.json#executionNotes`, `prd.md#non-functional-requirements`).
- **Legibility at several metres is judged on the capture**, not inferred from a pixel count or a font-size value.

### Execution Contract

- TI01 and TI02 land first and independently; TI03 depends on TI02's loop, and TI04 depends on both TI02 and TI03 – the refusal-versus-failure split cannot be written before both branches exist.
- TI05, TI06, TI07 and TI08 are guards over the surface TI01–TI04 produce and follow them.
- TI09 is last: the capture is of the finished four states, and capturing early produces evidence for a surface that no longer exists.
- This story starts only once S04's entry point, resolution route and service-worker exclusion are landed, and S06's permanent removal is in place for TI07's second half.



## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

### Run: 2026-08-30 21:14 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

_Propagated by the exec-plan wave triage from S02 (2026-08-30) – not authored with this story._

- **Do not inherit the SPA's absent-Board default.** `web/src/api/client.ts` defaults a missing Board with `round.uncategorised ?? { postIts: [], postItCount: 0 }`, which renders the Uncategorised region with a count of 0 and the "this round collected no post-its" copy for a payload that never claimed a Board – a positive assertion the API deliberately declines to make by omitting the keys. It is unreachable through `fetchSessionActivities`, which always supplies the Board for a Post-it Round, but this story reads the same type from a different endpoint where an absent Board is reachable. Distinguish "no Board in this payload" from "a Board with nothing on it"; do not copy the `??` fallback.
- **The unlisted-Category fallback holds for every Board read.** A Post-it whose Category is absent from the same Board read renders in **Uncategorised**, never dropped. The Session read takes Categories and Post-its as two statements inside one `Promise.all` with no transaction between them, so a Category removed between the two leaves the Post-it snapshot naming a Category the Category snapshot no longer lists. Grouping strictly by id puts such a Post-it in *neither* bucket, contradicting `prd.md#fr2-the-uncategorised-holding-area`'s invariant that a non-discarded Post-it is in exactly one Category or in Uncategorised, never neither. Established and proved by S02 (`api/test/category.integration.test.ts`, "renders a post-it in uncategorised when its category is removed mid-read"). Any read this story adds over the Board must preserve it.

### Run: 2026-08-31 14:01 UTC – discovered-requirements

#### DISCOVERED REQUIREMENTS

_Found during S07's implementation (2026-08-31), each appended before the test and code that depend on it._

- **The projected Board's overflow rule is S01's *sentence*, not S01's *table*.** `design-decisions.md#the-projected-views-overflow-behaviour` states the invariant as "each region renders its Post-its at the richest of three tiers that lets **all** of them fit its tile", and then gives a count-keyed table (`≤2 full`, `3–4 clamped`, `≥5 condensed`) as its approximation. At the near-uniform distribution S01 drew (16 Categories of 11, plus 2/3/4/4), the two agree. At the distribution a real sorting session produces – one or two Categories accumulating most of the Board – they do not: with 200 Post-its still across 20 Categories, a `[40, 20, 15, …]` split pushed 39 Post-its out of their tiles and `[80, 10, 8, …]` pushed 76, of which 35 left the screen entirely. On a surface with no scroll, no pointer and no input, those Post-its are unreachable, which is the one outcome `prd.md#edge-cases` and Acceptance Scenario S01 exist to prevent. **The tier still comes from the count; the type within it is then capped by the height a row can actually have**, so all of them fit (`web/src/display/display.css`, `--display-rows` / `--display-row-height`). The Category name, its count and its boundary are unchanged at every tier, and a Post-it never stops showing its author – S01's degradation ordering is preserved exactly. Worth reconciling into `design-decisions.md` so the table is read as the approximation it is.
- **A region's overflow must be contained inside its own boundary.** `.display-region__body` had no `overflow` rule, so a region holding more than fitted painted its surplus rows *through the tile below it* – a ghost Post-it over a neighbouring Category, attributed to neither. Containment is the floor under the fit rule above, not a substitute for it.
- **The staleness band must cost no content at the design ceiling.** When the band appears, every tile in the grid shrinks by its height. The Post-it author line was inheriting `styles.css`'s `line-height: 1.5` – a reading-at-arm's-length figure – and those fractions were enough to push the last row's Post-its out of their tiles the moment the venue network dropped. Line heights on the projection class are set, never inherited, and the stale state is measured with the same geometric reading as the populated one.
- **The projected surface must reach the transport without reaching the endpoints.** Importing `web/src/api/client.ts` for one anonymous `GET` put `castVote`, the Join Code helpers and every other authenticated endpoint into the 200 KB shared chunk a room machine downloads – so the Structural Criterion "no module reachable from the display entry point is a vote, ballot, tally or option module" was not true in fact, while both guards (file names, and `web/src/display/*` sources) passed. No vote data was ever exposed: the route returns none and the surface holds no credential, so ADR-006 was untouched throughout. The transport is now `web/src/api/request.ts` and the Board projection `web/src/api/board.ts`; `client.ts` re-exports both, so no other importer moved. The guard is now over the **built chunk graph** the display document actually loads, not the entry chunk alone.
- **A shape guard must cover every half the renderer reads.** `isDisplayBoard` checked `prompt`, that `categories` is an array, and that `uncategorised.postIts` is an array – and no `postItCount` and no Category element shape. A payload missing the counts therefore passed the guard that exists to refuse a payload "rather than filling it in", and reached the surface whose most prominent, never-degrading element *is* the count: the room would have read an empty pill and a band saying `NaN post-its`.

### Run: 2026-08-31 14:02 UTC – observations

#### NOTICED BUT NOT TOUCHING

- `npm run format:check` reports pre-existing Prettier drift in four files this story does not touch: `api/test/display-link.integration.test.ts`, `api/test/join-code.test.ts`, `visual/conferences.spec.ts`, `web/src/components/JoinCodePanel.tsx`. Left alone – surfacing, not fixing. **Corrected 2026-09-02 (gap review G10):** only **three** of those files are long-standing – `api/test/join-code.test.ts`, `visual/conferences.spec.ts` and `web/src/components/JoinCodePanel.tsx`, named as pre-existing by S01 before this bundle wrote any code. `api/test/display-link.integration.test.ts` was **created by S04 in this bundle** and was never pre-existing; each story's per-story "not mine" rule was individually true and collectively wrong, with no bundle-scope backstop. It has been formatted, and `npm run format:check` now reports the three long-standing files only.
- S01's stale wireframe (`docs/wireframes/facilitator-board-and-categorisation/projected-board-stale.html:266`) renders the staleness detail as a **wall-clock time** – "Showing the board as it stood at 15:12". The FIS overrides that specific wording (Technical Overview → "Staleness is local elapsed time"; Required Context → `web/src/attendee/staleness.ts#stalenessLabel`), because a time of day would need a timezone the product deliberately does not carry. The implementation therefore reads "Updated 3 minutes ago. It will catch up on its own when the connection returns." The wireframe and `design-decisions.md` still describe the wall-clock wording and were not edited.
- An **answered 5xx** from confApp's own API replaces the Board with the neutral sentence for one poll interval. That is S04's settled decision consumed unchanged (`web/src/display/DisplayBoardView.tsx`, review 2026-08-31 L5 – a server's own words must never reach a wall in front of a room), and S07's poll is what makes it self-healing rather than permanent. Recorded because it is the one case where a *working* link's Board is briefly replaced.
- The projected count now renders as the **bare number** in a pill, per S01's projected wireframe (`.tile__count`), where S04's placeholder rendered "N post-its". `web/test/DisplayBoard.test.tsx` and `visual/display-board.spec.ts`'s three-width block were updated to match; the phrase survives as the count's `aria-label` and in the head band's "200 post-its · 20 categories".
- `web/test/watermark-poll.test.tsx`'s deliberately-exact call-site register gained a fourth entry (`/display/DisplayBoardView.tsx`). The register's own note says a growing call-site list is not the thing to be afraid of – the singular *implementation* is what its other assertions hold, and those are untouched.
- The display entry point's import-graph walk in `web/test/display-structure.test.ts` originally matched single-quoted imports only, so a double-quoted import would have escaped the closure guard invisibly. Widened to both quote styles and re-falsified. Noted because `api/test/display-link-structure.test.ts#reachableFromDisplayRoute` – the API-side walk this one was modelled on – still has the single-quote form.
- The fresh-context code+gap review's report is at `.agent_temp/reviews/facilitator-board-and-categorisation-s07-mixed-review-claude-2026-08-31.md`, with its skewed-Board evidence capture beside it. Its two HIGH and two of its three MEDIUM findings were remediated in this run (see this run's Discovered Requirements); **M1 was deliberately not changed**. M1 observes that any answered 5xx – an API rollout, a database blip, an nginx 502 – replaces every projected wall with "This board is no longer available." for one poll interval. That is S04's settled decision (a server's own words must never reach a wall in front of a room) consumed unchanged, and the FIS's own Critical constraint says to branch on whether the response *resolved*. S07's poll is what turns it from permanent into ≤5s and self-healing. Reversing it – refusing on `DISPLAY_LINK_UNAVAILABLE` alone and routing every other answered failure into the staleness branch – would keep the Board on the wall and still never render server text, and is worth a decision rather than a quiet change here.
- `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-projected-views-overflow-behaviour` now under-describes the shipped surface in two ways, neither edited by this story: its tier table reads as the rule where the sentence above it is the rule (see this run's first Discovered Requirement), and it lists four projected states where six ship – the cold-start unreachable screen and the first-paint loading screen are genuinely reachable on a room machine and are now captured at the projection class, but S01 never drew them.
- The two extra states are captured as `docs/wireframes/facilitator-board-and-categorisation/screenshots/display-board-projection-1920-unreachable.png` and `-loading.png`; the skew evidence as `-skewed-40.png` and `-skewed-80.png`. (Paths corrected 2026-09-02: the four captures were committed under the wireframe directory's `screenshots/` un-ignore; they were previously cited against the gitignored repo-root `screenshots/`.)

### Run: 2026-08-31 14:20 UTC – observations

#### NOTICED BUT NOT TOUCHING

- **OPEN – needs a design call on S01's decision, not a code change.** A second-pass review (`.agent_temp/reviews/facilitator-board-and-categorisation-s07-remediation-quick-review-claude-2026-08-31.md`, finding F1) measured the fit rule at heavier skews than the ones this story guards. The **geometry** now holds everywhere inside the ceiling – `[40, …]`, `[80, …]` and `[150, …]`, all 200 Post-its across 20 Categories, all contained, nothing off-screen, proved by three guards in `visual/display-board.spec.ts` that each fall when the rule is reverted. The **legibility** does not: the type cap has no floor, so at 80-in-one-region the Post-its are drawn at ~0.2px and the tile reads as a grey band beside a count pill of 80 (`docs/wireframes/facilitator-board-and-categorisation/screenshots/display-board-projection-1920-skewed-80.png`). Nothing is unreachable in the geometric sense the decision states, and nothing is readable either.
  - This was **deliberately not settled here**. Giving the cap a floor means deciding what a region does with the Post-its it then cannot draw, and every answer – a minimum type size with an "N not shown" line, a fourth tier, a distribution-aware grid – is a new overflow mechanism. `docs/specs/facilitator-board-and-categorisation/s07-the-projected-board-view.md#constraints--gotchas` forbids exactly that: *"Do not invent an overflow mechanism, and do not close the PRD's open question here."*
  - What it needs: an amendment to `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-projected-views-overflow-behaviour` naming a minimum legible type size and what a region says about the Post-its below it, then a change here to match. The PRD's open question on projected-view overflow is the right place for it.
- The same review's **F3** stands unclosed for the same reason: `design-decisions.md` now under-describes the shipped surface in three ways – the type-cap mechanism it does not mention, four drawn states against six that ship, and a wall-clock staleness sentence against the elapsed age the FIS mandates. All three are recorded here; none is edited, because the wireframe record is S01's.
- The gap term of the fit rule **was** a mechanical defect and is fixed: each tier's inter-row gap is a viewport-width `clamp()` that knew nothing about how many rows shared the tile, so past about a hundred rows the gaps alone exceeded the tile and pushed the Post-its back out of it. It is now capped at a quarter of the tile body, and `[150, 4, …]` is a guard that falls without the cap.

### Run: 2026-09-01 – owner decision (the legibility floor)

#### OWNER DECISION

**The open item recorded in the 2026-08-31 14:20 UTC run above is now CLOSED.** That entry left the
type cap without a floor and said explicitly that giving it one needed a design call on S01's
decision rather than a code change here. The owner made that call on 2026-09-01: **floor it, and show
the count honestly.**

- **The minimum is `0.7rem` – 11.2 px at a 16 px root, at the 1920×1080 projection class.** Not a new
  number: it is the Condensed tier's own declared `clamp()` minimum, it is comfortably below the
  ~13.4 px at which S01's own drawn ceiling (200 across 20, about eleven to a tile) renders, and it is
  about 10 mm of character height on a 2.4 m-wide projection – which reads from roughly two and a
  half metres, exactly the "legible from nearer the screen, not from the back row" that
  `design-decisions.md` already claims for Post-it wording at the ceiling. Below it that claim is
  false, which is what makes the floor a floor rather than a preference.
- **A region that cannot draw all of its Post-its at or above the floor draws none of them** and
  states what it holds instead – `80 post-its – too many to show at this size`, sized like the tile's
  own "No post-its yet". The count pill, the Category name and the boundary are untouched at full
  size, as at every tier.
- **S01's rule is intact and was re-verified, not assumed.** Every Category and Uncategorised stay on
  screen with their names and their server-supplied counts; no scroll extent in either axis; no
  control on any state; no input reveals anything. **No overflow mechanism was added** – nothing
  pages, cycles or waits, per this FIS's own Constraints & Gotchas.
- **The amendment is recorded at the cited anchor**,
  `docs/wireframes/facilitator-board-and-categorisation/design-decisions.md#the-projected-views-overflow-behaviour`,
  as a dated `### Amendment – 2026-09-01: the legibility floor` subsection plus a pointer under the
  tier table. S01's original prose is left exactly as written – five stories cite it, and it must not
  read as though it always said this. The wireframe HTML was **not** redrawn; the shipped surface and
  its projection-class captures are this amendment's demonstration.

#### HOW IT IS IMPLEMENTED

- `web/src/display/display.css` publishes the type scale as **registered `<length>` custom
  properties** – `--display-post-it-size`, `--display-post-it-by-size` and `--display-post-it-floor` –
  instead of setting `font-size` directly per tier. Registering them makes them *computed*, so
  `getComputedStyle` hands back resolved pixels with the container units already applied.
- `web/src/display/DisplayBoardView.tsx` reads those two lengths off the rendered list in a layout
  effect and compares them (`postItsAreLegible` in `board-layout.ts`). **Read, never recomputed**: the
  tile's height falls out of a grid sized to the number of regions and is not knowable in TypeScript,
  so re-deriving the type scale here would be a second copy of the stylesheet's arithmetic that would
  drift the first time either changed.
- The list stays in the document with its `--display-rows` intact even when it draws nothing – it is
  what the measurement reads – so a region resumes drawing by itself when the tile regains room (a
  Post-it discarded out of it, or the staleness band clearing). The effect has **no dependency list**
  on purpose: the staleness band appearing takes height out of every row of the grid, which is not a
  change in any region's props.
- **When the size cannot be read, the Post-its are drawn.** Below the projection class the tile has no
  determinate height, and in jsdom there is no layout at all; a surface that cannot see must not
  conclude that it cannot show. This is why the shipped 375/768/1280 rendering and every existing
  `web/test/` assertion are byte-for-byte unaffected.

#### EVIDENCE

- **Red first.** With `postItsAreLegible` forced to `true` (the surface as it was), four
  projection-class tests fail: `Error: no post-it may be drawn below the legibility floor` listing
  `Category number 1 (40) drawn at 3.21091px`, `Category number 1 (80) drawn at 1.59882px`,
  `Uncategorised (16) drawn at 9.65898px` and `Category number 1 (150) drawn at 0.851054px`, plus the
  boundary test's `expect(pastFloor?.drawn).toBe(0)` receiving 14. The near-uniform ceiling test
  passes either way – which is exactly why it was never enough on its own.
- **Both sides of the floor**, in one layout and one test
  (`draws a region at the legibility floor and states the one just past it`): with 21 identical tiles,
  a Category holding **13** draws all thirteen at 11.29 px (floor 11.2 px) and says nothing extra; its
  neighbour holding **14** would draw at 10.35 px, so it draws none and states `14 post-its – too many
  to show at this size`. Both keep their name and their count pill. Captured as
  `docs/wireframes/facilitator-board-and-categorisation/screenshots/display-board-projection-1920-floor.png`.
- The skewed captures were regenerated and looked at.
  `docs/wireframes/facilitator-board-and-categorisation/screenshots/display-board-projection-1920-skewed-80.png` now reads as a sentence in the 80-region
  and in Uncategorised-at-16, with every other region drawing its Post-its normally – the smear is
  gone and the wall states its own limit.
- Full suite green (92 files / 1539 tests – the drift from the 1532 baseline is S08's concurrent
  work, not this change), typecheck and lint clean, and `format:check` reports no file touched here.

#### NOTICED BUT NOT TOUCHING

- The second-pass review's **F3** is now partly closed: `design-decisions.md` describes the type-cap
  mechanism and its floor. The other two halves of F3 stand – it still draws four projected states
  where six ship, and still describes the staleness detail as a wall-clock time where the shipped
  surface says an elapsed age. Both belong to the wireframe record, which is S01's.
