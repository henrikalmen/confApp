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
| **Category** | A bucket an Organizer drags Post-its into while sorting. | bucket, cluster, column, theme | Insight |
| **Discard** | Removing a Post-it from consideration during sorting. Distinct from it never having existed. | delete (ambiguous with hard deletion), reject | Insight |
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
| **Board View** | The projected big-screen view of a Workshop's Post-it board, driven by the Facilitator. | projector mode, big screen, presenter view, TV mode | Participation |
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
- 2026-08-16: Added Membership, Role Assignment, Session Assignment, Join Code, and the Conference lifecycle states (Draft / Published / Archived); recorded the **Archive** vs **Archived** overload. Surfaced by the Conference setup & schedule plan bundle, where all five became first-class specified terms.
- 2026-08-16: Initial extraction from product clarification.
