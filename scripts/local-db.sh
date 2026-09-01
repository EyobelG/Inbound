#!/usr/bin/env bash
#
# Local Postgres + PostGIS for development.
#
# Runs an isolated cluster on port 55433 with its own data directory, so it
# never collides with a system Postgres you already have on 5432. PostGIS is
# only built for Postgres 17/18 on Homebrew, which is why this pins @18 rather
# than using whatever `psql` resolves to.
#
#   ./scripts/local-db.sh start | stop | status | reset | psql
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@18/bin}"
PGDATA="${INBOUND_PGDATA:-$HOME/.inbound/pgdata}"
SOCKET_DIR="${INBOUND_PGSOCKET:-$HOME/.inbound/socket}"
PORT="${INBOUND_PGPORT:-55433}"
DB=inbound

if [ ! -x "$PGBIN/pg_ctl" ]; then
  echo "Postgres 18 not found at $PGBIN" >&2
  echo "Install it with:  brew install postgresql@18 postgis" >&2
  exit 1
fi

start() {
  mkdir -p "$SOCKET_DIR"
  if [ ! -d "$PGDATA" ]; then
    echo "Initializing cluster at $PGDATA"
    mkdir -p "$(dirname "$PGDATA")"
    # trust auth is safe here: the cluster listens on a unix socket only,
    # never on a TCP interface.
    "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust -E UTF8 >/dev/null
  fi

  if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    echo "Already running on port $PORT"
    return 0
  fi

  "$PGBIN/pg_ctl" -D "$PGDATA" \
    -o "-p $PORT -k $SOCKET_DIR -c listen_addresses=127.0.0.1" \
    -l "$PGDATA/server.log" start >/dev/null
  sleep 2

  if ! "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$DB"; then
    "$PGBIN/createdb" -h 127.0.0.1 -p "$PORT" -U postgres "$DB"
    "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB" -q -c "create extension if not exists postgis;"
    echo "Created database '$DB' with PostGIS"
  fi

  # `postgres` owns every table `0003_rls.sql` creates, so a DATABASE_URL
  # pointed at it silently bypasses every RLS policy - dev would pass while
  # exercising none of the authorization the app relies on in production.
  # Create the same non-owner runtime role the migration documents, so local
  # dev is a real test of RLS rather than a no-op. `initdb --auth=trust`
  # above means the password is never actually checked over this local
  # socket; it exists only so the connection string has one to carry.
  if ! "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB" -tAc \
      "select 1 from pg_roles where rolname = 'inbound_app'" | grep -q 1; then
    "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB" -q \
      -c "create role inbound_app login password 'localdev';"
    echo "Created role 'inbound_app' (non-owner, RLS-enforcing)"
  fi

  echo "Running on port $PORT"
  echo "Migrate as the owner, then point .env.local at inbound_app - see README:"
  echo "  DATABASE_URL=postgresql://postgres@127.0.0.1:$PORT/$DB npm run db:migrate"
  echo "  DATABASE_URL=postgresql://inbound_app:localdev@127.0.0.1:$PORT/$DB"
}

case "${1:-start}" in
  start)  start ;;
  stop)   "$PGBIN/pg_ctl" -D "$PGDATA" stop >/dev/null 2>&1 && echo "Stopped" || echo "Not running" ;;
  status) "$PGBIN/pg_ctl" -D "$PGDATA" status || true ;;
  psql)   exec "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB" ;;
  reset)
    "$PGBIN/pg_ctl" -D "$PGDATA" stop >/dev/null 2>&1 || true
    rm -rf "$PGDATA"
    echo "Wiped $PGDATA"
    start ;;
  *) echo "usage: $0 {start|stop|status|reset|psql}" >&2; exit 1 ;;
esac
