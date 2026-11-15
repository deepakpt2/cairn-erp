#!/bin/sh
# Runs ONLY when PostgreSQL initializes an empty data volume. Never resets data.
set -eu

# Generate a URL-safe (hex) application password if none is provided.
# Fresh deployments can omit CAIRN_APP_DB_PASSWORD and receive a generated value.
if [ -z "${CAIRN_APP_DB_PASSWORD:-}" ]; then
  CAIRN_APP_DB_PASSWORD=$(LC_ALL=C tr -dc '0-9a-f' < /dev/urandom | head -c 32)
  export CAIRN_APP_DB_PASSWORD
fi

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${CAIRN_MIGRATOR_DB_PASSWORD:?CAIRN_MIGRATOR_DB_PASSWORD is required (migration role cairn_integration_migrator)}"

# CAIRN_APP_DB_PASSWORD and CAIRN_MIGRATOR_DB_PASSWORD are embedded in URLs by Compose, so they must be
# URL-safe. POSTGRES_PASSWORD is the PostgreSQL superuser password and is never
# placed in an application URL, so it is not URL-validated here.
for name in CAIRN_APP_DB_PASSWORD CAIRN_MIGRATOR_DB_PASSWORD; do
  eval "value=\$$name"
  case "$value" in
    *[!A-Za-z0-9_-]*)
      echo "$name must be URL-safe (letters, digits, underscore, hyphen; hex is recommended)." >&2
      exit 1
      ;;
  esac
done

psql --no-password --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=app_password="$CAIRN_APP_DB_PASSWORD" \
  --set=migrator_password="$CAIRN_MIGRATOR_DB_PASSWORD" \
  --set=db_name="$POSTGRES_DB" <<'SQL'
CREATE ROLE cairn_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'app_password';
GRANT CONNECT ON DATABASE :"db_name" TO cairn_app;
-- The migration role: drizzle/0000_baseline.sql assigns every object to it, and its
-- SECURITY DEFINER functions run as it. Owns the database; manages cairn_app without
-- inheriting or assuming it. Migrations must run as this role, never the superuser.
CREATE ROLE cairn_integration_migrator LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS PASSWORD :'migrator_password';
GRANT cairn_app TO cairn_integration_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
ALTER DATABASE :"db_name" OWNER TO cairn_integration_migrator;
SQL
