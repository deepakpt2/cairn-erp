import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createBatch } from '../src/modules/inventory/batch-master';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import {
  getMaterialDocument,
  postGoodsReceipt,
  reverseGoodsReceipt,
} from '../src/modules/inventory/goods-receipt';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { createOrder } from '../src/modules/purchasing/orders';
import {
  InspectionLotError,
  getLot,
  listInspectableLines,
  listLots,
  openLot,
} from '../src/modules/quality/lot';
import { createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';

/**
 * QM slice 1 — the inspection lot as a record with no power over stock.
 *
 * Nothing here is mocked: the purchase order, the goods receipt, its material document, the batch and the
 * journal are written by the engines the screens call, and the lot is opened against what those postings left
 * in `material_document_line`. Every refusal the service promises is answered here by a real posting —
 * including the reversal, which is what proves the lot's standing is read from the receipt rather than kept
 * as a status of its own.
 */
const ACTOR = 'QM9192_LOT_TEST';
const POSTING = { documentDate: '2026-10-18', postingDate: '2026-10-18' };
const MATERIAL = 'MAT-QM01';
const BATCH = '00012';
const PLANT = '1000';
const STORE = '0001';

let tenant: TestTenant;
let other: TestTenant;
let counter = 0;
const key = (what: string) => `qm9192-${what}-${++counter}`;

async function standingReceipt(quantity = 4) {
  const order = await createOrder({
    client: tenant.client, changedBy: ACTOR,
    supplierNumber: 'V10000', purchasingOrg: PLANT, purchasingGroup: '001',
    companyCode: PLANT, currency: '',
    items: [{
      materialNumber: MATERIAL, shortText: 'Inspected plates', quantity, unit: 'PC',
      netPrice: 10, priceUnit: 1, taxCode: '', plant: PLANT, storageLocation: STORE, batch: BATCH,
      markedForDeletion: false,
      scheduleLines: [{ deliveryDate: '2026-11-15', quantity }],
      assignments: [] as never[],
    }],
  });
  const doc = await postGoodsReceipt({
    client: tenant.client, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
    requestKey: key('gr'), lines: [{ itemNumber: 10, quantity, storageLocation: STORE }],
  });
  return { orderNumber: order.orderNumber, materialDocumentNumber: doc.materialDocumentNumber };
}

/** Everything a lot must not touch, captured in one read so a test can compare the whole of it. */
async function goodsState(materialDocumentNumber: string) {
  return withTenant(tenant.client, async (tx) => {
    const stock = await tx.execute(sql`
      select stock_type, batch_number, quantity::text as quantity from stock_quantity
       where client = ${tenant.client} and material_number = ${MATERIAL} and plant = ${PLANT}
       order by stock_type, batch_number
    `) as unknown as Array<{ stock_type: string; batch_number: string; quantity: string }>;
    const valuation = await tx.execute(sql`
      select total_stock_quantity::text as total, stock_value::text as value, moving_average_price::text as map
        from material_valuation where client = ${tenant.client} and material_number = ${MATERIAL} and valuation_area = ${PLANT}
    `) as unknown as Array<Record<string, string>>;
    // The batch row and its version: an act that restricted or released these goods would show up here,
    // and a lot must not. Batch *status* management is not switched on for this material, so there is no
    // status row to read, and none is expected either way.
    const batch = await tx.execute(sql`
      select batch_number, restricted_use, version, coalesce(changed_at::text, '') as changed_at
        from batch where client = ${tenant.client} and material_number = ${MATERIAL} order by batch_number
    `) as unknown as Array<{ batch_number: string; restricted_use: string; version: string; changed_at: string }>;
    const documents = await tx.execute(sql`
      select count(*)::int as documents, coalesce(sum((select count(*) from material_document_line ml
        where ml.client = h.client and ml.material_document_number = h.material_document_number)), 0)::int as lines
        from material_document h where h.client = ${tenant.client}
    `) as unknown as Array<{ documents: number; lines: number }>;
    const journals = await tx.execute(sql`
      select count(*)::int as lines from journal_entry_line jl
        join material_document h on h.journal_document_number = jl.document_number and h.client = jl.client
       where h.client = ${tenant.client} and h.material_document_number = ${materialDocumentNumber}
    `) as unknown as Array<{ lines: number }>;
    return {
      stock, valuation: valuation[0] ?? null, batch,
      documents: documents[0]!.documents, documentLines: documents[0]!.lines,
      journalLines: journals[0]!.lines,
    };
  });
}

describe('inspection lot (QM slice 1)', () => {
  let document = '';
  let lot = '';

  beforeAll(async () => {
    tenant = await createTenant('qm9192-lot');
    other = await createTenant('qm9192-lot-other');
    await defineTestRanges(tenant, { fiscalYear: 2026 });
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
    await initializeMaterialPeriodControl({
      client: tenant.client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'QM slice 1',
    });
    await saveBatchLevel({ client: tenant.client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await createBatch({ client: tenant.client, changedBy: ACTOR, materialNumber: MATERIAL, batchNumber: BATCH, reason: 'Receipt batch' });

    const posted = await standingReceipt();
    document = posted.materialDocumentNumber;
  });

  afterAll(async () => {
    if (tenant?.client) await destroyTenant(tenant.client);
    if (other?.client) await destroyTenant(other.client);
  });

  it('opens a lot against the receipt line, and posts nothing around it', async () => {
    const before = await goodsState(document);
    const opened = await openLot({
      client: tenant.client, changedBy: ACTOR, materialDocumentNumber: document, lineNumber: 1,
      inspectionNote: 'Visual check of the pallets', requestKey: key('open'),
    });
    lot = opened.lotNumber;

    expect(opened.replayed).toBe(false);
    expect(opened.lotNumber).toMatch(/^QL-\d{7}$/);
    expect(opened.state).toBe('OPEN');
    expect(opened.inspectionNote).toBe('Visual check of the pallets');
    // The goods facts are read from the line the posting wrote, and they are the posting's own numbers.
    expect(opened.source).toMatchObject({
      materialDocumentNumber: document,
      lineNumber: 1,
      materialNumber: MATERIAL,
      plant: PLANT,
      storageLocation: STORE,
      batchNumber: BATCH,
      stockType: 'UNRESTRICTED',
      lineDirection: 'RECEIPT',
      baseQuantity: '4.000',
      baseUnit: 'PC',
      documentStatus: 'POSTED',
    });
    // The movement a goods receipt writes for a tenant that has configured nothing else: the
    // delivered code, not a classic number, because `movement_type` rows are ensured per tenant.
    expect(opened.source.movementType).toBe('GOODS_RECEIPT_PO');
    expect(opened.source.purchaseOrderNumber).toBeTruthy();

    // Nothing a lot could have changed about the goods moved: same stock segments and quantities, same
    // valuation, same batch, no second document, no extra journal line.
    const after = await goodsState(document);
    expect(after).toEqual(before);

    const view = await getMaterialDocument(tenant.client, document);
    expect(view?.status).toBe('POSTED');
    expect(await listInspectableLines(tenant.client, { materialDocumentNumber: document })).toHaveLength(0);
  });

  it('keeps only its own facts, and audits the opening as its own act', async () => {
    const columns = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'quality_lot' order by ordinal_position
    `)) as unknown as Array<{ column_name: string }>;
    // No material, plant, batch, quantity, unit or stock type of its own: those are the line's, and a copy
    // would become a second claim about goods the inventory engine already recorded.
    expect(columns.map((row) => row.column_name)).toEqual([
      'client', 'lot_number', 'material_document_number', 'material_document_line',
      'inspection_note', 'request_key', 'created_by', 'created_at', 'changed_by', 'changed_at',
    ]);

    const audit = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select d.object_class, d.object_key, d.change_type, count(i.id)::int as items
        from change_document d
        left join change_document_item i on i.change_document_id = d.id
       where d.client = ${tenant.client} and d.object_key = ${lot}
       group by d.object_class, d.object_key, d.change_type
    `)) as unknown as Array<{ object_class: string; object_key: string; change_type: string; items: number }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ object_class: 'quality_lot', object_key: lot, change_type: 'CREATE' });
    expect(audit[0]!.items).toBeGreaterThanOrEqual(6);
  });

  it('refuses a document line that does not exist', async () => {
    await expect(openLot({
      client: tenant.client, changedBy: ACTOR, materialDocumentNumber: '9999999999', lineNumber: 1,
      requestKey: key('missing'),
    })).rejects.toThrow(InspectionLotError);
    await expect(openLot({
      client: tenant.client, changedBy: ACTOR, materialDocumentNumber: document, lineNumber: 70,
      requestKey: key('missing-line'),
    })).rejects.toThrow(new RegExp(`no line 70 in this tenant`));
  });

  it('refuses a second lot on the same line and names the standing one', async () => {
    await expect(openLot({
      client: tenant.client, changedBy: ACTOR, materialDocumentNumber: document, lineNumber: 1,
      requestKey: key('twice'),
    })).rejects.toThrow(new RegExp(`Lot ${lot} already stands against ${document} line 1`));
    const rows = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as lots from quality_lot where client = ${tenant.client}
    `)) as unknown as Array<{ lots: number }>;
    expect(rows[0]!.lots).toBe(1);
  });

  it('returns the standing lot to a submission that repeats its request key', async () => {
    const requestKey = key('replay');
    const first = await openLot({
      client: tenant.client, changedBy: ACTOR,
      materialDocumentNumber: (await standingReceipt(2)).materialDocumentNumber, lineNumber: 1, requestKey,
    });
    const second = await openLot({
      client: tenant.client, changedBy: ACTOR,
      materialDocumentNumber: first.source.materialDocumentNumber, lineNumber: 1, requestKey,
    });
    expect(second.lotNumber).toBe(first.lotNumber);
    expect(second.replayed).toBe(true);

    const rows = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as lots from quality_lot where client = ${tenant.client} and request_key = ${requestKey}
    `)) as unknown as Array<{ lots: number }>;
    expect(rows[0]!.lots).toBe(1);
  });

  it("reads a lot's standing from the receipt it points at, so a reversal shows and an issue line is refused", async () => {
    const received = await standingReceipt(3);
    const opened = await openLot({
      client: tenant.client, changedBy: ACTOR,
      materialDocumentNumber: received.materialDocumentNumber, lineNumber: 1, requestKey: key('to-reverse'),
    });
    expect(opened.state).toBe('OPEN');

    const reversed = await reverseGoodsReceipt({
      client: tenant.client, changedBy: ACTOR,
      materialDocumentNumber: received.materialDocumentNumber, ...POSTING, requestKey: key('reverse'),
    });

    const after = await getLot(tenant.client, opened.lotNumber);
    expect(after?.state).toBe('SOURCE_REVERSED');
    expect(after?.source.documentStatus).toBe('REVERSED');
    expect(after?.source.reversedOutBy).toBe(`${reversed.materialDocumentNumber} / 1`);

    // The line the reversal wrote is not goods arriving either. Its own direction column still says
    // RECEIPT — the reversal path copies the original line (`goods-receipt.ts:855-870`), and the owner has
    // that file open — so the guard reads the pair the reversal names rather than the direction.
    await expect(openLot({
      client: tenant.client, changedBy: ACTOR,
      materialDocumentNumber: reversed.materialDocumentNumber, lineNumber: 1, requestKey: key('issue-line'),
    })).rejects.toThrow(/is the reversal of .*: it records goods going back/);
    // Nor is the receipt line the reversal undid.
    await expect(openLot({
      client: tenant.client, changedBy: ACTOR,
      materialDocumentNumber: received.materialDocumentNumber, lineNumber: 1, requestKey: key('undone'),
    })).rejects.toThrow(new RegExp(`stands reversed by ${reversed.materialDocumentNumber}`));

    // The first lot, whose receipt still stands, is unaffected by that reversal.
    expect((await getLot(tenant.client, lot))?.state).toBe('OPEN');
  });

  it('refuses to draw a number when the INSPLOT interval is blocked', async () => {
    const received = await standingReceipt(1);
    try {
      await withTenant(tenant.client, async (tx) => tx.execute(sql`
        update number_range set status = 'BLOCKED' where client = ${tenant.client} and object_code = 'INSPLOT'
      `));
      await expect(openLot({
        client: tenant.client, changedBy: ACTOR,
        materialDocumentNumber: received.materialDocumentNumber, lineNumber: 1, requestKey: key('blocked'),
      })).rejects.toThrow(/No active INSPLOT number range stands for this tenant/);
    } finally {
      await withTenant(tenant.client, async (tx) => tx.execute(sql`
        update number_range set status = 'ACTIVE' where client = ${tenant.client} and object_code = 'INSPLOT'
      `));
    }
    const opened = await openLot({
      client: tenant.client, changedBy: ACTOR,
      materialDocumentNumber: received.materialDocumentNumber, lineNumber: 1, requestKey: key('after-block'),
    });
    expect(opened.lotNumber).toMatch(/^QL-\d{7}$/);
  });

  it('holds a lot inside its tenant, and leaves the runtime role no way to rewrite it', async () => {
    const rows = await listLots(tenant.client, { materialDocumentNumber: document });
    expect(rows.map((row) => row.lotNumber)).toContain(lot);
    expect(rows[0]).toMatchObject({ materialNumber: MATERIAL, plant: PLANT, batchNumber: BATCH, state: 'OPEN' });

    // Another tenant's session cannot see the lot, cannot read it by number, and cannot place a row for it.
    expect(await listLots(other.client, {})).toEqual([]);
    expect(await getLot(other.client, lot)).toBeNull();
    await expect(withTenant(other.client, async (tx) => tx.execute(sql`
      insert into quality_lot (client, lot_number, material_document_number, material_document_line, created_by)
      values (${tenant.client}, 'QL9999999', ${document}, 1, ${ACTOR})
    `))).rejects.toThrow();

    // The table is append-only in this slice: the migration revoked update and delete, and the platform never
    // rewrites a lot — a decision, when it exists, will be its own act.
    await expect(withTenant(tenant.client, async (tx) => tx.execute(sql`
      update quality_lot set inspection_note = 'rewritten' where client = ${tenant.client} and lot_number = ${lot}
    `))).rejects.toThrow(/permission denied/);
  });
});
