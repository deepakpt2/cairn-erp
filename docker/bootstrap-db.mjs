import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const envPath = '/work/.env.local';

function loadFile(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1).replace(/^["']|["']$/g, '')];
      }),
  );
}

function quote(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function ident(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(label + ' is not a plain identifier.');
  }
  return value;
}

function role(urlString) {
  const url = new URL(urlString);
  return {
    user: ident(decodeURIComponent(url.username), 'database user'),
    password: decodeURIComponent(url.password),
    database: ident(url.pathname.replace(/^\//, ''), 'database name'),
  };
}

const file = loadFile(envPath);
const appUrl = process.env.DATABASE_URL || file.DATABASE_URL;
const migrationUrl = process.env.MIGRATION_DATABASE_URL || file.MIGRATION_DATABASE_URL;
if (!appUrl || !migrationUrl) {
  console.log('No database URLs set. Postgres is listening on 127.0.0.1:5432 with no application roles.');
  process.exit(0);
}

const app = role(appUrl);
const migration = role(migrationUrl);
const sqlPath = '/tmp/build-box-bootstrap.sql';
const sql = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quote(migration.user)}) THEN
    CREATE ROLE ${migration.user} LOGIN SUPERUSER PASSWORD ${quote(migration.password)};
  ELSE
    ALTER ROLE ${migration.user} WITH LOGIN SUPERUSER PASSWORD ${quote(migration.password)};
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quote(app.user)}) THEN
    CREATE ROLE ${app.user} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${quote(app.password)};
  ELSE
    ALTER ROLE ${app.user} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${quote(app.password)};
  END IF;
END $$;
SELECT format('CREATE DATABASE %I OWNER %I', ${quote(app.database)}, ${quote(migration.user)})
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${quote(app.database)})\\gexec
GRANT CONNECT ON DATABASE ${app.database} TO ${app.user};
`;

try {
  writeFileSync(sqlPath, sql, { mode: 0o600 });
  execFileSync('su', ['-s', '/bin/sh', 'postgres', '-c', 'psql -v ON_ERROR_STOP=1 -f ' + sqlPath], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  console.log('Database roles stand for ' + app.database + '.');
} finally {
  if (existsSync(sqlPath)) unlinkSync(sqlPath);
}
