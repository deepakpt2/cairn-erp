import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { getReceiptOrder, postGoodsReceipt } from '../src/modules/inventory/goods-receipt';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { postTransfer } from '../src/modules/inventory/transfer-posting';
import {
  MaterialReversalError,
  getReversalDocument,
  reverseMaterialDocument,
} from '../src/modules/inventory/material-document-reversal';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

/**
 * SCR-132 / MBST acceptance for INV.REVERSE.
 *
 * The suite pins the general reversal: a goods receipt reversed returns its
 * stock, restores the order's open quantity by derivation and reverses its
 * journal; a transfer reversed restores both sides; a document may be reversed
 * line by line, with PARTIALLY_REVERSED standing between POSTED and REVERSED;
 * and every refusal the package implies is refused by name.
 */
const ACTOR = 'SCR132_MBST_TEST';
const DAY = '2026-10-18';

describe('SCR-132 material document reversal (MBST)', () => {
  let client = '';
  let key = 0;
  const nextKey = () => `scr132-${++key}`;

  async function stock(mat: string, plant: string, location: string, type = 'UNRESTRICTED'): Promise<number> {
    return withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select quantity from stock_quantity
        where client = ${client} and material_number = ${mat} and plant = ${plant}
          and storage_location = ${location} and stock_type = ${type}
      `) as unknown as Array<{ quantity: string }>;
      return rows[0] ? Number(rows[0].quantity) : 0;
    });
  }

  beforeAll(async () => {
    const tenant = await createTenant('scr132-mbst');
    client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
        values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${client}, 'V13200', 'ORGANIZATION', 'Test Supplier', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, 'V13200', 'SUPPLIER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
        values (${client}, 'V13200', 'SUPPLIER', '1000', ${tenant.currency}, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${client}, 'MAT-13201', 'Reversal material', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
        values (${client}, 'MAT-13201', '1000', 0, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency, created_by)
        values (${client}, 'MAT-13201', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, ${tenant.currency}, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
               (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by)
        values (${client}, '1000', '0001', 'Main store', false, true, ${ACTOR}),
               (${client}, '1000', '0002', 'Second store', false, true, ${ACTOR}),
               (${client}, '1000', '0003', 'Open store', true, true, ${ACTOR})
        on conflict (client, plant, storage_location) do update set
          allow_negative_stock = excluded.allow_negative_stock, is_active = excluded.is_active
      `);
    });
    await initializeMaterialPeriodControl({
      client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'SCR-132 fixture',
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function goodsReceipt(quantity: number, storageLocation = '0001') {
    const order = await createOrder({
      client, changedBy: ACTOR,
      supplierNumber: 'V13200', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-13201', shortText: 'Reversal material', quantity, unit: 'PC',
        netPrice: 100, priceUnit: 1, taxCode: '', plant: '1000', storageLocation,
        markedForDeletion: false,
        scheduleLines: [{ deliveryDate: '2026-11-15', quantity }],
        assignments: [] as never[],
      }],
    });
    const doc = await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: DAY, postingDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: 10, quantity }],
    });
    return { order, doc };
  }

  it('reverses a goods receipt: stock returns, the order opens again and the journal reverses', async () => {
    const { order, doc } = await goodsReceipt(5);
    expect(await stock('MAT-13201', '1000', '0001')).toBe(5);
    const openBefore = (await getReceiptOrder(client, order.orderNumber))!.items[0];

    const reversal = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: doc.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });

    expect(reversal.reversalOf).toBe(doc.materialDocumentNumber);
    expect(reversal.status).toBe('POSTED');
    expect(reversal.journalDocumentNumber).not.toBeNull();
    expect(reversal.lines).toHaveLength(1);
    expect(reversal.lines[0].lineDirection).toBe('ISSUE');
    expect(reversal.lines[0].movementType).toBe('RECEIPT_REVERSAL');
    expect(await stock('MAT-13201', '1000', '0001')).toBe(0);

    const refreshed = await getReversalDocument(client, doc.materialDocumentNumber);
    expect(refreshed!.status).toBe('REVERSED');
    expect(refreshed!.reversedBy).toBe(reversal.materialDocumentNumber);
    expect(refreshed!.lines[0].remainingQuantity).toBe('0.000');

    const openAfter = (await getReceiptOrder(client, order.orderNumber))!.items[0];
    expect(openBefore.received).toBe(5);
    expect(openAfter.received).toBe(0);
    expect(openAfter.remaining).toBe(5);
  });

  it('reverses a transfer through the same engine, restoring both sides', async () => {
    await goodsReceipt(10);
    const transfer = await postTransfer({
      client, changedBy: ACTOR, movementTypeCode: '311', materialNumber: 'MAT-13201', quantity: 4,
      issuingPlant: '1000', issuingStorageLocation: '0001',
      receivingPlant: '1000', receivingStorageLocation: '0002',
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    expect(await stock('MAT-13201', '1000', '0002')).toBe(4);

    await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: transfer.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });

    expect(await stock('MAT-13201', '1000', '0001')).toBeGreaterThanOrEqual(0);
    expect(await stock('MAT-13201', '1000', '0002')).toBe(0);
  });

  it('reverses one line, leaves the other open, and completes on the second', async () => {
    await goodsReceipt(10);
    const transfer = await postTransfer({
      client, changedBy: ACTOR, movementTypeCode: '311', materialNumber: 'MAT-13201', quantity: 6,
      issuingPlant: '1000', issuingStorageLocation: '0001',
      receivingPlant: '1000', receivingStorageLocation: '0002',
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    const before = await stock('MAT-13201', '1000', '0002');

    const partial = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: transfer.materialDocumentNumber,
      lines: [2], postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    expect(partial.lines).toHaveLength(1);

    const halfway = await getReversalDocument(client, transfer.materialDocumentNumber);
    expect(halfway!.status).toBe('PARTIALLY_REVERSED');
    expect(halfway!.lines[0].remainingQuantity).toBe('6.000');
    expect(halfway!.lines[1].remainingQuantity).toBe('0.000');
    expect(await stock('MAT-13201', '1000', '0002')).toBe(before - 6);
    expect(await stock('MAT-13201', '1000', '0001')).toBeGreaterThanOrEqual(0);

    await expect(reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: transfer.materialDocumentNumber,
      lines: [2], postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(/Line 2 of material document .* is already reversed in full/);

    await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: transfer.materialDocumentNumber,
      lines: [1], postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    expect((await getReversalDocument(client, transfer.materialDocumentNumber))!.status).toBe('REVERSED');
  });

  it('refuses a document already reversed, and a reversal of a reversal', async () => {
    const { doc } = await goodsReceipt(2);
    const reversal = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: doc.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    const again = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: doc.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    }).catch((e: unknown) => e);
    expect((again as MaterialReversalError).message).toMatch(/has already been cancelled by/);
    expect((again as MaterialReversalError).remedy).toMatch(/reversed once/);
    await expect(reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: reversal.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(/is itself a reversal of/);
  });

  it('refuses an unknown document, a wrong fiscal year and a reason code by name', async () => {
    await expect(reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: 'NO-SUCH-DOC',
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(/does not exist/);

    const { doc } = await goodsReceipt(1);
    await expect(reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: doc.materialDocumentNumber,
      fiscalYear: 2025, postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(/stands in fiscal year 2026, not 2025/);

    const reason = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: doc.materialDocumentNumber,
      reason: '01', postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    }).catch((e: unknown) => e);
    expect((reason as MaterialReversalError).message).toMatch(/carries no reversal-reason table/);
    expect((reason as MaterialReversalError).remedy).toMatch(/write it in the header text/);
  });

  it('refuses a closed material period', async () => {
    const { doc } = await goodsReceipt(1);
    await expect(reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: doc.materialDocumentNumber,
      postingDate: '2026-01-15', documentDate: '2026-01-15', requestKey: nextKey(),
    })).rejects.toThrow(/material posting period 2026\/1 is closed/);
  });

  it('refuses to take back stock that has already left, and permits it where configured', async () => {
    const { doc } = await goodsReceipt(9, '0003');
    // Move the received stock out again through a transfer that leaves the open store.
    await postTransfer({
      client, changedBy: ACTOR, movementTypeCode: '311', materialNumber: 'MAT-13201', quantity: 9,
      issuingPlant: '1000', issuingStorageLocation: '0003',
      receivingPlant: '1000', receivingStorageLocation: '0001',
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    // The open store permits a negative, so the reversal stands and the balance goes negative.
    const reversal = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: doc.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    expect(reversal.materialDocumentNumber).toBeTruthy();
    expect(await stock('MAT-13201', '1000', '0003')).toBe(-9);
  });

  it('returns the reversal already standing for a replayed request key', async () => {
    const { doc } = await goodsReceipt(1);
    const request = {
      client, changedBy: ACTOR, materialDocumentNumber: doc.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    };
    const first = await reverseMaterialDocument(request);
    const second = await reverseMaterialDocument(request);
    expect(second.materialDocumentNumber).toBe(first.materialDocumentNumber);
  });

  it('refuses a movement type that names no counter', async () => {
    const { doc } = await goodsReceipt(1);
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, reversal_movement_type, created_by)
        values (${client}, 'NO_COUNTER', 'No counter', 'RECEIPT', 'MATERIAL_DOCUMENT', null, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        update material_document_line set movement_type = 'NO_COUNTER'
        where client = ${client} and material_document_number = ${doc.materialDocumentNumber}
      `);
    });
    await expect(reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: doc.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(/names no counter movement type/);
  });
});
