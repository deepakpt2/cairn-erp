/**
 * Demo phase D9_PAYROLL_POST — payroll phase 3: the November run, released and posted.
 *
 * D8 left the run for the period the installation was claimed in PROPOSED, with the controller,
 * Walid Farouk (10000016), named as its exception: no pay structure. This phase does what a payroll
 * clerk would: assigns him the MGMT structure from the first day of the period, recalculates the run
 * (the exception clears and stays in the run's change history), releases it, and posts it — one PR
 * document dated the last day of the period, personnel cost by cost centre, the payables flat, net
 * pay to the account the PAYROLL_NET_PAY determination names.
 *
 * Only that period is posted: the demo's finance phase already books the earlier months' salaries by
 * plain journal, and a payroll run for them would book them twice. Nothing is paid — that is phase 4.
 *
 * Posted by `demo.admin`, who holds both halves of the authority (PEOPLE.PAYROLL.POST and
 * FIN.JOURNAL.POST) through the administrator wildcard; no role is granted the payroll capability.
 * The judged posting services also ask for an explicit Company Code scope, which the administrator
 * never had, so this phase grants it the demo's company code and both plants — its whole reach, now
 * stated — through the platform administrator, as B_PEOPLE scopes every other account. Idempotent: the assignment is
 * request-keyed, and each step runs only while the run stands in the status before it.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../db/client';
import { derivePosition, periodDates } from '../periods';
import { assignStructure, listAssignments } from '../../modules/people/payroll-structure';
import { listPayrollRuns, recalculatePayrollRun, releasePayrollRun } from '../../modules/people/payroll-run';
import { getPayrollPosting, postPayrollRun } from '../../modules/people/payroll-posting';
import { grantCompanyCodeScope, grantPlantScope } from '../../modules/platform/organisation-scope-admin';
import { DEMO_ACTOR, DEMO_FOUNDER_ACCOUNTS, DEMO_IDENTITY, DEMO_STRUCTURE } from './demo-organisation';
import { withActingUser } from './demo-people';
import type { DemoTimeline } from './demo-provisioning';

const AUTHORITY = ['*'] as const;
const CONTROLLER = { personnelNumber: '10000016', structure: 'MGMT', base: '3300' } as const;

const dayBefore = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

export interface DemoPayrollPostResult {
  fiscalYear: number;
  period: number;
  runId: string;
  status: string;
  documentNumber: string | null;
  displayNumber: string | null;
  debitTotal: string | null;
}

/** Give demo.admin explicit Company Code and Plant scope over the whole demo structure. */
async function scopeAdministrator(client: string): Promise<void> {
  const admin = DEMO_FOUNDER_ACCOUNTS.administrator.username;
  const { userId, held } = await withTenant(client, async (tx) => {
    const users = (await tx.execute(sql`select id from app_user where client = ${client} and username = ${admin}`)) as unknown as Array<{ id: string }>;
    const userId = String(users[0]!.id);
    const rows = (await tx.execute(sql`
      select scope_type, scope_value from auth_org_restriction where client = ${client} and user_id = ${userId}`)) as unknown as Array<{ scope_type: string; scope_value: string }>;
    return { userId, held: new Set(rows.map((r) => `${r.scope_type}/${r.scope_value}`)) };
  });
  const companyCode = DEMO_STRUCTURE.companyCode;
  const plants = [DEMO_STRUCTURE.manufacturingPlant, DEMO_STRUCTURE.distributionPlant];
  await withActingUser(client, DEMO_FOUNDER_ACCOUNTS.platformAdmin.username, async (actor) => {
    if (!held.has(`COMPANY_CODE/${companyCode}`)) {
      await grantCompanyCodeScope({ client, actor, targetUserId: userId, companyCode });
    }
    for (const plantCode of plants) {
      if (!held.has(`PLANT/${plantCode}`)) {
        await grantPlantScope({ client, actor, targetUserId: userId, companyCode, plantCode });
      }
    }
  });
}

export async function buildDemoPayrollPost(input: { client?: string; timeline: DemoTimeline }): Promise<DemoPayrollPostResult> {
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

  // The exception's remedy: a structure for the controller from the first day of the period, ending
  // the day before any assignment that already stands later in it.
  const standing = await listAssignments(client, CONTROLLER.personnelNumber);
  const covering = standing.find((a) => a.validFrom <= periodFrom && (a.validTo === null || a.validTo >= periodFrom));
  if (!covering) {
    const next = standing.filter((a) => a.validFrom > periodFrom).map((a) => a.validFrom).sort()[0];
    await assignStructure({
      client, personnelNumber: CONTROLLER.personnelNumber, structureCode: CONTROLLER.structure, baseAmount: CONTROLLER.base,
      currency: DEMO_IDENTITY.currency, validFrom: periodFrom, validTo: next ? dayBefore(next) : null,
      requestKey: `DEMO-SAL-${CONTROLLER.personnelNumber}-${fiscalYear}-${period}`, changedBy: DEMO_ACTOR,
    }, AUTHORITY);
  }

  const run = (await listPayrollRuns(client)).find(
    (r) => r.companyCode === companyCode && r.fiscalYear === fiscalYear && r.period === period && r.status !== 'CANCELLED',
  );
  if (!run) throw new Error(`D9_PAYROLL_POST: no payroll run stands for ${companyCode} ${period}/${fiscalYear}; D8_PAYROLL_RUN proposes it.`);

  let status = run.status;
  if (status === 'PROPOSED') {
    const recalculated = await recalculatePayrollRun({ client, runId: run.runId, changedBy: DEMO_ACTOR }, AUTHORITY);
    if (recalculated.exceptionCount > 0) {
      throw new Error(`D9_PAYROLL_POST: run ${run.runId} still names ${recalculated.exceptions.map((e) => `${e.personnelNumber} (${e.reasonCode})`).join(', ')}.`);
    }
    status = (await releasePayrollRun({ client, runId: run.runId, changedBy: DEMO_ACTOR }, AUTHORITY)).status;
  }
  const poster = DEMO_FOUNDER_ACCOUNTS.administrator.username;
  if (status === 'RELEASED') {
    await scopeAdministrator(client);
    await withActingUser(client, poster, (actor) => postPayrollRun({ client, changedBy: poster, runId: run.runId, authorization: actor }));
  }
  const posting = await getPayrollPosting(client, run.runId);
  return {
    fiscalYear,
    period,
    runId: run.runId,
    status: posting?.status ?? status,
    documentNumber: posting?.documentNumber ?? null,
    displayNumber: posting?.displayNumber ?? null,
    debitTotal: posting?.debitTotal ?? null,
  };
}
