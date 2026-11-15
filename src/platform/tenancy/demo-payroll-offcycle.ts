/**
 * Demo phase D11_PAYROLL_OFFCYCLE — payroll phase 5: an off-cycle run.
 *
 * The November run was proposed, released, posted and paid by D8–D10. A warehouse clerk who starts on
 * the 20th — Yara Khalil (10000019) — joins after it, so nobody has paid her for November. This phase
 * hires her and proposes a second run for the same period: it pays her alone, lists everyone the
 * November run already covers as information naming that run, and records the November run as its
 * predecessor. It is left PROPOSED, for a person to release, post and pay from /people/payroll-runs.
 *
 * Idempotent: the employee, position and assignment are looked up or request-keyed, and a second run
 * already standing for the period is left as it is.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../db/client';
import { derivePosition, periodDates } from '../periods';
import { assignStructure } from '../../modules/people/payroll-structure';
import { listPayrollRuns, proposePayrollRun } from '../../modules/people/payroll-run';
import { DEMO_ACTOR, DEMO_IDENTITY, DEMO_STRUCTURE } from './demo-organisation';
import { ensureEmployee } from './demo-payroll-run';
import type { DemoTimeline } from './demo-provisioning';

const AUTHORITY = ['*'] as const;
const LATE_JOINER = { personnelNumber: '10000019', fullName: 'Yara Khalil', positionCode: 'P2211', costCenter: 'CC2000', base: '780' } as const;

export interface DemoPayrollOffCycleResult {
  fiscalYear: number;
  period: number;
  runId: string;
  predecessorRunId: string | null;
  employees: number;
  alreadyCovered: number;
  netPay: string;
}

export async function buildDemoPayrollOffCycle(input: { client?: string; timeline: DemoTimeline }): Promise<DemoPayrollOffCycleResult> {
  const client = input.client ?? DEMO_IDENTITY.clientKey;
  const companyCode = DEMO_STRUCTURE.companyCode;
  const { fiscalYear, period, periodFrom } = await withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select fiscal_year_variant from company_code where client = ${client} and company_code = ${companyCode}`)) as unknown as Array<{ fiscal_year_variant: string }>;
    const variant = rows[0]!.fiscal_year_variant;
    const position = await derivePosition(tx, client, variant, input.timeline.anchorDate);
    const dates = await periodDates(tx, client, variant, position.fiscalYear, position.period);
    return { fiscalYear: position.fiscalYear, period: position.period, periodFrom: dates.from };
  });

  const start = new Date(`${periodFrom}T00:00:00Z`);
  start.setUTCDate(20);
  const from = start.toISOString().slice(0, 10);
  await ensureEmployee(client, LATE_JOINER, from, null);
  await assignStructure({
    client, personnelNumber: LATE_JOINER.personnelNumber, structureCode: 'STAFF', baseAmount: LATE_JOINER.base,
    currency: DEMO_IDENTITY.currency, validFrom: from, requestKey: `DEMO-SAL-${LATE_JOINER.personnelNumber}`, changedBy: DEMO_ACTOR,
  }, AUTHORITY);

  const runs = (await listPayrollRuns(client, AUTHORITY))
    .filter((r) => r.companyCode === companyCode && r.fiscalYear === fiscalYear && r.period === period && r.status !== 'CANCELLED');
  const standing = runs.find((r) => r.predecessorRunId !== null);
  const run = standing ?? await proposePayrollRun({
    client, companyCode, fiscalYear, period, requestKey: `DEMO-PAYRUN-OFFCYCLE-${fiscalYear}-${period}`, changedBy: DEMO_ACTOR,
  }, AUTHORITY);
  const covered = await withTenant(client, async (tx) => ((await tx.execute(sql`
    select count(*)::int as n from payroll_run_exception
     where client = ${client} and run_id = ${run.runId} and reason_code = 'ALREADY_COVERED'`)) as unknown as Array<{ n: number }>)[0]!.n);
  return {
    fiscalYear, period, runId: run.runId, predecessorRunId: run.predecessorRunId,
    employees: run.employeeCount, alreadyCovered: Number(covered), netPay: run.netPay,
  };
}
