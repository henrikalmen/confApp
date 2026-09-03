# Reconciliation Ledger

> Durable, greppable record of deliberate spec-vs-code drift. Entries are written by implementation and remediation skills and transitioned by review / remediation. See `reconciliation-ledger.md` for the schema, stable-ID derivation, status lifecycle, and match/recurrence/escalation rules.

## Entries

### docs/specs/facilitator-board-and-categorisation/s04-display-link-issuance-and-revocation.md:ambiguous-intent:the-projected-view-renders-any-server-message-not-only-the-neutral-refusal-and-the-constant-that-would-gate-it-is-unused
- Status: CLOSED
- Class: ambiguous-intent
- Stale targets: –
- Source run: exec-plan-s04-display-link-issuance-and-revocation-2026-08-31T09:31:04Z-11e2db56
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-31
- Updated: 2026-08-31
- Notes: L5 (LOW, Critic). `DISPLAY_LINK_UNAVAILABLE_CODE` was exported from `web/src/api/client.ts` with a docblock saying it exists so the display surface renders the refusal "without inventing a second wording", and nothing referenced it – one grep hit, the declaration. The refusal branch in `web/src/display/DisplayBoardView.tsx` instead rendered whatever message any answered failure carried, so a 500's internal-error string or a proxy's 502 text could reach a wall in front of a room. The unused export read as either an oversight or a deliberate hand-off to S07, which is why the class is `ambiguous-intent` rather than `code-defect`. Resolved as an oversight and closed in code, not by documentation: the surface now branches on `error.code === DISPLAY_LINK_UNAVAILABLE_CODE` for the constant sentence and gives every other answered failure one neutral sentence that discards the server's words. The export is consumed, and the "one sentence and nothing else" discipline is enforced client-side rather than delegated to whatever answers.

### docs/specs/facilitator-board-and-categorisation/s04-display-link-issuance-and-revocation.md:design-changed:concurrent-double-issue-on-one-round-surfaces-as-a-500
- Status: CLOSED
- Class: design-changed
- Stale targets: –
- Source run: exec-plan-s04-display-link-issuance-and-revocation-2026-08-31T09:31:04Z-11e2db56
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-08-31
- Updated: 2026-08-31
- Notes: L6 (LOW). `issue` in `api/src/rounds/display-link-repository.ts` is revoke-then-insert; under READ COMMITTED a second concurrent issue blocks on the row lock, re-evaluates `revoked_at is null`, matches nothing and inserts, colliding with the winner on `display_link_one_live_per_round`. Recorded deliberately as an accepted trade-off so nobody later reads the 500 as a defect: the partial unique index is the backstop that makes "one live link per Round" true whatever the code does, the issuing control is `disabled={busy}` while in flight, and two Facilitators pressing Issue in the same millisecond is not a case the product needs to survive gracefully. The remediation did absorb the constraint violation by re-reading the live link; a *token* collision is deliberately still loud, because 256 bits repeating must not be swallowed.

### docs/specs/facilitator-board-and-categorisation/s04-display-link-issuance-and-revocation.md:code-defect:g29-url-spelling-token-leak
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: review-gap-facilitator-board-and-categorisation-rereview-2026-09-02T06:23:51Z-354111a7
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-09-02
- Updated: 2026-09-02
- Notes: G29 (source: `facilitator-board-and-categorisation-gap-review-claude-2026-09-02-rereview.md`). A live Display Link token reached nginx access logs and API 404 response bodies through URL spellings that no gate normalised. Verified against a real `nginx:alpine`: of four spellings tested, three leaked, and `/DISPLAY/<token>` returned **200** while writing the raw token to the log. On the API side, raw-socket probes found `/%61pi/display/<t>`, `/api/%64isplay/<t>`, `/api/display%2f<t>`, `/api%2Fdisplay/<t>`, `/./api/display/<t>`, `/foo/../api/display/<t>` and `/api/./display/<t>` reaching the log, the body, or both – `find-my-way` percent-decodes for matching but hands the handler the raw `request.url`. Closed three ways: `routeNotFound` no longer echoes the request path at all (the root fix, covering spellings nobody has thought of); `isDisplayPath` now decodes percent-escapes repeatedly, resolves `.`/`..`, strips control characters, collapses separators and folds case, deliberately over-matching because a false positive costs a redundant log line while a false negative writes a credential to disk; and the nginx map is case-insensitive and tolerant of repeated separators and literal `%2f`. Verified after the fix in a real container: seven spellings, zero raw tokens, seven redacted lines, `nginx -t` clean. Pinned by `never echoes or logs the token, whatever slashes or casing the URL carries` over eleven spellings, proved red.

### docs/specs/facilitator-board-and-categorisation/s04-display-link-issuance-and-revocation.md:code-defect:g30-error-log-directive-untested
- Status: CLOSED
- Class: code-defect
- Stale targets: –
- Source run: review-gap-facilitator-board-and-categorisation-rereview-2026-09-02T06:23:51Z-354111a7
- Recurrence: 1
- Falsifier: –
- Override reason: –
- Created: 2026-09-02
- Updated: 2026-09-02
- Notes: G30 (source: `facilitator-board-and-categorisation-gap-review-claude-2026-09-02-rereview.md`). The nginx `error_log … crit;` directive genuinely closes the error-log half of the G29 leak – confirmed in a real container, one token occurrence to zero – but **no test asserts the directive exists**, so deleting it leaves the suite green. The prior report's own acceptance criterion required a `display-build.test.ts` assertion and it was not written. **Revert-recipe proving the gap is real** (this is not a withdrawal falsifier – the entry is OPEN): remove the `error_log` line from `web/nginx/default.conf.template` and run `npm test`; nothing goes red. Note also the operational cost the fix carries, which the code comment currently understates: the suppressed `[error]` lines carried the *cause* of an outage (`api could not be resolved (110: Operation timed out)`), and the access log carries only the 502. Left OPEN deliberately – the owner scoped the second remediation pass to the credential leak only. **Closed 2026-09-02 (test added; the directive had shipped working but unasserted, so the fix is a test rather than a behaviour change).** The directive is now asserted by `silences the served image's error log above crit, where the token cannot be redacted` in `web/test/display-build.test.ts`, which checks three things: that an explicit `error_log` directive exists at all; that its level is one of `crit`, `alert` or `emerg`; and that it sits inside the server block, so a location added later cannot inherit a noisier default by omission. The level is asserted as a **set** rather than as the literal `crit`, so a deliberate move to `alert` is not a false failure – but `error` and below are refused, because nginx logs the named level *and above* and `[error]` is exactly where the request line carrying the token is written. That is the case that matters: someone lowering the level to "see the errors again" reintroduces the leak, and this is what stops them. Both falsifications were run: deleting the line fails with `an explicit error_log directive should be declared: expected null not to be null`, and lowering the level to `error` fails with `expected [ 'crit', 'alert', 'emerg' ] to include 'error'`. Re-confirmed in a real `nginx:alpine` with a refusing upstream: config valid, zero raw tokens in any container log, and the 502 still visible as `"GET /api/display/<token> HTTP/1.1" 502`. Changed: `web/test/display-build.test.ts`.
