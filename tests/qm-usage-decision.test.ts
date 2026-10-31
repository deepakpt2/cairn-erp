import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createTenant, destroyTenant, defineTestRanges } from './helpers';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import {
  createOrder,
} from '../src/modules/purchasing/orders';

import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import {
  openLot,
} from '../src/modules/quality/lot';
import {
  saveCharacteristic,
  recordInspectionResult,
} from '../src/modules/quality/inspection-results';
import {
  UsageDecisionError,
  recordUsageDecision,
  postUsageDecisionWithStock,
  getDecisionWithLot,
} from '../src/modules/quality/usage-decision';
import { stockQuantity } from '../src/modules/inventory/schema';

const ACTOR = 'QM_DECISION_TEST';
const MATERIAL = 'MAT-QMD01';
const PLANT = '1000';
const STORE = '0001';

let tenant: any;
let counter = 0;
const key = (what: string) => `qm-decision-${what}-${++counter}`;

// Record a result for every characteristic that exists in the tenant, against the given lot.
// Without inspection plans, every defined characteristic is mandatory for every lot.
async function recordAllCharacteristics(lotNumber: string) {
  const rows = await withTenant(tenant.client, async (tx) => {
    return await tx.execute(sql`
      select characteristic_code as code, characteristic_type as type from inspection_characteristic
       where client = ${tenant.client}
    `) as unknown as Array<{ code: string; type: string }>;
  });
  for (const c of rows) {
    await recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lotNumber,
      characteristicCode: c.code,
      resultValue: '50.2',
      measuredUnit: c.type === 'QUANTITATIVE' ? 'MM' : undefined,
    });
  }
}

async function standingReceipt(quantity = 10) {
  const order = await createOrder({
    client: tenant.client, changedBy: ACTOR,
    supplierNumber: 'V10000', purchasingOrg: PLANT, purchasingGroup: '001',
    companyCode: PLANT, currency: '',
    items: [{
      materialNumber: MATERIAL, shortText: 'Inspected plates', quantity, unit: 'PC',
      netPrice: 10, priceUnit: 1, taxCode: '', plant: PLANT, storageLocation: STORE,
      markedForDeletion: false,
      scheduleLines: [{ deliveryDate: '2026-11-15', quantity }],
      assignments: [] as never[],
    }],
  });
  const doc = await postGoodsReceipt({
    client: tenant.client, changedBy: ACTOR, orderNumber: order.orderNumber,
    documentDate: '2026-10-18', postingDate: '2026-10-18',
    requestKey: key('gr'), stockType: 'QUALITY',
    lines: [{ itemNumber: 10, quantity, storageLocation: STORE }],
  });
  return { orderNumber: order.orderNumber, materialDocumentNumber: doc.materialDocumentNumber };
}

describe('QM usage decision (QE51N) and quality stock', () => {
  let document = '';
  let lot = '';

  afterAll(async () => {
    if (tenant?.client) await destroyTenant(tenant.client);
  });

  beforeAll(async () => {
    tenant = await createTenant('qm-usage-decision');
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await initializeMaterialPeriodControl({
      client: tenant.client, changedBy: ACTOR, companyCode: '1000',
      fiscalYear: 2026, period: 10, reason: 'QM usage decision',
    });
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, { client: tenant.client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'INSPLOT', subObject: '*', prefix: 'QL', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
        values (${tenant.client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${tenant.client}, 'V10000', 'ORGANIZATION', 'Test Supplier', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${tenant.client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
        values (${tenant.client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Inspected plates', 'RAW', 'PC', true, ${ACTOR})
        on conflict (client, material_number) do update set batch_managed = excluded.batch_managed
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
        values (${tenant.client}, ${MATERIAL}, '1000', 0, ${ACTOR}) on conflict do nothing
      `);
      // Seed movement types needed for quality stock posting
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category,
          movement_kind, source_stock_type, destination_stock_type, plant_rule, location_rule,
          valuation_relevant, account_assignment, created_by)
        values (${tenant.client}, 'TRANSFER_STYPE', 'Quality inspection to unrestricted stock', 'TRANSFER',
          'MATERIAL_DOCUMENT', 'STOCK_TYPE', 'QUALITY', 'UNRESTRICTED', 'SAME', 'SAME',
          false, 'NONE', ${ACTOR})
        on conflict (client, movement_type) do nothing
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category,
          movement_kind, source_stock_type, destination_stock_type, plant_rule, location_rule,
          valuation_relevant, account_assignment, created_by)
        values (${tenant.client}, 'TRANSFER_STYPE_BLOCK', 'Quality inspection to blocked stock', 'TRANSFER',
          'MATERIAL_DOCUMENT', 'STOCK_TYPE', 'QUALITY', 'BLOCKED', 'SAME', 'SAME',
          false, 'NONE', ${ACTOR})
        on conflict (client, movement_type) do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (
          client, material_number, valuation_area, valuation_class, price_control,
          standard_price, moving_average_price, price_unit, currency, created_by
        )
        values (${tenant.client}, ${MATERIAL}, '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        values (${tenant.client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
               (${tenant.client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR})
        on conflict do nothing
      `);
    });
    const posted = await standingReceipt();
    document = posted.materialDocumentNumber;

    const opened = await openLot({
      client: tenant.client, changedBy: ACTOR,
      materialDocumentNumber: document, lineNumber: 1,
      inspectionNote: 'Receipt for decision tests', requestKey: key('lot'),
    });
    lot = opened.lotNumber;

    // Set up one quantitative characteristic and record an accepted result
    await saveCharacteristic({
      client: tenant.client, changedBy: ACTOR,
      characteristicCode: 'DIM01',
      description: 'Outer diameter',
      characteristicType: 'QUANTITATIVE',
      nominalValue: 50,
      tolerancePlus: 1.0,
      toleranceMinus: -1.0,
      unit: 'MM',
    });
    await recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot,
      characteristicCode: 'DIM01',
      resultValue: '50.2',
      measuredUnit: 'MM',
    });
  });

  it('accepts a lot and moves quality stock to unrestricted', async () => {
    // The goods receipt already posted to QUALITY stock (stockType: 'QUALITY').
    // The lot references that receipt line, so its standing stock is in QUALITY.
    const before = await withTenant(tenant.client, async (tx) => {
      const [q] = await tx.execute(sql`
        select quantity::text as qty from stock_quantity
         where client = ${tenant.client} and material_number = ${MATERIAL} and plant = ${PLANT}
         and storage_location = ${STORE} and stock_type = 'QUALITY'
      `) as unknown as Array<{ qty: string }>;
      const [u] = await tx.execute(sql`
        select quantity::text as qty from stock_quantity
         where client = ${tenant.client} and material_number = ${MATERIAL} and plant = ${PLANT}
         and storage_location = ${STORE} and stock_type = 'UNRESTRICTED'
      `) as unknown as Array<{ qty: string }>;
      return { quality: q?.qty ?? '0', unrestricted: u?.qty ?? '0' };
    });

    await recordAllCharacteristics(lot);
    const decided = await postUsageDecisionWithStock({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot,
      decisionCode: 'ACCEPT',
      postStock: true,
    });
    expect(decided.decisionCode).toBe('ACCEPT');
    expect(decided.stockPosted).toBe(true);
    expect(decided.stockDocumentNumber).toBeTruthy();

    const after = await withTenant(tenant.client, async (tx) => {
      const [q] = await tx.execute(sql`
        select quantity::text as qty from stock_quantity
         where client = ${tenant.client} and material_number = ${MATERIAL} and plant = ${PLANT}
         and storage_location = ${STORE} and stock_type = 'QUALITY'
      `) as unknown as Array<{ qty: string }>;
      const [u] = await tx.execute(sql`
        select quantity::text as qty from stock_quantity
         where client = ${tenant.client} and material_number = ${MATERIAL} and plant = ${PLANT}
         and storage_location = ${STORE} and stock_type = 'UNRESTRICTED'
      `) as unknown as Array<{ qty: string }>;
      return { quality: q?.qty ?? '0', unrestricted: u?.qty ?? '0' };
    });

    // Quality stock should be 0 (or negative if there was none), unrestricted should have increased
    expect(Number(after.quality)).toBeLessThanOrEqual(Number(before.quality));
    expect(Number(after.unrestricted)).toBe(Number(before.unrestricted) + 10);
  });

  it('rejects a lot and moves quality stock to blocked', async () => {
    // Open a new lot for rejection test
    const posted2 = await standingReceipt(5);
    const opened2 = await openLot({
      client: tenant.client, changedBy: ACTOR,
      materialDocumentNumber: posted2.materialDocumentNumber, lineNumber: 1,
      inspectionNote: 'Receipt for rejection', requestKey: key('lot2'),
    });
    const lot2 = opened2.lotNumber;

    await saveCharacteristic({
      client: tenant.client, changedBy: ACTOR,
      characteristicCode: 'DIM02',
      description: 'Inner diameter',
      characteristicType: 'QUANTITATIVE',
      nominalValue: 50,
      tolerancePlus: 1.0,
      toleranceMinus: -1.0,
      unit: 'MM',
    });
    await recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot2,
      characteristicCode: 'DIM02',
      resultValue: '50.2',
      measuredUnit: 'MM',
    });

    await recordAllCharacteristics(lot2);
    const decided = await postUsageDecisionWithStock({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot2,
      decisionCode: 'REJECT',
      postStock: true,
    });
    expect(decided.decisionCode).toBe('REJECT');
    expect(decided.stockPosted).toBe(true);

    // Verify blocked stock has the quantity
    const blocked = await withTenant(tenant.client, async (tx) => {
      const [b] = await tx.execute(sql`
        select quantity::text as qty from stock_quantity
         where client = ${tenant.client} and material_number = ${MATERIAL} and plant = ${PLANT}
         and storage_location = ${STORE} and stock_type = 'BLOCKED'
      `) as unknown as Array<{ qty: string }>;
      return b?.qty ?? '0';
    });
    expect(Number(blocked)).toBe(5);
  });

  it('blocks a lot without moving stock when postStock is false', async () => {
    const posted3 = await standingReceipt(3);
    const opened3 = await openLot({
      client: tenant.client, changedBy: ACTOR,
      materialDocumentNumber: posted3.materialDocumentNumber, lineNumber: 1,
      inspectionNote: 'Receipt for block without stock move', requestKey: key('lot3'),
    });
    const lot3 = opened3.lotNumber;

    await saveCharacteristic({
      client: tenant.client, changedBy: ACTOR,
      characteristicCode: 'DIM03',
      description: 'Width',
      characteristicType: 'QUANTITATIVE',
      nominalValue: 50,
      tolerancePlus: 1.0,
      toleranceMinus: -1.0,
      unit: 'MM',
    });
    await recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot3,
      characteristicCode: 'DIM03',
      resultValue: '50.2',
      measuredUnit: 'MM',
    });

    await recordAllCharacteristics(lot3);
    const decided = await postUsageDecisionWithStock({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot3,
      decisionCode: 'BLOCK',
      postStock: false,
    });
    expect(decided.decisionCode).toBe('BLOCK');
    expect(decided.stockPosted).toBe(false);
    expect(decided.stockDocumentNumber).toBeNull();
  });

  it('keeps stock in quality for rework', async () => {
    const posted4 = await standingReceipt(2);
    const opened4 = await openLot({
      client: tenant.client, changedBy: ACTOR,
      materialDocumentNumber: posted4.materialDocumentNumber, lineNumber: 1,
      inspectionNote: 'Receipt for rework', requestKey: key('lot4'),
    });
    const lot4 = opened4.lotNumber;

    await saveCharacteristic({
      client: tenant.client, changedBy: ACTOR,
      characteristicCode: 'DIM04',
      description: 'Height',
      characteristicType: 'QUANTITATIVE',
      nominalValue: 50,
      tolerancePlus: 1.0,
      toleranceMinus: -1.0,
      unit: 'MM',
    });
    await recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot4,
      characteristicCode: 'DIM04',
      resultValue: '50.2',
      measuredUnit: 'MM',
    });

    await recordAllCharacteristics(lot4);
    const decided = await postUsageDecisionWithStock({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot4,
      decisionCode: 'REWORK',
      postStock: true,
    });
    expect(decided.decisionCode).toBe('REWORK');
    expect(decided.stockPosted).toBe(false);
    expect(decided.stockDocumentNumber).toBeNull();
  });

  it('refuses a decision on a lot with incomplete results', async () => {
    const posted5 = await standingReceipt(1);
    const opened5 = await openLot({
      client: tenant.client, changedBy: ACTOR,
      materialDocumentNumber: posted5.materialDocumentNumber, lineNumber: 1,
      inspectionNote: 'Receipt with no results', requestKey: key('lot5'),
    });
    const lot5 = opened5.lotNumber;

    await expect(postUsageDecisionWithStock({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot5,
      decisionCode: 'ACCEPT',
    })).rejects.toThrow(UsageDecisionError);
  });

  it('refuses a duplicate decision on the same lot', async () => {
    await expect(postUsageDecisionWithStock({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot,
      decisionCode: 'REJECT',
    })).rejects.toThrow(/already has a/);
  });

  it('reads back a decision with lot context', async () => {
    const view = await getDecisionWithLot(tenant.client, lot);
    expect(view).not.toBeNull();
    expect(view!.lotNumber).toBe(lot);
    expect(view!.decisionCode).toBe('ACCEPT');
    expect(view!.stockPosted).toBe(true);
    expect(view!.results.total).toBeGreaterThan(0);
    expect(view!.results.recorded).toBeGreaterThan(0);
  });
});
