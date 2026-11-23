#!/usr/bin/env bash
# Spins up a throwaway Postgres 16, applies all migrations and runs the SQL test suite.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
WORK="${WORK:-$(mktemp -d)}"
PORT="${PORT:-54329}"
chown -R postgres "$WORK" 2>/dev/null || true
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else bash -c "$*"; fi; }
as_pg "$PGBIN/initdb -D $WORK/data -A trust -U postgres >/dev/null"
as_pg "$PGBIN/pg_ctl -D $WORK/data -o '-p $PORT -k $WORK' -l $WORK/log -w start >/dev/null"
trap 'as_pg "$PGBIN/pg_ctl -D $WORK/data -m fast stop >/dev/null"' EXIT
PSQL="psql -h $WORK -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA"
$PSQL -f "$ROOT/supabase/tests/auth_mock.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do echo "→ migration $(basename "$f")"; $PSQL -f "$f"; done
$PSQL -f "$ROOT/supabase/tests/rls_and_booking.test.sql"
$PSQL -f "$ROOT/supabase/tests/restaurant.test.sql"
$PSQL -f "$ROOT/supabase/tests/staff.test.sql"
$PSQL -f "$ROOT/supabase/tests/saas.test.sql"
echo "→ concurrency test"
WORK="$WORK" PORT="$PORT" bash "$ROOT/supabase/tests/concurrency.test.sh"
echo "ALL DATABASE TESTS PASSED"
