# Research — can a client observe that a Workspace account was deprovisioned?

**Retrieved 2026-08-26.** Google revises these pages without notice; re-check before relying on this.

## The question

confApp performs a silent renewal by re-issuing the authorization request with `prompt=none` and a `login_hint`. The redirect returns `?code=…` or `?error=…`. TI06 classifies that `error` value to decide whether the person's *access has ended* (clear the session, purge the offline cache) or their *Google session merely lapsed* (keep both, prompt for sign-in). Is that distinction observable?

## Finding: no

| Question | Answer | Evidence status |
|---|---|---|
| Error for a suspended/deleted Workspace account under `prompt=none`? | **Not documented anywhere.** Implied answer is `login_required` — identical to an ordinary lapsed cookie | Implied by documented rules, not stated |
| Can `invalid_grant` arrive on an authorization redirect? | **No.** Not among RFC 6749 §4.1.2.1's seven values; §5.2 defines it as a token-endpoint error; OIDC Core §3.1.2.6's nine additions do not include it; Google's own docs place it under the token endpoint | Documented, two specs + vendor |
| Is `access_denied` a deprovisioning signal? | **No.** RFC: "resource owner or authorization server denied the request". Google widens it to a user who "is not already authenticated and has not pre-configured consent" — reachable for a still-employed attendee | Documented |
| Is the token endpoint an oracle? | **No.** `invalid_grant` for many unrelated causes; `error_description` ("Token has been expired or revoked") is community-observed, undocumented, and does not distinguish admin suspension from user revocation from six-month disuse. **And an auth-code + PKCE SPA doing `prompt=none` never runs a refresh grant** — the path does not exist here | Documented generically; community for the rest |
| Google's recommended detection mechanism? | **Cross-Account Protection (RISC)** — whose page states it *"does not currently send security events for Google Workspace (formerly G Suite) users."* confApp is Workspace-only by design | Explicitly documented |

### The implication chain for `login_required`

OIDC Core §3.1.2.1: under `prompt=none` "The Authorization Server MUST NOT display any authentication or consent user interface pages. An error is returned if an End-User is not already authenticated." §3.1.2.6 defines `login_required` as "The Authorization Server requires End-User authentication." Disabling a Google account terminates its active sessions. No session ⇒ not authenticated ⇒ `login_required`.

This is inference from documented rules, not a documented statement. Google's refresh-token-invalidation list enumerates seven causes and **account suspension is not among them** — a conspicuous omission rather than a denial. No well-corroborated community report shows a distinct error value for a deprovisioned account; that is an absence of evidence, which is weaker than evidence of absence, and it is what exists.

### Delivery caveat

Google's error table does not distinguish values delivered as a redirect parameter from values rendered as a full error page. `redirect_uri_mismatch` and `deleted_client` provably cannot be redirect parameters, which proves the table mixes both channels. Google's own Handle Errors guide documents exactly **one** value, `access_denied`; the OIDC values (`login_required`, `interaction_required`, `consent_required`, `account_selection_required`) appear nowhere in Google's pages — reliance is on Google's conformance to OIDC Core, not on a Google statement.

## What this leaves standing

| Bound | Mechanism | Enforced where |
|---|---|---|
| Server-side access | A suspended account cannot be issued a new ID token; the stored one expires in ~1h; `apiRequest` refuses to send an expired token | Client + API, no cooperation needed |
| Cached schedule data | The readability window over the entry's own conference dates and last sync | Client only — advisory against a tampered device clock |
| The stored session | `docs/specs/shared-device-session-lifetime/` | Not yet implemented |

## Open question this did not settle

Whether a deployment could obtain the signal server-side via the Admin SDK Directory API. That is a scope and dependency question rather than a protocol one, and was dealbreakered out at gate 1 (no new external dependency or admin credentials). Recorded so a future revisit knows it was excluded by constraint, not by evidence.

## Sources

- OpenID Connect Core 1.0 §3.1.2.1, §3.1.2.6 — https://openid.net/specs/openid-connect-core-1_0.html
- RFC 6749 §4.1.2.1, §5.2 — https://datatracker.ietf.org/doc/html/rfc6749
- Google — Using OAuth 2.0 for Web Server Applications — https://developers.google.com/identity/protocols/oauth2/web-server
- Google — Using OAuth 2.0 to Access Google APIs (refresh-token expiration) — https://developers.google.com/identity/protocols/oauth2
- Google — Handle Errors (GIS web guides) — https://developers.google.com/identity/oauth2/web/guides/error
- Google — Protect user accounts with Cross-Account Protection (RISC) — https://developers.google.com/identity/protocols/risc
