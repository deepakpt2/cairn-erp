/**
 * Demo phase D16_COST_ESTIMATE — a standard cost estimate (CK11N) for one finished good.
 *
 * FG-CHOC is costed in the manufacturing plant on the installation's anchor date: its BOM selects the
 * made sub-assembly SEMI-DOUGH, so the estimate shows the roll-up (the dough is costed from its own flour,
 * sugar, fat, cocoa and mixing/packing hours, not from its standard price of 1.72). The estimate is
 * saved and nothing is released: **no price is written, no existing price or rate is changed.**
 *
 * What the demo lacked, and this phase fills (only where missing — it never overwrites a value):
 * - control key PP01 was not relevant for costing, so no operation would have been costed (a flag, not a price);
 * - the routing operations carried no operation quantity (hours), only a base quantity;
 * - the work centres carried no costing line (cost centre and activity type): WC01 → CC1000 / MIXH
 *   (mixing), WC02 → CC1010 / PACKH (packing). The plan prices of MIXH and PACKH already stand (D13).
 * Operation quantities are in hours against the operation's base quantity of 1200.
 *
 * It then reports what the estimate would have been had the sub-assembly been priced from its standard
 * price instead. Idempotent: a standing SAVED estimate of the date is read back, and the request key
 * makes a repeat a replay.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../db/client';
import { saveRoutingControlKey } from '../../modules/production/routing';
import { createCostEstimate, getCostEstimate, listCostEstimates, materialAmount, type CostEstimateView } from '../../modules/production/cost-estimate';
import { toScaled } from '../posting/decimal';
import { DEMO_ACTOR, DEMO_FOUNDER_ACCOUNTS, DEMO_IDENTITY, DEMO_STRUCTURE } from './demo-organisation';
import { withActingUser } from './demo-people';
import type { DemoTimeline } from './demo-provisioning';

const MATERIAL = 'FG-CHOC';
const SUB_ASSEMBLY = 'SEMI-DOUGH';

/** Hours per 1200 base units, by routing group and operation. */
const OPERATION_HOURS: Array<[string, string, string]> = [
  ['00000001', '0010', '12'], ['00000001', '0020', '6'],
  ['00000002', '0010', '6'], ['00000002', '0020', '18'],
  ['00000003', '0010', '6'], ['00000003', '0020', '18'],
  ['00000004', '0010', '6'], ['00000004', '0020', '18'],
  ['00000005', '0010', '1'],
];
const WORK_CENTRE_COSTING: Array<[string, string, string]> = [['WC01', 'CC1000', 'MIXH'], ['WC02', 'CC1010', 'PACKH']];

export interface DemoCostEstimateResult {
  material: string;
  plant: string;
  costingDate: string;
  costingVersion: string;
  lotSize: string;
  unit: string;
  currency: string;
  totalCost: string;
  unitCost: string;
  materialCost: string;
  activityCost: string;
  overheadCost: string;
  firstLines: string[];
  subAssemblyRolledUp: string;
  subAssemblyAtStandardPrice: string;
  totalIfSubAssemblyAtStandardPrice: string;
  rollUpDifference: string;
  filledIn: { controlKeyCosting: boolean; operationQuantities: number; workCenterCostingLines: number };
}

const m4 = (value: string) => toScaled(value, 4);
const shown = (value: bigint) => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 10000n}.${String((value < 0n ? -value : value) % 10000n).padStart(4, '0')}`;

export async function buildDemoCostEstimate(input: { client?: string; timeline: DemoTimeline }): Promise<DemoCostEstimateResult> {
  const client = input.client ?? DEMO_IDENTITY.clientKey;
  const plant = DEMO_STRUCTURE.manufacturingPlant;
  const area = DEMO_STRUCTURE.controllingArea;
  const costingDate = input.timeline.anchorDate;
  const admin = DEMO_FOUNDER_ACCOUNTS.administrator.username;

  // 1. What the demo lacked — filled only where missing.
  const [key] = (await withTenant(client, (tx) => tx.execute(sql`select costing, description from routing_control_key where client = ${client} and control_key = 'PP01'`))) as unknown as Array<{ costing: string; description: string }>;
  const controlKeyCosting = !!key && String(key.costing).trim() !== 'X';
  if (controlKeyCosting) {
    await saveRoutingControlKey({ client, changedBy: DEMO_ACTOR, controlKey: 'PP01', description: String(key!.description), costing: 'X' });
  }
  const counts = await withTenant(client, async (tx) => {
    let operationQuantities = 0;
    for (const [group, operation, hours] of OPERATION_HOURS) {
      const done = (await tx.execute(sql`
        update routing_operation set operation_quantity = ${hours}::numeric, operation_unit = 'HR', changed_by = ${DEMO_ACTOR}, changed_at = now()
         where client = ${client} and task_list_type = 'N' and routing_group = ${group} and operation_number = ${operation} and operation_quantity is null
        returning 1`)) as unknown as unknown[];
      operationQuantities += done.length;
    }
    let workCenterCostingLines = 0;
    for (const [workCenter, centre, type] of WORK_CENTRE_COSTING) {
      const done = (await tx.execute(sql`
        insert into work_center_costing (client, plant, work_center, line_number, valid_from, valid_to, controlling_area, cost_center, activity_type, created_by)
        select ${client}, ${plant}, ${workCenter}, 1, ${input.timeline.startDate}::date, '9999-12-31'::date, ${area}, ${centre}, ${type}, ${DEMO_ACTOR}
         where not exists (select 1 from work_center_costing where client = ${client} and plant = ${plant} and work_center = ${workCenter})
        returning 1`)) as unknown as unknown[];
      workCenterCostingLines += done.length;
    }
    return { operationQuantities, workCenterCostingLines };
  });

  // 2. The estimate, once per date; a repeat reads the standing one.
  const view: CostEstimateView = await withActingUser(client, admin, async (actor) => {
    const options = { authorization: actor };
    const standing = (await listCostEstimates({ client, materialNumber: MATERIAL, plant }, options)).find((e) => e.costingDate === costingDate && e.status === 'SAVED');
    if (standing) return getCostEstimate({ client, materialNumber: MATERIAL, plant, costingDate, costingVersion: standing.costingVersion }, options);
    return createCostEstimate({ client, materialNumber: MATERIAL, plant, costingDate, requestKey: `DEMO-CK11N-${MATERIAL}`, actor: admin }, options);
  });

  // 3. The roll-up, against the standard price the sub-assembly carries.
  const rolled = view.items.find((i) => i.componentMaterial === SUB_ASSEMBLY && i.level === 1)!;
  const [valuation] = (await withTenant(client, (tx) => tx.execute(sql`
    select standard_price::text as standard_price, price_unit::text as price_unit from material_valuation
     where client = ${client} and material_number = ${SUB_ASSEMBLY} and valuation_area = ${plant}`))) as unknown as Array<{ standard_price: string; price_unit: string }>;
  const atStandard = materialAmount(toScaled(rolled.quantity, 3), m4(valuation.standard_price), toScaled(valuation.price_unit, 3));
  const total = m4(view.totalCost);
  const ifStandard = total - m4(rolled.amount) + atStandard;

  return {
    material: view.materialNumber, plant: view.plant, costingDate: view.costingDate, costingVersion: view.costingVersion,
    lotSize: view.costingLotSize, unit: view.unit, currency: view.currency, totalCost: view.totalCost, unitCost: view.unitCost,
    materialCost: view.materialCost, activityCost: view.activityCost, overheadCost: view.overheadCost,
    firstLines: view.items.slice(0, 6).map((i) => (i.itemType === 'MATERIAL'
      ? `L${i.level} ${i.componentMaterial} ${i.quantity} ${i.unit ?? ''} @ ${i.price}/${i.priceUnit} (${i.priceSource}) = ${i.amount}${i.inTotal ? '' : ' [explains the line above]'}`
      : `op ${i.operationNumber} ${i.workCenter} ${i.costCenter ?? ''}/${i.activityType ?? ''} ${i.quantity} ${i.unit ?? ''} @ ${i.price}/${i.priceUnit} (${i.priceSource}) = ${i.amount}`)),
    subAssemblyRolledUp: rolled.amount, subAssemblyAtStandardPrice: shown(atStandard),
    totalIfSubAssemblyAtStandardPrice: shown(ifStandard), rollUpDifference: shown(total - ifStandard),
    filledIn: { controlKeyCosting, ...counts },
  };
}
