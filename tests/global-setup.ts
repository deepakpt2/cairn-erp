/**
 * Test suite setup.
 *
 * Purges stale test tenants before the run. This is not housekeeping for its own
 * sake: a tenant left behind by an aborted run carries exhausted number ranges and
 * half-applied configuration, which makes the next run fail in ways that look like
 * product defects. Cleaning the slate first means a failure is always real.
 *
 * Refuses to run against anything but the development database.
 */
import postgres from 'postgres';

export default async function setup() {
  if ((process.env.CAIRN_ENV ?? 'development') !== 'development') {
    throw new Error('Tests only run against the development database (CAIRN_ENV).');
  }

  const connectionString =
    process.env.MIGRATION_DATABASE_URL ?? 'postgresql://cairn:cairn_dev@127.0.0.1:5432/cairn';
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
