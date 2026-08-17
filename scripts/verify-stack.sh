#!/usr/bin/env bash
#
# Compose-level verification of the properties that cannot be proven from inside a test
# process: that the database's named volume really outlives its container, that
# `docker compose down -v` really discards state, and that both application containers can be
# destroyed and recreated with nothing to restore.
#
# These act on the development stack and its own named volume, on purpose – running them
# against the integration tests' database would mask exactly what they are trying to prove.
#
# WARNING: this script runs `docker compose down -v`. It deletes the local development
# database and everything in it. It is a verification tool, not part of the dev loop.
#
# Usage:  bash scripts/verify-stack.sh

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
set -a; [ -f .env ] && . ./.env; set +a

WEB_URL="http://127.0.0.1:${WEB_HOST_PORT:-8082}"
API_URL="http://127.0.0.1:${API_HOST_PORT:-8081}"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

psql_dev() {
  docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"
}

wait_for_health() {
  local url="$1" expected="$2" tries="${3:-45}" code=''
  for _ in $(seq 1 "$tries"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$url/api/health" || true)
    [ "$code" = "$expected" ] && return 0
    sleep 1
  done
  echo "    (last status: ${code:-none}, wanted $expected)"
  return 1
}

# ---------------------------------------------------------------------------
step 'Bringing the stack up'
docker compose up -d >/dev/null 2>&1
node db/migrate.mjs up >/dev/null

# ---------------------------------------------------------------------------
step 'Structural: only the database has storage, and it is a named volume'
# Asserted against the running containers rather than the Compose file, so this reports what
# actually got mounted. The database is the only component that needs durable storage; that
# the API and SPA containers have none is a stated design property, not an omission.

TOP_LEVEL_VOLUMES=$(docker compose config --volumes | grep -c . || true)
[ "$TOP_LEVEL_VOLUMES" = '1' ] \
  || fail "expected exactly one top-level named volume, found $TOP_LEVEL_VOLUMES"
pass 'exactly one top-level named volume is declared'

for service in api web; do
  mounts=$(docker inspect -f '{{len .Mounts}}' "$(docker compose ps -q "$service")")
  [ "$mounts" = '0' ] \
    || fail "service '$service' has $mounts mount(s) – it holds no state and must have none"
  pass "service '$service' runs with no volume of any kind"
done

DB_MOUNT=$(docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}}{{end}}' \
  "$(docker compose ps -q db)")
case "$DB_MOUNT" in
  volume:confapp-db-data:/var/lib/postgresql) pass "database data directory is on a named volume ($DB_MOUNT)" ;;
  bind:*) fail "database uses a bind mount ($DB_MOUNT) – it must be a named volume" ;;
  volume::*) fail "database uses an anonymous volume ($DB_MOUNT) – it must be named" ;;
  *) fail "unexpected database mount: '$DB_MOUNT'" ;;
esac

# ---------------------------------------------------------------------------
step 'S08: data written before the database container is destroyed survives its recreation'

wait_for_health "$API_URL" 200 || fail 'the stack did not come up healthy before the test began'

PROBE="survives-$(date +%s)"
psql_dev "insert into app_meta (key, value) values ('durability_probe', '$PROBE')
          on conflict (key) do update set value = excluded.value" >/dev/null
psql_dev "update app_meta set value = '$PROBE' where key = 'schema_version'" >/dev/null
pass "wrote a distinguishable value: $PROBE"

DB_ID_BEFORE=$(docker compose ps -q db)

# No -v: the named volume must be kept.
docker compose down >/dev/null 2>&1
if docker ps -a --format '{{.ID}}' | grep -q "^${DB_ID_BEFORE:0:12}"; then
  fail 'the database container still exists after `docker compose down`'
fi
pass 'database container destroyed by `docker compose down` (volume kept)'

docker compose up -d >/dev/null 2>&1
DB_ID_AFTER=$(docker compose ps -q db)
[ "$DB_ID_BEFORE" != "$DB_ID_AFTER" ] || fail 'the database container was not actually recreated'
pass 'a new database container started against the same named volume'

# The normal case after the first run: the volume already holds the schema and the applied
# migration record, so migrate-up must skip rather than fail with a duplicate-object error.
MIGRATE_OUT=$(node db/migrate.mjs up 2>&1)
echo "$MIGRATE_OUT" | grep -qi 'nothing to up' \
  || fail "migrate-up re-applied or failed against a populated volume: $MIGRATE_OUT"
pass 'migrate-up recognised the applied migration and re-applied nothing'

wait_for_health "$API_URL" 200 || fail 'the API did not become healthy after recreation'
BODY=$(curl -s "$WEB_URL/api/health")
echo "$BODY" | grep -q "$PROBE" \
  || fail "the value written before teardown did not survive: $BODY"
pass 'the pre-teardown value read back unchanged through the full path'

# ---------------------------------------------------------------------------
step 'S09: `docker compose down -v` deliberately discards state'

docker compose down -v >/dev/null 2>&1
pass '`docker compose down -v` removed the stack and its named volume'

docker compose up -d >/dev/null 2>&1
wait_for_health "$API_URL" 503 \
  || fail 'an empty database should refuse health with 503 until migrate-up has run'
pass 'the database came up empty – health refuses until migrations are applied'

curl -s "$API_URL/api/health" | grep -q 'DATABASE_UNAVAILABLE' \
  || fail 'the pre-migration refusal did not use the standard error envelope'
pass 'the refusal arrived in the standard error envelope'

node db/migrate.mjs up >/dev/null
wait_for_health "$API_URL" 200 || fail 'health did not recover after migrate-up'
curl -s "$API_URL/api/health" | grep -q "$PROBE" \
  && fail 'data survived `down -v` – the volume was not actually deleted'
pass 'migrate-up was required, and the old rows are gone – a volume is not a backup'

# ---------------------------------------------------------------------------
step 'S10: both application containers are destroyed and recreated with nothing to restore'

BEFORE=$(curl -s "$WEB_URL/api/health" | sed 's/"serverTime":"[^"]*"//')
API_BEFORE=$(docker compose ps -q api)
WEB_BEFORE=$(docker compose ps -q web)

# The database container is left untouched.
DB_UNTOUCHED=$(docker compose ps -q db)
docker compose rm -sf api web >/dev/null 2>&1
docker compose up -d >/dev/null 2>&1
wait_for_health "$API_URL" 200 || fail 'the recreated API did not come back healthy'

[ "$(docker compose ps -q db)" = "$DB_UNTOUCHED" ] \
  || fail 'the database container was replaced; this check must leave it alone'
[ "$(docker compose ps -q api)" != "$API_BEFORE" ] || fail 'the API container was not recreated'
[ "$(docker compose ps -q web)" != "$WEB_BEFORE" ] || fail 'the SPA container was not recreated'

AFTER=$(curl -s "$WEB_URL/api/health" | sed 's/"serverTime":"[^"]*"//')
[ "$BEFORE" = "$AFTER" ] \
  || fail "behaviour changed after recreation:\n  before: $BEFORE\n  after:  $AFTER"
pass 'both came back serving identically – no configuration replay, no data restoration'

printf '\n\033[32mAll compose-level checks passed.\033[0m\n'
printf 'Note: the local database was reset by this script. Re-seed it if you had test data.\n'
