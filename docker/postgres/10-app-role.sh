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

# CAIRN_APP_DB_PASSWORD is embedded in DATABASE_URL by Compose, so it must be
# URL-safe. POSTGRES_PASSWORD is the PostgreSQL superuser password and is never
# placed in an application URL, so it is not URL-validated here.
case "$CAIRN_APP_DB_PASSWORD" in
  *[!A-Za-z0-9_-]*)
    echo 'CAIRN_APP_DB_PASSWORD must be URL-safe (letters, digits, underscore, hyphen; hex is recommended).' >&2
    exit 1
    ;;
esac

psql --no-password --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=app_password="$CAIRN_APP_DB_PASSWORD" <<'SQL'
CREATE ROLE cairn_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'app_password';
GRANT CONNECT ON DATABASE cairn TO cairn_app;
SQL
