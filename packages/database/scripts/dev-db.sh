#!/usr/bin/env bash
# Local development database: PostgreSQL 16 + PostGIS on port 54329.
# Usage: dev-db.sh start|stop|status
set -euo pipefail

PGDATA="${FITMARKET_PGDATA:-/var/lib/postgresql/16/dev}"
PGBIN="/usr/lib/postgresql/16/bin"
PORT="${FITMARKET_PGPORT:-54329}"

case "${1:-start}" in
  start)
    if [ ! -s "$PGDATA/PG_VERSION" ]; then
      mkdir -p "$PGDATA"
      chown -R postgres:postgres "$(dirname "$PGDATA")" 2>/dev/null || true
      su postgres -c "$PGBIN/initdb -D $PGDATA --auth-local=trust --auth-host=trust -E UTF8"
    fi
    su postgres -c "$PGBIN/pg_ctl -D $PGDATA -l /tmp/fitmarket-pg.log -o '-p $PORT -c listen_addresses=127.0.0.1' start" || true
    ;;
  stop)
    su postgres -c "$PGBIN/pg_ctl -D $PGDATA stop" || true
    ;;
  status)
    su postgres -c "$PGBIN/pg_ctl -D $PGDATA status" || true
    ;;
  *)
    echo "usage: $0 start|stop|status" >&2
    exit 1
    ;;
esac
