import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postJournalEntry } from '../src/platform/posting';
import { closeDb, createTenant, destroyTenant, defineTestRanges } from './helpers';
import {
  saveAllocationStructure,
  saveAllocationStructureAssignment,
  saveSettlementProfile,
} from '../src/modules/foundation/settlement-configuration-masters';
import {
  assignProductionOrderTypeSettlementProfile,
  saveProductionOrderSettlementConfiguration,
} from '../src/modules/production/settlement-configuration';
import {
  createProductionOrder,
  releaseProductionOrder,
} from '../src/modules/inventory/production-orders';
import {
  ProductionOrderSettlementError,
  settleProductionOrder,
  productionOrderSettlementPosting,
} from '../src/modules/production/order-settlement';

const ACTOR = 'PROD_SETTLE_TEST';
const PLANT = 'QO01';
const ORDER_TYPE = 'PP01';

const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

interface Place {
  client: string;
  area: string;
  company: string;
  currency: string;
  periods: number;
}

async function standing(seed: string): Promise<Place> {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  await defineTestRanges(tenant);
  const place: Place = { client: tenant.client, area: '', company: '', currency: '', periods: 0 };
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, {
      client: tenant.client,
      objectCode: 'PRODORDER',
      subObject: '*',
      prefix: 'PRD',
      numberLength: 7,
      createdBy: ACTOR,
    });
    // RF_BELEG range is defined via defineTestRanges (companyCode-scoped, subObject GENERAL)
    // to match what postJournalEntry allocates against.
    await tx.execute(sql`
      insert into production_order_type (client, order_type, description, order_category, created_by)
      values (${tenant.client}, ${ORDER_TYPE}, 'Standard production', '10', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      select ${tenant.client}, ${PLANT}, 'Order plant', c.company_code, 'KW', ${ACTOR}
      from (select company_code from company_code where client = ${tenant.client} order by company_code limit 1) c
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${tenant.client}, v.n, v.d, t.material_type, 'PC', ${ACTOR}
      from (values ('FG01', 'Finished good'), ('RM01', 'Raw material one')) as v(n, d)
      cross join (select material_type from material_type where client = ${tenant.client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      select ${tenant.client}, v.n, ${PLANT}, ${ACTOR}
      from (values ('FG01'), ('RM01')) as v(n)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${tenant.client}, ${PLANT}, 'SO01', 'Order store', true, false, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      select ${tenant.client}, a.controlling_area, 'CC1000', '2020-01-01', '9999-12-31', 'Settlement receiver', 'PRODUCTION', c.company_code, ${ACTOR}
      from controlling_area_company a
      join company_code c on c.client = a.client and c.company_code = a.company_code
      where a.client = ${tenant.client}
      limit 1
      on conflict do nothing
    `);
    const [areaRow] = await tx.execute(sql`
      select c.controlling_area as area, c.currency, c.fiscal_year_variant as fv
        from controlling_area c
       where c.client = ${tenant.client}
       limit 1
    `) as unknown as Array<{ area: string; currency: string; fv: string }>;
    if (!areaRow) {
      throw new Error(`No controlling area found for tenant ${tenant.client}`);
    }
    place.area = areaRow.area;
    place.company = tenant.companyCode;
    place.currency = areaRow.currency.trim();
    // Look up periods from fiscal_year_variant
    const [fvRow] = await tx.execute(sql`
      select v.regular_periods as periods
        from fiscal_year_variant v
       where v.client = ${tenant.client} and v.variant = ${areaRow.fv}
       limit 1
    `) as unknown as Array<{ periods: number }>;
    place.periods = fvRow ? Number(fvRow.periods) : 12;
  });
  // Set up settlement masters for production orders (profile, structure, type assignment),
  // mirroring ensureSettlementMasters but using production order type instead of internal IO01.
  await saveAllocationStructure({
    client: place.client,
    changedBy: ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    structureCode: 'AS01',
    description: 'Original account',
  });
  await saveAllocationStructureAssignment({
    client: place.client,
    changedBy: ACTOR,
    expectedVersion: 0,
    structureCode: 'AS01',
    sourceAccount: '410000',
    receiverCategory: 'COST_CENTER',
    byOriginalAccount: true,
    settlementAccount: '',
  });
  await saveSettlementProfile({
    client: place.client,
    changedBy: ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    profileCode: 'SP01',
    description: 'Order settlement',
    allocationStructure: 'AS01',
    documentType: 'SA',
    percentageAllowed: true,
    equivalenceAllowed: true,
    amountAllowed: true,
    isActive: true,
  });
  await assignProductionOrderTypeSettlementProfile({
    client: place.client,
    changedBy: ACTOR,
    orderType: ORDER_TYPE,
    profileCode: 'SP01',
  });
  return place;
}

async function makeOrder(place: Place, orderType = ORDER_TYPE) {
  const view = await createProductionOrder({
    client: place.client,
    createdBy: ACTOR,
    materialNumber: 'FG01',
    plant: PLANT,
    orderQuantity: 100,
    scheduledStart: '2026-11-02',
    scheduledFinish: '2026-11-06',
    components: [
      { materialNumber: 'RM01', plant: PLANT, storageLocation: 'SO01', requiredQuantity: 50 },
    ],
    orderType,
  });
  await releaseProductionOrder({
    client: place.client,
    orderNumber: view.orderNumber,
    releasedBy: ACTOR,
  });
  return view;
}

function run(place: Place, orderNumber = '') {
  return {
    client: place.client,
    changedBy: ACTOR,
    orderNumber,
    controllingArea: place.area,
    fiscalYear: 2026,
    settlementPeriod: 1,
    testRun: true,
  };
}

async function postCost(place: Place, orderNumber: string, amount: string, account = '410000') {
  await withTenant(place.client, (tx) => postJournalEntry(tx, {
    client: place.client,
    companyCode: place.company,
    documentType: 'SA',
    documentDate: '2026-01-15',
    postingDate: '2026-01-15',
    fiscalYear: 2026,
    postingPeriod: 1,
    currency: place.currency,
    localCurrency: place.currency,
    headerText: 'Order cost',
    postedBy: ACTOR,
    lines: [
      { glAccount: account, debitCredit: 'S', amount, productionOrder: orderNumber },
      { glAccount: '100000', debitCredit: 'H', amount },
    ],
  }));
}

function settlementRule(place: Place, orderNumber: string, receiver: string, percentage = '100') {
  return saveProductionOrderSettlementConfiguration({
    client: place.client,
    changedBy: ACTOR,
    orderNumber,
    receiverCategory: 'COST_CENTER',
    receiver,
    percentage,
    settlementType: 'PER',
    validFromYear: 2026,
    validFromPeriod: 1,
    validToYear: 2026,
    validToPeriod: 12,
  });
}

describe('production order settlement', () => {
  it('does not post an individual settlement with no rule stored', async () => {
    const place = await standing('prod-settle-none');
    const saved = await makeOrder(place);
    const before = productionOrderSettlementPosting().posts;
    expect(before).toBe(false);
    const simulated = await settleProductionOrder(run(place, saved.orderNumber));
    expect(simulated.posted).toBe(false);
    expect(simulated.transactionCode).toBe('KO88');
    expect(simulated.documents).toEqual([]);
    expect(simulated.settled).toBe(0);
    expect(simulated.eligible).toBe(0);
    expect(simulated.fiscalYear).toBe(2026);
    expect(simulated.settlementPeriod).toBe(1);
    expect(simulated.orders).toHaveLength(1);
    expect(simulated.orders[0]?.reasons.join(' ')).toMatch(
      /receiver and a percentage are not assumed|rule stored on this order/i,
    );
    expect(simulated.orders[0]).not.toHaveProperty('receiver');
  });

  it('posts one balanced document from the stored rule and does not post again', async () => {
    const place = await standing('prod-settle-post');
    const saved = await makeOrder(place);
    await postCost(place, saved.orderNumber, '1000.00');
    await postCost(place, saved.orderNumber, '500.00');

    await assignProductionOrderTypeSettlementProfile({
      client: place.client, changedBy: ACTOR, orderType: ORDER_TYPE, profileCode: 'SP01',
    });
    await settlementRule(place, saved.orderNumber, 'CC1000', '100');

    const result = await settleProductionOrder({ ...run(place, saved.orderNumber), testRun: false });
    expect(result.posted).toBe(true);
    expect(result.transactionCode).toBe('KO88');
    expect(result.documents.length).toBe(1);
    expect(result.documents[0]?.amount).toBe('1500.0000');
    expect(result.settled).toBe(1);

    // Re-run: nothing to post again.
    const again = await settleProductionOrder({ ...run(place, saved.orderNumber), testRun: false });
    expect(again.documents).toEqual([]);
    expect(again.settled).toBe(0);
    expect(again.orders[0]?.reasons.join(' ')).toMatch(/nothing to settle/i);
  });

  it('refuses a period outside the fiscal year variant', async () => {
    const place = await standing('prod-settle-period');
    const saved = await makeOrder(place);
    await expect(settleProductionOrder({
      ...run(place, saved.orderNumber),
      settlementPeriod: place.periods + 1,
    })).rejects.toThrow(/outside fiscal year variant/);
  });

  it('does not read an order from another client', async () => {
    const tenant = await standing('prod-settle-hide');
    const other = await standing('prod-settle-miss');
    const saved = await makeOrder(tenant);
    const foreign = await settleProductionOrder(run(other, saved.orderNumber));
    expect(foreign.outcome).toBe('INVALID_SELECTION');
    expect(foreign.posted).toBe(false);
    const missing = await settleProductionOrder(run(other, 'PRD0000001'));
    expect(missing.outcome).toBe('INVALID_SELECTION');
    expect(missing.selected).toBe(0);
  });

  it('exposes KO88 posting flag as false until a run posts', () => {
    expect(productionOrderSettlementPosting().posts).toBe(false);
    expect(new ProductionOrderSettlementError('x').name).toBe('ProductionOrderSettlementError');
  });

  it('rejects a receiver the order does not allow', async () => {
    const place = await standing('prod-settle-badrule');
    const saved = await makeOrder(place);
    await expect(saveProductionOrderSettlementConfiguration({
      client: place.client,
      changedBy: ACTOR,
      orderNumber: saved.orderNumber,
      receiverCategory: 'COST_CENTER',
      receiver: 'ZZ9999',
      percentage: '100',
      settlementType: 'PER',
      validFromYear: 2026,
      validFromPeriod: 1,
      validToYear: 2026,
      validToPeriod: 12,
    })).rejects.toThrow(/not in controlling area|does not exist/);
  });
});
