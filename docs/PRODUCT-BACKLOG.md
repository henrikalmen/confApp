# Product Backlog

<!-- REQ-IDs are the traceability anchor: PRDs and FIS files reference them.
     Derived from `docs/PRODUCT.md` (clarified 2026-08-16). -->

## Validated
<!-- Requirements confirmed and accepted for implementation. -->

| REQ-ID  | Description | Priority | Stories | Status    |
|---------|-------------|----------|---------|-----------|
| REQ-001 | Runs as a React single-page app in the browser | Must | – | Planned |
| REQ-002 | Runs on Android and iOS from the same codebase | Must | – | Planned |
| REQ-003 | UI rescales responsively across phone, tablet, and desktop viewports | Must | – | Planned |
| REQ-004 | Distributed to employees through the app stores (channel TBD) | Must | – | Planned |
| REQ-005 | Push notifications on iOS and Android via native APNs/FCM | Must | – | Planned |
| REQ-006 | Employees sign in with their company identity | Must | – | Planned |
| REQ-007 | An organizer can create a conference spanning 1–4 days | Must | – | Planned |
| REQ-008 | A conference has a schedule of sessions; confApp holds many conferences over time | Must | – | Planned |
| REQ-009 | Sessions are of two kinds: presentation and workshop | Must | – | Planned |
| REQ-010 | A session contains zero or more voting rounds and zero or more post-it rounds | Must | – | Planned |
| REQ-011 | Workshops split into smaller groups running in parallel | Must | – | Planned |
| REQ-012 | Attendees self-select their workshop group | Must | – | Planned |
| REQ-013 | Attendees add post-it notes during a post-it round | Must | – | Planned |
| REQ-014 | Post-its always display the author's name | Must | – | Planned |
| REQ-015 | An organizer categorizes collected post-its by dragging them between categories | Must | – | Planned |
| REQ-016 | An organizer can delete or discard a post-it | Must | – | Planned |
| REQ-017 | Voting is available in both presentations and workshops | Must | – | Planned |
| REQ-018 | Votes are anonymous — unlinkable to the voter in storage, not merely hidden in the UI | Must | – | Planned |
| REQ-019 | Voting supports live polls during a session | Must | – | Planned |
| REQ-020 | Voting supports prioritizing post-its / ideas | Must | – | Planned |
| REQ-021 | Voting supports feedback and rating on sessions | Should | – | Planned |
| REQ-022 | A facilitator can project a big-screen board view of the post-its to the room | Must | – | Planned |
| REQ-023 | A report is produced per conference for the owner and leadership | Must | – | Planned |
| REQ-024 | The report carries action points, follow-ups, poll results, and workshop output | Must | – | Planned |
| REQ-025 | Three roles are distinguished: Admin, Presenter/Facilitator, Attendee | Must | – | Planned |
| REQ-026 | Updates are near-live — a few seconds of latency is acceptable | Must | – | Planned |
| REQ-027 | The schedule is readable without a network connection | Should | – | Planned |
| REQ-028 | A typed post-it survives a network blip and syncs when connectivity returns | Should | – | Planned |
| REQ-029 | Sessions may optionally run in parallel tracks | Should | – | Planned |

## Active (Under Discussion)
<!-- Requirements being refined or awaiting validation. -->

| REQ-ID  | Description | Priority | Open Questions |
|---------|-------------|----------|----------------|
| REQ-030 | Report export format | Should | PDF, shareable in-app link, or both? |
| REQ-031 | Post-it category definition | Must | Defined at conference setup, or created ad hoc while sorting? |
| REQ-032 | Workshop group capacity | Could | Do groups have size limits, and what happens when one is full? |
| REQ-033 | Conference access | Must | Automatic for anyone with a company Google account, or by explicit invitation? |
| REQ-034 | Poll result visibility | Should | Can attendees see results, or only the facilitator and the report? |

## Out of Scope
<!-- Explicitly excluded requirements – useful to prevent scope creep. See `docs/PRODUCT.md` → Anti-Goals. -->

- General-purpose whiteboarding (Miro/Mural territory) – post-its exist only inside workshop activities.
- Action-point lifecycle tracking after the conference – the report surfaces them; confApp does not own them.
- Video conferencing or session streaming – confApp assumes people are in the room.
- Ticketing, registration, or public attendee marketing – internal employees only.
- Full offline operation – limited to schedule reads and post-it queueing.
- Q&A upvoting – considered during clarification and set aside for now (deferred, not rejected).
