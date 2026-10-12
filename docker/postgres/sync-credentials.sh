#!/bin/sh
# Explicit existing-volume repair via the database container's local admin socket.
# Reads ONLY configured container environment; never resets a schema/volume or prints secrets.
set -eu
: "${POSTGRES_USER:?Database owner is required}"
: "${POSTGRES_DB:?Database name is required}"
: "${POSTGRES_PASSWORD:?Configured owner password is required}"
: "${CAIRN_APP_DB_PASSWORD:?Configured app password is required}"
case "$CAIRN_APP_DB_PASSWORD$POSTGRES_PASSWORD" in
  *[!A-Za-z0-9_-]*) echo 'Use URL-safe database passwords (hex is recommended).' >&2; exit 1 ;;
esac
psql --no-password --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=owner_name="$POSTGRES_USER" \
  --set=owner_password="$POSTGRES_PASSWORD" --set=app_password="$CAIRN_APP_DB_PASSWORD" <<'SQL'
BEGIN;
SELECT 'CREATE ROLE cairn_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cairn_app')
\gexec
ALTER ROLE cairn_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'app_password';
ALTER ROLE :"owner_name" PASSWORD :'owner_password';
COMMIT;
SQL
printf '%s\n' 'Managed database credentials synchronized. No schema or business data reset.'
