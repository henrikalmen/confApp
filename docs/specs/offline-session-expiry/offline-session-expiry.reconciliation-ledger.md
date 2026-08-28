# Reconciliation Ledger

> Durable, greppable record of deliberate spec-vs-code drift. Entries are written by implementation and remediation skills and transitioned by review / remediation. See `reconciliation-ledger.md` for the schema, stable-ID derivation, status lifecycle, and match/recurrence/escalation rules.

## Entries

### web/src/auth/session.ts:design-changed:refusal-clearing-narrowed-to-silent-renewals-only-structural-criterion-4-still-states-the-broader-rule
- Status: RECONCILED
- Reconciled: 2026-08-26 by ADR-005 (`docs/adrs/ADR-005-bound-access-by-time-not-by-refusal-code.md`); the FIS was amended via the `design-change` form in the same pass, which supersedes the drift rather than merely acknowledging it.
- Class: design-changed
- Stale targets: docs/specs/offline-session-expiry/offline-session-expiry.md#structural-criteria (item 4), docs/specs/offline-session-expiry/offline-session-expiry.md#acceptance-scenarios (S08), docs/specs/offline-session-expiry/offline-session-expiry.md#implementation-plan (TI06 Verify line, which restates the unqualified rule)
- Source run: remediate-2026-08-25
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-25
- Updated: 2026-08-25
- Notes: Refusal clearing narrowed to silent renewals only; Structural Criterion 4 still states the broader rule. Structural Criterion 4 of `docs/specs/offline-session-expiry/offline-session-expiry.md` reads: "invalid_grant and access_denied clear the session and purge as today". Remediation of review finding M-2 changed `web/src/auth/session.ts` to compute `grantRefused` as `attempt.silent && GRANT_REFUSED.has(error)`, so `access_denied` now clears ONLY on a silent renewal. Reason: `access_denied` is what Google returns when a person closes the account chooser or declines consent on an INTERACTIVE sign-in, which says nothing about entitlement and is reachable from the two "Sign in again" controls this feature adds; clearing there fires the hook AuthProvider purges the whole offline schedule cache on, destroying every cached schedule because somebody cancelled a dialog. The narrowing is defensible on its merits but the criterion was not amended, so the FIS and the code now disagree on record and the next gap review will re-derive it as a fresh finding. Coupled to open finding H-5: `invalid_grant` is an RFC 6749 section 5.2 token-endpoint code and cannot arrive at the authorization-redirect branch at all, so the clearing set may now have no reachable production trigger. Both must be settled together against Google's documented `prompt=none` error codes before the criterion is rewritten.

### web/src/auth/AuthProvider.tsx:design-changed:renewal-trigger-moved-out-of-the-attendee-panel-to-the-shell-ti05-still-names-the-panel-as-its-location
- Status: OPEN
- Note 2026-08-26: **not** closed by ADR-005. That decision amends TI06, S08, OC03 and Structural Criteria 4/5/6; it does not touch TI05, the Work Areas, or the Testing Strategy note that still name `AttendeeSchedulePanel.tsx` as the renewal trigger's home. This drift stands until TI05 is amended in its own right.
- Class: design-changed
- Stale targets: docs/specs/offline-session-expiry/offline-session-expiry.md#implementation-plan (TI05, and its Verify line naming AttendeeSchedulePanel.tsx), docs/specs/offline-session-expiry/offline-session-expiry.md#scope--boundaries (Work Areas: the credential-path and attendee-panel entries), docs/specs/offline-session-expiry/offline-session-expiry.md#testing-strategy (TI01 and TI05 assert on the renewal entry point, not on rendered output)
- Source run: remediate-c1-2026-08-25
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-25
- Updated: 2026-08-25
- Notes: Renewal trigger moved out of the attendee panel to the shell; TI05 still names the panel as its location. TI05 of the FIS reads: renewal is "Invoked from the reconnect path in `AttendeeSchedulePanel.tsx` that has just completed a successful request". Implemented that way, the trigger was additionally gated on the poll rendering cached data, so it was unreachable from a live (online) attendee view and from every organizer surface — an attendee online all day and any organizer silently lost API access an hour after signing in, with no renewal and no recovery short of a reload. That was review finding C-1 (CRITICAL, converged across three independent reviewers). The fix moves the trigger: `web/src/api/client.ts` now exposes a `setCredentialMissingListener` seam that `apiRequest` invokes when an authenticated request cannot be issued for want of a credential, and `web/src/auth/AuthProvider.tsx` registers the probe-and-renew coordinator on it, once per page load. The panel keeps no renewal logic at all and `web/src/auth/session-actions.ts` no longer carries a renew seam. The substantive rule TI05 exists to enforce is unchanged and is asserted in the same terms — renewal fires only after the anonymous `/health` route has actually answered, never from `navigator.onLine` — so Structural Criterion 1 still holds and is now proven at the shell rather than at the panel. What changed is the location, and TI05, the Work Areas list, and the Testing Strategy note that pins S04 at the panel all still describe the old one. Note also that the probe itself remains unreconciled and defective in a separate way: review finding H-3 (a captive portal answering 200 text/html satisfies `fetchHealth`, because `apiRequest` returns an unparseable 200 as null) is still open and now applies to the shell coordinator instead of the panel.
