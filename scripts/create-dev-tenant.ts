/**
 * Create the development tenant — CAIRN.md D-006, §27 item 7.
 *
 * The product owner creates their own tenant through the UI, page by page, during
 * testing. This script creates the agent's development tenant only, so there is
 * always somewhere to build and test against.
 *
 * It goes through the same createTenant() service the UI uses. If this script and
 * the wizard ever diverge, the wizard is right and this is a bug.
 */
import { createTenant, listTenants } from '../src/platform/tenancy';
import { closeDb } from '../src/platform/db/client';
import { listNumberRanges, maintainNumberRange } from '../src/modules/foundation/number-ranges';
import { seedDevelopmentMaterials } from '../src/modules/inventory/development-fixture';

async function ensureDevelopmentInterval() {
  const { ranges } = await listNumberRanges('0100');
  if (!ranges.some((r) => r.objectCode === 'JOURNAL_ENTRY' && r.companyCode === '1000' && r.subObject === 'GENERAL' && r.fiscalYear === 0)) {
    await maintainNumberRange({ client: '0100', objectCode: 'JOURNAL_ENTRY', companyCode: '1000', subObject: 'GENERAL', fiscalYear: 0, prefix: 'JE', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE', status: 'ACTIVE', mode: 'CREATE', reason: 'Development fixture setup', changedBy: 'DEV_SEED' });
  }
}


async function main() {
  const existing = await listTenants();
  const alreadyThere = existing.find((t) => t.client === '0100');

  if (alreadyThere) {
    console.log(`Development tenant 0100 already exists (${alreadyThere.name}).`);
    await ensureDevelopmentInterval();
    await seedDevelopmentMaterials();
    await closeDb();
    return;
  }

  const result = await createTenant({
    clientKey: '0100',
    name: 'Cairn Development',
    legalName: 'Cairn Development Company',
    country: 'KW',
    currency: 'USD',
    timezone: 'Asia/Kuwait',
    isDevelopment: true,
    companyCode: '1000',
    companyName: 'Cairn Development Company',
    fiscalYearVariant: 'K4',
    chartOfAccounts: 'CAIRN',
    administrator: {
      username: 'dev.admin',
      fullName: 'Development Administrator',
      email: 'dev@cairn.local',
      // Development-only credential. The environment check lives in .env.
      password: 'cairn-dev-2026',
    },
    activateStandardPackage: true,
    createdBy: 'DEV_SEED',
  });

  await ensureDevelopmentInterval();
  await seedDevelopmentMaterials();
  console.log('Development tenant created:');
  console.log(`  Tenant key        ${result.client}`);
  console.log(`  Company code      ${result.companyCode}`);
  console.log(`  Administrator     ${result.administratorUsername}`);
  console.log(`  Roles             ${result.rolesCreated}`);
  console.log(`  Number ranges     ${result.rangesCreated} operational + 1 accounting`);
  console.log(`  Workbench steps   ${result.onboardingActivities}`);
  console.log(`  Package           ${result.packageVersion ?? 'not applied'}`);
  console.log(`  G/L accounts      ${result.accountsCreated ?? 0}`);

  await closeDb();
}

main().catch(async (error) => {
  console.error('Failed:', error.message);
  await closeDb();
  process.exit(1);
});
