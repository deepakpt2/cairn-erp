/**
 * Demo phase D12_CO_PLAN — cost centre planning (KP06): a plan to measure the year against.
 *
 * The demo's actual costs reach its cost centres through the finance, production and payroll phases.
 * This phase plans the fiscal year of the installation for every cost centre and cost element that
 * carries cost: the monthly plan is the element's average actual month, rounded to whole currency
 * units, spread as a total over the regular periods the cost centre is valid in (version 000) — the
 * demo's centres stand from the timeline's start, and a period they do not cover is not planned. The actual/plan
 * report then shows variance for every period that has actuals, and plan alone for the rest.
 *
 * Saved through `saveCostCenterPlan` as `demo.admin` (D9 gave it its explicit Company Code scope);
 * no role is granted CO.PLAN.COSTCENTER.MAINTAIN. Idempotent: a save replaces the selection, so a
 * repeat writes the same plan and changes nothing.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../db/client';
import { derivePosition } from '../periods';
import { planningContext } from '../../modules/foundation/activity-rate-definition';
import { listCostCentersFor, planningCurrencyDecimals, saveCostCenterPlan, spreadAnnualTotal } from '../../modules/foundation/cost-center-planning';
import { DEMO_FOUNDER_ACCOUNTS, DEMO_IDENTITY, DEMO_STRUCTURE } from './demo-organisation';
import { withActingUser } from './demo-people';
import type { DemoTimeline } from './demo-provisioning';

export interface DemoCoPlanResult {
  fiscalYear: number;
  planVersion: string;
  costCenters: number;
  elements: number;
  annualTotal: string;
}

export async function buildDemoCoPlan(input: { client?: string; timeline: DemoTimeline }): Promise<DemoCoPlanResult> {
  const client = input.client ?? DEMO_IDENTITY.clientKey;
  const area = DEMO_STRUCTURE.controllingArea;
  const { fiscalYear, actuals } = await withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select fiscal_year_variant from company_code where client = ${client} and company_code = ${DEMO_STRUCTURE.companyCode}`)) as unknown as Array<{ fiscal_year_variant: string }>;
    const position = await derivePosition(tx, client, rows[0]!.fiscal_year_variant, input.timeline.anchorDate);
    const actuals = (await tx.execute(sql`
      select l.cost_center, l.gl_account,
             count(distinct date_trunc('month', e.posting_date))::int as months,
             sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end)::text as amount
        from journal_entry_line l
        join journal_entry e on e.client = l.client and e.company_code = l.company_code
                            and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
       where l.client = ${client} and coalesce(l.cost_center, '') <> '' and e.fiscal_year = ${position.fiscalYear}
         and l.company_code in (select company_code from controlling_area_company where client = ${client} and controlling_area = ${area})
       group by 1, 2
       having sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end) <> 0
       order by 1, 2
    `)) as unknown as Array<{ cost_center: string; gl_account: string; months: number; amount: string }>;
    return { fiscalYear: position.fiscalYear, actuals };
  });

  const context = await planningContext(client, area, fiscalYear);
  if (!context) throw new Error(`D12_CO_PLAN: controlling area ${area} does not stand.`);
  const regular = context.periods.filter((p) => p.periodType === 'REGULAR');
  const decimals = await planningCurrencyDecimals(client, context.currency);
  const validity = new Map((await listCostCentersFor(client, area, fiscalYear)).map((c) => [c.costCenter, c]));
  const periodsOf = (centre: string) => {
    const c = validity.get(centre);
    return c ? regular.filter((p) => c.validFrom <= p.end && p.start <= c.validTo) : [];
  };
  const byCentre = new Map<string, Array<{ element: string; annual: string }>>();
  let grand = 0;
  for (const a of actuals) {
    const monthly = Math.round(Number(a.amount) / Math.max(1, Number(a.months)));
    if (monthly === 0 || periodsOf(a.cost_center).length === 0 || validity.get(a.cost_center)?.isPostingLocked) continue;
    const annual = monthly * periodsOf(a.cost_center).length;
    grand += annual;
    const list = byCentre.get(a.cost_center) ?? [];
    list.push({ element: a.gl_account, annual: String(annual) });
    byCentre.set(a.cost_center, list);
  }

  const admin = DEMO_FOUNDER_ACCOUNTS.administrator.username;
  await withActingUser(client, admin, async (actor) => {
    for (const [costCenter, elements] of byCentre) {
      const periods = periodsOf(costCenter);
      const entries = elements.flatMap(({ element, annual }) => {
        const parts = spreadAnnualTotal(annual, periods.length, decimals);
        return periods.map((p, i) => ({ costElement: element, period: p.period, amount: parts[i]! }));
      });
      await saveCostCenterPlan({
        client, changedBy: admin, controllingArea: area, planVersion: '000', fiscalYear, costCenter, entries,
        reason: `Demo plan ${fiscalYear}: each element's average actual month, twelve times`,
        requestKey: `DEMO-COPLAN-${fiscalYear}-${costCenter}`,
      }, { authorization: actor });
    }
  });

  return {
    fiscalYear,
    planVersion: '000',
    costCenters: byCentre.size,
    elements: [...byCentre.values()].reduce((n, list) => n + list.length, 0),
    annualTotal: grand.toFixed(decimals),
  };
}
