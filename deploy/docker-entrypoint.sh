#!/bin/sh
set -eu

attempt=1
max_attempts="${DB_MIGRATION_ATTEMPTS:-30}"
until node src/db/migrate.js; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "Database migration failed after ${max_attempts} attempts." >&2
    exit 1
  fi
  echo "Database is not ready; retrying migration in 2 seconds (${attempt}/${max_attempts})." >&2
  attempt=$((attempt + 1))
  sleep 2
done

exec node src/api/server.js
