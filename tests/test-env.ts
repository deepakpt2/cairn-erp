/**
 * Test environment loader — imported for its side effect by every vitest config, and by
 * `scripts/with-test-env.ts` for the `test:db:*` npm scripts.
 *
 * Loads `.env.test` over the container's environment (the container's DATABASE_URL points at
 * the dev database erp_dev), takes the migration URL from `.env.test` (cairn_integration_migrator)
 * or else composes it from PGUSER/PGPASSWORD/PGHOST, and then refuses to continue unless both database URLs name the test database. Tests must
 * never run against erp_dev.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FORBIDDEN = new Set(['erp_dev']);

function parseEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, eq).trim()] = value;
  }
  return values;
}

function databaseOf(url: string, name: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new Error(`${name} in the test environment is not a valid URL; value withheld.`);
  }
}

export function loadTestEnv(): string {
  const file = resolve(process.cwd(), '.env.test');
  if (!existsSync(file)) {
    throw new Error('.env.test is missing; refusing to run tests against the container default (erp_dev).');
  }
  Object.assign(process.env, parseEnvFile(file));

  const database = process.env.TEST_DATABASE_NAME;
  if (!database || FORBIDDEN.has(database)) {
    throw new Error(`TEST_DATABASE_NAME must name the test database, not "${database ?? ''}".`);
  }

  if (!process.env.MIGRATION_DATABASE_URL || databaseOf(process.env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL') !== database) {
    const { PGUSER, PGPASSWORD, PGHOST, PGPORT } = process.env;
    if (!PGUSER || !PGPASSWORD || !PGHOST) {
      throw new Error('PGUSER, PGPASSWORD and PGHOST are required to compose the test MIGRATION_DATABASE_URL.');
    }
    process.env.MIGRATION_DATABASE_URL =
      `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT || '5432'}/${database}`;
  }

  for (const name of ['DATABASE_URL', 'MIGRATION_DATABASE_URL'] as const) {
    const target = databaseOf(process.env[name] ?? '', name);
    if (target !== database || FORBIDDEN.has(target)) {
      throw new Error(`${name} names "${target}", expected the test database "${database}". Refusing to run.`);
    }
  }
  // libpq-style tools (psql, createdb) launched from tests should also default to the test database.
  process.env.PGDATABASE = database;
  return database;
}

loadTestEnv();
