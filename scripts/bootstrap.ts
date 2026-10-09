/**
 * Bootstrap — bring a database from empty to a working development tenant.
 *
 * Order matters and is not obvious, so it lives in one place rather than in a
 * wiki page nobody reads:
 *
 *   1 migrate   — schema, policies, admin functions
 *   2 seed      — global definitions: capabilities, config activities, messages, registry
 *   3 reference — countries, currencies, units of measure
 *   4 tenant    — create the development tenant, activating the standard package
 *
 * Step 2 must precede step 4: the onboarding flow marks configuration activities
 * complete, and those activities have to exist first. Getting this order wrong
 * produces a tenant whose workbench checklist is silently empty.
 */
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

const STEPS = [
  { name: 'Migrate schema', script: 'src/platform/db/migrate.ts' },
  { name: 'Seed global definitions', script: 'scripts/seed.ts' },
  { name: 'Seed reference data', script: 'scripts/seed-reference.ts' },
  { name: 'Create development tenant', script: 'scripts/create-dev-tenant.ts' },
];

async function main() {
  const reset = process.argv.includes('--reset');

  if (reset) {
    if ((process.env.CAIRN_ENV ?? 'development') !== 'development') {
      console.error('Refusing to reset outside the development environment.');
      process.exit(1);
    }
    console.log('\n\u25b8 Reset database');
    execFileSync('npx', ['tsx', 'scripts/reset-db.ts'], { stdio: 'inherit' });
  }

  for (const step of STEPS) {
    console.log(`\n\u25b8 ${step.name}`);
    execFileSync('npx', ['tsx', step.script], { stdio: 'inherit' });
  }

  // Verify the end state rather than assuming the steps worked.
  const connectionString =
    process.env.MIGRATION_DATABASE_URL ?? 'postgresql://cairn:cairn_dev@127.0.0.1:5432/cairn';
  const client = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });

  try {
    const rows = await client.unsafe<Array<Record<string, string>>>(`
      select c.client, c.name,
             (select count(*) from gl_account where client = c.client) as accounts,
             (select count(*) from config_activity_status where client = c.client) as activities,
             (select count(*) from number_range where client = c.client) as ranges,
             (select count(*) from role where client = c.client) as roles,
             (select count(*) from company_code where client = c.client) as companies
      from client c order by c.client
    `);

    console.log('\n\u25b8 Result');
    for (const row of rows) {
      console.log(
        `  ${row.client}  ${row.name}\n` +
          `      accounts ${row.accounts} · workbench ${row.activities} · ranges ${row.ranges} · ` +
          `roles ${row.roles} · company codes ${row.companies}`,
      );
    }
  } finally {
    await client.end({ timeout: 5 });
  }

  console.log('\nBootstrap complete.\n');
}

main().catch((error) => {
  console.error('\nBootstrap failed:', error.message);
  process.exit(1);
});
