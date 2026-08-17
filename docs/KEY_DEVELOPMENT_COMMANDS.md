# Key Development Commands

<!-- Keep commands up to date as the project evolves.
     Every command listed here has been run as written from a clean checkout. -->

**Prerequisites**: Node.js 24+ (`.nvmrc` pins 24), Docker Engine with the Compose plugin, and
a `.env` file – `cp .env.example .env` and adjust. `.env` is never committed.

## First run, from a clean clone

```sh
npm ci
cp .env.example .env        # then edit the password and the Google sign-in settings
docker compose up -d        # builds the images on first run
npm run migrate:up          # creates the schema; required before the API is healthy
```

The API **refuses to start** until `GOOGLE_HOSTED_DOMAIN` and `GOOGLE_AUDIENCE_ALLOWLIST` are
set, and says which one is missing. That is deliberate: defaulting either of them would mean
serving with the domain or audience check effectively disabled. See *Google sign-in setup*
below.

Then open the application URL below. Until `migrate:up` has run, `GET /api/health` answers
`503 DATABASE_UNAVAILABLE` and the app shows that message – that is the expected empty-database
state, not a failure.

## Running the Application
| Command | Description |
|---------|-------------|
| `docker compose up -d` | Start the whole stack – SPA container, API container, PostgreSQL |
| `docker compose up -d --build` | Same, rebuilding the images after a source change |
| `docker compose ps` | Show container status and published ports |
| `docker compose logs -f api` | Follow the API logs (`db` / `web` for the others) |
| `docker compose down` | Stop and remove the containers. **Keeps** the named volume – the database and every row in it survive |
| `docker compose down -v` | Stop and remove the containers **and delete the named volume**. This destroys the local database and every row in it. Use it for a deliberate clean rebuild; `migrate:up` is required afterwards |
| `npm run dev:api` | API only, on the host, watching `api/src` (needs the database up) |
| `npm run dev:web` | SPA only, on the host, with Vite HMR; proxies `/api` to `http://localhost:8080` |

Application URL (composed stack): `http://localhost:8082`
Application URL (`npm run dev:web`): `http://localhost:5173`
API directly (composed stack): `http://localhost:8081/api/health`

Host ports come from `.env` (`WEB_HOST_PORT`, `API_HOST_PORT`, `POSTGRES_HOST_PORT`). The
database defaults to **5434** rather than 5432 so it does not collide with a natively
installed PostgreSQL.

## Google Sign-In Setup (S02)

One-time, per developer. Everything below lives in `.env`, which is never committed.

1. In **Google Cloud Console → APIs & Services → Credentials**, create an **OAuth client ID**
   of type *Web application*.
2. Add `http://localhost:8082/auth/callback` as an **Authorized redirect URI** (add
   `http://localhost:5173/auth/callback` too if you use `npm run dev:web`). The value must
   match `GOOGLE_REDIRECT_URI` exactly – Google compares it character for character.
3. Copy the client ID and client secret into `.env`.

| Variable | What it is |
|----------|------------|
| `GOOGLE_HOSTED_DOMAIN` | The Workspace domain allowed to sign in. Verified server-side on the ID token's `hd` claim; the `hd` request parameter restricts nobody. **No default – the API refuses to start without it.** |
| `GOOGLE_AUDIENCE_ALLOWLIST` | Comma-separated list of confApp's **own** OAuth client IDs, one per platform. S11 appends its Android and iOS IDs here and changes no code. Literal IDs only – a wildcard entry is refused at startup. **No default.** |
| `GOOGLE_WEB_CLIENT_ID` | The web client ID. Public; also served to the browser. |
| `GOOGLE_WEB_CLIENT_SECRET` | The web client secret. **API only** – Google's token endpoint requires it for a web client, which is why the API brokers the code exchange and the SPA never sees it. |
| `GOOGLE_REDIRECT_URI` | Must match a redirect URI registered on the OAuth client. |

Startup failures are named, so the message says which setting is wrong:

| Error | Cause |
|-------|-------|
| `MissingHostedDomainError` | `GOOGLE_HOSTED_DOMAIN` unset |
| `EmptyAudienceAllowListError` | `GOOGLE_AUDIENCE_ALLOWLIST` unset or empty |
| `WildcardAudienceError` | An allow-list entry is a wildcard or pattern rather than a literal client ID |
| `MissingAuthSettingError` | `GOOGLE_REDIRECT_URI`, `GOOGLE_WEB_CLIENT_ID` or `GOOGLE_WEB_CLIENT_SECRET` unset |

Verifying it end to end:

```sh
curl -i http://localhost:8081/api/me                          # 401 AUTH_CREDENTIAL_MISSING
curl -i -H 'Authorization: Bearer not-a-token' \
     http://localhost:8081/api/me                             # 401 AUTH_TOKEN_MALFORMED
```

Signing in through the browser at `http://localhost:8082` and then calling `/api/me` with the
resulting token returns your `sub`, email and display name. A Google account outside
`GOOGLE_HOSTED_DOMAIN` is refused with `403 AUTH_DOMAIN_NOT_ALLOWED`, and a consumer
`@gmail.com` account with `403 AUTH_DOMAIN_CLAIM_MISSING`.

## Code Quality (Formatting, Linting, Type Checking)
| Command | Description |
|---------|-------------|
| `npm run format` | Format code with Prettier |
| `npm run format:check` | Check formatting without writing |
| `npm run lint` | Lint with ESLint |
| `npm run lint:fix` | Lint and apply fixable corrections |
| `npm run typecheck` | Type-check every workspace (`tsc --build`) |

## Testing
| Command | Description |
|---------|-------------|
| `npm test` | Run all tests – both workspaces |
| `npm test -- <pattern>` | Run a specific test file, e.g. `npm test -- error-envelope` |
| `npm test -- --project api` | Run only the API tests (`web` for the SPA tests) |
| `npm run test:watch` | Run tests in watch mode |
| `bash scripts/verify-stack.sh` | Compose-level durability checks. **Destructive**: it runs `docker compose down -v` and resets the local database |

The integration tests in `api/test/database.integration.test.ts` need PostgreSQL running and use
their **own** database (`TEST_DATABASE_URL`), never the development one – their migrate-down
cycle would otherwise destroy your working data. With no database reachable they skip with a
warning rather than failing, so `npm test` still passes on a clean checkout.

## Database & Migrations
| Command | Description |
|---------|-------------|
| `npm run migrate:up` | Apply all pending migrations. Safe to re-run: already-applied migrations are recorded in the database and skipped |
| `npm run migrate:down` | Revert the most recent migration |
| `npm run migrate:down:all` | Revert every migration, leaving an empty schema |
| `docker compose exec db psql -U confapp -d confapp` | Open a psql shell against the composed database |

## Build & Deployment
| Command | Description |
|---------|-------------|
| `npm run build` | Production build – compiles the API to `api/dist` and the SPA to `web/dist` |
| `docker compose build` | Build both container images |
| `docker build -f api/Dockerfile -t confapp-api .` | Build the API image alone (context is the repository root) |
| `docker build -f web/Dockerfile -t confapp-web .` | Build the SPA image alone |
| Deploy | Out of scope here – image publication and deployment to a container platform are owned by **S13** |

Neither image contains environment-specific configuration. The API reads `PORT` and
`DATABASE_URL` from its environment at startup; the SPA container reads `API_BASE_URL` (what the
browser calls) and `API_UPSTREAM` (where it proxies `/api/`) at start, so the *same* image runs
against any environment without a rebuild.

## Visual Validation
<!-- confApp is responsive-first: validate at phone / tablet / desktop widths, not just one. -->

Requires the stack to be up (`docker compose up -d && npm run migrate:up`) and, once,
`npx playwright install chromium`.

| Command / Tool | Description |
|----------------|-------------|
| `docker compose up -d` | Launch the app for manual testing at `http://localhost:8082` |
| `npm run screenshots` | Capture all three widths and assert no horizontal scrolling at any of them |
| `npm run screenshots -- -g 375` | Capture at ~375px (phone) → `screenshots/phone-375.png` |
| `npm run screenshots -- -g 768` | Capture at ~768px (tablet) → `screenshots/tablet-768.png` |
| `npm run screenshots -- -g 1280` | Capture at ~1280px (desktop) → `screenshots/desktop-1280.png` |

## Note for Docker-in-WSL setups

If `docker` lives inside WSL while Node runs on Windows, run the Docker commands from a WSL
shell in the repository directory (`/mnt/c/...`). `scripts/verify-stack.sh` needs both `docker`
and `node` on the same PATH, so run it where both are available.
