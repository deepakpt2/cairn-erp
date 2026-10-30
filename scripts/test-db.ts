/**
 * Provision the scratch database the test suite owns — `npm run test:db`.
 *
 * Why this exists as a script rather than as a wiki sentence: the suite and the browser acceptance cohort were
 * sharing one database. `vitest.config.ts` runs files serially precisely because the database tests share a
 * cluster, `tests/global-setup.ts` purges stale `T###` fixture tenants before a run, and
 * `scripts/browser-smoke.ts` guards its own database by name. Running the whole suite inside the guarded
 * acceptance database breaks all three arrangements at once: the suite's fixture tenants occupy the keys the
 * browser cohort reserves, the acceptance data sits beside a thousand test rows, and the purge step deletes
 * browser fixtures. So the suite needs a database of its own, named on purpose.
 *
 * What it does, in the order `scripts/bootstrap.ts` documents as the only correct one:
 *
 *   1. create the database when it does not exist;
 *   2. `src/platform/db/migrate.ts`   — schema, policies, admin functions;
 *   3. `scripts/seed-reference.ts`   — currencies, countries, units, approved bank profiles;
 *   4. `scripts/seed.ts`              — global definitions: capabilities, activities, messages, registry.
 *
 * The development tenant is deliberately NOT created: `tests/global-setup.ts` says the tenant `0100` is never
 * touched, and a suite run has no business writing into it. `npm run bootstrap` remains the command that
 * produces a usable application database.
 *
 * Safety, in this order: it refuses to run unless `CAIRN_ENV` is `development`; it refuses any database named
 * by `ACCEPTANCE_DATABASE_GUARDS` (the browser cohort's own registry, so there is one list, not two); it
 * refuses a name that is not the configured test database unless `--database` says so out loud; and `--fresh`
 * (which drops `schema public`) additionally requires `--yes`.
 */
import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import postgres from 'postgres';

import { ACCEPTANCE_DATABASE_GUARDS } from './browser-smoke/database-guards';

/** The repository's own default identity for the test database (`src/platform/db/client.ts:25`). */
const DEFAULT_TEST_DATABASE = 'cairn';

function usageError(detail: string): never {
  console.error(`test-db: ${detail}`);
  process.exit(1);
}

function ownerUrl(): URL {
  const raw = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!raw) usageError('MIGRATION_DATABASE_URL (or DATABASE_URL) must name the cluster to work against.');
  try {
    return new URL(raw as string);
  } catch {
    usageError('the owner connection URL is not a valid PostgreSQL URL.');
  }
}

function guardedDatabases(): Set<string> {
  return new Set(
    Object.values(ACCEPTANCE_DATABASE_GUARDS)
      .map((guard) => guard?.database)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
}

function withDatabase(base: URL, database: string, username?: string): string {
  const url = new URL(base.toString());
  url.pathname = `/${database}`;
  if (username) {
    url.username = username;
    // The scratch database is owned by the same role the owner connection uses; the runtime role is created or
    // aligned separately (`npm run db:sync-role`), because DDL cannot carry a password parameter.
    if (username !== base.username) url.password = decodeURIComponent(base.password);
  }
  return url.toString();
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(
      'usage: npm run test:db -- [--database <name>] [--fresh --yes] [--no-seed]\n'
      + `       the scratch test database defaults to "${DEFAULT_TEST_DATABASE}"; set CAIRN_TEST_DB_NAME to change it.`,
    );
    return;
  }
  if ((process.env.CAIRN_ENV ?? 'development') !== 'development') {
    usageError(`CAIRN_ENV is "${process.env.CAIRN_ENV}"; this script only provisions a development scratch database.`);
  }

  const requested = argv.includes('--database') ? argv[argv.indexOf('--database') + 1] : undefined;
  const configured = process.env.CAIRN_TEST_DB_NAME;
  const database = requested ?? configured ?? DEFAULT_TEST_DATABASE;
  const guarded = guardedDatabases();
  assert.ok(guarded.size > 0, 'the browser cohort must name at least one guarded database');
  if (guarded.has(database)) {
    usageError(
      `${database} is the browser acceptance database (ACCEPTANCE_DATABASE_GUARDS). The suite must not provision, `
      + 'purge or share it — name a scratch database instead.',
    );
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) {
    usageError(`"${database}" is not a plain lower-case identifier, which is what this script will create.`);
  }

  const fresh = argv.includes('--fresh');
  if (fresh && !argv.includes('--yes')) {
    usageError('--fresh drops schema public in the target database; add --yes once you have read that.');
  }
  const owner = ownerUrl();
  if (decodeURIComponent(owner.username) === 'cairn_app') {
    usageError('the owner connection must not be the restricted application role (`cairn_app`).');
  }
  // The application role is cluster-wide and its password is whatever the deployment gave it — it is NOT the
  // owner's password in general, so an existing DATABASE_URL for the same host, port and role is copied for its
  // credential and only that. Guessing here would print a connection line that cannot connect.
  const existingApplicationUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  const appPassword = existingApplicationUrl
    && decodeURIComponent(existingApplicationUrl.username) === 'cairn_app'
    && existingApplicationUrl.hostname === owner.hostname
    && existingApplicationUrl.port === owner.port
    ? decodeURIComponent(existingApplicationUrl.password)
    : decodeURIComponent(owner.password);
  const maintenance = new URL(owner.toString());
  maintenance.pathname = '/postgres';
  const migrationUrl = withDatabase(owner, database);
  const applicationUrl = (() => {
    const url = new URL(owner.toString());
    url.pathname = `/${database}`;
    url.username = 'cairn_app';
    url.password = appPassword;
    return url.toString();
  })();

  const pointed = new URL(owner.toString()).pathname.replace(/^\//, '');
  console.log(`test-db: target ${owner.hostname}:${owner.port || '5432'} database ${database} (owner role ${owner.username})`);
  if (pointed !== database) {
    console.log(`test-db: the connection string names "${pointed}"; every step below is given "${database}" instead,`);
    console.log('test-db: and the export lines at the end are what the suite itself must be given.');
  }

  const admin = postgres(maintenance.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    const [exists] = await admin`select 1 from pg_database where datname = ${database}`;
    if (!exists) {
      await admin.unsafe(`create database "${database.replace(/"/g, '""')}"`);
      console.log(`test-db: created ${database}`);
    } else {
      console.log(`test-db: ${database} already exists`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  const target = postgres(migrationUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    if (fresh) {
      console.log('test-db: dropping schema public…');
      await target.unsafe('drop schema if exists public cascade');
      await target.unsafe('create schema public');
      await target.unsafe('grant usage on schema public to public');
    }
  } finally {
    await target.end({ timeout: 5 });
  }

  const env = {
    ...process.env,
    CAIRN_ENV: 'development',
    MIGRATION_DATABASE_URL: migrationUrl,
    DATABASE_URL: applicationUrl,
  };
  const steps = [
    { name: 'Migrate schema', script: 'src/platform/db/migrate.ts' },
    ...(argv.includes('--no-seed') ? [] : [
      { name: 'Initialize standard reference data', script: 'scripts/seed-reference.ts' },
      { name: 'Seed global definitions', script: 'scripts/seed.ts' },
    ]),
  ];
  for (const step of steps) {
    console.log(`\n▸ ${step.name}`);
    execFileSync('npx', ['tsx', step.script], { stdio: 'inherit', env });
  }

  // Verify the end state rather than assuming the steps worked, the way scripts/bootstrap.ts does.
  const check = postgres(migrationUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const [row] = await check`
      select
        (select count(*) from cairn_migration) as migrations,
        (select count(*) from capability) as capabilities,
        (select count(*) from unit_of_measure) as units,
        (select count(*) from country) as countries,
        (select count(*) from client where client ~ '^T[0-9]{3}$') as test_tenants,
        (select current_database()) as database
    `;
    assert.equal(row?.database, database, 'the verification must read the database it provisioned');
    console.log(
      `\ntest-db: ${database} stands with ${row.migrations} migrations, ${row.capabilities} capabilities, `
      + `${row.units} units, ${row.countries} countries, ${row.test_tenants} test tenant(s).`,
    );
    console.log('Run the suite against it with:\n');
    console.log(`  export DATABASE_URL="${applicationUrl}"`);
    console.log(`  export MIGRATION_DATABASE_URL="${migrationUrl}"\n`);
    console.log('  npm test          # or: npx vitest run tests/some.test.ts');
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(`test-db: ${error.message ?? error}`);
  process.exit(1);
});
