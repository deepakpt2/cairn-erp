/**
 * Demo phase D8_PAYROLL_RUN — payroll phase 2: a proposed run with something to show.
 *
 * The run pays the demo company for the fiscal period the installation was claimed in. Around it the
 * phase places the cases a payroll user checks first:
 * - a **joiner** (10000017, Rami Saleh) who starts on the 10th, paid for the days from then;
 * - a **leaver** (10000018, Salma Idris) whose position ends on the 20th, paid to that day;
 * - **unpaid leave**: three approved days for Omar Nasser (10000004), deducted; two approved days
 *   at the end of the period for Faisal Jaber (10000007) that run past it, counted only inside;
 *   and a still-requested unpaid leave for Hana Qasem (10000008), which does not count;
 * - an **exception**: the controller, Walid Farouk (10000016), still has no pay structure, so the run
 *   names him and cannot be released until he is assigned one and the run is recalculated.
 *
 * End-of-service provisions are out of scope for v1 and a run refuses a structure naming one, so the
 * phase takes EOSPROV out of the demo structures where an earlier build put it (the component and its
 * mapping stay). The run is proposed, never released: nothing posts.
 *
 * Idempotent: employees, positions, absences and the run are request-keyed or looked up before they
 * are written; a run already standing for the period is left as it is.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../db/client';
import { derivePosition, periodDates } from '../periods';
import { assignPosition, assignmentsOf, delimitAssignment } from '../../modules/people/assignment';
import { createEmployee } from '../../modules/people/employee-master';
import {
  assignStructure,
  getStructure,
  removeStructureComponent,
} from '../../modules/people/payroll-structure';
import { listPayrollRuns, proposePayrollRun } from '../../modules/people/payroll-run';
import { absencesOf, decideAbsence, requestAbsence } from '../../modules/people/time-leave';
import { DEMO_ACTOR, DEMO_IDENTITY, DEMO_STRUCTURE } from './demo-organisation';
import type { DemoTimeline } from './demo-provisioning';

const AUTHORITY = ['*'] as const;

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The two employees this phase adds, and where they sit. */
const JOINER = { personnelNumber: '10000017', fullName: 'Rami Saleh', positionCode: 'P2211', costCenter: 'CC2000', base: '820' } as const;
const LEAVER = { personnelNumber: '10000018', fullName: 'Salma Idris', positionCode: 'P4100', costCenter: 'CC4000', base: '900' } as const;

export interface DemoPayrollRunResult {
  fiscalYear: number;
  period: number;
  runId: string | null;
  employees: number;
  exceptions: number;
  netPay: string | null;
  eosRemovedFrom: string[];
}

async function ensureEmployee(
  client: string,
  person: { personnelNumber: string; fullName: string; positionCode: string; costCenter: string },
  from: string,
  to: string | null,
): Promise<void> {
  const exists = await withTenant(client, async (tx) => ((await tx.execute(sql`
    select 1 from employee where client = ${client} and personnel_number = ${person.personnelNumber}`)) as unknown as unknown[]).length > 0);
  if (!exists) {
    await createEmployee({
      client, personnelNumber: person.personnelNumber, fullName: person.fullName, isActive: true,
      requestKey: `DEMO-${person.personnelNumber}`, changedBy: DEMO_ACTOR,
    }, AUTHORITY);
  }
  const standing = await assignmentsOf(client, person.personnelNumber);
  const current = standing.find((a) => a.validFrom === from);
  if (!current) {
    await assignPosition({
      client, personnelNumber: person.personnelNumber, positionCode: person.positionCode,
      controllingArea: DEMO_STRUCTURE.controllingArea, costCenter: person.costCenter, validFrom: from, changedBy: DEMO_ACTOR,
    }, AUTHORITY);
  }
  if (to && (current?.validTo ?? null) !== to) {
    await delimitAssignment({ client, personnelNumber: person.personnelNumber, validFrom: from, validTo: to, changedBy: DEMO_ACTOR }, AUTHORITY);
  }
}

async function ensureAbsence(client: string, personnelNumber: string, timeTypeCode: string, from: string, to: string, approve: boolean, reason: string) {
  const standing = (await absencesOf(client, personnelNumber)).find((a) => a.timeTypeCode === timeTypeCode && a.validFrom === from);
  if (!standing) {
    await requestAbsence({
      client, personnelNumber, timeTypeCode, validFrom: from, validTo: to, reason,
      requestKey: `DEMO-ABS-${personnelNumber}-${from}`, changedBy: DEMO_ACTOR,
    }, AUTHORITY);
  }
  if (approve && (!standing || standing.status === 'REQUESTED')) {
    await decideAbsence({ client, personnelNumber, timeTypeCode, validFrom: from, status: 'APPROVED', changedBy: DEMO_ACTOR }, AUTHORITY);
  }
}

export async function buildDemoPayrollRun(input: { client?: string; timeline: DemoTimeline }): Promise<DemoPayrollRunResult> {
  const client = input.client ?? DEMO_IDENTITY.clientKey;
  const companyCode = DEMO_STRUCTURE.companyCode;

  // EOS provisions are not calculated in v1: no demo structure may name one.
  const eosRemovedFrom: string[] = [];
  for (const structureCode of ['STAFF', 'MGMT']) {
    const structure = await getStructure(client, structureCode).catch(() => null);
    if (structure?.components.some((c) => c.componentKind === 'EOS_PROVISION')) {
      for (const c of structure.components.filter((x) => x.componentKind === 'EOS_PROVISION')) {
        await removeStructureComponent({ client, structureCode, componentCode: c.componentCode, changedBy: DEMO_ACTOR }, AUTHORITY);
      }
      eosRemovedFrom.push(structureCode);
    }
  }

  // The period the installation was claimed in, and its dates.
  const { fiscalYear, period, periodFrom, periodTo } = await withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select fiscal_year_variant from company_code where client = ${client} and company_code = ${companyCode}`)) as unknown as Array<{ fiscal_year_variant: string }>;
    const variant = rows[0]!.fiscal_year_variant;
    const position = await derivePosition(tx, client, variant, input.timeline.anchorDate);
    const dates = await periodDates(tx, client, variant, position.fiscalYear, position.period);
    return { fiscalYear: position.fiscalYear, period: position.period, periodFrom: dates.from, periodTo: dates.to };
  });

  const joinFrom = addDays(periodFrom, 9);
  const leaveTo = addDays(periodFrom, 19);
  const leaverFrom = input.timeline.startDate < periodFrom ? input.timeline.startDate : periodFrom;

  await ensureEmployee(client, JOINER, joinFrom, null);
  await ensureEmployee(client, LEAVER, leaverFrom, leaveTo);
  await assignStructure({
    client, personnelNumber: JOINER.personnelNumber, structureCode: 'STAFF', baseAmount: JOINER.base, currency: DEMO_IDENTITY.currency,
    validFrom: joinFrom, requestKey: `DEMO-SAL-${JOINER.personnelNumber}`, changedBy: DEMO_ACTOR,
  }, AUTHORITY);
  await assignStructure({
    client, personnelNumber: LEAVER.personnelNumber, structureCode: 'STAFF', baseAmount: LEAVER.base, currency: DEMO_IDENTITY.currency,
    validFrom: leaverFrom, validTo: leaveTo, requestKey: `DEMO-SAL-${LEAVER.personnelNumber}`, changedBy: DEMO_ACTOR,
  }, AUTHORITY);

  await ensureAbsence(client, '10000004', 'UNPAID', addDays(periodFrom, 4), addDays(periodFrom, 6), true, 'Family matter, unpaid (demo)');
  await ensureAbsence(client, '10000007', 'UNPAID', addDays(periodTo, -1), addDays(periodTo, 2), true, 'Unpaid leave across the month end (demo)');
  await ensureAbsence(client, '10000008', 'UNPAID', addDays(periodFrom, 11), addDays(periodFrom, 12), false, 'Requested, not yet decided (demo)');

  const standing = (await listPayrollRuns(client)).find(
    (r) => r.companyCode === companyCode && r.fiscalYear === fiscalYear && r.period === period && r.status !== 'CANCELLED',
  );
  const run = standing ?? await proposePayrollRun({
    client, companyCode, fiscalYear, period, requestKey: `DEMO-PAYRUN-${fiscalYear}-${period}`, changedBy: DEMO_ACTOR,
  }, AUTHORITY);

  return {
    fiscalYear,
    period,
    runId: run.runId,
    employees: run.employeeCount,
    exceptions: run.exceptionCount,
    netPay: run.netPay,
    eosRemovedFrom,
  };
}
