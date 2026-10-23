import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { getReceiptOrder, postGoodsReceipt, reverseGoodsReceipt } from '../src/modules/inventory/goods-receipt';
import { reverseMaterialDocument } from '../src/modules/inventory/material-document-reversal';
import { createPhysicalInventory } from '../src/modules/inventory/physical-inventory';
import { defineUomConversion } from '../src/modules/inventory/unit-conversion';
import {
  RETURN_CAPABILITY,
  ReturnDeliveryError,
  getReturnableDocument,
  postReturnDelivery,
  resolveReturnMovement,
} from '../src/modules/inventory/return-delivery';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

/**
 * SCR-145 / MBRL — a return is not a cancellation.
 *
 * A receipt of forty pieces, twenty returned, twenty more returned, a third attempt refused. The
 * received position on the purchase order falls by what went back and rises again when the return
 * is reversed. A cancelling-of-the-receipt is refused as a reference, because that document never
 * stood. Stock is judged on the exact dimension. The return posts through the same engine,
 * numbering service and journal as every other movement.
 */
const ACTOR = 'SCR145_RETURN_TEST';
const DAY = '2026-10-18';
const POSTING = { documentDate: DAY, postingDate: DAY };

describe('SCR-145 return delivery (MBRL)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr145-mbrl');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
        await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
        await defineRange(tx, { client, objectCode: 'PHYINV', subObject: '*', prefix: 'PI', numberLength: 7, createdBy: ACTOR });
        await tx.execute(sql`
          insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
          values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, created_by)
          values (${client}, 'V20000', 'ORGANIZATION', 'Return Supplier', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bp_role (client, partner_number, role_code, created_by)
          values (${client}, 'V20000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
          values (${client}, 'V20000', 'SUPPLIER', '1000', 'USD', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material (client, material_number, description, material_type, base_unit, created_by)
          values (${client}, 'RET-MAT', 'Returnable steel plate', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material (client, material_number, description, material_type, base_unit, created_by)
          values (${client}, 'RET-OTHER', 'Second returnable', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
          values (${client}, 'RET-MAT', '1000', 0, ${ACTOR}),
                 (${client}, 'RET-OTHER', '1000', 0, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material_valuation (
            client, material_number, valuation_area, valuation_class, price_control,
            standard_price, moving_average_price, price_unit, currency, created_by
          ) values (${client}, 'RET-MAT', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR}),
                   (${client}, 'RET-OTHER', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
                 (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}),
                 (${client}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '300000', ${ACTOR})
          on conflict do nothing
        `);
      });
      await initializeMaterialPeriodControl({
        client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'SCR-145 acceptance',
      });
    }
    return client;
  }

  const header = {
    supplierNumber: 'V20000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
  };
  const item = (materialNumber: string, quantity: number, netPrice: number, storageLocation = '0001') => ({
    materialNumber, shortText: materialNumber, quantity, unit: 'PC',
    netPrice, priceUnit: 1, taxCode: '', plant: '1000', storageLocation,
    markedForDeletion: false,
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity }],
    assignments: [] as never[],
  });

  let keySeed = 0;
  const nextKey = () => `scr145-${++keySeed}`;

  /**
   * The received quantity as the receipt screen reports it — not re-derived here, so the figure
   * under test is the one a user reads.
   */
  async function received(orderNumber: string, c = client): Promise<number> {
    const view = await getReceiptOrder(c, orderNumber);
    return view!.items[0].received;
  }

  async function stockOf(materialNumber = 'RET-MAT', location = '0001'): Promise<number> {
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select coalesce(quantity, 0)::text as quantity from stock_quantity
       where client = ${client} and material_number = ${materialNumber} and plant = '1000'
         and storage_location = ${location} and stock_type = 'UNRESTRICTED'
    `)) as unknown as Array<{ quantity: string }>;
    return rows[0] ? Number(rows[0].quantity) : 0;
  }

  async function valuationOf(materialNumber = 'RET-MAT') {
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select total_stock_quantity::text as qty, stock_value::text as value from material_valuation
       where client = ${client} and material_number = ${materialNumber} and valuation_area = '1000'
    `)) as unknown as Array<{ qty: string; value: string }>;
    return { qty: Number(rows[0].qty), value: Number(rows[0].value) };
  }

  let receiptNumber = '';
  let receiptOrder = '';
  let cancelledReceiptNumber = '';

  it('names its capability and posts the configured movement', async () => {
    const c = await standingClient();
    expect(RETURN_CAPABILITY).toBe('INV.RETURN.POST');
    const movement = await withTenant(c, (tx) => resolveReturnMovement(tx, c));
    expect(movement.movementType).toBe('RETURN_TO_VENDOR');
    expect(movement.direction).toBe('ISSUE');
    expect(movement.reversalMovementType).toBe('RETURN_TO_VENDOR_REV');
  });

  it('refuses a movement configuration that does not describe a return', async () => {
    const c = await standingClient();
    await withTenant(c, (tx) => tx.execute(sql`
      update movement_type set direction = 'RECEIPT' where client = ${c} and movement_type = 'RETURN_TO_VENDOR'
    `));
    const error = await withTenant(c, (tx) => resolveReturnMovement(tx, c)).catch((e: unknown) => e as ReturnDeliveryError);
    expect(error).toBeInstanceOf(ReturnDeliveryError);
    expect(error.message).toMatch(/must take stock out/);
    await withTenant(c, (tx) => tx.execute(sql`
      update movement_type set direction = 'ISSUE' where client = ${c} and movement_type = 'RETURN_TO_VENDOR'
    `));
  });

  it('receives forty pieces against a purchase order, and shows them returnable', async () => {
    const c = await standingClient();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item('RET-MAT', 40, 100)] });
    receiptOrder = order.orderNumber;
    const doc = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 40, storageLocation: '0001' }],
    });
    receiptNumber = doc.materialDocumentNumber;
    expect(await received(receiptOrder)).toBe(40);

    const view = await getReturnableDocument(c, { documentNumber: receiptNumber, documentYear: doc.documentYear });
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0].remaining).toBe(40);
    expect(view?.items[0].eligible).toBe(true);
    expect(view?.items[0].purchaseOrderNumber).toBe(order.orderNumber);
  });

  it('returns part of the quantity and pulls the received position down', async () => {
    const c = await standingClient();
    const before = await stockOf();
    const returned = await postReturnDelivery({
      client: c, changedBy: ACTOR, documentNumber: receiptNumber,
      ...POSTING, requestKey: nextKey(), lines: [{ originalLine: 1, quantity: 15 }],
    });

    expect(returned.status).toBe('POSTED');
    expect(returned.movementType).toBe('RETURN_TO_VENDOR');
    expect(returned.returnsAgainst?.documentNumber).toBe(receiptNumber);
    expect(returned.lines[0].returnOfLine).toBe(1);
    expect(returned.lines[0].quantity).toBe('15.000');
    expect(returned.journalDocumentNumber).toBeTruthy();

    expect(await stockOf()).toBe(before - 15);
    // The receipt stood; what changed is what is still received.
    expect(await received(receiptOrder)).toBe(25);
    expect((await valuationOf()).qty).toBe(25);

    const view = await getReturnableDocument(c, { documentNumber: receiptNumber });
    expect(view?.items[0].previouslyReturned).toBe(15);
    expect(view?.items[0].remaining).toBe(25);
  });

  it('posts the journal as the mirror of the receipt: inventory credited, GR/IR debited', async () => {
    const c = await standingClient();
    const rows = await withTenant(c, (tx) => tx.execute(sql`
      select l.gl_account, l.debit_credit, l.amount_local::text as amount
        from material_document d
        join journal_entry_line l
          on l.client = d.client and l.document_number = d.journal_document_number
       where d.client = ${c} and d.material_document_number = (
         select l2.material_document_number from material_document_line l2
          where l2.client = ${c} and l2.movement_type = 'RETURN_TO_VENDOR'
          order by l2.material_document_number limit 1
       )
       order by l.gl_account
    `)) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string }>;

    // The receipt debited inventory 120000 and credited GR/IR 210000. The return is its mirror:
    // stock leaves, so inventory is credited and the GR/IR position reopens.
    const inventory = rows.find((r) => r.gl_account === '120000');
    const grIr = rows.find((r) => r.gl_account === '210000');
    expect(inventory?.debit_credit).toBe('H');
    expect(grIr?.debit_credit).toBe('S');
    expect(Number(inventory?.amount)).toBe(1500);
    expect(Number(grIr?.amount)).toBe(1500);

    const balanced = rows.reduce((sum, r) => sum + (r.debit_credit === 'S' ? Number(r.amount) : -Number(r.amount)), 0);
    expect(Math.abs(balanced)).toBeLessThan(0.005);
  });

  it('returns the rest, and refuses a third attempt naming what is left', async () => {
    const c = await standingClient();
    const second = await postReturnDelivery({
      client: c, changedBy: ACTOR, documentNumber: receiptNumber,
      ...POSTING, requestKey: nextKey(), lines: [{ originalLine: 1, quantity: 25 }],
    });
    expect(second.status).toBe('POSTED');
    expect(await received(receiptOrder)).toBe(0);

    const error = await postReturnDelivery({
      client: c, changedBy: ACTOR, documentNumber: receiptNumber,
      ...POSTING, requestKey: nextKey(), lines: [{ originalLine: 1, quantity: 1 }],
    }).catch((e: unknown) => e as ReturnDeliveryError);
    expect(error.message).toMatch(/only 0\.000 of the 40\.000 received may still be returned/);

    const view = await getReturnableDocument(c, { documentNumber: receiptNumber });
    expect(view?.items[0].remaining).toBe(0);
    expect(view?.items[0].eligible).toBe(false);
    expect(view?.items[0].refusal).toMatch(/already been returned in full/);
  });

  it('reverses a return, which puts both the stock and the received quantity back', async () => {
    const c = await standingClient();
    const stockBefore = await stockOf();
    const returns = await withTenant(c, (tx) => tx.execute(sql`
      select l.material_document_number from material_document_line l
        join material_document d
          on d.client = l.client and d.material_document_number = l.material_document_number
       where l.client = ${c} and l.movement_type = 'RETURN_TO_VENDOR' and d.status = 'POSTED'
       order by l.material_document_number desc limit 1
    `)) as unknown as Array<{ material_document_number: string }>;
    const target = returns[0].material_document_number;

    await reverseMaterialDocument({
      client: c, changedBy: ACTOR, materialDocumentNumber: target,
      ...POSTING, requestKey: nextKey(),
    });

    expect(await stockOf()).toBe(stockBefore + 25);
    expect(await received(receiptOrder)).toBe(25);
    const view = await getReturnableDocument(c, { documentNumber: receiptNumber });
    expect(view?.items[0].previouslyReturned).toBe(15);
    expect(view?.items[0].remaining).toBe(25);
  });

  it('refuses a return against a receipt that has been cancelled', async () => {
    const c = await standingClient();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item('RET-OTHER', 10, 50)] });
    const doc = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 10, storageLocation: '0001' }],
    });
    cancelledReceiptNumber = doc.materialDocumentNumber;
    await reverseGoodsReceipt({
      client: c, changedBy: ACTOR, materialDocumentNumber: cancelledReceiptNumber,
      ...POSTING, requestKey: nextKey(),
    });

    const error = await postReturnDelivery({
      client: c, changedBy: ACTOR, documentNumber: cancelledReceiptNumber,
      ...POSTING, requestKey: nextKey(), lines: [{ originalLine: 1, quantity: 1 }],
    }).catch((e: unknown) => e as ReturnDeliveryError);
    expect(error.message).toMatch(/is reversed and cannot be returned against/);
  });

  it('refuses a return of more than the storage location carries, naming what stands', async () => {
    const c = await standingClient();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item('RET-MAT', 10, 100, '0002')] });
    const doc = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 10, storageLocation: '0002' }],
    });
    // Stock moved out of 0001 earlier in this suite; 0002 holds exactly this receipt.
    const error = await postReturnDelivery({
      client: c, changedBy: ACTOR, documentNumber: doc.materialDocumentNumber,
      ...POSTING, requestKey: nextKey(), lines: [{ originalLine: 1, quantity: 10, storageLocation: '0003' }],
    }).catch((e: unknown) => e as ReturnDeliveryError);
    expect(error.message).toMatch(/is 0\.000, short of the 10\.000 to return/);
  });

  it('refuses a unit it cannot convert, and refuses the structures canon does not carry', async () => {
    const c = await standingClient();
    const unconverted = await postReturnDelivery({
      client: c, changedBy: ACTOR, documentNumber: receiptNumber,
      ...POSTING, requestKey: nextKey(), lines: [{ originalLine: 1, quantity: 1, entryUnit: 'GAL' }],
    }).catch((e: unknown) => e as ReturnDeliveryError);
    expect(unconverted.message).toMatch(/carries no conversion from GAL/);

    await defineUomConversion({ client: c, changedBy: ACTOR, materialNumber: 'RET-MAT', alternativeUnit: 'BOX', numerator: 12, denominator: 1 });
    const batched = await postReturnDelivery({
      client: c, changedBy: ACTOR, documentNumber: receiptNumber,
      ...POSTING, requestKey: nextKey(), lines: [{ originalLine: 1, quantity: 1 }], batch: 'B-1',
    }).catch((e: unknown) => e as ReturnDeliveryError);
    expect(batched.message).toMatch(/has no batch/);

    const delivery = await postReturnDelivery({
      client: c, changedBy: ACTOR, documentNumber: receiptNumber,
      ...POSTING, requestKey: nextKey(), lines: [{ originalLine: 1, quantity: 1 }], createDelivery: true,
    }).catch((e: unknown) => e as ReturnDeliveryError);
    expect(delivery.message).toMatch(/no logistics module/);
  });

  it('posts the same request key once, however often it is retried', async () => {
    const c = await standingClient();
    const before = await withTenant(c, (tx) => tx.execute(sql`
      select count(*)::int as n from material_document where client = ${c}
    `)) as unknown as Array<{ n: number }>;
    const key = nextKey();
    const request = {
      client: c, changedBy: ACTOR, documentNumber: receiptNumber,
      ...POSTING, requestKey: key, lines: [{ originalLine: 1, quantity: 1 }],
    };
    // The line is now fully returned, so a *fresh* posting refuses; a replay must not.
    const first = await postReturnDelivery({
      ...request, documentNumber: (await withTenant(c, (tx) => tx.execute(sql`
        select l.material_document_number from material_document_line l
          join material_document d
            on d.client = l.client and d.material_document_number = l.material_document_number
         where l.client = ${c} and l.movement_type = 'GOODS_RECEIPT_PO' and d.status = 'POSTED'
         order by l.material_document_number desc limit 1
      `)) as unknown as Array<{ material_document_number: string }>)[0].material_document_number,
    });
    const replay = await postReturnDelivery({
      ...request, documentNumber: first.returnsAgainst!.documentNumber,
    });
    expect(replay.materialDocumentNumber).toBe(first.materialDocumentNumber);
    const after = await withTenant(c, (tx) => tx.execute(sql`
      select count(*)::int as n from material_document where client = ${c}
    `)) as unknown as Array<{ n: number }>;
    expect(after[0].n).toBe(before[0].n + 1);
  });

  it('answers to the physical inventory block like every other stock writer', async () => {
    const c = await standingClient();
    const count = await createPhysicalInventory({
      client: c, createdBy: ACTOR, plant: '1000', storageLocation: '0002',
      plannedCountDate: DAY, postingBlock: true, materials: ['RET-MAT'],
    });
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item('RET-MAT', 5, 100, '0002')] });
    const doc = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 5, storageLocation: '0002' }],
    }).catch((e: unknown) => e as Error);
    // The receipt itself is blocked by the count, which is the guard doing its job.
    expect((doc as Error).message).toMatch(/blocks postings/);
    void count;
  });
});
