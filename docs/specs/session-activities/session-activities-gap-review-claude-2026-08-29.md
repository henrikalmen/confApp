# Gap Review: Session Activities – Post-it Rounds and Polls

> **Review mode used**: gap
> **Requirements baseline**: `docs/specs/session-activities/plan.json`, `prd.md`, and the five FIS files `s01-*.md` … `s05-*.md`
> **Implementation root** (resolved from the caller's `CODE DIRECTORY:` line): `C:/git/confApp`
> **Source Trust**: trusted-local
> **Reconciliation Ledger**: five ledgers beside the FIS files – 25 entries, 23 OPEN / 2 CLOSED, all read and matched
> **Report location**: tier 2 spec-directory match
> **Date**: 2026-08-29

---

## Executive Summary

Five stories, all `done`, and the load-bearing product rule **holds in composition**:

- **Post-its always carry their author's name.** `post_it.author_sub` is `NOT NULL REFERENCES
  app_user (sub)`; the display name is joined from `app_user.display_name` (itself `NOT NULL`) at
  read time rather than copied; the author reaches the column only as a parameter the route passes
  from `caller.sub`, and no request-body field is read on any write path. Every surface renders the
  name, including offline-queued items still on the device, which are keyed and filtered by `sub`
  and whose drain captures the signer once and re-checks it before every send.
- **Votes are anonymous at the storage level.** `vote` is exactly `(id, round_id, option_id)` —
  asserted against the *live* `information_schema`, not only the migration text. The has-voted fact
  is a separate table sharing only `round_id`. `writeTheBallot` has no parameter a `sub` could
  arrive through; `api/src/votes/vote-repository.ts` is the only module in `api/src` reaching either
  table, enforced by a content scan over every `.ts` under `api/src` rather than a filename
  allow-list; every emittable response shape is at most a count per option; no log line pairs the
  two; nothing vote-shaped is ever persisted on a device. S05's deletion guard — the newest consumer
  of the ballot table — counts through the Round and takes no identity parameter, adding no path
  back to a voter.

**This is a tight PASS, not a comfortable one.** Functionality sits exactly on its threshold. Six
findings at MEDIUM or above are new, five of them only visible in composition — no single story's
tests could have caught them:

- **G-01 (HIGH)** — the offline queue's drain has exactly two triggers, and neither fires in the
  failure mode S04 was written for. A held Post-it is not retried while the app stays loaded.
- **G-02 (MEDIUM)** — the Session-scoped activity watermark is a noiseless vote-arrival oracle for
  any Member, which **refutes a ledger entry currently marked CLOSED**.
- **G-03 (MEDIUM)** — `offlineComposed` unlocks writes to a Round that has *never been opened*, not
  only one closed after running. The one finding here with a mechanical fix.
- **G-04 (MEDIUM)** — a lost response plus a delete lets a queued retry **recreate a Post-it its
  author deliberately withdrew**, under their real name.

Nothing found breaches the voter↔ballot guarantee. G-02 leaks *that* and *when* a Vote was cast,
never *which option* or *whose*.

## Verdict

| Dimension     | Score | Threshold | Status |
|---------------|-------|-----------|--------|
| Functionality | 7/10  | >= 7      | PASS |
| Completeness  | 9/10  | >= 9      | PASS |
| Wiring        | 8/10  | >= 8      | PASS |

**Overall: PASS**

CONVERGED: NO (five new `code-defect` findings at MEDIUM or above – G-01 through G-05)
Auto-Remediation: PENDING

### Scoring rationale

- **Functionality 7 — on the line, and it should be read that way.** All seven FRs and all eleven
  user stories are implemented; all 37 FIS Acceptance Scenarios across the five stories are checked
  with **zero** unchecked boxes anywhere (149 checked). The suite is green: `npm run typecheck`
  exit 0, `npm run lint` exit 0, `npm test` **1179 passed / 1179 across 72 files**, and the 65 tests
  in `vote.integration.test.ts`, `post-it.integration.test.ts` and `session-deletion.integration.test.ts`
  were confirmed to have **executed against a real PostgreSQL** (listener verified on the
  `TEST_DATABASE_URL` port), not skipped. Held down to 7 because four requirement clauses are
  defeated on their failure paths: FR6's central promise that a queued Post-it "syncs on reconnect"
  (G-01), FR6's ambiguous-outcome clause and FR3's "no trace that it existed" (G-04), FR3/FR6's
  scoping of the closed-Round bypass (G-03), and FR5's withholding intent (G-02). Six of seven FRs
  are fully delivered and nothing is *lost* — FR6 recovers on relaunch — which is why this is 7 and
  not below.
- **Completeness 9** — zero `TODO`, `FIXME`, `XXX` or `HACK` markers in `api/src`, `web/src` or
  `db/migrations`. S01's `BallotGate` port was genuinely discharged by S03 TI08: the body is a real
  `exists` over the ballot table, with no stub, constant or flag surviving on the freeze path. Not
  10: the requirements baseline itself carries text the code contradicts (G-06, G-07).
- **Wiring 8** — end to end and verified: migrations applied and exercised; cast and tally routes
  registered and authenticated; `PostItQueueDrain` mounted once in the app shell (`web/src/App.tsx:152`);
  `SessionActivitiesPanel` reachable from both the organizer schedule (`SchedulePanel.tsx:488`) and
  the attendee schedule (`AttendeeSchedulePanel.tsx:839`); every server answer the client renders
  from (`canRun`, `mine`, `hasVoted`, `tally`, `arrivedAfterClose`, `textMaxLength`) is consumed
  rather than re-derived; visual validation present at all three required widths (24
  `session-activities-*` screenshots at 375 / 768 / 1280). Held to 8 by the one genuine integration
  gap: nothing connects a *successful* request back to the drain (G-01's mechanism), so a component
  that is mounted is not reachable by the event that should drive it.

### Findings Filter

Sixteen candidates were raised across the primary pass and the Critic. **Fourteen accepted, two
withdrawn**, both from the Critic:

- *Withdrawn* — the EPQ-visibility half of the Critic's option-churn finding (its own confidence 50;
  nothing in code or test pins PostgreSQL's behaviour here, and the freeze makes it unreachable once
  any Vote exists). Its concrete half survives as G-09.
- *Withdrawn* — "the cross-author `submissionId` collision silently drops the victim's text". The
  text **is** surfaced to its author by `HeldPostIt`'s refusal branch. The real defect is a false
  refusal sentence, kept and **downgraded to LOW** as G-08.

---

## Coverage Matrix

| surface | evidence read | positive proof | falsifier attempted | result |
|---|---|---|---|---|
| **FR4 / OC03 – no declared column, constraint or index joins a Vote to its voter** | `db/migrations/20260829090000000_vote.sql`; `api/test/vote-structure.test.ts`; `api/test/vote.integration.test.ts:1050-1057` | `vote` is `(id, round_id, option_id)`; `round_voter` separate, sharing only `round_id`; live `information_schema.columns` asserted `toEqual(['id','option_id','round_id'])` | Would a **later** migration adding `user_sub` to `vote` turn a test red? | **finding (G-05)** – the structural guard reads one migration by hardcoded name and would not |
| **FR4 – the ballot writer cannot receive an identity** | `api/src/votes/vote-repository.ts` `writeTheBallot`, `claimTheVote`, `cast` | The two never share a parameter list; only `cast` holds both values, passing each to one | Could a `sub` reach the ballot insert another way? Is the module boundary enforced? | covered – content scan over every `.ts` in `api/src` fails on any SQL literal naming `vote`/`round_voter` outside `/votes/` |
| **FR4 – no API response, refusal or log associates a Vote with a Member** | `routes/rounds.ts` `toRoundWire`, `PollView`, `refuseCast`, `/tally`, `/votes`; `app.ts:115`; `db.ts` | Only Vote-shaped output is `OptionTally[]`; `hasVoted` concerns the caller alone; no refusal carries a count; logger defaults `false` and no body reaches a serializer | Does the cast response, any of the four refusals, or a log line leak a pairing? | covered – `{ voted: true }` only; `round_voter`'s unique-violation `detail` (which carries `user_sub`) is caught by name and never logged |
| **FR5 / OC02 – the tally is withheld from an Attendee while the Poll runs** | `routes/rounds.ts` tally gate + `pollView`; `resultsNotYetAvailable()` | Attendee on an open Poll gets no `tally` key – absent, not zeroed; dedicated endpoint refuses 403 | Is there a **second route to the same information** the tally gate does not cover? | **finding (G-02)** – the Membership-gated activity watermark is one |
| **FR3 – a Post-it carries its author everywhere it appears** | `post_it.author_sub`; `COLUMNS` join; `toPostItWire`; `Board`/`HeldPostIt`; screenshots | Name joined from a `NOT NULL` column, rendered on every card including pending and refused queued items | Can a Post-it render with an empty author? Can a body field override it? | covered – `display_name` is `NOT NULL`; body author fields accepted-and-ignored, proved behaviourally |
| **FR3 – an author's deletion is final and leaves no trace** | `post-it-repository.ts#remove`; `post_it_submission_unique` | Hard `delete`, no tombstone, no soft-delete flag | Can a deleted Post-it come back? | **finding (G-04)** – the idempotency key dies with the row, so a queued retry re-inserts it |
| **FR3 / FR6 – one closed-Round rule, two branches** | `post-it-repository.ts#contribute`; `20260830090000000_post-it-late-arrival.sql`; `round-repository.ts#open` | `($6::boolean or r.state = 'open')` and `r.state <> 'open'` read the same row in the same statement – the check *is* the write | Does the bypass distinguish "created closed" from "already run", as `open()` does? | **finding (G-03)** – it does not; `open()` uses `closed_at`, `contribute()` does not |
| **FR6 / OC01 – a queued Post-it syncs on reconnect** | `use-post-it-queue.ts` `PostItQueueDrain`, `drain`; `use-online.ts`; full `drain` call-site grep across `web/src` | Drain is device-wide, mounted once, sequential, identity-safe | What actually re-triggers a drain after the first failure? | **finding (G-01)** – only the mount effect and the `online` event, and `online` does not fire in the documented case |
| **FR6 – a retried send produces one Post-it, not two** | `post_it_submission_unique (round_id, submission_id)`; `on conflict do nothing` + post-hoc lookup | Enforcement is the database constraint, not a pre-read – correct across replicas (Binding Constraint FR2) | Two different authors presenting the same `submissionId`; a retry after the row is deleted | **findings (G-08, G-04)** – constraint scope and lookup scope disagree; the key does not outlive the row |
| **FR6 – offline support is not widened** | `schedule-cache.ts` store list; `vote-structure.test.ts` "caches no vote…"; S04 Scenario S07 | Exactly three IndexedDB stores: `schedules`, `meta`, `post-it-queue` | Is a Vote queueable? A second polling mechanism? | covered – no vote path reaches `hold()`; exactly one poll cadence across `web/src` |
| **FR6 – queued items belong to the composer across a handover** | `post-it-queue.ts` `keyFor`/`listQueuedPostIts`; `drain()`; `AuthProvider.tsx:81,204` | Keys carry the `sub` and are filtered on it before any value is fetched; `drain` captures `sub` once and re-checks before each send | Shared tablet changing hands mid-send – can Anna's text post under Björn's name? | covered – drain breaks; projection gated on `owner === cacheIdentity()`; sign-in requires a full redirect, leaving no window |
| **FR7 – deletion refused server-side, naming what would be lost** | `session-deletion.ts`; `session-repository.ts#remove`; `countVotesForSession` | Guard is a pure function of two counts, given no row, id or identity | Does satisfying it reintroduce a voter join? Does the refusal disclose a withheld tally? | covered – no identity parameter exists; disclosure is Admin-only, and Admin already passes the tally gate |
| **FR7 – the guard cannot be raced** | `session-repository.ts#remove` lock order; Scenarios S06, S07 | Conference → Session → Rounds `FOR UPDATE` → both counts → delete, one transaction | Contribution committing inside the counted window, either interleaving | covered – `FOR UPDATE` conflicts with the FK's `FOR KEY SHARE` both ways; no committed contribution can vanish (G-11 is the error-surface consequence only) |
| **FR7 – the Conference cascade is retained** | `session-deletion.integration.test.ts:471,504,525,563-585` | Cascade asserted against `pg_constraint.confdeltype` – the rules the database holds, not the migration text | Does the `round_option` delete trigger break the cascade? | covered – exercised, fires six times against a Round being deleted; **discharges an OPEN S03 ledger entry** |
| **FR1 – the Poll freeze is race-free** | `round-repository.ts#updateContent`; `ballot-gate.ts`; `vote.integration.test.ts:732` | `select … for update` **before** the guard; guard and UPDATE in one transaction; same lock order as `cast` | A Vote committing between the freeze check and the write | covered – proved red by removing `for update` |
| **FR1 – a Poll edit cannot destroy ballots** | `assertSameActivity`; `updateContent`; `round_option → vote` CASCADE | `delete from round_option` appears once in `api/src`, always behind the freeze under the lock | Any reachable path where an edit cascades a ballot away | covered – none; but the replacement is unconditional (**G-09**) |
| **FR2 – reopen refused for a Poll, permitted for a Post-it Round** | `round-repository.ts#open`/`close` | The rule is the UPDATE's own predicate: `not (kind = 'VotingRound' and closed_at is not null)` | Does an idempotent re-open produce the wrong refusal sentence? | covered – predicate matches, transition is a no-op |
| **Guardrail – responsive at 375 / 768 / 1280** | `visual/session-activities.spec.ts` (3 tests × 3 viewports); 24 screenshots | `assertWithinViewport` per surface; two phone screenshots inspected directly | Long pasted identifiers pushing a 375px phone sideways | covered – the spec deliberately seeds long unbroken tokens; no horizontal overflow |
| **Requirements baseline vs shipped vocabulary** | `docs/UBIQUITOUS_LANGUAGE.md` changelog; `prd.md`; `plan.json` | Code and UI fully renamed to Board | Does the baseline still use a glossary-forbidden synonym? | **finding (G-06)** – "wall" survives 17× in `prd.md` and once in `plan.json` |
| **FR7 refusal sentence** | `prd.md` FR7 Error Handling vs `session-deletion.ts` | – | Does the shipped sentence contain the PRD's fixed noun phrase? | **finding (G-07)**, matched to an OPEN ledger entry |

---

## Guardrails Coverage

**Guardrails Coverage: 16 checked, 2 findings.**

Clean against `AGENTS.md` → Do Not / Never and `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md`:
never ship a fixed-width layout; never tie the schema to provider features (`gen_random_uuid`, plain
sequences, asserted by "uses no extension and no provider-specific feature"); never rely on
in-process state (authorization and every repository re-read per request; `post-it-structure.test.ts`
asserts no module-level mutable state under `api/src`); never attribute a Vote to a voter; never key
a user on email (`author_sub`, `user_sub` → `app_user.sub` throughout); never derive roles from
directory groups; never widen offline support; never use web push; never commit `.env` (gitignored
at `.gitignore:18`, untracked); no AI attribution anywhere in the shipped tree; en dashes throughout,
zero em dashes in the new modules; temp work under `.agent_temp/`. The `hd`-claim and
embedded-WebView rules are untouched by this bundle.

Two deviations, both LOW: **G-13** (real dates only) and **G-14** (scope discipline).

---

## Gap Analysis Results

### G-01 — The offline drain has no trigger that fires in the failure mode S04 was written for

- **Reviewer**: Critic · **Severity**: HIGH · **Confidence**: 90 · **Scope relation**: primary
- **Location**: `web/src/offline/use-post-it-queue.ts:274-280` (`PostItQueueDrain`); `web/src/offline/use-online.ts:1-20`
- **Class**: `code-defect` · **Routing**: **Note** — the fix direction is not uniquely determined (post-success hook, bounded backoff, or both), so it is not mechanically applicable.

**Finding.** `PostItQueueDrain`'s effect has `[]` deps and does exactly two things: `void drain()`
once on mount, and `window.addEventListener('online', attempt)`. A repository-wide grep for `drain`
confirms there is no third caller — `usePostItQueue` documents that it "**starts no drain**",
`hold()` calls only `reload()`, and the Session panel reads the shared store rather than driving it.
So after the first failed send, the only paths back to a delivery are an `online` event or a remount
of the app shell.

**Threatened assumption.** That connectivity returning always produces an `online` event. The
codebase states, in two places, that it does not — and one of them is the module the drain's sole
recovery trigger depends on:

- `web/src/offline/use-online.ts`: "`navigator.onLine` reports the link, not reachability: it is
  `true` behind a captive portal and on dead venue wifi, and it is **the single most common way an
  offline path comes to hang forever waiting for a request that will not arrive**."
- `web/src/offline/post-it-queue.ts`: "**What decides that an item is held is a request failing**,
  never `navigator.onLine`."

A Post-it is queued precisely because a *request* failed while `navigator.onLine` stayed `true`. In
that state `navigator.onLine` never transitions, so `online` never fires, so no second drain occurs
for the life of the page. The design correctly refuses to let `navigator.onLine` *gate* anything —
and then leaves it as the only thing that *triggers* recovery.

**Evidence.** `use-post-it-queue.ts:274-280` in full; the `drain` call-site grep across `web/src`;
`use-online.ts`. `web/test/PostItQueueDrain.test.tsx` encodes the premise the code inherits — that
the `online` event "is the moment the venue's wifi actually comes back" — so the suite is green on
an assumption its sibling module documents as false.

**Impact.** On the dominant venue failure mode, a held Post-it is never retried while the app stays
loaded. Under Capacitor, backgrounding and foregrounding does not remount React, so the item is
stranded until a force-quit and relaunch. The author sees "Waiting to be posted – it is still on this
device" indefinitely, with no error and no delivery. FR6's acceptance criterion — "On reconnect it is
sent and appears on the wall for everyone" — and S04's OC01 are not met in the case the story exists
for. The PRD's success metric "Post-its lost to connectivity: zero" holds only because the item
survives on disk; the promise was that it *arrives*.

**Suggested fix.** Add a trigger independent of `navigator.onLine` transitions: attempt a drain after
any successful authenticated API response — the watermark poll already runs every 5 s on an open
Session (`web/src/poll/use-watermark-poll.ts:36`), which is a ready-made liveness signal — and/or a
bounded backoff timer while `queued.length > 0`. Keep `online` as an additional prompt.

**Verification needed.** Mount the shell with one held item, never dispatch `online`, then let a
successful `fetch` occur. Assert the queue empties. Red today.

### G-02 — The activity watermark is a noiseless vote-arrival oracle for any Conference Member

- **Reviewer**: gap lens + Critic · **Severity**: MEDIUM · **Confidence**: 95 · **Scope relation**: primary
- **Why MEDIUM and not HIGH**: it leaks *that* and *when* a Vote was cast, never *which option* and
  never *whose* — the storage-level voter↔ballot guarantee is intact. The residual is already named
  in the shipped documents, just understated, and the owner ratified the counter change with the
  channel partly in view. For an internal app under a hundred employees that is rework and a
  documentation correction, not a reason to hold a release.
- **Location**: `api/src/rounds/round-repository.ts:270-279`; `api/src/routes/rounds.ts` (`GET …/activities/watermark`); `db/migrations/20260829090000000_vote.sql` (`vote_advances_activity_watermark`); `db/migrations/20260829120000000_activity-watermark-counter.sql`
- **Class**: `code-defect` · **Routing**: **Note** — four defensible directions, and it needs the ADR-006 amendment an existing OPEN ledger entry already calls for.

**Finding.** Both the Session read and the poll endpoint serve
`select max(activity_watermark) from round where conference_id = $1 and session_id = $2` — scoped to
**this Session's Rounds**. `vote_advances_activity_watermark` moves that value on every ballot
insert. The endpoint is gated on Conference Membership alone and is not throttled (the API's only
rate limiter is `api/src/conferences/failed-join-attempts.ts`, on join codes; `app.ts` registers no
throttling hook). Every *other* cursor-advancing write — prompt, state, `closed_at`, `position`,
every Post-it insert/update/delete, every option write — is visible in the Session payload the same
Member may read, and option writes are additionally frozen from the first Vote. So during a running
Poll, **a change in the watermark unaccompanied by any change in the Session payload is a ballot
insert, with no other explanation available.**

**Threatened assumption.** Both shipped statements of the residual argue about the *magnitude* of the
delta, never about the *change event*:

- `20260829120000000_activity-watermark-counter.sql`: "A sequence shared by every Round in the
  deployment is advanced by unrelated writes too, so a difference is a floor rather than a count …
  In a very quiet deployment … the difference between two polls approximates the local write volume."
- `s03-anonymous-poll-voting-and-result-reveal.md:101`: "a difference between two polls is a floor
  on write volume and not a count of Votes, except in a deployment quiet enough that nothing else is
  writing."

Because the served value is `max()` **scoped to one Session**, writes elsewhere in the deployment
never move it. The global sequence adds noise to the *size of the jump* and **zero** noise to the
*fact that it jumped*. The "quiet deployment" precondition therefore does not apply — the channel is
open at any deployment volume. And because the caller chooses the polling rate on an unthrottled
endpoint, timing precision is bounded by the attacker, not the design, recovering much of what
replacing the microsecond timestamp was meant to remove.

**Evidence.** The strongest citation is S03's own **checked** Structural Criterion at
`s03-…md:101`, which sees the whole shape of this and then closes it with the incomplete argument. It
states outright that the trigger's justification "does *not* hold for an Attendee, who is
deliberately refused a running Poll's tally so that not voting carries no signal … and who may
nonetheless poll the Session's cursor for as long as the Poll runs", then resolves it by pointing at
the counter. The escape hatch it leans on — deployment volume — is not load-bearing. So the criterion
is checked while the property it claims does not hold: the lens's "satisfies the literal scenario
while defeating its outcome" case, at Structural-Criterion level. Corroborating:
`vote.integration.test.ts` "advances the round cursor on a ballot insert … and no other cursor"
asserts exactly the observable this turns on, and "serves an opaque counter that carries no
wall-clock time" tests the value's *shape*, never the inference. No Acceptance Scenario in any of the
five FIS files attacks the watermark endpoint as an alternative route to withheld Poll information.

**Impact.** An Attendee — including one not in the room, since attendance is deliberately not tracked
— can reconstruct the running number of Votes cast in a Poll and each ballot's arrival time to
whatever resolution they choose to poll. `prd.md` FR5 withholds the tally with the stated purpose
that "not voting carries no signal"; OC02 scopes the running tally to a Session Assignment holder.
That intent is defeated for cardinality and timing, though not for the per-option split. Combined
with watching the room, this is the correlation vector the OPEN S03 ledger entry records for the
Facilitator, now available to every Member.

**Ledger relation — this refutes a CLOSED entry.**
`api/src/routes/rounds.ts:spec-stale:the-activity-watermark-hands-every-member-the-instant-of-each-vote`
is CLOSED with "owner decision 2026-08-29 replaced the exposed value with an opaque monotonic
counter". The counter narrowed the precision; it did not close the channel, and the closure note's
own residual statement understates what remains. Per the ledger contract a CLOSED entry stays
suppressed *unless refuted* — this refutes it.

**Suggested fix (not uniquely determined).** (a) Drop `vote_advances_activity_watermark` and accept a
poll-driven rather than cursor-driven Facilitator tally; (b) debounce or quantise the served value
while a Poll is open; (c) advance the cursor on a decoy schedule so the event itself carries noise;
(d) leave the mechanism and amend ADR-006 and both residual statements to describe the channel
accurately. (d) is the minimum honest option and is required in every case.

**Verification needed.** A test that a Member without a Session Assignment cannot distinguish "a Vote
was cast" from "nothing happened" by polling the watermark while the Session payload is otherwise
unchanged. No test exists in either direction today.

### G-03 — `offlineComposed` unlocks a Round that has never been opened

- **Reviewer**: Critic · **Severity**: MEDIUM · **Confidence**: 95 · **Scope relation**: primary
- **Location**: `api/src/rounds/post-it-repository.ts:275-293`; `db/migrations/20260828090000000_round.sql` (`state` default `'closed'`, `closed_at` NULL)
- **Class**: `code-defect` · **Routing**: **Fix** — the correction is one predicate, uniquely determined by an idiom already used three functions away.

**Finding.** The contribution's source predicate is `($6::boolean or r.state = 'open')` and the
late-arrival marker is `r.state <> 'open'`. Both read `state` **only**. A Round authored ahead of the
Session has `state = 'closed'` and `closed_at IS NULL`, which is indistinguishable here from a Round
closed after running. So any Conference Member who passes `authorizeContribution` can `POST
…/rounds/:roundId/post-its` with `{"text":"…","offlineComposed":true}` against a Round the
Facilitator authored last week and has never opened, and the row lands — marked
`arrived_after_close = true` on a Round that never closed.

**Threatened assumption.** Two, both stated in the code:

- `api/src/routes/rounds.ts`: "The Round is created **closed**: the state is the table's default …
  so no write path can produce one that is already running."
- `20260830090000000_post-it-late-arrival.sql`: the bypass is scoped to a Round "the Facilitator may
  have closed **in between**".

**Evidence.** The decisive comparison is internal: `round-repository.ts#open` already draws exactly
this distinction, with `not (kind = 'VotingRound' and closed_at is not null)` and the comment
"created-closed is not already-run". S01 built the vocabulary for "has this Round ever run"; S04's
bypass predicate does not use it. That is a composition gap between two stories, not a judgement call
— the two halves of one rule disagree about what "closed" means.

**Impact.** A Facilitator's pre-authored board can be seeded by any Member before the activity is
ever run, and those rows render "Arrived after this round closed" — a statement that is false about a
Round that never closed. The Facilitator opens a prepared Round to find it already populated. Note
the app's own client never does this: live compose sends `{submissionId}` without `offlineComposed`,
and the drain only holds items composed against a Round the app rendered open. It takes a
hand-crafted request — but the server-side rule is the guarantee here, exactly as it is everywhere
else in this bundle.

**Suggested fix.** `($6::boolean and r.closed_at is not null) or r.state = 'open'`. A never-opened
Round then refuses both branches, which is the state S01 designed for. The marker expression needs no
change: with the bypass so scoped it can only ever see a genuinely-closed-after-running Round or an
open one.

**Verification needed.** Integration test — author a Post-it Round, never open it, POST with
`offlineComposed: true` as a plain Member, assert 409 `POST_IT_ROUND_CLOSED`. Currently 200.

### G-04 — A queued retry can recreate a Post-it its author deliberately deleted

- **Reviewer**: Critic · **Severity**: MEDIUM · **Confidence**: 85 · **Scope relation**: primary
- **Location**: `api/src/rounds/post-it-repository.ts#remove` composed with `#contribute` and `web/src/offline/use-post-it-queue.ts#drain`
- **Class**: `code-defect` · **Routing**: **Note** — the fix needs a new storage concept (a claim that outlives the row), which is a design decision.

**Finding.** The submission-identity idempotency is enforced by `post_it_submission_unique
(round_id, submission_id)` — a constraint over *live rows*. `remove()` is a hard
`delete from post_it` with, deliberately, no tombstone and no soft-delete flag, so `submission_id`
goes with the row. Once it is gone the same `submissionId` no longer conflicts, and a still-queued
retry inserts a **new** Post-it.

**Trigger path.** Offline compose → drain sends → server writes the row → the response is lost at the
network → the item stays queued and pending (and, per G-01, no further drain fires while the page
lives) → the author sees the Post-it on the board, because the server did write it, and deletes it →
relaunch → drain retries → no conflict → the row is recreated under the author's real name, marked
`arrived_after_close` per the Round's state at that later moment.

**Threatened assumption.** `prd.md` → Edge Cases: "Attendee deletes their only Post-it → The wall has
one fewer; **no trace that it existed**", restated at `api/src/routes/rounds.ts` ("The row goes: no
tombstone, no placeholder, no 'removed by' marker"). And FR6's own Error Handling: "Send outcome is
ambiguous … the item is retried, and **the repeat is recognised as the same contribution** rather
than a second one" — which holds only while the first row survives. The ambiguous-outcome case is
precisely the one FR6 names, so this is not an exotic path.

**Impact.** A named contribution the author deliberately withdrew reappears on the board and in the
input to categorization and the Report. The delete affordance is not final. This is the one finding
that touches the *named* half of the load-bearing rule: authorship is never wrong, but the author's
control over what stands under their name is.

**Suggested fix.** Retain the submission identity past the row — a small `post_it_submission
(round_id, submission_id, author_sub)` claim table written by `contribute` and *not* cascaded by the
post-it delete — or have `remove()` record the identity so a later retry resolves to "already
handled" rather than inserting.

**Verification needed.** Integration test — contribute with `submissionId = X`, delete the resulting
Post-it, re-POST the same `X` with `offlineComposed: true`. Assert the board stays empty. A second
row is created today.

### G-05 — The anonymity structural guard reads one migration by hardcoded name

- **Reviewer**: gap lens (verification depth) · **Severity**: MEDIUM · **Confidence**: 95 · **Scope relation**: primary
- **Location**: `api/test/vote-structure.test.ts:47`; backstop at `api/test/vote.integration.test.ts:1050-1057`
- **Class**: `code-defect` · **Routing**: **Note** — two defensible fixes, one of which changes CI behaviour repo-wide.

**Finding.** `const MIGRATION = '20260829090000000_vote.sql';` — the structural guard opens exactly
that file. It contains no `readdirSync` over `db/migrations`, unlike
`api/test/membership-structure.test.ts`, which does scan the directory. A later migration doing
`ALTER TABLE vote ADD COLUMN user_sub text` is never read, and **no assertion in
`vote-structure.test.ts` turns red.**

The real backstop is `vote.integration.test.ts`, which queries the live accumulated schema
(`select column_name from information_schema.columns where table_name = 'vote'`, asserted
`toEqual(['id','option_id','round_id'])`) and would catch it — but sits inside
`describe.skipIf(!reachable)`. With no PostgreSQL at `TEST_DATABASE_URL` the block silently skips and
`npm test` still reports green, distinguished only by a `console.warn` in a log already dense with
Node experimental warnings.

**Threatened assumption.** `plan.json` → `riskSummary` for S03: "Prove anonymity against the schema,
not the UI: a Structural Criterion asserting no column, constraint or index permits joining a ballot
to a Member, **plus a test that fails if such a path is added**." The always-on test does not fail
when such a path is added; the test that does is environment-dependent and silently optional. For the
property the plan itself names as the bundle's highest risk, that is weaker than specified.

**Evidence.** Confirmed by inspection and by rerunning the three integration files verbosely — 65
tests, all executed, PostgreSQL confirmed listening. The guard works *today*; the finding is that its
strength rests on an environment condition nothing asserts.

**Impact.** The one regression this bundle most needs to be impossible could be introduced by a
future migration and reach a green CI run on any machine without the test database.

**Suggested fix.** Widen the structural scan to every file under `db/migrations` and assert that no
statement anywhere adds an identity-bearing column to `vote` — the `membership-structure.test.ts`
directory-scan idiom already exists in this repo — and/or make the integration skip fail rather than
skip when a CI environment variable is set.

**Verification needed.** Add the offending `ALTER TABLE` in a scratch migration; confirm the
structural test goes red **with no database running**.

### G-06 — "wall" survives in the requirements baseline after Board became canonical

- **Severity**: MEDIUM · **Confidence**: 100 · **Scope relation**: primary
- **Location**: `docs/specs/session-activities/prd.md` (17 occurrences over 16 lines, incl. 25, 47, 56, 113, 114, 213, 313, 322; none of them "wall-clock"); `docs/specs/session-activities/plan.json:145` (S02 `scope`)
- **Class**: `spec-stale` · **Routing**: **Note**

`docs/UBIQUITOUS_LANGUAGE.md` — amended during this run — registers **Board** as canonical and lists
`wall, post-it wall, canvas, whiteboard` as synonyms to avoid, with a changelog entry naming
session-activities S02 as the renamed surface. The code and UI were fully renamed (no "wall" in
`web/src`; the shipped screenshots read "board" throughout). The **requirements baseline was not**:
`prd.md` still says "reaches the wall on reconnect" (FR6), "a wall of named ideas cannot vanish"
(US10), "the updated wall for all participants" (FR3 Outputs); `plan.json`'s S02 `scope` says "A
closed Round's wall stays readable".

This is drift **beyond** the set already reported to this review. The known-and-unswept set was the
`activity_watermark_at` references in the S01/S02/S03 FIS bodies (12 / 4 / 15) plus `plan.json`'s
`sharedDecisions` (2), and the "wall" in S02's already-applied migration comments, which is
separately ledgered. The `prd.md` and `plan.json`-scope occurrences are neither ledgered nor
reported. Every "wall" inside the S02 and S03 FIS bodies is, correctly, provenance narration inside a
DECISION NOTE or a NOTICED-BUT-NOT-TOUCHING block, not a live claim.

`plan.json` is rewritable only by the `andthen:plan` skill; `prd.md` is baseline text. Recorded for
the sweep that will carry the `activity_watermark_at` corrections.

### G-07 — FR7 still states a fixed refusal sentence the code does not produce

- **Severity**: LOW · **Confidence**: 100 · **Class**: `spec-stale` · **Routing**: **Note** — *matched to an OPEN ledger entry*

Confirmed still true and recorded against
`api/src/sessions/session-deletion.ts:spec-stale:the-shipped-refusal-is-parameterised-while-fr7-fixes-a-literal-sentence`
rather than raised fresh. The PRD fixes the sentence as "This session has collected post-its or votes
and cannot be deleted."; the shipped message is parameterised and, for a Session holding only
ballots, never contains "post-its" at all. TI01's reconciliation of FR7 against US10 is the right
call; the PRD is what is stale. The ledger's recommended restatement stands.

### G-08 — A foreign `submissionId` produces a refusal that is false about the Round

- **Reviewer**: Critic (downgraded from MEDIUM) · **Severity**: LOW · **Confidence**: 100 · **Scope relation**: primary
- **Location**: `api/src/rounds/post-it-repository.ts:328-333`
- **Class**: `code-defect` · **Routing**: **Note**

`post_it_submission_unique` is `(round_id, submission_id)` — **not** author-scoped — while every
resolution path *is* (`p.author_sub = $4`). When two authors present the same `submissionId` on one
Round, the second insert is swallowed by `on conflict … do nothing`, the author-scoped lookup finds
nothing, and control reaches a probe that selects `state` and **never reads it**:

```
const rounds = await db.query<{ state: string }>(`select state from round where …`);
return rounds[0] === undefined ? { outcome: 'missing' } : { outcome: 'round-closed' };
```

The route maps that to a 409 "This round is closed, so it is not taking post-its at the moment." on a
Round that is open, and `mayStillBeDelivered` treats 409 as terminal.

**Downgraded from the Critic's MEDIUM** for two reasons: the victim's text is *not* silently dropped
— `HeldPostIt`'s refusal branch renders it with a Discard control — and `mintSubmissionId` uses
`crypto.randomUUID`/`getRandomValues`, so reaching this needs a deliberately chosen colliding UUID.
What remains is a refusal sentence that lies, and a selected-but-unread column that will mislead the
next person to touch this fall-through.

**Suggested fix.** Either scope the constraint `(round_id, author_sub, submission_id)`, or make the
fall-through honest by reading `state` and returning `round-closed` only when it is not `'open'`.

### G-09 — A prompt-only Poll edit replaces the whole option set

- **Reviewer**: Critic (concrete half) · **Severity**: LOW · **Confidence**: 90 · **Scope relation**: primary
- **Location**: `api/src/rounds/round-repository.ts:375-378`
- **Class**: `code-defect` · **Routing**: **Note**

`if (details.kind === 'VotingRound') { delete from round_option …; insertOptions(…) }` is
unconditional on whether the labels changed, so **every** Poll edit — including one that only touches
the prompt — deletes and re-inserts the option set, minting fresh `gen_random_uuid()` ids.

The reachable consequence is on the client. `SessionActivitiesPanel` holds `choices[roundId]` — an
option **id** — deliberately at panel level so a poll tick cannot take a half-made choice away. After
an id churn, no option matches: the radio group renders nothing selected while `choice` is still
defined, so the Vote button stays enabled and pressing it yields `VOTE_OPTION_UNKNOWN` — "That answer
is not one of this poll's options. Reload the session and choose again." A Facilitator fixing a typo
in the question silently resets every undecided voter's selection.

Ballots are safe: this path is reachable only before the first Vote, because `assertPollContentEditable`
refuses afterwards **under the row lock**. That is also why the Critic's companion concern — that the
`round_option → vote` CASCADE could destroy ballots here — is withdrawn rather than recorded (see
Findings Filter). It does, however, compose badly with the OPEN S03 ledger entry noting that "only
the freeze stands between a bug and lost Votes": needless churn on a path guarded by exactly one
thing is worth removing on its own.

**Suggested fix.** Skip the replacement when the label list is unchanged.

### G-10 — S05's guard does not protect an undelivered queued Post-it

- **Severity**: LOW · **Confidence**: 85 · **Class**: `code-defect` · **Routing**: **Note** — *matched to an OPEN ledger entry*

A Session whose only contribution is still queued on a device holds zero server-side contributions,
so `sessionDeletionRefusalReason` returns `null` and the delete succeeds. The drain then receives
`SESSION_NOT_FOUND` / `ROUND_NOT_FOUND`, `mayStillBeDelivered` returns false, and the item is marked
refused. Per the OPEN S04 entry
`web/src/activities/SessionActivitiesPanel.tsx:code-defect:a-returned-to-author-item-is-surfaced-only-by-the-session-panel`,
with the Session gone **there is no surface that renders it at all**.

Recorded against that entry with one correction to its framing: the entry calls this "new scope". It
is also an unmet clause of a shipped requirement — FR6 → Error Handling states "The Round or Session
no longer exists on arrival → the contribution is refused and **the text surfaced to its author**
rather than silently dropped", and this is the one path where it is not. Worth re-weighting when the
entry is scheduled.

### G-11 — A contribution racing a Session delete surfaces as 500, not 404

- **Reviewer**: Critic · **Severity**: LOW · **Confidence**: 80 · **Class**: `code-defect` · **Routing**: **Note** — *matched to an OPEN ledger entry*

Independently rediscovered by the Critic and already tracked as
`api/src/rounds/post-it-repository.ts:code-defect:contribute-returns-500-when-its-round-is-deleted-mid-insert`
in S05's ledger. The Critic adds the precise mechanism, worth appending to the entry: the INSERT's
source `select` on `round` is non-locking and passes on its own snapshot; the FK check then blocks on
the delete's `FOR UPDATE`, and when the delete commits the referenced row is gone → SQLSTATE 23503,
uncaught by `contribute`, surfaced as `INTERNAL_ERROR`. Data integrity is intact — the guard counted
zero and nothing was written. Suggested fix unchanged: catch `23503` and fall through to the existing
`{ outcome: 'missing' }` path.

### G-12 — Run controls offer Open, Close and Edit unconditionally

- **Severity**: LOW · **Confidence**: 90 · **Location**: `web/src/activities/SessionActivitiesPanel.tsx:612-641` · **Class**: `code-defect` · **Routing**: **Note**

All three buttons render whenever `canRun`, with no `disabled` and no gate on Round state — so a
terminal Poll shows an enabled "Open" and a frozen Poll an enabled "Edit". Both produce the correct
server refusal, so shipped **behaviour conforms** to FR1 and FR2's Error Handling, which is why this
is LOW. What is inconsistent is that the sibling `Board` component in the same file *does* gate its
affordances on `open`, with an explicit comment that "the board stops offering *both* affordances the
moment it ends". One panel, two opposite positions on whether to offer an affordance the server will
refuse. Worth settling deliberately.

### G-13 — Migration id dated one day ahead of the real date

- **Severity**: LOW · **Confidence**: 95 · **Location**: `db/migrations/20260830090000000_post-it-late-arrival.sql` · **Routing**: **Note**

Written on 2026-08-29 (`date +%Y-%m-%d`) with an id reading 2026-08-30. Every other migration id in
the repository is a plausible real date, and `CRITICAL-RULES-AND-GUARDRAILS.md` says "Real dates only
… never guess." Cosmetic — the id is an ordering key and renaming an applied migration is not safe —
so recorded rather than proposed.

### G-14 — AGENTS.md edited outside the bundle's scope

- **Severity**: LOW · **Confidence**: 80 · **Location**: `AGENTS.md` (43 deletions, 0 insertions) · **Routing**: **Note**

The working tree strips every HTML scaffolding comment and `_**TODO**_` placeholder from `AGENTS.md`.
**No rule text changed** — the Do Not / Never list and the Visual Validation Workflow are
byte-identical — so this is not a guardrail alteration. But it is an edit to project instructions
with no trace to this feature, against "Change only what the request needs", and two tracked gaps
lost their marker without being filled: the Key Development Commands TODO and the Visual Validation
tooling TODO.

---

## Negative Results

Attacked and found sound. Recorded so the next reviewer does not re-derive them.

- **The offline drain across a user handover.** `drain()` captures `cacheIdentity()` once, passes it
  explicitly to every queue call, and re-checks `cacheIdentity() !== sub` immediately before each
  send; the in-memory projection is gated on `owner === cacheIdentity()`. `AuthProvider` initialises
  to `{kind:'starting'}` so the drain is not in the first commit, and `setCacheIdentity` runs
  synchronously before the state becomes `signed-in`; `cacheIdentity()` is a live read, never a
  stale cached sub; sign-in requires a full redirect, leaving no window. Anna's text cannot post
  under Björn's credential. The most dangerous composition failure available to S04 + S02, closed
  carefully.
- **Session-deletion lock order and cascade.** Conference → Session → Rounds `FOR UPDATE` → both
  counts → delete, one transaction. `FOR UPDATE` genuinely conflicts with the `FOR KEY SHARE` the
  child inserts take, and `cast` takes `for update of r` on the same rows — so no contribution can
  commit inside the counted window. Both interleavings check out. No path found where a committed
  Post-it or ballot vanishes through a Session delete; G-11 is only the error-surface consequence.
- **No Session-adjacent delete path other than `remove()`.** No round-delete endpoint exists,
  `delete from sessions` appears exactly once, and the conference date-range edit refuses rather
  than stranding Sessions.
- **A Poll edit destroying ballots.** `assertSameActivity` refuses any kind/purpose mismatch before
  validation, so the option-replacement branch is reachable only for a real `VotingRound`, always
  behind `assertPollContentEditable` under `FOR UPDATE`, with `voteExistsForRound` running on the
  transaction's own client. `delete from round_option` appears exactly once in `api/src`.
- **`updateContent` vs `cast` deadlock.** Both acquire the `round` row first and in the same mode;
  `round_option` is touched only after that lock is held.
- **The S05 refusal's vote count.** `DELETE /sessions/:id` requires `Admin`, and an Admin passes
  `requireConferenceRole(..., { sessionId })` unconditionally, so `holdsAssignment` already returns
  true for them. The count discloses nothing they could not already fetch, and is a per-Session
  total, never per-option.
- **Client-side vote storage.** Exactly three IndexedDB stores; no ballot, tally or has-voted fact
  is persisted on any device. The chosen option lives only in React state, and the post-vote card
  does not render the radio group at all.
- **Logging on the vote path.** No `console.`, `request.log` or logger call in `api/src/votes/` or
  `api/src/routes/rounds.ts`; `app.ts:115` builds Fastify with `logger: loggerOptions`, defaulting
  `false`. Even with request logging on, the cast URL carries Conference, Session and Round ids and
  **not** the chosen option, while the voter travels in the Authorization header. `round_voter`'s
  unique violation — whose pg `detail` does carry `user_sub` — is caught by name and never logged.
  `web/src` has no `console.*` at all.
- **The Poll freeze against a concurrent cast.** `select … for update` before the guard, held
  through the option replacement; proved red by removing `for update`.
- **The Conference cascade over `round_option`.** Exercised including the six-fires-per-option case,
  against the cascade rules read from `pg_constraint.confdeltype` rather than the migration text.

---

## Critic Coverage

The Critic sub-lens ran as a dispatched fresh-context `review-critic` sub-agent, given the primary
pass's established findings so it could not re-derive them, and pointed at the surfaces the primary
pass had not closed: the `session-repository.ts#remove` lock order and cascade; `updateContent`'s
transaction against `cast`'s; the `offlineComposed` bypass composed across S01/S02/S04; the
duplicate-`submissionId` cross-author case; every logging call site on the vote path; and the
`PostItQueueDrain` mount against `AuthProvider`'s cache-owner adoption.

It returned six findings and eight negative results. **Its three highest-impact mechanisms (G-01,
G-03, G-04) were each re-verified directly against the source before acceptance** — the drain
call-site grep, the `contribute` predicate against `open()`'s, and `remove()`'s hard delete — rather
than taken on report. Two of its findings were withdrawn or downgraded by the Findings Filter; one
(G-11) independently rediscovered an already-ledgered entry, which is a useful signal about the
ledger's accuracy.

---

## Reconciliation Ledger Annotations

25 entries read across the five ledgers (23 OPEN, 2 CLOSED). Matched as follows:

- **Refuted (1)** — the CLOSED
  `…the-activity-watermark-hands-every-member-the-instant-of-each-vote`. See G-02. Its closure note's
  residual statement is narrower than what shipped.
- **Discharged in fact, still OPEN (1)** —
  `db/migrations/20260829090000000_vote.sql:code-defect:the-round-option-delete-trigger-fires-during-cascade-deletion-and-is-untested-there`
  is now covered by `session-deletion.integration.test.ts:471` and `:504`, which exercise exactly the
  six-fires-during-cascade case it describes. It was routed to S05, and S05 landed it. Ready to
  transition.
- **Confirmed still true, recorded as Notes (3)** — G-07, G-10, G-11. G-11 gains a mechanism worth
  appending to its entry; G-10 gains a re-weighting from "new scope" to an unmet FR6 clause.
- **Confirmed still true, not re-raised (18)** — every remaining OPEN entry still describes the
  shipped code and is already-tracked reconciliation work. Per the ledger's match-and-route rules,
  none is raised as a fresh blocker.
- **No recurrence escalation** — every entry stands at `Recurrence: 1`.

---

## Remediation Plan

One finding meets the `Fix` bar (confidence ≥ 75, scope primary, class `code-defect`, and a fix that
is mechanical, bounded and uniquely determined). The other thirteen route to `Note`, so
`Auto-Remediation: PENDING` with exactly one item an automated pass can apply.

**Fix — applicable now**

1. **G-03.** Change the contribution predicate to
   `($6::boolean and r.closed_at is not null) or r.state = 'open'`. One line, matching
   `round-repository.ts#open`'s existing idiom. Acceptance: a plain Member POSTing with
   `offlineComposed: true` to a never-opened Round receives 409 `POST_IT_ROUND_CLOSED`; every
   existing S04 scenario still passes.

**High — before this runs at a real conference**

2. **G-01.** Add a drain trigger that does not depend on `navigator.onLine` transitions. The
   watermark poll's 5 s successful response is the cheapest available liveness signal. Acceptance:
   with one held item and no `online` event ever dispatched, a successful request empties the queue.

**Medium**

3. **G-02.** Take the product/architecture decision between the four directions. Whichever is chosen,
   the documentation half is unconditional: amend `docs/adrs/ADR-006-*.md` — which already needs the
   cross-response-correlation amendment its OPEN ledger entry calls for, so fold both into one edit —
   plus the residual paragraph in `20260829120000000_activity-watermark-counter.sql` and
   `s03-…md:101`. Acceptance: a Member without a Session Assignment cannot distinguish a cast Vote
   from no activity, **or** every document states plainly that they can.
4. **G-04.** Decide how a submission identity outlives its row, then implement. Acceptance:
   contribute → delete → retry the same `submissionId` leaves the board empty.
5. **G-05.** Widen the structural scan to all of `db/migrations` using the existing
   `membership-structure.test.ts` idiom. Acceptance: adding `user_sub` to `vote` in a scratch
   migration turns a test red **with no database running**.
6. **G-06.** Sweep "wall" → "Board" in `prd.md` alongside the already-planned `activity_watermark_at`
   corrections; `plan.json:145`'s S02 `scope` needs the `andthen:plan` skill.

**Low — opportunistic**

7. **G-08**, **G-09**, **G-12**. Each is a small bounded change; G-09 in particular removes needless
   churn on a path guarded by exactly one thing.
8. **G-07**, **G-10**, **G-11.** Already ledgered; carry the annotations above into their entries.
9. **G-13**, **G-14.** Record only. Do not rename an applied migration.

---

## Appendix: Verification Evidence

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0, no diagnostics |
| `npm run lint` | exit 0, no findings |
| `npm test` | **1179 passed / 1179**, 72 files, 77.3 s, zero skipped |
| `vote` / `post-it` / `session-deletion` integration | 65 tests, **executed** against real PostgreSQL (listener confirmed on the `TEST_DATABASE_URL` port), none skipped |
| FIS Acceptance Scenarios | 37 across five stories, all `[x]`; 149 checked boxes; **zero** unchecked |
| Stub / TODO scan | zero `TODO`/`FIXME`/`XXX`/`HACK` in `api/src`, `web/src`, `db/migrations` |
| Visual validation | 24 `session-activities-*` screenshots at 375 / 768 / 1280; two inspected directly, no horizontal overflow |
| AI attribution scan | zero occurrences in the shipped tree |
| `.env` | gitignored (`.gitignore:18`), untracked |

Known-environmental, excluded from the verdict as pre-existing and unrelated: `npm run format:check`
on three files; `api/test/join-code.test.ts:48` birthday-collision flake; `visual/shell.spec.ts`
without a live `/api/health` on port 8080.
