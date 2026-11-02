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
 * `--no-seed` skips step 4 only. Standard reference rows are always initialized,
 * because business fixtures depend on the same currency/country/unit catalogue
 * whether or not the optional global definitions are requested.
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
import { redactConnectionUrls, validateIntegrationDatabaseConfig } from './integration-db-config';

/** The repository's own default identity for the test database (`src/platform/db/client.ts:25`). */
const DEFAULT_TEST_DATABASE = 'cairn';

function usageError(detail: string): never {
  throw new Error(detail);
}

function ownerUrl(): URL {
  const raw = process.env.MIGRATION_DATABASE_URL;
  if (!raw) usageError('MIGRATION_DATABASE_URL must be set explicitly; no database URL fallback is allowed.');
  try {
    return new URL(raw);
  } catch {
    usageError('MIGRATION_DATABASE_URL is not a valid PostgreSQL URL; value withheld.');
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
      + '       --no-seed skips global definitions; standard reference data is always initialized.\n'
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
  if (fresh && database === 'cairn_integration') {
    usageError('cairn_integration is persistent and can never be reset by test-db.');
  }
  if (fresh && !/^cairn_migration_test_\d{8}_[a-z0-9]{4,12}$/.test(database)) {
    usageError('--fresh is restricted to uniquely named cairn_migration_test_YYYYMMDD_<run-id> databases.');
  }
  const owner = ownerUrl();
  const applicationRaw = process.env.DATABASE_URL;
  if (!applicationRaw) usageError('DATABASE_URL must be set explicitly; no runtime URL fallback is allowed.');
  let applicationBase: URL;
  try {
    applicationBase = new URL(applicationRaw);
  } catch {
    usageError('DATABASE_URL is not a valid PostgreSQL URL; value withheld.');
  }
  if (![owner, applicationBase].every((url) => ['postgres:', 'postgresql:'].includes(url.protocol))) {
    usageError('MIGRATION_DATABASE_URL and DATABASE_URL must both use PostgreSQL.');
  }
  if (decodeURIComponent(owner.username) === 'cairn_app'
      || decodeURIComponent(applicationBase.username) !== 'cairn_app') {
    usageError('Use separate migration and restricted cairn_app runtime roles.');
  }
  if (!decodeURIComponent(owner.password) || !decodeURIComponent(applicationBase.password)
      || decodeURIComponent(owner.password) === decodeURIComponent(applicationBase.password)) {
    usageError('Distinct, non-empty migration and runtime credentials are required; values withheld.');
  }
  if (owner.hostname !== applicationBase.hostname || owner.port !== applicationBase.port) {
    usageError('MIGRATION_DATABASE_URL and DATABASE_URL must address the same approved cluster.');
  }
  if (owner.pathname !== `/${database}` || applicationBase.pathname !== `/${database}`) {
    usageError(`Both database URLs must explicitly name ${database}; URL values are withheld.`);
  }
  let integrationConfig: ReturnType<typeof validateIntegrationDatabaseConfig> | null = null;
  if (process.env.CAIRN_INTEGRATION_MODE || database === 'cairn_integration') {
    try {
      integrationConfig = validateIntegrationDatabaseConfig(process.env);
      if (integrationConfig.database !== database) usageError('Integration environment and provisioning target differ.');
    } catch (error) {
      usageError(error instanceof Error ? error.message : 'Integration environment was refused; values withheld.');
    }
  }
  const maintenance = new URL(owner.toString());
  maintenance.pathname = '/postgres';
  const migrationUrl = withDatabase(owner, database);
  const applicationUrl = new URL(applicationBase.toString());
  applicationUrl.pathname = `/${database}`;

  if (database === 'cairn_integration') {
    if (!integrationConfig) usageError('cairn_integration requires the validated persistent integration configuration.');
    const identity = postgres(migrationUrl, { max: 1, prepare: false, connect_timeout: 8, onnotice: () => {} });
    let row: {
      database: string;
      role: string;
      host: string | null;
      port: number | null;
      dataDirectory: string;
      systemIdentifier: string;
      versionNum: number;
      inRecovery: boolean;
    } | undefined;
    try {
      [row] = await identity<Array<{
        database: string;
        role: string;
        host: string | null;
        port: number | null;
        dataDirectory: string;
        systemIdentifier: string;
        versionNum: number;
        inRecovery: boolean;
      }>>`
        select current_database() as database, current_user as role,
               host(inet_server_addr()) as host, inet_server_port() as port,
               data_directory as "dataDirectory", system_identifier as "systemIdentifier",
               current_setting('server_version_num')::int as "versionNum",
               pg_is_in_recovery() as "inRecovery"
          from cairn_integration_guard.cluster_identity()
      `;
    } catch {
      usageError('cairn_integration cluster identity could not be verified before provisioning; refusing changes.');
    } finally {
      await identity.end({ timeout: 5 });
    }
    if (!row || row.database !== integrationConfig.database || row.role !== integrationConfig.migrationRole
        || row.host !== integrationConfig.host || Number(row.port) !== integrationConfig.port
        || row.dataDirectory !== integrationConfig.dataDirectory
        || row.systemIdentifier !== integrationConfig.systemIdentifier
        || Math.floor(row.versionNum / 10_000) !== 17 || row.inRecovery) {
      usageError('cairn_integration cluster identity did not match the approved target; refusing changes.');
    }
  }

  console.log(`test-db: target ${owner.hostname}:${owner.port || '5432'} database ${database}; migration role ${decodeURIComponent(owner.username)}, runtime role cairn_app; credentials withheld.`);

  const admin = postgres(maintenance.toString(), { max: 1, prepare: false, onnotice: () => {} });
  let createdNow = false;
  try {
    const [existing] = await admin<Array<{
      owner: string;
      allow_connections: boolean;
      encoding: number;
    }>>`
      select pg_get_userbyid(datdba) as owner,
             datallowconn as allow_connections,
             encoding
        from pg_database where datname = ${database}
    `;
    if (!existing) {
      await admin.unsafe(`create database "${database.replace(/"/g, '""')}"`);
      createdNow = true;
      console.log(`test-db: created ${database}`);
    } else {
      const [activity] = await admin<Array<{ active: number }>>`
        select count(*)::int as active
          from pg_stat_activity
         where datname = ${database} and pid <> pg_backend_pid()
      `;
      if (existing.owner !== decodeURIComponent(owner.username) || !existing.allow_connections
          || existing.encoding !== 6 || Number(activity?.active ?? 0) > 0) {
        usageError(`Existing database ${database} does not match its configured owner or has active dependencies; refusing to reuse it.`);
      }
      if (fresh) {
        usageError(`Fresh target ${database} already exists; test-db will not overwrite an existing database.`);
      }
      console.log(`test-db: verified existing ${database} (owner ${existing.owner}, active sessions 0, UTF8=${existing.encoding === 6})`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  const target = postgres(migrationUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    if (fresh) {
      if (!createdNow) usageError('Refusing destructive initialization of an existing database.');
      console.log('test-db: initializing the newly created disposable database…');
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
    DATABASE_URL: applicationUrl.toString(),
  };
  const steps = [
    { name: 'Migrate schema', script: 'src/platform/db/migrate.ts' },
    { name: 'Initialize standard reference data', script: 'scripts/seed-reference.ts' },
    ...(argv.includes('--no-seed') ? [] : [
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
    console.log(`test-db: ${database} is ready. Connection URLs and credentials were not printed.`);
    console.log('Load the approved secure environment for this exact database, then use `npm run test:integration` for integration suites.');
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'provisioning failed';
  console.error(`test-db: ${redactConnectionUrls(message)}`);
  process.exit(1);
});
