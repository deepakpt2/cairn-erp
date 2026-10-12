#!/bin/sh
# Runs ONLY when PostgreSQL initializes an empty data volume. Never resets data.
set -eu
: "${CAIRN_APP_DB_PASSWORD:?CAIRN_APP_DB_PASSWORD is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
# The Compose connection URLs embed these values; refuse reserved URI characters.
case "$CAIRN_APP_DB_PASSWORD$POSTGRES_PASSWORD" in
  *[!A-Za-z0-9_-]*) echo 'Use URL-safe database passwords (hex is recommended).' >&2; exit 1 ;;
esac
psql --no-password --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=app_password="$CAIRN_APP_DB_PASSWORD" <<'SQL'
CREATE ROLE cairn_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'app_password';
GRANT CONNECT ON DATABASE cairn TO cairn_app;
SQL
