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
  startDemoPhase,
  type DemoTimeline,
} from '../src/platform/tenancy/demo-provisioning';

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

const PHASES: Record<string, (ctx: PhaseContext) => Promise<Record<string, unknown>>> = {
  A_FOUNDATION: runFoundationPhase,
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
    return 0;
  }

  const ctx: PhaseContext = { installationId: claim.installationId, timeline, database };
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
  return 0;
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
