/** Provision the project's global reference catalogue after schema migrations. */
import postgres from 'postgres';
import { validateTarget } from '../src/platform/db/target-guard';
import { initializeStandardReferenceData } from './standard-reference-data';

async function main() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required for reference-data initialization.');
  const database = new URL(connectionString).pathname.replace(/^\//, '');
  await validateTarget(database, undefined, process.env.DATABASE_URL);
  const client = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await initializeStandardReferenceData(client);
    const counts = await client.unsafe(`
      select 'country' as table_name, count(*)::text as row_count from country
      union all select 'currency', count(*)::text from currency
      union all select 'unit_of_measure', count(*)::text from unit_of_measure
      union all select 'partner_bank_country_profile', count(*)::text from partner_bank_country_profile
    `);
    console.log('Standard reference data initialized:', counts);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('Reference-data initialization failed:', error.message);
  process.exit(1);
});
