/**
 * Development database reset.
 *
 * Drops and recreates the schema, then leaves the database empty for migrations.
 * This is a DEVELOPMENT tool only — it destroys all data. It refuses to run when
 * CAIRN_ENV is anything other than 'development' (CAIRN.md §22.8).
 *
 * The database target is validated through `validateTarget()` before any
 * destructive operation: protected databases are refused, and the actual
 * connected database identity is confirmed before the schema is dropped.
 */
import postgres from 'postgres';
import { validateTarget } from '../src/platform/db/target-guard';

async function main() {
  if ((process.env.CAIRN_ENV ?? 'development') !== 'development') {
    console.error(
      `Refusing to reset the database: CAIRN_ENV is "${process.env.CAIRN_ENV}". ` +
        `This script only runs in development.`,
    );
    process.exit(1);
  }

  const connectionString =
    process.env.MIGRATION_DATABASE_URL ??
    'postgresql://cairn:cairn_dev@127.0.0.1:5432/cairn';

  await validateTarget(new URL(connectionString).pathname.replace(/^\//, ''));

  const client = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });

  try {
    console.log('Dropping schema public…');
    await client.unsafe('drop schema if exists public cascade');
    await client.unsafe('create schema public');
    await client.unsafe('grant usage on schema public to public');
    console.log('Database is empty. Run `npm run db:migrate` next.');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('Reset failed:', error.message);
  process.exit(1);
});
