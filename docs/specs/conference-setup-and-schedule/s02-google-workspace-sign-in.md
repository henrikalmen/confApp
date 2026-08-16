# S02 – Google Workspace Sign-In

**Plan**: docs/specs/conference-setup-and-schedule/plan.json
**Story-ID**: S02

## Feature Overview and Goal

**Intent**: Nothing in confApp can make a trust decision until the API can prove, on every single request, that the caller is a named employee of the company's Google Workspace domain – without this, an app whose entire audience is "our employees" is open to anyone with a Google account.

**Expected Outcomes**

- [OC01] An employee signs in with their company Google account through the system browser, returns to confApp signed in, stays signed in across the multi-day conference without re-entering credentials, and can sign out.
- [OC02] The API refuses every request whose ID token fails signature, issuer, audience or expiry validation, **or** whose `hd` claim is not the company domain – a structurally valid Google token from any other domain is refused. Audience validation accepts any client ID on confApp's own configured allow-list and nothing else, so the web, Android and iOS client IDs all pass while a third party's does not.
- [OC03] The signed-in employee is identified by a confApp user record keyed on the stable `sub` claim, so a changed email address neither creates a second user nor loses the first.
- [OC04] Every later HTTP handler obtains its verified caller from one shared wrapper with a pinned signature, so no downstream story re-implements token validation.


## Required Context

- `docs/adrs/ADR-002-authenticate-with-google-workspace-oidc.md#decision` – binding: auth code + PKCE, system browser (never an embedded WebView), `hd` verified **server-side on the ID token** with the `hd` request parameter explicitly untrusted, `sub` as the user key with email as display data, roles never from directory groups.
- `docs/specs/conference-setup-and-schedule/prd.md#non-functional-requirements` – the Security row (`hd` claim verified server-side on **every** request), the Portability row (plain PostgreSQL only), and the Usability row (verified at 375px / 768px / 1280px). All three bind this FIS.
- `docs/specs/conference-setup-and-schedule/prd.md#constraints` – identity is the `sub` claim and email is display data only; roles are confApp's own per-conference data and are never derived from directory groups. The second half is a boundary this story must not cross, not work it performs.
- `docs/specs/conference-setup-and-schedule/prd.md#dependencies` – Google Workspace OIDC sign-in is the prerequisite "every requirement here assumes"; this story is that prerequisite, so its caller contract is consumed by S03–S09.
- `docs/specs/conference-setup-and-schedule/prd.md#fr8-offline-schedule-access` – "Cached data is cleared on sign-out and when a different user signs in on the same device." S10 owns the schedule cache; this story owns the sign-out/user-switch hook it must clear through.
- `docs/specs/conference-setup-and-schedule/plan.json#sharedDecisions` – this story **produces** "Authenticated caller context" (consumed unchanged by S03–S09) and **consumes** S01's "API route, handler and error envelope conventions"; refusals here emit that envelope rather than a bespoke shape.
- `docs/specs/conference-setup-and-schedule/plan.json#bindingConstraints` – the full constraint set for this plan; the entries applicable here are quoted above and must not be narrowed.
- `docs/adrs/ADR-004-containerized-api-and-spa.md#decision` – binding: the API is a **long-running HTTP server in a container**, not Azure Functions; no part of this story is written against the Functions programming model. Handlers still hold no state between requests – the reason is now horizontal scaling across replicas rather than transient instances.
- `AGENTS.md#do-not--never` – the four auth prohibitions (`hd` parameter is not a restriction, never key on email, never an embedded WebView, never derive roles from directory groups), plus "never rely on in-process state between requests" and "never commit `.env` files or credentials".


## Deeper Context

- `docs/ARCHITECTURE.md#data-flow` – steps 2–4 place this story: SPA acquires a token, presents it as a bearer credential, the API validates signature/issuer/audience/expiry/`hd`, then resolves per-conference role (S07). The document's Azure Functions framing predates ADR-004; read the flow, not the runtime.
- `docs/specs/conference-setup-and-schedule/s01-tracer-bullet-skeleton.md` – the concrete route layout, validation entry point and error-envelope shape this story wraps. Written by S01, which this story depends on.
- `docs/specs/conference-setup-and-schedule/prd.md#edge-cases` – the row "Employee leaves the company mid-conference | Google sign-in fails at next token refresh; access ends" is the acceptance source for the renewal-failure half of [OC01].
- `docs/guidelines/CRITICAL-RULES-AND-GUARDRAILS.md#operational-rules` – never overwrite or commit `.env`; temp files under `.agent_temp/`.


## Acceptance Scenarios

- [ ] **S01 [OC01] [TI07,TI08] Employee signs in with their company Google account and returns to confApp signed in**
  - **Given** Anna (`anna@<company-domain>`) opens confApp signed out
  - **When** she chooses Sign in and completes Google's consent screen in the top-level system browser
  - **Then** she is returned to confApp showing her name and email as signed in, and the next API call carries her ID token and is accepted

- [ ] **S02 [OC02,OC03] [TI03,TI05,TI06] A structurally valid Google ID token from a non-company domain is refused and creates no user**
  - **Given** a token that passes signature, issuer, audience and expiry validation but whose `hd` claim is `othercompany.example` (or is absent entirely, as on a consumer `@gmail.com` account)
  - **When** it is presented as the bearer credential on any API route
  - **Then** the request is refused with the shared error envelope and a machine code naming a domain refusal, the handler body never runs, and no row is created in the user table for that `sub`

- [ ] **S03 [OC02] [TI03] A token failing any of signature, issuer, audience or expiry is refused**
  - **Given** four tokens, each otherwise valid and each carrying the correct `hd`: one re-signed with an attacker key, one with `iss` set to a non-Google issuer, one with `aud` set to an OAuth client ID that is **not on confApp's configured audience allow-list** (a third party's client ID – not merely a different one of confApp's own platform IDs), one whose `exp` has passed
  - **When** each is presented in turn
  - **Then** every one is refused, each with its own machine code, and none reaches handler code – in particular an `alg: none` or otherwise unsigned token is refused rather than accepted as unverified; and a fifth token whose `aud` is a *different* entry on the same allow-list (the Android client ID rather than the web one) is **accepted**, so the allow-list is proven to admit every confApp platform and only those

- [ ] **S04 [OC03] [TI02,TI06] Identity is keyed on `sub`, so a changed email keeps one user**
  - **Given** Anna signed in once as `anna.smith@<company-domain>`, and later signs in with the same `sub` after her address changed to `anna.jones@<company-domain>`
  - **When** the second sign-in is verified
  - **Then** exactly one user row exists for that `sub`, its stored email now reads `anna.jones@…`, and a different employee whose token carries a different `sub` but a recycled address gets a separate user row

- [ ] **S05 [OC04] [TI05] A wrapped handler never executes without a verified caller**
  - **Given** an HTTP route wrapped with the shared auth wrapper
  - **When** it is called with no `Authorization` header, with a malformed bearer value, and with a token that fails validation
  - **Then** each call is refused before the handler body runs (the handler records no invocation), and each refusal uses the S01 error envelope carrying a user-facing message and a machine code

- [ ] **S06 [OC01] [TI09] The session survives token expiry, and a renewal Google refuses ends it**
  - **Given** Anna is signed in on day 2 of the conference and her ID token has passed its expiry
  - **When** she opens the app and it makes an API call
  - **Then** a fresh token is obtained without her re-entering credentials and the call succeeds; and when Google refuses the renewal because her account was deprovisioned, she is signed out with the reason shown rather than left on a silently failing screen

- [ ] **S07 [OC01] [TI10] Sign-out ends API access and fires the user-switch hook S10's cache clears through**
  - **Given** Anna is signed in on a shared tablet, and a probe is registered on the sign-out / user-switch hook (standing in for the schedule cache S10 will register there)
  - **When** she signs out and Björn then signs in on the same device
  - **Then** the stored token is gone and any API call made with it is refused, confApp shows the signed-out state, the hook fires exactly once on sign-out and once on the switch to a different `sub` – carrying the identity being cleared – and Björn's session starts from his own identity. *Whether any cached schedule data actually exists to be cleared is S10's concern, not this story's.*


## Structural Criteria

- [ ] ID-token validation exists in exactly one module; no route handler and no client code parses a JWT to make a trust decision.
- [ ] The OIDC callback refuses a response whose `state` or `nonce` does not match the initiating request, and stores no token in that case.
- [ ] Signing keys are read from Google's published JWKS via the OIDC discovery document and refreshed on an unknown `kid`; correctness never depends on an in-process cache surviving between requests or being shared across replicas (`AGENTS.md` – no in-process state between requests; ADR-004).
- [ ] The audience allow-list, hosted domain, expected issuer and redirect URI are configuration values; no client secret ships in the SPA bundle, and no `.env` file is committed.
- [ ] `aud` is validated against a configured **allow-list of confApp's own OAuth client IDs** – Google issues a distinct client ID per platform, so the web, Android and iOS IDs are separate entries. The allow-list contains no wildcard and no pattern match, is never empty, and is applied identically on every platform; there is no code path that skips or relaxes the `aud` check for mobile callers.
- [ ] `GET /api/health` remains the single unauthenticated route – it is a deployment health/readiness signal S13 depends on, so it stays anonymous by decision, not by omission. Every other route registered by this or any later story goes through the wrapper; the route table is asserted against that rule so a new anonymous route cannot be added silently.
- [ ] No part of the auth path consults Google Directory, the Admin SDK, or any group claim.
- [ ] The user table uses plain PostgreSQL only, with a unique constraint on `sub` and no uniqueness constraint on email; the migration is reversible.
- [ ] No token, token fragment, or `Authorization` header value appears in a log line or an error response body.
- [ ] The sign-in screen and signed-in shell render without horizontal scroll at 375px and rescale legibly at 768px and 1280px.


## Scope & Boundaries

### Work Areas
- SPA auth module – PKCE authorization request, redirect callback and token exchange, token storage, signed-in state, renewal, sign-out.
- SPA sign-in screen and signed-in shell affordance (responsive; sign-out control).
- API auth wrapper producing the `AuthenticatedCaller` value every later handler consumes.
- Google OIDC discovery + JWKS retrieval and ID-token verification service (signature, `iss`, `aud` against the allow-list, `exp`, `hd`).
- `app_user` table, its migration, and the upsert-on-verified-sign-in repository keyed on `sub`.
- Auth configuration surface (audience allow-list, hosted domain, issuer, redirect URI) plus `.env.example` and the `docs/KEY_DEVELOPMENT_COMMANDS.md` entries for local setup.

### What We're NOT Doing
- **Per-conference roles and any authorization beyond "is this a verified company employee"** – owned by S07; this story answers *who is calling*, never *what they may do*.
- **The mobile system-browser flow (`ASWebAuthenticationSession` / Chrome Custom Tabs) and its app redirect** – owned by S11. This story delivers the web redirect path; the verification and caller-context code it produces is shared unchanged. The one seam S11 needs is already built here: because `aud` is checked against a configured allow-list, S11 adds its Android and iOS client IDs as configuration and changes no verification code. Registering those client IDs in Google Cloud Console is S11's work, not this story's.
- **The schedule cache itself** – owned by S10. This story only exposes the sign-out / user-switch hook that S10's cache clears through.
- **A confApp-issued session token or refresh-token store** – the Google ID token is the bearer credential; introducing a second token system would duplicate the trust boundary ADR-002 already placed at Google.
- **Directory-driven user provisioning or an employee list** – users exist from their first successful sign-in; anything else would need the directory access ADR-002 rejects.


## Architecture Decision

**Approach**: The SPA runs authorization code + PKCE as a top-level browser redirect and holds no client secret; the API validates the resulting **ID token** (signature, `iss`, `aud` against an allow-list of confApp's own per-platform client IDs, `exp`, `hd`) on every request inside one `withAuth` wrapper around a plain HTTP handler. See ADRs: `docs/adrs/ADR-002-authenticate-with-google-workspace-oidc.md` (identity), `docs/adrs/ADR-004-containerized-api-and-spa.md` (the API's runtime shape).
**Why this over alternatives**: ADR-002 already rejected Entra and SWA Easy Auth; per-request bearer validation is the only shape that behaves identically in the browser and inside the Capacitor WebView shells (S11), and it keeps the domain check server-side where the `hd` request parameter cannot be tampered with.


## Technical Overview

The verified-caller contract is the artefact eight later stories depend on, so it is pinned here rather than discovered at exec time:

```ts
type AuthenticatedCaller = { userId: string; sub: string; hd: string; email: string; displayName: string };
type AuthedHandler = (req: HttpRequest, caller: AuthenticatedCaller) => Promise<HttpResponse>;
export function withAuth(handler: AuthedHandler): HttpHandler;
```

`withAuth` wraps a **plain HTTP handler** of the API server's own framework (ADR-004 – long-running container, not the Azure Functions programming model). The exact `HttpRequest` / `HttpResponse` / `HttpHandler` types are S01's, whatever framework S01 pinned; what is pinned here and must not drift is the wrapper's *shape* – one wrapper, caller passed as an argument, handler unreachable without one.

**The identity join key is `sub`.** Downstream stories (S03, S05, S06, S07, and every later one) key their rows and foreign keys on `sub`, referencing `app_user.sub`, which the Structural Criteria below constrain unique. This is the single rule – there is no "or `userId` where convenient" and no per-story choice. `userId` is confApp's own surrogate primary key for the `app_user` row and is carried on the caller for local convenience only; it is never the join key a downstream story picks. Nothing keys on `email`, ever.

`hd` is carried so a handler can assert the domain without re-parsing the token; nothing else about the token escapes the wrapper.

**Expected audience is a list, not a value.** The verification service takes a configured **allow-list** of confApp's own OAuth client IDs and accepts a token whose `aud` matches any entry:

```ts
type AuthConfig = { audienceAllowList: readonly string[]; hostedDomain: string; issuer: string; redirectUri: string };
```

Google issues a **distinct client ID per platform** – one for the web app, one for Android (bound to package name + signing-certificate fingerprint), one for iOS (bound to bundle ID) – and the token minted by the PKCE + system-browser flow carries the *platform's* client ID in `aud`. A single-value expected audience would therefore refuse every mobile sign-in the moment S11 lands. The list is never a wildcard, never a prefix or pattern match, and never bypassed or relaxed for mobile callers; it is confApp's own IDs and nothing else.


## Code Patterns & External References

```
# type | path#anchor or url                                              | why needed (intent)
file   | docs/specs/conference-setup-and-schedule/s01-tracer-bullet-skeleton.md | Route registration + error-envelope shape the wrapper must emit through
url    | https://accounts.google.com/.well-known/openid-configuration    | Discovery document – issuer and jwks_uri; do not hardcode either
url    | https://developers.google.com/identity/openid-connect/openid-connect | ID-token claim set (sub, hd, aud, iss, exp, nonce), PKCE parameters, and the rule that aud must be *one of* your app's OAuth client IDs
adr    | docs/adrs/ADR-002-authenticate-with-google-workspace-oidc.md#decision | Binding decisions: hd server-side, sub as key, system browser
adr    | docs/adrs/ADR-004-containerized-api-and-spa.md#decision          | The API is a long-running HTTP server in a container – withAuth wraps plain HTTP handlers, never Function bindings
```


## Constraints & Gotchas

- **Critical**: The `hd` **request parameter** only pre-fills Google's account chooser – any user can complete the flow from any Google account regardless of it. Only the `hd` **claim on the verified ID token** restricts the domain. Send the parameter for UX, refuse on the claim. A missing `hd` claim (consumer Google account) is a refusal, not a pass.
- **Critical**: Google **access** tokens are opaque and carry no `hd`, so they cannot be the API's credential – the bearer credential is the **ID token**, whose `aud` must match one of confApp's own OAuth client IDs. Validating the wrong token type silently removes the domain check.
- **Critical**: `aud` is checked against an **allow-list**, not a single client ID. Google's OIDC guidance is that `aud` must be *one of* the OAuth client IDs of your application, and Google issues a distinct client ID per platform (web; Android, bound to package name + signing fingerprint; iOS, bound to bundle ID). The PKCE + system-browser flow S11 builds mints tokens carrying the *platform* client ID, so a single-value expected audience refuses every mobile sign-in – and the failure surfaces in S11, not here, which is why it is pinned now. The list is confApp's own IDs only: no wildcard, no pattern, no "skip `aud` on mobile" branch. Widening it to accept any client ID would accept tokens minted for a different application entirely.
- **Avoid**: keying anything on `email`, or treating it as unique. Emails change and are reissued; only `sub` is stable (ADR-002, `prd.md#constraints`). This applies to the user table, the caller context, and every later story's foreign keys.
- **Avoid**: running the flow in an embedded WebView or an iframe – Google blocks it and it is a credential-interception risk. Web uses a top-level redirect; S11 uses the platform system browser.
- **Constraint**: the API runs as horizontally scaled container replicas and requests are not sticky (ADR-004) – JWKS caching is a per-replica optimization only. A freshly started replica with an empty cache must verify correctly, and an unknown `kid` must trigger a refetch rather than a refusal on the first key rotation. -- Workaround: cache keyed by `kid` with a bounded refetch, never a process-lifetime assumption. The rule survived the move off Functions unchanged; only its reason changed.
- **Constraint**: refusals go through S01's error envelope with a machine code, because the PRD's error handling is user-facing prose – a bare 401 with no displayable message breaks the shared convention S03–S09 build on.


## Implementation Plan

### Implementation Tasks

- [ ] **TI01** Auth configuration is external, validated at startup, and documented for local setup
  - The **audience allow-list** (one or more of confApp's own OAuth client IDs, one per platform – see **Technical Overview**), hosted domain, expected issuer and redirect URI come from environment configuration. Startup fails with a named configuration error when the hosted domain is absent, when the allow-list is empty, or when any entry is a wildcard/pattern rather than a literal client ID – rather than defaulting to "any domain" or "any audience". Add `.env.example` (never a real `.env`) documenting the allow-list as a multi-value setting, and the local-setup rows in `docs/KEY_DEVELOPMENT_COMMANDS.md`.
  - **Verify**: `Starting the API with the hosted-domain setting unset, with an empty audience allow-list, or with a wildcard entry each fails with its own named configuration error and serves no request; a two-entry allow-list starts cleanly; .env.example is tracked and no .env is`

- [ ] **TI02** An `app_user` table exists keyed on the stable `sub` claim
  - Columns: confApp id, `sub` (unique), email, display name, created/last-seen timestamps. Plain PostgreSQL only, reversible migration, no uniqueness on email.
  - **Verify**: `Test: migration applies and reverts cleanly; a second insert with an existing sub is rejected by the unique constraint; two rows sharing an email with distinct subs both insert`

- [ ] **TI03** An ID-token verification service refuses any token failing signature, issuer, audience, expiry, or the `hd` domain check
  - Single module, single entry point returning either a verified claim set or a typed refusal reason. Each failure mode carries its own machine code. `aud` is accepted when it matches **any** entry on TI01's allow-list and refused otherwise – one comparison against the list, with no platform-conditional branch that skips or relaxes it. Unsigned / `alg: none` tokens are a refusal. The decision uses token claims only – no directory, Admin SDK, or group lookup.
  - **Verify**: `Test (S02, S03): against a two-entry allow-list, a locally-signed fixture set – aud = entry one; aud = entry two; tampered signature; wrong iss; aud = a client ID absent from the allow-list; expired; hd absent; hd = othercompany.example – yields exactly two acceptances (both allow-list entries) and six refusals with distinct codes, with no outbound call other than JWKS retrieval`

- [ ] **TI04** Signing keys come from Google's discovery document and survive key rotation without in-process assumptions
  - Discover `jwks_uri` from the well-known document; cache by `kid` per instance only; an unknown `kid` triggers one refetch before refusal. Consumes TI03's verification entry point.
  - **Verify**: `Test: verification succeeds against a cold, empty cache; an unknown kid causes exactly one JWKS refetch, and a kid still unknown after refetch is refused rather than accepted`

- [ ] **TI05** A `withAuth` wrapper is the only way a handler obtains its caller
  - Signature and `AuthenticatedCaller` shape exactly as pinned in **Technical Overview**, wrapping a plain HTTP handler of S01's framework (ADR-004 – no Functions bindings) – this is the `sharedDecisions` artefact S03–S09 consume, and `sub` is the join key it hands them. Uses TI03 for verification and TI06 for the user row; refuses through S01's error envelope; never logs the token or `Authorization` value. Every registered route is wrapped except `GET /api/health`, which stays anonymous as S13's readiness signal.
  - **Verify**: `Test (S05): a wrapped probe handler records no invocation for a missing, malformed, invalid, or wrong-domain credential; each response body carries the S01 envelope's message and machine code; neither response bodies nor log output contain the token or Authorization value; no route module imports the JWT verification library directly; an assertion over the registered route table names GET /api/health as the only unwrapped route`

- [ ] **TI06** A verified first sign-in creates the user row, and later sign-ins update display data on the same row
  - Upsert on `sub` (TI02); email and display name are refreshed as display data. A refused token never reaches this step. Wrapper (TI05) resolves `userId` from here.
  - **Verify**: `Test (S02, S04): two verifications with one sub and different emails leave one row with the newer email; a refused wrong-domain token leaves the table unchanged`

- [ ] **TI07** The SPA initiates authorization code + PKCE in the top-level browser with no client secret
  - Authorization request carries `code_challenge_method=S256`, a per-attempt `state` and `nonce`, `scope=openid email profile`, and the `hd` parameter as a UX hint only. Top-level navigation – no iframe, no WebView.
  - **Verify**: `Test: the generated authorization URL contains code_challenge_method=S256 plus distinct per-attempt state and nonce values; the production bundle contains no client secret; navigation is top-level`

- [ ] **TI08** The redirect callback exchanges the code, rejects a mismatched `state` or `nonce`, and establishes signed-in state
  - Verifier from TI07's attempt; on success store the ID token and expose signed-in state so API calls attach it as a bearer credential.
  - **Verify**: `Test (S01): a callback whose state does not match the initiating request stores no token and surfaces a sign-in error; a matching callback yields a signed-in session whose next API call is accepted`

- [ ] **TI09** An expiring token renews without re-prompting, and a refused renewal ends the session with a reason
  - Renew ahead of expiry and on an expiry refusal from the API; when Google refuses the renewal (deprovisioned account), sign out and state why rather than looping. Consumes TI08's session state.
  - **Verify**: `Test (S06): an expired stored token is renewed and the retried API call succeeds without user interaction; a renewal refused by Google leaves the app signed out with the reason displayed`

- [ ] **TI10** Sign-out clears the token and user-scoped device state, and a different user signing in starts clean
  - Clearing exposes the hook S10's schedule cache registers with – sign-out and user-switch both fire it, carrying the `sub` being cleared. This story owns the hook and its firing; S10 owns what is registered on it. Access ends at the next request; no server-side eviction.
  - **Verify**: `Test (S07): after sign-out no token remains and an API call made with the previous token is refused; a probe registered on the hook is invoked exactly once on sign-out and once when a different sub signs in, each time with the sub being cleared`

- [ ] **TI11** The sign-in screen and signed-in shell are legible across the three target widths
  - Follows the responsive shell from S01. Sign-out control reachable one-handed on a phone.
  - **Verify**: `Screenshots at 375px, 768px and 1280px show the sign-in screen and signed-in shell with no horizontal scroll and no clipped controls`

### Testing Strategy

- ID-token tests must not call Google. Generate fixtures with a locally-generated key pair and serve a stub JWKS, so signature, `iss`, `aud`, `exp` and `hd` failures are each provable in isolation and `hd` cannot be accidentally satisfied by a real account. `[TI03,TI04]`
- The wrong-domain and unsigned-token cases are the two that silently pass if verification is stubbed – assert them against the real verification path, never a mocked verifier. `[TI03,TI05]`
- Fixtures must exercise the audience allow-list from **both** sides: a token minted for a second allow-list entry is accepted (the case a single-value check would wrongly refuse, breaking S11), and a token minted for a client ID outside the list is refused. A one-entry allow-list in tests proves neither. `[TI01,TI03]`


## Final Validation Checklist

- [ ] A token that is cryptographically valid but carries no `hd`, or a foreign `hd`, is refused by the running API – demonstrated end to end, not only in unit tests.
- [ ] No `.env`, client secret, or token value appears anywhere in the committed tree or in log output.
- [ ] The running API accepts a token whose `aud` is any configured allow-list entry and refuses one whose `aud` is outside it, with no platform-conditional branch anywhere in the verification path – S11 must be able to sign in on Android and iOS by adding configuration only.


## Implementation Observations

> _Managed by exec-spec post-implementation – append-only. Spec authors: leave this section empty._

_No observations recorded yet._
