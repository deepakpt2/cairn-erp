/**
 * Test suite setup.
 *
 * Purges stale test tenants before the run. This is not housekeeping for its own
 * sake: a tenant left behind by an aborted run carries exhausted number ranges and
 * half-applied configuration, which makes the next run fail in ways that look like
 * product defects. Cleaning the slate first means a failure is always real.
 *
 * Refuses to run against anything but the development database.
 *
 * It also names, on every run, which database it is using. The acceptance database is guarded by name in
 * `scripts/browser-smoke/database-guards.ts`; its fixture tenants are reserved by the browser cohort. The
 * persistent integration target is guarded here as well. This setup skips stale-fixture deletion on every
 * guarded database, including focused runs, so a test setup cannot purge browser or persistent integration
 * fixtures. Tests against either guarded target must clean up only the tenants they create.
 */
import postgres from 'postgres';
import { validateTarget } from '../src/platform/db/target-guard';

import { ACCEPTANCE_DATABASE_GUARDS } from '../scripts/browser-smoke/database-guards';
import { validateIntegrationDatabaseConfig } from '../scripts/integration-db-config';

export default async function setup() {
  if ((process.env.CAIRN_ENV ?? 'development') !== 'development') {
    throw new Error('Tests only run against the development database (CAIRN_ENV).');
  }

  const targetsIntegration = [process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL]
    .some((raw) => {
      if (!raw) return false;
      try { return new URL(raw).pathname === '/cairn_integration'; }
      catch { return false; }
    });
  const integrationRequested = Boolean(process.env.CAIRN_INTEGRATION_MODE)
    || process.env.CAIRN_TEST_DB_NAME === 'cairn_integration'
    || targetsIntegration;
  const integration = integrationRequested
    ? validateIntegrationDatabaseConfig(process.env)
    : null;
  const connectionString = integration?.migrationUrl
    ?? process.env.MIGRATION_DATABASE_URL
    ?? 'postgresql://cairn:cairn_dev@127.0.0.1:5432/cairn';
  const identity = new URL(connectionString);
  const database = identity.pathname.replace(/^\//, '');
  if (integration && database !== integration.database) {
    throw new Error('Integration database target mismatch; refusing before any connection.');
  }

  // Validate the database target through the guard before connecting: protected
  // databases are refused without explicit authorization, and the actual
  // connected identity is confirmed against the requested target.
  await validateTarget(database, undefined, integration?.runtimeUrl);

  if (integration) {
    for (const [kind, url, expectedRole] of [
      ['runtime', integration.runtimeUrl, integration.runtimeRole],
      ['migration', integration.migrationUrl, integration.migrationRole],
    ] as const) {
      const connection = postgres(url, { max: 1, prepare: false, connect_timeout: 8, onnotice: () => {} });
      try {
        const [row] = await connection<Array<{
          database: string;
          role: string;
          serverAddress: string;
          serverPort: number;
          versionNum: number;
          inRecovery: boolean;
          superuser: boolean;
          bypassrls: boolean;
          createdb: boolean;
          createrole: boolean;
          inherit: boolean;
        }>>`
          select current_database() as database,
                 current_user as role,
                 host(inet_server_addr()) as "serverAddress",
                 inet_server_port() as "serverPort",
                 current_setting('server_version_num')::int as "versionNum",
                 pg_is_in_recovery() as "inRecovery",
                 r.rolsuper as superuser,
                 r.rolbypassrls as bypassrls,
                 r.rolcreatedb as createdb,
                 r.rolcreaterole as createrole,
                 r.rolinherit as inherit
            from pg_roles r where r.rolname = current_user
        `;
        if (!row || row.database !== integration.database || row.role !== expectedRole
            || row.serverAddress !== '127.0.0.1' || Number(row.serverPort) !== integration.port
            || Math.floor(row.versionNum / 10_000) !== 17
            || row.inRecovery) {
          throw new Error(`Integration ${kind} connection identity did not match the approved target.`);
        }
        if (kind === 'runtime'
            && (row.superuser || row.bypassrls || row.createdb || row.createrole || row.inherit)) {
          throw new Error('Integration runtime role is not restricted.');
        }
        if (kind === 'migration'
            && (row.superuser || !row.bypassrls || !row.createdb || !row.createrole || row.inherit)) {
          throw new Error('Integration migration role privileges do not match the approved arrangement.');
        }
        if (kind === 'migration') {
          const [cluster] = await connection<Array<{ dataDirectory: string; systemIdentifier: string }>>`
            select data_directory as "dataDirectory",
                   system_identifier as "systemIdentifier"
              from cairn_integration_guard.cluster_identity()
          `;
          if (cluster?.dataDirectory !== integration.dataDirectory
              || cluster?.systemIdentifier !== integration.systemIdentifier) {
            throw new Error('Integration PostgreSQL cluster identity did not match the approved target.');
          }
        }
      } finally {
        await connection.end({ timeout: 5 });
      }
    }
    console.log(`Test setup: verified ${integration.mode} integration database ${integration.database} on ${integration.host}:${integration.port}; credentials withheld.`);
  } else {
    console.log(`Test setup: database ${database} on ${identity.hostname}:${identity.port || '5432'}.`);
  }

  const guarded = new Set([
    ...Object.values(ACCEPTANCE_DATABASE_GUARDS)
      .map((guard) => guard?.database)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
    'cairn_integration',
  ]);
  const focused = process.argv.slice(2).some((arg) => !arg.startsWith('-') && arg.includes('.test.'));
  if (guarded.has(database) && !focused && !process.env.CAIRN_ALLOW_GUARDED_TEST_DATABASE) {
    throw new Error(
      `The whole suite must not run in ${database}: it is the browser acceptance database, named by `
      + 'ACCEPTANCE_DATABASE_GUARDS, and a suite run both reserves its reserved tenant keys and purges its '
      + 'fixture tenants. Provision a suite-owned database with `npm run test:db` and load its connection details '
      + 'from a secure environment file (the command never prints URLs or credentials). To measure a focused gate '
      + 'on a guarded database, pass the file names; stale-fixture cleanup is skipped there.',
    );
  }

  if (guarded.has(database)) {
    console.log('Test setup: stale-fixture cleanup skipped on guarded database.');
    return;
  }

  const client = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });

  try {
    // Test tenants are keyed T### by tests/helpers.ts. The development tenant
    // (0100) is deliberately not matched and is never touched.
    const removed = await client.unsafe<Array<{ client: string }>>(
      `delete from client where client ~ '^T[0-9]{3}$' and is_development = true and (name like 'Test tenant T%' or name = 'Browser verification tenant') returning client`,
    );
    if (removed.length > 0) {
      console.log(
        `\nTest setup: removed ${removed.length} stale test tenant(s): ` +
          removed.map((r) => r.client).join(', '),
      );
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}
