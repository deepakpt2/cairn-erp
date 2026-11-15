/**
 * Demo phase D13_ACTIVITY_PRICE — activity price calculation (KSPI).
 *
 * The demo had no activity types. This phase defines three for the installation's year and plans
 * their output where D12 planned primary cost:
 * - MIXH, machine hours of Mixing (CC1000), price indicator 1 — calculated;
 * - PACKH, line hours of Packing (CC1010), price indicator 1 — calculated;
 * - QCH, inspection hours of Quality (CC6000), price indicator 3 at a manual 25.00 — skipped.
 * It then runs the calculation (annual basis) over the periods the cost centres are valid in, so the
 * activity rate screen shows calculated prices beside a manual one, with the rounding residual.
 *
 * Definitions and plans go through the product's configuration services; the calculation through
 * `calculateActivityPrices` as `demo.admin` (explicitly scoped by D9). No role is granted
 * CO.PLAN.ACTIVITYPRICE.EXECUTE. Idempotent: types are adopted when standing, a rate save replaces
 * its matrix, and a repeated calculation writes the same prices.
 */
import { and, eq } from 'drizzle-orm';

import { withTenant } from '../db/client';
import { planningContext, saveActivityRates } from '../../modules/foundation/activity-rate-definition';
import { saveActivityType } from '../../modules/foundation/activity-type-definition';
import { calculateActivityPrices } from '../../modules/foundation/activity-price';
import { listCostCentersFor } from '../../modules/foundation/cost-center-planning';
import { activityType } from '../../modules/foundation/schema';
import { DEMO_ACTOR, DEMO_FOUNDER_ACCOUNTS, DEMO_IDENTITY, DEMO_STRUCTURE } from './demo-organisation';
import { withActingUser } from './demo-people';
import type { DemoTimeline } from './demo-provisioning';

const REASON = 'Demo: activity types and their planned output';

const PLAN = [
  { type: 'MIXH', name: 'Mixing machine hours', centre: 'CC1000', indicator: '1', hours: '160', manualPrice: null },
  { type: 'PACKH', name: 'Packing line hours', centre: 'CC1010', indicator: '1', hours: '120', manualPrice: null },
  { type: 'QCH', name: 'Quality inspection hours', centre: 'CC6000', indicator: '3', hours: '40', manualPrice: '25.00' },
] as const;

export interface DemoActivityPriceResult {
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  prices: Record<string, string>;
  skipped: string[];
  totalResidual: string;
}

export async function buildDemoActivityPrice(input: { client?: string; timeline: DemoTimeline }): Promise<DemoActivityPriceResult> {
  const client = input.client ?? DEMO_IDENTITY.clientKey;
  const area = DEMO_STRUCTURE.controllingArea;
  const fiscalYear = Number(input.timeline.anchorDate.slice(0, 4));
  const context = await planningContext(client, area, fiscalYear);
  if (!context) throw new Error(`D13_ACTIVITY_PRICE: controlling area ${area} does not stand.`);

  // The periods every planned centre is valid in (the demo's centres stand from the timeline start).
  const centres = new Map((await listCostCentersFor(client, area, fiscalYear)).map((c) => [c.costCenter, c]));
  const regular = context.periods.filter((p) => p.periodType === 'REGULAR');
  const valid = regular.filter((p) => PLAN.every(({ centre }) => {
    const c = centres.get(centre);
    return c && c.validFrom <= p.start && c.validTo >= p.end;
  }));
  if (valid.length === 0) throw new Error('D13_ACTIVITY_PRICE: no period in which all planned cost centres stand.');
  const validFrom = valid[0]!.start;

  const standing = await withTenant(client, async (tx) => new Set((await tx.select({ code: activityType.activityType }).from(activityType)
    .where(and(eq(activityType.client, client), eq(activityType.controllingArea, area)))).map((r) => r.code)));
  for (const p of PLAN) {
    if (standing.has(p.type)) continue;
    await saveActivityType({
      client, changedBy: DEMO_ACTOR, mode: 'CREATE', controllingArea: area, activityType: p.type,
      validFrom, validTo: '9999-12-31', name: p.name, activityUnit: 'HR', category: '1',
      priceIndicator: p.indicator, validCcCategories: [], reason: REASON,
    });
  }
  for (const p of PLAN) {
    await saveActivityRates({
      client, changedBy: DEMO_ACTOR, controllingArea: area, planVersion: '000', fiscalYear, costCenter: p.centre, activityType: p.type,
      entries: valid.map((period) => ({
        period: period.period, plannedQuantity: p.hours, fixedPrice: p.manualPrice ?? '0', variablePrice: '0', priceUnit: 1,
      })),
      reason: REASON,
    });
  }

  const admin = DEMO_FOUNDER_ACCOUNTS.administrator.username;
  const view = await withActingUser(client, admin, (actor) => calculateActivityPrices({
    client, changedBy: admin, controllingArea: area, planVersion: '000', fiscalYear,
    periodFrom: valid[0]!.period, periodTo: valid.at(-1)!.period, basis: 'ANNUAL',
    reason: `Demo: activity prices ${fiscalYear} from the plan`, requestKey: `DEMO-KSPI-${fiscalYear}`,
  }, { authorization: actor }));

  return {
    fiscalYear,
    periodFrom: view.periodFrom,
    periodTo: view.periodTo,
    prices: Object.fromEntries(view.pairs.filter((p) => p.status === 'CALCULATED').map((p) => [`${p.costCenter}/${p.activityType}`, p.newPrices[0]?.price ?? ''])),
    skipped: view.pairs.filter((p) => p.status === 'SKIPPED').map((p) => `${p.costCenter}/${p.activityType}`),
    totalResidual: view.totalResidual,
  };
}
