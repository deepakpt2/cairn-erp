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
 * It also names, on every run, which database it purged — and refuses to purge a *whole suite's* worth of
 * fixture tenants inside the browser acceptance database. The acceptance database is guarded by name in
 * `scripts/browser-smoke/database-guards.ts`, its fixture tenants are the keys the browser cohort reserves for
 * itself, and this file's purge matches `Browser verification tenant` by name. Focused runs (one file, a
 * handful of files, `npm run db:verify`) are left alone: they are how a gate is measured on the acceptance
 * database, and they cannot collide with a whole cohort.
 */
import postgres from 'postgres';

import { ACCEPTANCE_DATABASE_GUARDS } from '../scripts/browser-smoke/database-guards';

export default async function setup() {
  if ((process.env.CAIRN_ENV ?? 'development') !== 'development') {
    throw new Error('Tests only run against the development database (CAIRN_ENV).');
  }

  const connectionString =
    process.env.MIGRATION_DATABASE_URL ?? 'postgresql://cairn:cairn_dev@127.0.0.1:5432/cairn';
  const identity = new URL(connectionString);
  const database = identity.pathname.replace(/^\//, '');
  console.log(`Test setup: database ${database} on ${identity.hostname}:${identity.port || '5432'}.`);

  const guarded = new Set(
    Object.values(ACCEPTANCE_DATABASE_GUARDS)
      .map((guard) => guard?.database)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
  const focused = process.argv.slice(2).some((arg) => !arg.startsWith('-') && arg.includes('.test.'));
  if (guarded.has(database) && !focused && !process.env.CAIRN_ALLOW_GUARDED_TEST_DATABASE) {
    throw new Error(
      `The whole suite must not run in ${database}: it is the browser acceptance database, named by `
      + 'ACCEPTANCE_DATABASE_GUARDS, and a suite run both reserves its reserved tenant keys and purges its '
      + 'fixture tenants. Provision a scratch database of the suite\'s own with `npm run test:db`, export the '
      + 'two connection lines it prints, and run again. To measure this run in the acceptance database on '
      + 'purpose — for one file or a focused set, which is what that database is for — pass the file names, or '
      + 'set CAIRN_ALLOW_GUARDED_TEST_DATABASE=1 and say so in the record.',
    );
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
