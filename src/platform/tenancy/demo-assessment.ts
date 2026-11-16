/**
 * Demo phase D14_ASSESSMENT — cost allocation cycles, assessment (KSU1, KSU5) and distribution (KSV1, KSV5).
 *
 * The full path a tenant walks, in the product's own services:
 * 1. a dedicated allocation account, 690000 "Internal cost allocation", in the demo's chart — so the
 *    assessment flows do not sit inside a real expense account on centres that never had that expense;
 * 2. the CO_ASSESSMENT determination naming it (the event ships with no seeded row by design);
 * 3. cycle SVC01 "Service centre assessment": one segment sending the net cost of Warehousing
 *    (CC2000) and Administration (CC5000) to Mixing (CC1000) 60 % and Packing (CC1010) 40 %;
 * 4. the cycle run for the period the installation was claimed in, as `demo.admin`.
 * 5. cycle DST01 "Support centre distribution", category DISTRIBUTION: one segment sending the cost of
 *    Maintenance (CC3000) and Facilities (CC6000) to Mixing 60 % and Packing 40 %, run for the same
 *    period. It reuses the cost already posted on those centres (their own accounts, 500000 and 500100)
 *    and keeps each account: the receivers show the salary accounts as if posted there directly. Those
 *    senders are not on SVC01's document, so the two cycles do not meet (a centre on a live run's
 *    document cannot be distributed). No assessment account is involved.
 * The cost-centre report then shows the service centres relieved and the production centres charged.
 *
 * No role is granted CFG.COST.ALLOCATION.DEFINE, CO.ASSESSMENT.EXECUTE or CO.DISTRIBUTION.EXECUTE. Idempotent: the account and
 * determination are created only when missing, the cycle is adopted when it stands, and a period that
 * already carries a live run is left as it is.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../db/client';
import { derivePosition } from '../periods';
import { saveAccountDetermination } from '../../modules/foundation/account-determination';
import { getCycle, listRuns, runAssessment, saveCycle, setReceiver, setSegment, setSender } from '../../modules/foundation/cost-allocation-cycle';
import { upsertGlAccount } from '../../modules/foundation/services';
import { DEMO_ACTOR, DEMO_FOUNDER_ACCOUNTS, DEMO_IDENTITY, DEMO_STRUCTURE } from './demo-organisation';
import { withActingUser } from './demo-people';
import type { DemoTimeline } from './demo-provisioning';

const ACCOUNT = '690000';
const CYCLE = 'SVC01';
const REASON = 'Demo: service centre assessment';
const DISTRIBUTION_CYCLE = 'DST01';
const DISTRIBUTION_REASON = 'Demo: support centre distribution';

export interface DemoAssessmentResult {
  account: string;
  cycle: string;
  fiscalYear: number;
  period: number;
  documentNumber: string | null;
  assessedTotal: string | null;
  distributionCycle: string;
  distributionDocument: string | null;
  distributedTotal: string | null;
}

export async function buildDemoAssessment(input: { client?: string; timeline: DemoTimeline }): Promise<DemoAssessmentResult> {
  const client = input.client ?? DEMO_IDENTITY.clientKey;
  const area = DEMO_STRUCTURE.controllingArea;
  const { chart, fiscalYear, period, accountStands, determinationStands } = await withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select chart_of_accounts, fiscal_year_variant from company_code where client = ${client} and company_code = ${DEMO_STRUCTURE.companyCode}`)) as unknown as Array<{ chart_of_accounts: string; fiscal_year_variant: string }>;
    const chart = rows[0]!.chart_of_accounts;
    const position = await derivePosition(tx, client, rows[0]!.fiscal_year_variant, input.timeline.anchorDate);
    const account = (await tx.execute(sql`select 1 from gl_account where client = ${client} and chart_of_accounts = ${chart} and account_number = ${ACCOUNT}`)) as unknown as unknown[];
    const det = (await tx.execute(sql`select 1 from account_determination where client = ${client} and chart_of_accounts = ${chart} and event = 'CO_ASSESSMENT'`)) as unknown as unknown[];
    return { chart, fiscalYear: position.fiscalYear, period: position.period, accountStands: account.length > 0, determinationStands: det.length > 0 };
  });

  // 1. The dedicated allocation account.
  if (!accountStands) {
    await upsertGlAccount({
      client, chartOfAccounts: chart, accountNumber: ACCOUNT, name: 'Internal cost allocation', accountType: 'EXPENSE',
      accountGroup: 'GENL', isOpenItemManaged: false, requiresCostObject: true, isTaxRelevant: false,
      retainedEarningsIndicator: 'X', changedBy: DEMO_ACTOR,
    });
  }
  // 2. The determination naming it.
  if (!determinationStands) {
    await saveAccountDetermination({
      client, changedBy: DEMO_ACTOR, mode: 'CREATE', chartOfAccounts: chart, event: 'CO_ASSESSMENT',
      valuationClass: '', generalModifier: '', glAccount: ACCOUNT, reason: REASON,
    });
  }

  const admin = DEMO_FOUNDER_ACCOUNTS.administrator.username;
  return withActingUser(client, admin, async (actor) => {
    const options = { authorization: actor };
    // 3. The cycle.
    if (!(await getCycle(client, area, CYCLE))) {
      await saveCycle({ client, changedBy: admin, mode: 'CREATE', controllingArea: area, cycleCode: CYCLE, name: 'Service centre assessment', category: 'ASSESSMENT', validFrom: `${fiscalYear}-01-01`, validTo: '9999-12-31', isActive: true, reason: REASON }, options);
      await setSegment({ client, changedBy: admin, controllingArea: area, cycleCode: CYCLE, segmentNumber: 1, name: 'Services to production', receiverRule: 'PERCENTAGE', reason: REASON }, options);
      for (const [i, centre] of ['CC2000', 'CC5000'].entries()) {
        await setSender({ client, changedBy: admin, controllingArea: area, cycleCode: CYCLE, segmentNumber: 1, itemNumber: i + 1, costCenter: centre, reason: REASON }, options);
      }
      for (const [i, [centre, weight]] of ([['CC1000', '60'], ['CC1010', '40']] as const).entries()) {
        await setReceiver({ client, changedBy: admin, controllingArea: area, cycleCode: CYCLE, segmentNumber: 1, itemNumber: i + 1, costCenter: centre, weight, reason: REASON }, options);
      }
    }
    // 4. The run, once per period.
    const live = (await listRuns(client, area)).find((r) => r.cycleCode === CYCLE && r.fiscalYear === fiscalYear && r.period === period && r.status === 'EXECUTED');
    const run = live ?? await runAssessment({ client, changedBy: admin, controllingArea: area, cycleCode: CYCLE, fiscalYear, period, reason: REASON }, options);
    // 5. The distribution cycle and its run, once per period.
    if (!(await getCycle(client, area, DISTRIBUTION_CYCLE))) {
      await saveCycle({ client, changedBy: admin, mode: 'CREATE', controllingArea: area, cycleCode: DISTRIBUTION_CYCLE, name: 'Support centre distribution', category: 'DISTRIBUTION', validFrom: `${fiscalYear}-01-01`, validTo: '9999-12-31', isActive: true, reason: DISTRIBUTION_REASON }, options);
      await setSegment({ client, changedBy: admin, controllingArea: area, cycleCode: DISTRIBUTION_CYCLE, segmentNumber: 1, name: 'Support to production', receiverRule: 'PERCENTAGE', reason: DISTRIBUTION_REASON }, options);
      for (const [i, centre] of ['CC3000', 'CC6000'].entries()) {
        await setSender({ client, changedBy: admin, controllingArea: area, cycleCode: DISTRIBUTION_CYCLE, segmentNumber: 1, itemNumber: i + 1, costCenter: centre, reason: DISTRIBUTION_REASON }, options);
      }
      for (const [i, [centre, weight]] of ([['CC1000', '60'], ['CC1010', '40']] as const).entries()) {
        await setReceiver({ client, changedBy: admin, controllingArea: area, cycleCode: DISTRIBUTION_CYCLE, segmentNumber: 1, itemNumber: i + 1, costCenter: centre, weight, reason: DISTRIBUTION_REASON }, options);
      }
    }
    const liveDistribution = (await listRuns(client, area)).find((r) => r.cycleCode === DISTRIBUTION_CYCLE && r.fiscalYear === fiscalYear && r.period === period && r.status === 'EXECUTED');
    const distribution = liveDistribution ?? await runAssessment({ client, changedBy: admin, controllingArea: area, cycleCode: DISTRIBUTION_CYCLE, fiscalYear, period, reason: DISTRIBUTION_REASON }, options);
    return {
      account: ACCOUNT, cycle: CYCLE, fiscalYear, period, documentNumber: run.documentNumber, assessedTotal: run.assessedTotal,
      distributionCycle: DISTRIBUTION_CYCLE, distributionDocument: distribution.documentNumber, distributedTotal: distribution.assessedTotal,
    };
  });
}
