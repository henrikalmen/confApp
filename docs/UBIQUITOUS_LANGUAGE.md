# Ubiquitous Language

> Domain glossary for confApp. Canonical terms for use in code, documentation, and team communication.
>
> **Usage**: Use these exact terms in code (class names, variables, functions), documentation, and discussion. Avoid synonyms listed in the "Avoid" column.

## Conference Structure

| Term | Definition | Avoid (synonyms) | Bounded Context |
|------|-----------|-------------------|-----------------|
| **Conference** | A single company event spanning 1–4 days. confApp holds many over time. | event, occasion | Conference Setup |
| **Conference Day** | One calendar day within a Conference, holding its own schedule. | day one, track day | Conference Setup |
| **Schedule** | The ordered set of Sessions across a Conference's Days. | agenda (reserve for the personal view), programme | Conference Setup |
| **Session** | A scheduled slot in the Conference. Exactly one of two kinds: Presentation or Workshop. | talk, slot, event, item | Conference Setup |
| **Presentation** | A Session kind: someone presents to the room. May contain Voting Rounds. | talk, lecture, keynote | Conference Setup |
| **Workshop** | A Session kind: participatory work, usually split into Groups. May contain Voting Rounds and Post-it Rounds. | breakout (reserve for Group), lab | Conference Setup |
| **Group** | A subdivision of a Workshop that attendees self-select into. Groups run in parallel. | team, breakout, table, room | Participation |
| **Personal Agenda** | An Attendee's own view, differing from the Schedule only by the Workshop **Groups** they joined. Sessions are open – attendance is neither chosen nor recorded – so there is no per-session personalization. | my schedule, itinerary; "my sessions" (implies a selection that does not exist) | Participation |
| **Parallel Track** | Two or more Sessions scheduled at the same time. Supported but uncommon. | stream, strand | Conference Setup |
| **Draft** | Conference lifecycle state: visible only to holders of a Role Assignment. Has no Join Code. One-way transition to Published. | unpublished, hidden, private | Conference Setup |
| **Published** | Conference lifecycle state: joinable and visible to Attendees. Requires at least one Session. Cannot return to Draft. | live, active, open | Conference Setup |
| **Archived** | Conference lifecycle state: read-only after the event. Not joinable, not editable, deletes nothing. Distinct from the **Archive** (see Overloaded Terms). | closed, finished, retired | Conference Setup |
| **Join Code** | The per-Conference code an employee enters to join. Minted on publish, unique across all Conferences including archived ones, regenerable. **Not a security boundary** – sign-in already restricts to the company domain; the code only selects *which* Conference. | invite code, access code, password, token | Conference Setup |

## Session Activities

| Term | Definition | Avoid (synonyms) | Bounded Context |
|------|-----------|-------------------|-----------------|
| **Activity** | Umbrella term for anything a Session runs interactively – a Voting Round or a Post-it Round. A Session contains zero or more of each. | exercise, module | Participation |
| **Post-it Round** | An Activity in which participants contribute Post-its on a prompt. | post-it session, brainstorm session, sticky session | Participation |
| **Post-it** | A single note contributed by an Attendee during a Post-it Round. **Always displays its author's name.** | sticky, sticky note, card, idea card | Participation |
| **Category** | A named bucket on **one Post-it Round's Board**, created by the Facilitator and existing nowhere else – there is no conference-level set. Post-its are placed into it during or after the Round. "Column" describes how it is drawn on a wide Board View; it is not the term. | bucket, cluster, column, theme, tag, swimlane | Participation → Insight |
| **Discard** | A Facilitator removing a Post-it from consideration during sorting. It leaves the Board and the Report but **leaves a trace** – distinct from it never having existed – and is restorable until the Conference is archived. Not the same act as an author deleting their own Post-it, which leaves no trace at all. | delete (ambiguous with hard deletion), reject, archive, hide | Insight |
| **Voting Round** | An Activity in which participants cast anonymous Votes. Three purposes: Poll, Prioritization, Rating. | vote session, ballot session | Participation |
| **Vote** | A single anonymous ballot cast by an Attendee. **Never linkable to its voter.** | response, answer, submission | Participation |
| **Poll** | A Voting Round purpose: a live question posed to the room during a Session. | survey, quiz | Participation |
| **Prioritization** | A Voting Round purpose: ranking Post-its or ideas by importance. Sometimes called dot-voting externally. | dot vote, ranking | Insight |
| **Rating** | A Voting Round purpose: feedback on a Session's quality. | review, score, feedback form | Insight |

## Roles

| Term | Definition | Avoid (synonyms) | Bounded Context |
|------|-----------|-------------------|-----------------|
| **Admin** | Also *Organizer*. Sets up the Conference, sorts Post-its, produces the Report. Conference-wide authority. | owner (reserve for the company owner), superuser | Identity |
| **Presenter/Facilitator** | One role, two words for what the holder is doing: *presenting* a Presentation (and may start Voting Rounds in it) or *facilitating* a Workshop (its Groups, Activities, and the Board View). Permissions are identical – authority over their own Sessions only. | speaker, host, moderator, leader; also "Presenter" or "Facilitator" as if they were separate roles | Identity |
| **Attendee** | An employee participating in the Conference. | user, participant, delegate, guest | Identity |
| **Leadership** | The company owner and managers who consume the Report. Not app users in the participation sense. | management, stakeholders, execs | Insight |
| **Membership** | The fact that a user is in a Conference, keyed on the OIDC `sub` claim. Universal – *every* role holder has one, including the creator, who is seeded a Membership alongside their Admin Role Assignment. Created by joining with a Join Code, revoked by leaving or Admin removal; revocation ends access without deleting historical records. | enrolment, registration, subscription, attendance (attendance is not tracked) | Identity |
| **Role Assignment** | A grant of Admin or Presenter/Facilitator to a user **within one Conference**, keyed on `sub`. confApp's own data – never derived from a Google Workspace directory group (ADR-002). The Attendee role needs no Role Assignment; it *is* Membership. | permission, grant, ACL entry, group membership | Identity |
| **Session Assignment** | Links a Presenter/Facilitator to the specific Sessions they may run and edit. A Session may have zero or more; zero is valid at publish, and assignment may happen during the Conference. | ownership, session owner, speaker slot | Identity |

## Output

| Term | Definition | Avoid (synonyms) | Bounded Context |
|------|-----------|-------------------|-----------------|
| **Report** | The per-Conference document produced for Leadership: Action Points, follow-ups, Voting Round results, and categorized Workshop output. | summary, export, recap | Insight |
| **Action Point** | A concrete follow-up surfaced by the Conference and carried in the Report. confApp surfaces these; it does not track their completion. | action item, todo, task, ticket | Insight |
| **Board** | The collection of Post-its contributed to a Post-it Round, shown live to every participant. | wall, post-it wall, canvas, whiteboard | Participation |
| **Board View** | The projected big-screen view of **any** Post-it Round's Board – in a Presentation as well as a Workshop – driven by the Facilitator. Read-only: it mirrors what the Facilitator does on their own device and is never a control surface. | projector mode, big screen, presenter view, TV mode | Participation |
| **Uncategorised** | The implicit holding area on a Board where every Post-it arrives and waits to be placed. **Not a Category** – it cannot be renamed, reordered or removed, and a Post-it left in it is a valid terminal state. It is where a late-syncing Post-it lands and where a restored one returns. | inbox, unsorted category, default column, backlog | Participation |
| **Display Link** | The unguessable, revocable, read-only link a Facilitator issues to open one Board's Board View on a room machine without signing in. Scoped to a single Post-it Round; **dies on its own once that Round's Session day has passed**, and renders nothing while its Conference is still Draft. It confers no authority over the Conference. | share link, public link, guest access, projector URL | Participation |
| **Permanent Removal** | An Admin removing a Post-it outright: it leaves every surface, leaves **no trace**, and cannot be restored by anyone. The moderation act for something abusive or accidentally confidential. Distinct from **Discard**, which is a Facilitator act that leaves a trace and is restorable, and from an author deleting their own Post-it, which needs an open Round and is theirs alone to do. | delete, discard, purge, hard delete, moderate | Insight |
| **Archive** | Past Conferences and their Reports, retained and readable after the event. | history, log | Insight |

## Overloaded Terms

| Term | Context A | Meaning A | Context B | Meaning B |
|------|-----------|-----------|-----------|-----------|
| **Session** | Conference domain | A scheduled Presentation or Workshop | Authentication | A signed-in user's login session |
| **Vote** | Voting Round | A single anonymous ballot | Prioritization | Informally, the whole dot-voting exercise – prefer *Voting Round* for the exercise |
| **Group** | Workshop domain | A self-selected subdivision of a Workshop | Identity / Google Workspace | A directory group. confApp roles are never derived from these (ADR-002) |
| **Archive** | Insight domain | The body of past Conferences and their Reports, browsable over time (Phase 4) | Conference lifecycle | **Archived**, a state a single Conference is moved into after its end date. Archiving *one* Conference is Phase 3; browsing *across* them is Phase 4 |

> **Watch out**: "post-it session" is a natural phrase but collides with **Session**, which is a scheduled slot. The Activity inside a Session is a **Post-it Round**. Same for "voting session" → **Voting Round**.

## Changelog
- 2026-08-30 (second pass): Added **Permanent Removal** so the three removal concepts on one Post-it stay apart — author deletion (no trace, open Round, author only), Discard (trace, restorable, Facilitator), Permanent Removal (no trace, irreversible, Admin). Amended **Display Link** to carry its day bound and its Draft behaviour. Surfaced by the facilitator-board-and-categorisation clarification's second pass, after a doc review found the first pass had specified against shipped code it had not consulted.
- 2026-08-30: Added **Uncategorised** and **Display Link**. Widened **Category** from Insight into Participation → Insight and bound it to one Board (no conference-level set), keeping "column" as an avoided synonym for the layout. Amended **Board View** to cover a Post-it Round in either Session kind, not Workshops only, and to state that it is read-only. Sharpened **Discard** to say it leaves a trace and is restorable until archival, and to distinguish it from an author deleting their own Post-it. Surfaced by the facilitator-board-and-categorisation clarification.
- 2026-08-29: Registered **Board** as the canonical noun for the collection of Post-its on a Post-it Round, and amended **Board View** to read against it. Surfaced by session-activities S02, which had introduced "wall" across component names, testids, CSS classes and repository seams; that surface is renamed to Board.
- 2026-08-16: Added Membership, Role Assignment, Session Assignment, Join Code, and the Conference lifecycle states (Draft / Published / Archived); recorded the **Archive** vs **Archived** overload. Surfaced by the Conference setup & schedule plan bundle, where all five became first-class specified terms.
- 2026-08-16: Initial extraction from product clarification.
