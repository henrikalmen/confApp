# Roadmap

<!-- Themes come from `docs/PRODUCT.md` → Roadmap Themes. Features are decided downstream
     by the `andthen:prd` skill – keep this file at theme/phase altitude. -->

## Phase 1: Define
<!-- Goal: know what confApp is and what it is built on before any code is written. -->

**Success Criteria:**
- [x] `docs/PRODUCT.md` states confApp's purpose, target users, and key capabilities
- [x] Backend decision settled – serverless on Azure (`docs/DECISIONS.md`)
- [x] Mobile packaging strategy settled – Capacitor (ADR-001)
- [x] Auth settled – Google Workspace OIDC (ADR-002)
- [x] Database engine chosen – PostgreSQL (ADR-003)
- [ ] Mobile distribution channel chosen (Google Endpoint Management / Apple Business Manager / managed Play)
- [ ] Production database hosting chosen (phase 2 – see ADR-003)
- [ ] `docs/STACK.md` versions pinned

**Milestones:**
| Milestone | Target | Status |
|-----------|--------|--------|
| Product definition | – | Done (2026-08-16) |
| Platform + backend decisions settled | – | Done (2026-08-16) |
| Remaining architecture decisions closed | _TBD_ | In progress |

## Phase 2: Scaffold
<!-- Goal: a running, responsive React SPA skeleton on all three targets. -->

**Success Criteria:**
- [ ] React SPA builds and runs locally
- [ ] Responsive shell verified at phone / tablet / desktop widths
- [ ] Capacitor shells build for Android and iOS
- [ ] Employees can sign in
- [ ] Test, lint, and format commands filled into `docs/KEY_DEVELOPMENT_COMMANDS.md`
- [ ] GitHub remote configured; issue workflows functional

**Milestones:**
| Milestone | Target | Status |
|-----------|--------|--------|
| App skeleton runs on web | _TBD_ | Not started |
| App runs on Android + iOS | _TBD_ | Not started |

## Phase 3: MVP – thin end-to-end slice
<!-- Goal: run one real conference on confApp. Every theme present, none deep. -->

**Success Criteria:**
- [ ] An organizer can set up a conference with days and sessions
- [ ] Attendees see the schedule, including offline
- [ ] Both session kinds exist; workshops split into self-selected groups
- [ ] A post-it round works end to end, names attached, surviving a network blip
- [ ] A voting round works end to end, anonymous by construction
- [ ] The facilitator can project the board and sort post-its into categories
- [ ] A report can be produced for leadership

**Milestones:**
| Milestone | Target | Status |
|-----------|--------|--------|
| Conference setup + schedule | _TBD_ | Not started |
| Session activities (post-its, voting) | _TBD_ | Not started |
| Facilitator board view | _TBD_ | Not started |
| Report generation | _TBD_ | Not started |
| **First real conference run on confApp** | _TBD_ | Not started |

## Phase 4: Deepen
<!-- Goal: act on what the first real conference teaches. -->

**Success Criteria:**
- [ ] Multi-conference archive with past reports accessible
- [ ] Parallel-track scheduling exercised in practice
- [ ] Session feedback/rating loop closed into the report

## Future / Backlog
<!-- Items acknowledged but not yet scheduled -->

- Q&A upvoting (considered and set aside during clarification – not rejected outright).
- Push notification strategy beyond basic session reminders.
- Post-conference action-point follow-up (currently an anti-goal – confApp is not a task tracker).
