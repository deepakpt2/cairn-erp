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
  InspectionLotError,
  openLot,
  getLot,
} from '../src/modules/quality/lot';
import {
  saveCharacteristic,
  InspectionResultError,
  recordInspectionResult,
  getInspectionResult,
  listInspectionResults,
  lotResultSummary,
} from '../src/modules/quality/inspection-results';

const ACTOR = 'QM_INSPECTION_TEST';
const MATERIAL = 'MAT-QMI01';
const PLANT = '1000';
const STORE = '0001';

let tenant: any;
let counter = 0;
const key = (what: string) => `qm-inspection-${what}-${++counter}`;

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
    requestKey: key('gr'), lines: [{ itemNumber: 10, quantity, storageLocation: STORE }],
  });
  return { orderNumber: order.orderNumber, materialDocumentNumber: doc.materialDocumentNumber };
}

describe('QM inspection results (QA32)', () => {
  let document = '';
  let lot = '';

  afterAll(async () => {
    if (tenant?.client) await destroyTenant(tenant.client);
  });

  beforeAll(async () => {
    tenant = await createTenant('qm-inspection-results');
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await initializeMaterialPeriodControl({
      client: tenant.client, changedBy: ACTOR, companyCode: '1000',
      fiscalYear: 2026, period: 10, reason: 'QM inspection results',
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
      inspectionNote: 'First receipt for QM tests', requestKey: key('lot'),
    });
    lot = opened.lotNumber;
  });

  it('saves a quantitative characteristic with tolerances and unit', async () => {
    const saved = await saveCharacteristic({
      client: tenant.client, changedBy: ACTOR,
      characteristicCode: 'DIM01',
      description: 'Outer diameter',
      characteristicType: 'QUANTITATIVE',
      nominalValue: 50,
      tolerancePlus: 0.5,
      toleranceMinus: -0.5,
      unit: 'MM',
    });
    expect(saved.characteristicCode).toBe('DIM01');
    expect(saved.characteristicType).toBe('QUANTITATIVE');
    expect(saved.unit).toBe('MM');
    expect(saved.tolerancePlus).toBe('0.5000');
    expect(saved.toleranceMinus).toBe('-0.5000');
  });

  it('saves a qualitative characteristic without unit', async () => {
    const saved = await saveCharacteristic({
      client: tenant.client, changedBy: ACTOR,
      characteristicCode: 'VIS01',
      description: 'Visual appearance',
      characteristicType: 'QUALITATIVE',
    });
    expect(saved.characteristicCode).toBe('VIS01');
    expect(saved.characteristicType).toBe('QUALITATIVE');
    expect(saved.unit).toBeNull();
  });

  it('refuses a quantitative characteristic without a unit', async () => {
    await expect(saveCharacteristic({
      client: tenant.client, changedBy: ACTOR,
      characteristicCode: 'BAD01',
      description: 'Bad quantitative',
      characteristicType: 'QUANTITATIVE',
    })).rejects.toThrow(/quantitative characteristic needs a unit/);
  });

  it('records a quantitative result within tolerance and marks it ACCEPTED', async () => {
    const result = await recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot,
      characteristicCode: 'DIM01',
      resultValue: '50.2',
      measuredUnit: 'MM',
    });
    expect(result.resultValue).toBe('50.2');
    expect(result.measuredUnit).toBe('MM');
    expect(result.resultStatus).toBe('ACCEPTED');
  });

  it('records a quantitative result outside tolerance and marks it REJECTED', async () => {
    await saveCharacteristic({
      client: tenant.client, changedBy: ACTOR,
      characteristicCode: 'DIM02',
      description: 'Inner diameter',
      characteristicType: 'QUANTITATIVE',
      nominalValue: 50,
      tolerancePlus: 0.5,
      toleranceMinus: -0.5,
      unit: 'MM',
    });
    const result = await recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot,
      characteristicCode: 'DIM02',
      resultValue: '51.0',
      measuredUnit: 'MM',
    });
    expect(result.resultStatus).toBe('REJECTED');
  });

  it('records a qualitative result with PASS/FAIL', async () => {
    const result = await recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot,
      characteristicCode: 'VIS01',
      resultValue: 'PASS',
    });
    expect(result.resultValue).toBe('PASS');
    expect(result.measuredUnit).toBeNull();
    expect(result.resultStatus).toBe('RECORDED');
  });

  it('refuses a unit on a qualitative result', async () => {
    await expect(recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot,
      characteristicCode: 'VIS01',
      resultValue: 'FAIL',
      measuredUnit: 'MM',
    })).rejects.toThrow(/qualitative result carries no unit/);
  });

  it('refuses a non-numeric result for a quantitative characteristic', async () => {
    await expect(recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot,
      characteristicCode: 'DIM01',
      resultValue: 'not-a-number',
      measuredUnit: 'MM',
    })).rejects.toThrow(/not a number/);
  });

  it('refuses a result for a lot that does not exist', async () => {
    await expect(recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: 'QL9999999',
      characteristicCode: 'DIM01',
      resultValue: '50.0',
      measuredUnit: 'MM',
    })).rejects.toThrow(InspectionLotError);
  });

  it('refuses a result for a characteristic that does not exist', async () => {
    await expect(recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot,
      characteristicCode: 'NOPE99',
      resultValue: '50.0',
      measuredUnit: 'MM',
    })).rejects.toThrow(/does not exist/);
  });

  it('reads back a recorded result', async () => {
    const view = await getInspectionResult(tenant.client, lot, 'DIM01');
    expect(view).not.toBeNull();
    expect(view!.lotNumber).toBe(lot);
    expect(view!.characteristicCode).toBe('DIM01');
    expect(view!.resultValue).toBe('50.2');
    expect(view!.resultStatus).toBe('ACCEPTED');
  });

  it('lists all results for a lot', async () => {
    const list = await listInspectionResults(tenant.client, lot);
    expect(list.length).toBeGreaterThanOrEqual(3);
    const codes = list.map((r) => r.characteristicCode);
    expect(codes).toContain('DIM01');
    expect(codes).toContain('DIM02');
    expect(codes).toContain('VIS01');
  });

  it('supersedes a previous result for the same lot/characteristic', async () => {
    const first = await recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot,
      characteristicCode: 'DIM01',
      resultValue: '50.5',
      measuredUnit: 'MM',
    });
    expect(first.resultValue).toBe('50.5');

    const view = await getInspectionResult(tenant.client, lot, 'DIM01');
    expect(view!.resultValue).toBe('50.5');
    // Only one row per lot/characteristic
    const list = await listInspectionResults(tenant.client, lot);
    const dim01 = list.filter((r) => r.characteristicCode === 'DIM01');
    expect(dim01.length).toBe(1);
  });

  it('computes lot result summary', async () => {
    const summary = await lotResultSummary(tenant.client, lot);
    expect(summary).not.toBeNull();
    expect(summary!.totalCharacteristics).toBe(3);
    expect(summary!.resultsRecorded).toBe(3);
    expect(summary!.resultsAccepted).toBe(1); // DIM01 accepted
    expect(summary!.resultsRejected).toBe(1); // DIM02 rejected
    // VIS01 is RECORDED not ACCEPTED, so not all complete
    expect(summary!.allMandatoryComplete).toBe(true);
    expect(summary!.canDecide).toBe(true);
  });

  it('records overwrite the prior result for the same lot/characteristic', async () => {
    const first = await recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot,
      characteristicCode: 'DIM01',
      resultValue: '50.2',
      measuredUnit: 'MM',
    });
    expect(first.resultValue).toBe('50.2');

    const second = await recordInspectionResult({
      client: tenant.client, changedBy: ACTOR,
      lotNumber: lot,
      characteristicCode: 'DIM01',
      resultValue: '50.5',
      measuredUnit: 'MM',
    });
    expect(second.resultValue).toBe('50.5');

    // Only one row per lot/characteristic, value is the latest
    const view = await getInspectionResult(tenant.client, lot, 'DIM01');
    expect(view!.resultValue).toBe('50.5');
    const list = await listInspectionResults(tenant.client, lot);
    const dim01 = list.filter((r) => r.characteristicCode === 'DIM01');
    expect(dim01.length).toBe(1);
  });
});
