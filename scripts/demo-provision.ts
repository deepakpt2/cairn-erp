/**
 * Dummy-data provisioning — the `demo:provision` step of the one-shot operations run.
 *
 * Runs after migrations, reference data and the global seed, and before the
 * application is allowed to start. It does nothing at all unless ENABLE_DUMMY_DATA
 * asks for it, and it refuses rather than guesses when the database already holds
 * business data.
 *
 * Exit codes: 0 when there is nothing to do or the work is finished; 1 when the
 * installation was refused or failed. A non-zero exit keeps `migrate` from completing
 * successfully, which is what stops the application starting over an incomplete or
 * contaminated demo environment.
 */
import { basename } from 'node:path';

import { validateTarget } from '../src/platform/db/target-guard';
import { closeDb } from '../src/platform/db/client';
import {
  acquireDemoProvisioningLock,
  buildDemoTimeline,
  claimDemoInstallation,
  completeDemoInstallation,
  completeDemoPhase,
  DEMO_PHASE_PLAN,
  DEMO_PROVISION_OPERATION,
  failDemoPhase,
  isDemoProvisioningEnabled,
  readDemoPasswordState,
  recordDemoPasswordIssued,
  startDemoPhase,
  type DemoTimeline,
} from '../src/platform/tenancy/demo-provisioning';
import {
  buildDemoOrganisation,
  DEMO_IDENTITY,
} from '../src/platform/tenancy/demo-organisation';
import { buildDemoMasters } from '../src/platform/tenancy/demo-masters';
import { buildDemoProcurement } from '../src/platform/tenancy/demo-procurement';
import { buildDemoProduction } from '../src/platform/tenancy/demo-production';
import { buildDemoSales } from '../src/platform/tenancy/demo-sales';
import { buildDemoFinance } from '../src/platform/tenancy/demo-finance';
import { buildDemoQuality } from '../src/platform/tenancy/demo-quality';
import {
  buildDemoPeople,
  listDemoAccounts as readDemoAccounts,
  setEveryPassword,
} from '../src/platform/tenancy/demo-people';
import {
  DEFAULT_CREDENTIALS_DIR,
  fingerprintDemoPassword,
  generateDemoPassword,
  renderDemoCredentialReport,
  writeDemoCredentials,
  type DemoAccount,
} from '../src/platform/tenancy/demo-credentials';

/**
 * Databases this step must never write to, on top of the guard every connection
 * already passes. Provisioning is only ever aimed at the database the deployment
 * created for itself, and these are the ones that belong to something else.
 */
const PROHIBITED_DATABASES = new Set([
  'cairn_b210',
  'cairn_hr_accept',
  'cairn_demo',
  'cairn_acceptance',
  'cairn_integration',
]);

interface PhaseContext {
  installationId: string;
  timeline: DemoTimeline;
  database: string;
  /**
   * The shared password, in memory only, for the lifetime of the run.
   *
   * It is generated once at the start so every phase stamps the same one onto the
   * accounts it creates, and it is never written to the database, the log, or the
   * repository — only to the credential file, at the end, once there is something
   * for it to open.
   */
  password: string;
}

/**
 * Where the credential file lands on the host, for the report.
 *
 * The container path and the host path are both shown because the person reading the
 * file is on the host and the process writing it is not.
 */
function describeCredentialsDirectory(): { directory: string; hostPath: string } {
  const directory =
    process.env.CAIRN_DEMO_CREDENTIALS_DIR?.trim() || DEFAULT_CREDENTIALS_DIR;
  const mount = process.env.CAIRN_DEMO_CREDENTIALS_MOUNT?.trim();
  return { directory, hostPath: mount ? `${mount.replace(/\/$/, '')}` : directory };
}

/**
 * Deliver the credential file.
 *
 * `password` is null when a password was issued by an earlier run and cannot be
 * recovered; the report says so rather than printing a blank.
 */
async function deliverDemoCredentials(input: {
  installationId: string;
  database: string;
  password: string | null;
  passwordGeneratedAt: string | null;
  accounts: DemoAccount[];
}): Promise<void> {
  const { directory, hostPath } = describeCredentialsDirectory();
  const report = renderDemoCredentialReport({
    loginUrl: process.env.CAIRN_DEMO_LOGIN_URL?.trim() || 'http://localhost:3000',
    tenant: process.env.CAIRN_DEMO_TENANT_NAME?.trim() || 'Cairn Demo',
    password: input.password,
    passwordGeneratedAt: input.passwordGeneratedAt,
    accounts: input.accounts,
    filePath: `${directory}/demo-credentials.txt`,
    hostPath: `${hostPath}/demo-credentials.txt`,
    generatedAt: new Date().toISOString(),
  });

  const written = writeDemoCredentials(report, { directory });

  if (input.password) {
    // Only after the file exists on disk: the database must never claim a password
    // was issued when the operator has not actually been handed one.
    await recordDemoPasswordIssued(input.installationId, fingerprintDemoPassword(input.password));
  }

  console.log('');
  console.log(`  Credentials         ${written.filePath}`);
  console.log(`  Read them on host   ${hostPath}/demo-credentials.txt`);
  console.log('  The shared password is in that file. It is not in the database and it is not in this log.');
}

/**
 * The foundation phase: the claim, the frozen calendar, and nothing else.
 *
 * It exists so that later phases can be interrupted and resumed against a calendar
 * that never moves, and so that a database which has been claimed is visibly claimed
 * even if the run dies immediately afterwards.
 */
async function runFoundationPhase(ctx: PhaseContext): Promise<Record<string, unknown>> {
  return {
    operation: DEMO_PROVISION_OPERATION,
    database: ctx.database,
    timeline: ctx.timeline,
    phasesDeclared: DEMO_PHASE_PLAN.length,
  };
}

async function runOrganisationPhase(ctx: PhaseContext): Promise<Record<string, unknown>> {
  const result = await buildDemoOrganisation({ password: ctx.password, timeline: ctx.timeline });
  return {
    client: result.client,
    companyCode: result.companyCode,
    plants: result.plants,
    tenantCreated: result.tenantCreated,
  };
}

async function runPeoplePhase(ctx: PhaseContext): Promise<Record<string, unknown>> {
  const result = await buildDemoPeople({
    client: DEMO_IDENTITY.clientKey,
    password: ctx.password,
    timeline: ctx.timeline,
  });
  return {
    orgUnits: result.orgUnits,
    positions: result.positions,
    employees: result.employees,
    roles: result.roles,
    users: result.users,
  };
}

async function runMastersPhase(ctx: PhaseContext): Promise<Record<string, unknown>> {
  const result = await buildDemoMasters({
    client: DEMO_IDENTITY.clientKey,
    timeline: ctx.timeline,
  });
  return {
    materials: result.materials,
    suppliers: result.suppliers,
    customers: result.customers,
    infoRecords: result.infoRecords,
    salesPrices: result.salesPrices,
    boms: result.boms,
    routings: result.routings,
    productionVersions: result.productionVersions,
    taxCodes: result.taxCodes,
  };
}

async function runProcurementPhase(ctx: PhaseContext): Promise<Record<string, unknown>> {
  const result = await buildDemoProcurement({
    client: DEMO_IDENTITY.clientKey,
    timeline: ctx.timeline,
  });
  return {
    openingJournal: result.openingJournal,
    openingStock: result.openingStock,
    determinationRows: result.determinationRows,
    purchaseOrders: result.purchaseOrders,
    goodsReceipts: result.goodsReceipts,
    supplierInvoices: result.supplierInvoices,
    payments: result.payments,
    goodsIssues: result.goodsIssues,
    documents: result.documents,
  };
}

async function runProductionPhase(ctx: PhaseContext): Promise<Record<string, unknown>> {
  const result = await buildDemoProduction({
    client: DEMO_IDENTITY.clientKey,
    timeline: ctx.timeline,
  });
  return {
    orderTypes: result.orderTypes,
    determinationRows: result.determinationRows,
    orders: result.orders,
    componentIssues: result.componentIssues,
    confirmations: result.confirmations,
    receipts: result.receipts,
    completions: result.completions,
    scrap: result.scrap,
    documents: result.documents,
  };
}

async function runSalesPhase(ctx: PhaseContext): Promise<Record<string, unknown>> {
  const result = await buildDemoSales({
    client: DEMO_IDENTITY.clientKey,
    timeline: ctx.timeline,
  });
  return {
    determinationRows: result.determinationRows,
    orders: result.orders,
    deliveries: result.deliveries,
    picks: result.picks,
    goodsIssues: result.goodsIssues,
    billingDocuments: result.billingDocuments,
    payments: result.payments,
    documents: result.documents,
  };
}

async function runFinancePhase(ctx: PhaseContext): Promise<Record<string, unknown>> {
  const result = await buildDemoFinance({
    client: DEMO_IDENTITY.clientKey,
    timeline: ctx.timeline,
  });
  return {
    costJournals: result.costJournals,
    payrollPayments: result.payrollPayments,
    accruals: result.accruals,
    supplierPayments: result.supplierPayments,
    internalOrders: result.internalOrders,
    orderCostJournals: result.orderCostJournals,
    settlements: result.settlements,
    grirRuns: result.grirRuns,
    taxReturns: result.taxReturns,
    dunningNotices: result.dunningNotices,
    documents: result.documents,
  };
}
/**
 * The quality phase: two deliveries bought, received into inspection stock,
 * inspected, decided on, invoiced and paid.
 */
async function runQualityPhase(ctx: PhaseContext): Promise<Record<string, unknown>> {
  const result = await buildDemoQuality({
    client: DEMO_IDENTITY.clientKey,
    timeline: ctx.timeline,
  });
  return {
    characteristics: result.characteristics,
    purchaseOrders: result.purchaseOrders,
    goodsReceipts: result.goodsReceipts,
    lots: result.lots,
    results: result.results,
    decisions: result.decisions,
    stockMovements: result.stockMovements,
    invoices: result.invoices,
    payments: result.payments,
    documents: result.documents,
  };
}

const PHASES: Record<string, (ctx: PhaseContext) => Promise<Record<string, unknown>>> = {
  A_FOUNDATION: runFoundationPhase,
  B_ORGANISATION: runOrganisationPhase,
  B_PEOPLE: runPeoplePhase,
  C_MASTERS: runMastersPhase,
  D1_PROCUREMENT: runProcurementPhase,
  D2_PRODUCTION: runProductionPhase,
  D3_SALES: runSalesPhase,
  D4_FINANCE: runFinancePhase,
  D5_QUALITY: runQualityPhase,
};

async function main(): Promise<number> {
  if (!isDemoProvisioningEnabled()) {
    console.log('Dummy-data provisioning is not enabled (ENABLE_DUMMY_DATA is not set to true); nothing to do.');
    return 0;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Dummy-data provisioning refused: DATABASE_URL is not set.');
    return 1;
  }
  const database = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]{1,63}$/.test(database)) {
    console.error(`Dummy-data provisioning refused: ${database} is not a valid database name.`);
    return 1;
  }
  if (PROHIBITED_DATABASES.has(database)) {
    console.error(`Dummy-data provisioning refused: ${database} is a protected or persistent database.`);
    return 1;
  }
  await validateTarget(database, undefined, databaseUrl);

  const lock = await acquireDemoProvisioningLock(databaseUrl);
  if (!lock) {
    console.error('Dummy-data provisioning refused: another provisioning run already holds this installation.');
    console.error('  Only one run may provision a database at a time. If no run is alive, the lock was released with its session.');
    return 1;
  }

  try {
    return await provision(database, databaseUrl);
  } finally {
    await lock.release();
  }
}

async function provision(database: string, databaseUrl: string): Promise<number> {
  const timeline = buildDemoTimeline();
  const claim = await claimDemoInstallation({ database, timeline });

  if (claim.disposition === 'REFUSE') {
    console.error(`Dummy-data provisioning refused: ${claim.reason}`);
    for (const line of claim.detail) console.error(`  ${line}`);
    return 1;
  }
  if (claim.disposition === 'ALREADY_COMPLETE') {
    console.log('Dummy data is already installed in this database; leaving it unchanged.');
    // The dataset is untouched, but the credential file may have been lost from the
    // host. Rewrite it: the accounts are still worth listing even though the password
    // that opens them cannot be reproduced.
    const state = await readDemoPasswordState(claim.installationId);
    await deliverDemoCredentials({
      installationId: claim.installationId,
      database,
      password: null,
      passwordGeneratedAt: state.issuedAt,
      accounts: await listDemoAccounts(),
    });
    return 0;
  }

  // One password for the whole run, so every phase stamps the same one.
  //
  // A resumed run gets a new one even though a fingerprint already stands, and that
  // deserves the explanation: the recorded password was never stored, only hashed, so
  // the run that finishes the work cannot know what the run that started it chose.
  // The accounts already created are therefore reset to the new one, and the
  // credential file is rewritten — one file, one password, every account in it.
  const existing = await readDemoPasswordState(claim.installationId);
  const password = generateDemoPassword();
  const ctx: PhaseContext = {
    installationId: claim.installationId,
    timeline,
    database,
    password: password ?? '',
  };
  const results: Record<string, Record<string, unknown>> = {};

  for (const phaseCode of DEMO_PHASE_PLAN) {
    if (claim.disposition === 'RESUME' && claim.completed.includes(phaseCode)) {
      console.log(`  ${phaseCode}: already complete, skipping.`);
      continue;
    }
    const run = PHASES[phaseCode];
    if (!run) {
      console.error(`Dummy-data provisioning cannot continue: phase ${phaseCode} is declared but not implemented.`);
      await failDemoPhase(claim.installationId, phaseCode, 'Declared but not implemented.');
      return 1;
    }
    console.log(`  ${phaseCode}: running…`);
    await startDemoPhase(claim.installationId, phaseCode);
    try {
      results[phaseCode] = await run(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failDemoPhase(claim.installationId, phaseCode, message);
      console.error(`Dummy-data provisioning failed in ${phaseCode}: ${message}`);
      console.error('  The partial installation was left in place and marked failed. It will not be resumed automatically.');
      return 1;
    }
    await completeDemoPhase(claim.installationId, phaseCode, results[phaseCode]);
    console.log(`  ${phaseCode}: complete.`);
  }

  const closed = await completeDemoInstallation(claim.installationId, {
    operation: DEMO_PROVISION_OPERATION,
    database,
    phases: results,
  });
  if (!closed.completed) {
    console.error(`Dummy-data provisioning could not finish; outstanding phases: ${closed.outstanding.join(', ')}.`);
    return 1;
  }

  console.log('Dummy-data provisioning complete.');
  console.log(`  Database            ${database}`);
  console.log(`  Timeline            ${timeline.startDate} → ${timeline.endDate} (open periods ${timeline.openPeriods.join(', ')})`);

  // Every account is set to the password this run issued — including on a run that
  // resumed after the people phase had already finished.
  //
  // The people phase resets every account itself, because it is the phase that
  // creates them and a run that died inside it left accounts holding a password
  // nobody wrote down. A run that resumes *after* that phase would otherwise write
  // a credential file naming a password no account answers to, which is a file that
  // looks like it works and does not. Setting it here as well keeps one password,
  // one file, and no gap between them.
  const peopleAlreadyBuilt = claim.disposition === 'RESUME' && claim.completed.includes('B_PEOPLE');
  if (ctx.password && peopleAlreadyBuilt) {
    await setEveryPassword(DEMO_IDENTITY.clientKey, ctx.password);
  }

  const accounts = await listDemoAccounts();
  await deliverDemoCredentials({
    installationId: claim.installationId,
    database,
    password: ctx.password || null,
    passwordGeneratedAt: existing.issuedAt,
    accounts,
  });

  return 0;
}

/**
 * The accounts the credential file should list.
 *
 * Read back from the database rather than remembered from the run, so a resumed
 * installation — where the accounts were created by a run that is no longer alive —
 * still produces a complete list. Empty until the phase that creates users has run.
 */
/**
 * The accounts the credential file should list.
 *
 * Read back from the database rather than remembered from the run, so a resumed
 * installation — where the accounts were created by a run that is no longer alive —
 * still produces a complete list.
 */
async function listDemoAccounts(): Promise<DemoAccount[]> {
  return readDemoAccounts(DEMO_IDENTITY.clientKey);
}

if (basename(process.argv[1] ?? '') === 'demo-provision.ts') {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(async (error: unknown) => {
      console.error(`Dummy-data provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDb();
    });
}
