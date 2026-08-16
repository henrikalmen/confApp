# Product Vision: confApp

> **Source Trust**: trusted-local

## Vision

confApp is an internal mobile and web application for running a company's own 1–4 day conferences. It carries a conference end to end: an organizer sets up the schedule and its sessions, attendees follow their agenda and take part in presentations and workshops from their phones, and everything the conference produces – ideas, priorities, sentiment – is captured as it happens rather than reconstructed afterwards. The change it makes: a conference stops being a few days that evaporate into a photo of a post-it wall, and becomes a structured record that leadership can act on.

## Problem Statement

The company runs internal conferences today with no supporting tooling at all. Three things break as a result:

- **Workshop output is lost.** Brainstorming happens on physical post-its. Someone photographs the wall, and the ideas rarely survive contact with the following week.
- **Leadership has no honest read on sentiment.** There is no structured way to ask the whole company what it thinks about a decision, a market, or the company's direction – and no way to be confident the answers are candid.
- **Nothing produces follow-up.** Action points that surface in a workshop depend on whoever happened to write them down.

There is no incumbent tool to displace. The alternative today is email, slides, and memory.

## Target Users & Personas

- **Organizer (Admin)** – runs the conference. Sets it up, builds the schedule and sessions, sorts collected post-its into categories, discards noise, and produces the report. Wants the event to run without them being a bottleneck on the day.
- **Presenter / Facilitator** – runs a single session. A presenter gives a talk and may poll the room; a facilitator runs a workshop, splits it into group activities, and drives post-it and voting rounds. Needs control over their own session without conference-wide admin rights.
- **Attendee** – a company employee. Follows the schedule, self-selects into workshop groups, contributes named post-its, and votes anonymously. On a phone, in a room, with limited patience for friction.
- **Owner / Leadership** – does not attend as a user so much as consume the output. Reads the report to extract action points, follow-ups, and a read on how satisfied employees are with decisions, markets, and the company's direction.

## Value Propositions

- Workshop ideas survive the conference as **categorized, attributed output** – not a photograph.
- Leadership gets an **honest sentiment signal**, because voting is anonymous by construction rather than by policy.
- Organizers get a report **without manually transcribing** a post-it wall.
- Attendees carry one app that answers "where am I supposed to be, and what am I doing in this session".
- Each conference leaves an **archive** – past conferences and their reports remain available, so follow-ups can be checked against what was actually said.

## Product Principles

- **Post-its are named; votes are anonymous.** These are two different functions and the distinction is never blurred. Named ideas enable discussion and follow-up; anonymous votes enable honesty.
- **Room-first.** Much of the value happens with people physically together. The projected facilitator view is a first-class surface, not a desktop afterthought.
- **Near-live is enough.** A few seconds of latency is acceptable everywhere. Do not pay the complexity cost of hard real-time.
- **The report is the point.** Features earn their place by what they contribute to the conference's output.
- **One codebase, three targets.** Browser, Android, and iOS from the same React application.

## Anti-Goals

- **Not a public or consumer product** – internal employees only.
- **Not a general-purpose whiteboard.** Post-its exist inside workshop activities. confApp is not competing with Miro or Mural for open-ended canvas work.
- **Not a task tracker.** The report surfaces action points; it does not own their lifecycle afterwards.
- **Not a video conferencing or streaming platform.** confApp assumes people are in the room.
- **Not fully offline.** Schedule viewing works without a connection and post-its survive a network blip, but the app assumes connectivity.
- **Not an external event platform** – no ticketing, no registration, no public attendee marketing.

## Success Metrics

### North Star
- **Conferences that produce a leadership-accepted report containing action points.** The product works when the output is used, not when the app is opened.

### Leading Indicators
- Share of attendees contributing at least one post-it in a workshop they attend.
- Poll response rate per session (an anonymous vote has no excuse not to be answered).
- Share of sessions that run at least one activity (poll or post-it) rather than being schedule-only.
- Workshop groups filled by self-selection without facilitator intervention.
- Post-its surviving categorization rather than being discarded – a proxy for signal over noise.

## Strategic Constraints

- **Business**: internal tool for a company of under 100 employees. No external revenue, no hard deadline. Reused for a new conference each time rather than rebuilt.
- **Regulatory**: employee data under GDPR. The anonymity guarantee on voting is a **hard** constraint, not a UI convention – votes must be genuinely unlinkable to the voter in storage, not merely hidden in the interface. Named post-its and anonymous votes therefore have different privacy and retention handling.
- **Technical**: React SPA packaged with Capacitor for Android and iOS (ADR-001); serverless Azure backend (Functions + Static Web Apps); sign-in via Google Workspace OIDC (ADR-002) – the company runs on Google, so identity does not follow the cloud provider; near-live updates acceptable; partial offline support required (schedule reads, post-it queueing).

## Roadmap Themes

<!-- Themes, not features. Features are decided downstream in andthen:prd. -->

- **Conference setup & schedule** – creating a conference, its days, and its sessions; attendees seeing where to be. Mostly sequential sessions, with parallel tracks supported as an option. Unlocks everything else.
- **Session activities** – presentations and workshops as containers for zero or more voting rounds and zero or more post-it rounds. The unit of participation.
- **Workshop groups** – splitting a workshop into smaller self-selected groups running in parallel.
- **Facilitator & room experience** – the projected board view, running activities live, managing a session in front of people.
- **Insight & reporting** – categorization, prioritization, and the leadership-facing report. The theme the north star depends on.
- **Multi-conference archive** – past conferences and reports remaining available over time.

## Open Questions

- What format does the report take – exportable PDF, a shareable in-app link, or both?
- Are post-it categories defined during conference setup, or created ad hoc by the organizer while sorting?
- Do self-selected workshop groups have capacity limits, and what happens when an attendee picks a full group?
- Can attendees see poll results themselves, or only the facilitator and the report?
- Area to revisit: how far confApp follows an action point after the conference – what would sharpen it is knowing whether leadership tracks follow-ups inside the app or exports them into an existing process.

## Decisions Log

| Decision | Rationale | Date |
|----------|-----------|------|
| Internal conference app for company-run 1–4 day conferences | Core product identity, confirmed by the user | 2026-08-16 |
| Reused for many conferences over time, not a single event | Setup flow is reusable; past reports stay accessible as an archive | 2026-08-16 |
| Three roles: Admin, Presenter/Facilitator, Attendee | A facilitator needs to run their own session without conference-wide admin rights | 2026-08-16 |
| Two session kinds: presentation and workshop | Stated requirement; workshops additionally support groups | 2026-08-16 |
| A session contains one or more voting rounds and/or one or more post-it rounds | Activities are containers within a session, not properties of it | 2026-08-16 |
| Post-its always carry the author's name | They exist to drive discussion and follow-up, which needs attribution | 2026-08-16 |
| Voting is always anonymous | Sentiment reaches the owner and leadership; attributed answers would skew positive. Different function from post-its | 2026-08-16 |
| Workshop groups are self-selected by attendees | User preference over facilitator assignment or randomization | 2026-08-16 |
| Sessions mostly sequential; parallel tracks supported as an option; workshop groups run in parallel | Matches how the company actually runs conferences | 2026-08-16 |
| Near-live updates (seconds of delay acceptable) | Avoids hard real-time infrastructure cost; adequate for brainstorming and polls | 2026-08-16 |
| A projected facilitator/big-screen view is in scope | Sorting post-its into categories is a group activity visible to the room | 2026-08-16 |
| Partial offline: schedule readable offline, post-its queue through a network blip | Reverses the earlier blanket "offline not important"; conference venue wifi is unreliable and a lost idea is unrecoverable | 2026-08-16 |
| MVP is a thin end-to-end slice | Proves the whole loop at one real conference before deepening any part | 2026-08-16 |
| Employees join a conference by entering a join code | Chosen over automatic access for every company account and over explicit invitation lists. Low admin overhead; the code selects a conference rather than granting authority, since Google sign-in already restricts to employees | 2026-08-16 |
| Sessions carry a location | "Where am I supposed to be" is the core attendee question, unanswerable once sessions or workshop groups run in parallel | 2026-08-16 |
| Conferences have a draft → published → archived lifecycle | Stops attendees seeing half-built agendas and asking about sessions that get deleted | 2026-08-16 |
| Published schedules stay editable, notifying only affected attendees | Conferences slip; notifying everyone about every change trains people to ignore notifications | 2026-08-16 |
