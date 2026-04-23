#!/bin/sh
set -eu

db_host="${PGHOST:-db}"
db_port="${PGPORT:-5432}"
db_user="${PGUSER:-postgres}"
db_name="${PGDATABASE:-StarknetDeg}"
db_wait_retries="${DB_WAIT_RETRIES:-60}"
db_wait_delay_seconds="${DB_WAIT_DELAY_SECONDS:-2}"

echo "[entrypoint] waiting for postgres ${db_host}:${db_port}/${db_name}"

attempt=1
while ! pg_isready -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name" >/dev/null 2>&1; do
  if [ "$attempt" -ge "$db_wait_retries" ]; then
    echo "[entrypoint] postgres is not ready after ${db_wait_retries} attempts"
    exit 1
  fi

  echo "[entrypoint] postgres not ready attempt=${attempt}/${db_wait_retries}"
  attempt=$((attempt + 1))
  sleep "$db_wait_delay_seconds"
done

echo "[entrypoint] postgres is ready"

run_migrations="$(printf '%s' "${RUN_MIGRATIONS:-true}" | tr '[:upper:]' '[:lower:]')"
case "$run_migrations" in
  1|true|yes|on)
    echo "[entrypoint] running migrations"
    npm run migrate
    echo "[entrypoint] migrations complete"
    ;;
  *)
    echo "[entrypoint] skipping migrations (RUN_MIGRATIONS=${RUN_MIGRATIONS:-false})"
    ;;
esac

exec "$@"
