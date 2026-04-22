#!/bin/sh
set -eu

case "${RUN_MIGRATIONS:-true}" in
  1|true|TRUE|yes|YES|on|ON)
    node scripts/run-migrations.js
    ;;
esac

exec "$@"
