import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postGoodsIssue } from '../src/modules/inventory/goods-issue';
import { MaterialReversalError, reverseMaterialDocument } from '../src/modules/inventory/material-document-reversal';
import { postProductionReceipt, receivedQuantityFor } from '../src/modules/inventory/production-receipt';
import { createProductionOrder, releaseProductionOrder } from '../src/modules/inventory/production-orders';
import { defineUomConversion } from '../src/modules/inventory/unit-conversion';
import { getProductionOrderDisplay } from '../src/modules/production/production-order-display';
import { planSingleItem } from '../src/modules/production/mrp-run';
import { stockRequirementsList } from '../src/modules/production/stock-requirements';
import { createTenant, destroyTenant } from './helpers';

/**
 * Open production quantities after MBST.
 *
 * A line is reversed in full or not at all. Reversing one line of a document
 * restores only that line. A partial quantity is refused, not netted. A 261
 * never changes receipt supply, and a 101 never changes component demand.
 */
const ACTOR = 'REVQTY_TEST';
const PLANT = 'RV01';
const COMPANY = '1000';
const DAY = '2026-10-16';

describe('production reversal quantities', () => {
  let client = '';
  let other = '';
  let key = 0;
  const nextKey = () => `revqty-${++key}`;

  async function order(material: string, quantity: number, components: Array<{ materialNumber: string; requiredQuantity: number }>) {
    const draft = await createProductionOrder({
      orderType: 'PP01',
      client, createdBy: ACTOR,
      materialNumber: material, plant: PLANT, orderQuantity: quantity,
      scheduledStart: '2026-10-01', scheduledFinish: '2026-10-20',
      components: components.map((component) => ({ ...component, plant: PLANT, storageLocation: 'RS01' })),
    });
    await releaseProductionOrder({ client, orderNumber: draft.orderNumber, releasedBy: ACTOR });
    await withTenant(client, (tx) => tx.execute(sql`
      update production_order_component
         set requirement_date = '2026-10-18'
       where client = ${client} and order_number = ${draft.orderNumber}
    `));
    return draft.orderNumber;
  }

  async function issued(orderNumber: string, item: number) {
    const shown = await getProductionOrderDisplay(client, orderNumber);
    return Number(shown?.components.find((row) => row.itemNumber === item)?.issuedQuantity ?? '0');
  }

  async function componentRow(material: string, orderNumber: string) {
    const list = await stockRequirementsList({
      client, today: '2026-10-01', selection: { material, plant: PLANT },
    });
    return {
      row: list.rows.find((item) => item.documentNumber === orderNumber && item.elementType === 'PRODUCTION_COMPONENT'),
      warnings: list.warnings,
    };
  }

  async function receiptRow(material: string, orderNumber: string) {
    const list = await stockRequirementsList({
      client, today: '2026-10-01', selection: { material, plant: PLANT },
    });
    return list.rows.find((item) => item.documentNumber === orderNumber && item.elementType === 'PRODUCTION_ORDER');
  }

  async function plan(material: string) {
    return planSingleItem({
      client, requestedBy: ACTOR, requestKey: nextKey(),
      materialNumber: material, plant: PLANT,
      processingKey: 'NEUPL', confirmRegenerative: true, simulationOnly: true,
    });
  }

  function demanded(run: Awaited<ReturnType<typeof plan>>, orderNumber: string) {
    return run.diagnostics.find((row) => row.diagnosticCode === 'PRODUCTION_COMPONENT_DEMAND' && row.message.includes(orderNumber));
  }

  beforeAll(async () => {
    client = (await createTenant('rev-qty')).client;
    other = (await createTenant('rev-qty-other')).client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, v.n, v.n, v.t, 'PC', ${ACTOR}
          from (values
            ('REV-FG', 'FIN'), ('REV-OUT', 'FIN'),
            ('REV-A', 'RAW'), ('REV-B', 'RAW'), ('REV-C', 'RAW'), ('REV-D', 'RAW'),
            ('REV-E', 'RAW'), ('REV-U', 'RAW'), ('REV-F', 'RAW')
          ) as v(n, t)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${client}, ${PLANT}, 'Reversal plant', c.company_code, 'KW', ${ACTOR}
          from (select company_code from company_code where client = ${client} order by company_code limit 1) c
        on conflict (client, plant) do update set company_code = excluded.company_code
      `);
      await tx.execute(sql`
        insert into material_plant (
          client, material_number, plant, mrp_type, mrp_controller, procurement_type, lot_sizing,
          purchasing_group, mrp_status, created_by
        )
        select ${client}, v.n, ${PLANT}, 'REQUIREMENTS', '001', 'BUY', 'EXACT', '001', 'MAINTAINED', ${ACTOR}
          from (values ('REV-FG'), ('REV-OUT'), ('REV-A'), ('REV-B'), ('REV-C'), ('REV-D'), ('REV-E'), ('REV-U'), ('REV-F')) as v(n)
        on conflict (client, material_number, plant) do update set
          mrp_type = excluded.mrp_type, procurement_type = excluded.procurement_type,
          lot_sizing = excluded.lot_sizing, purchasing_group = excluded.purchasing_group, mrp_status = 'MAINTAINED'
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${client}, ${PLANT}, 'RS01', 'Reversal store', true, false, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (
          client, material_number, valuation_area, valuation_class, price_control,
          standard_price, moving_average_price, price_unit, currency, total_stock_quantity, stock_value, created_by
        )
        select ${client}, v.n, ${PLANT}, v.c, v.p, 10, 10, 1, 'USD', v.q, v.q * 10, ${ACTOR}
          from (values
            ('REV-FG', 'FINISHED_INVENTORY', 'STANDARD', 0),
            ('REV-OUT', 'FINISHED_INVENTORY', 'STANDARD', 0),
            ('REV-A', 'RAW_INVENTORY', 'MOVING_AVERAGE', 100),
            ('REV-B', 'RAW_INVENTORY', 'MOVING_AVERAGE', 100),
            ('REV-C', 'RAW_INVENTORY', 'MOVING_AVERAGE', 100),
            ('REV-D', 'RAW_INVENTORY', 'MOVING_AVERAGE', 100),
            ('REV-E', 'RAW_INVENTORY', 'MOVING_AVERAGE', 100),
            ('REV-U', 'RAW_INVENTORY', 'MOVING_AVERAGE', 100),
            ('REV-F', 'RAW_INVENTORY', 'MOVING_AVERAGE', 100)
          ) as v(n, c, p, q)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        select ${client}, v.n, ${PLANT}, 'RS01', 'UNRESTRICTED', 100, ${ACTOR}
          from (values ('REV-A'), ('REV-B'), ('REV-C'), ('REV-D'), ('REV-E'), ('REV-U'), ('REV-F')) as v(n)
        on conflict (client, material_number, plant, storage_location, stock_type, batch_number) do update set quantity = 100
      `);
      await tx.execute(sql`
        insert into material_period_control (
          client, company_code, current_fiscal_year, current_period, previous_fiscal_year, previous_period,
          allow_backposting, created_by
        ) values (${client}, ${COMPANY}, 2026, 10, 2026, 9, true, ${ACTOR})
        on conflict (client, company_code) do update set current_fiscal_year = 2026, current_period = 10
      `);
      await tx.execute(sql`
        insert into gl_account (
          client, chart_of_accounts, account_number, name, account_type, is_balance_sheet,
          is_open_item_managed, reconciliation_type, requires_cost_object, is_tax_relevant,
          account_group, gl_account_type, created_by
        )
        select ${client}, c.chart_of_accounts, v.n, v.d, v.t, v.balance, false, null, false, false, 'GENL', v.kind, ${ACTOR}
          from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
          cross join (values
            ('121910', 'Reversal finished inventory', 'ASSET', true, 'BALANCE_SHEET'),
            ('122910', 'Reversal component inventory', 'ASSET', true, 'BALANCE_SHEET'),
            ('590910', 'Reversal production output', 'EXPENSE', false, 'PL_STATEMENT'),
            ('510910', 'Reversal production consumption', 'EXPENSE', false, 'PL_STATEMENT')
          ) as v(n, d, t, balance, kind)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        select ${client}, c.chart_of_accounts, v.e, v.vc, '', v.a, ${ACTOR}
          from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
          cross join (values
            ('INVENTORY', 'FINISHED_INVENTORY', '121910'),
            ('PRODUCTION_OUTPUT', 'FINISHED_INVENTORY', '590910'),
            ('INVENTORY', 'RAW_INVENTORY', '122910'),
            ('PRODUCTION_CONSUMPTION', 'RAW_INVENTORY', '510910')
          ) as v(e, vc, a)
        on conflict do nothing
      `);
      await defineRange(tx, { client, objectCode: 'PRODORDER', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: 'RQ', numberLength: 8, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'MRPRUN', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, {
        client, objectCode: 'RF_BELEG', companyCode: COMPANY, subObject: 'GENERAL',
        fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into production_order_type (client, order_type, description, order_category, created_by)
        values (${client}, 'PP01', 'Standard production', '10', ${ACTOR})
        on conflict (client, order_type) do nothing
      `);
    });
  }, 180_000);

  afterAll(async () => {
    if (client) await destroyTenant(client);
    if (other) await destroyTenant(other);
  }, 180_000);

  it('keeps the issued quantity until a full reversal cancels it once', async () => {
    const orderNumber = await order('REV-FG', 4, [{ materialNumber: 'REV-A', requiredQuantity: 5 }]);
    const posted = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '261', postingDate: DAY, documentDate: DAY,
      lines: [{ materialNumber: 'REV-A', plant: PLANT, storageLocation: 'RS01', quantity: 2, productionOrderNumber: orderNumber, productionOrderItem: 10 }],
      requestKey: nextKey(),
    }, 'MIGO');
    expect(await issued(orderNumber, 10)).toBe(2);
    const before = await componentRow('REV-A', orderNumber);
    expect(before.row).toEqual(expect.objectContaining({ quantity: 3, direction: 'REQUIREMENT' }));
    expect(await receiptRow('REV-FG', orderNumber)).toEqual(expect.objectContaining({ quantity: 4, direction: 'RECEIPT' }));
    const planned = await plan('REV-A');
    expect(demanded(planned, orderNumber)?.message).toContain('requires 3.000');
    expect(Number(planned.materials[0]?.demandQuantity)).toBe(3);

    const requestKey = nextKey();
    const reversed = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey,
    });
    const replay = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey,
    });
    expect(replay.materialDocumentNumber).toBe(reversed.materialDocumentNumber);
    expect(await issued(orderNumber, 10)).toBe(0);
    expect((await componentRow('REV-A', orderNumber)).row).toEqual(expect.objectContaining({ quantity: 5 }));
    expect(await receiptRow('REV-FG', orderNumber)).toEqual(expect.objectContaining({ quantity: 4, direction: 'RECEIPT' }));
    const restored = await plan('REV-A');
    expect(demanded(restored, orderNumber)?.message).toContain('requires 5.000');
    expect(Number(restored.materials[0]?.demandQuantity)).toBe(5);

    await expect(reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(/already been cancelled|already reversed in full/);
    expect(await issued(orderNumber, 10)).toBe(0);
  }, 60_000);

  it('restores one line at a time and reverses the journal only when the document is finished', async () => {
    const orderNumber = await order('REV-FG', 4, [
      { materialNumber: 'REV-B', requiredQuantity: 5 },
      { materialNumber: 'REV-C', requiredQuantity: 5 },
    ]);
    const posted = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '261', postingDate: DAY, documentDate: DAY,
      lines: [
        { materialNumber: 'REV-B', plant: PLANT, storageLocation: 'RS01', quantity: 2, productionOrderNumber: orderNumber, productionOrderItem: 10 },
        { materialNumber: 'REV-C', plant: PLANT, storageLocation: 'RS01', quantity: 3, productionOrderNumber: orderNumber, productionOrderItem: 20 },
      ],
      requestKey: nextKey(),
    }, 'MIGO');
    expect(posted.journalDocumentNumber).toBeTruthy();
    const lines = await withTenant(client, (tx) => tx.execute(sql`
      select line_number, material_number from material_document_line
       where client = ${client} and material_document_number = ${posted.materialDocumentNumber}
       order by line_number
    `)) as unknown as Array<{ line_number: number; material_number: string }>;
    const first = lines.find((line) => line.material_number === 'REV-B')!;
    const second = lines.find((line) => line.material_number === 'REV-C')!;

    const partial = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      lines: [Number(first.line_number)], postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    expect(partial.journalDocumentNumber).toBeNull();
    expect(partial.lines).toHaveLength(1);
    const copied = await withTenant(client, (tx) => tx.execute(sql`
      select production_order_number, production_order_item
        from material_document_line
       where client = ${client} and material_document_number = ${partial.materialDocumentNumber}
    `)) as unknown as Array<{ production_order_number: string; production_order_item: number }>;
    expect(copied[0]).toEqual({ production_order_number: orderNumber, production_order_item: 10 });
    expect(await issued(orderNumber, 10)).toBe(0);
    expect(await issued(orderNumber, 20)).toBe(3);
    expect((await componentRow('REV-B', orderNumber)).row?.quantity).toBe(5);
    expect((await componentRow('REV-C', orderNumber)).row?.quantity).toBe(2);
    expect(await receiptRow('REV-FG', orderNumber)).toEqual(expect.objectContaining({ quantity: 4 }));
    const journalStillOpen = await withTenant(client, (tx) => tx.execute(sql`
      select status from journal_entry
       where client = ${client} and document_number = ${posted.journalDocumentNumber}
    `)) as unknown as Array<{ status: string }>;
    expect(journalStillOpen[0]?.status).toBe('POSTED');
    const midway = await plan('REV-C');
    expect(demanded(midway, orderNumber)?.message).toContain('requires 2.000');

    await expect(reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      lines: [Number(first.line_number)], postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(/already reversed in full/);
    expect(await issued(orderNumber, 20)).toBe(3);

    const finished = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      lines: [Number(second.line_number)], postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    expect(finished.journalDocumentNumber).toBeTruthy();
    expect(await issued(orderNumber, 10)).toBe(0);
    expect(await issued(orderNumber, 20)).toBe(0);
    expect((await componentRow('REV-B', orderNumber)).row?.quantity).toBe(5);
    expect((await componentRow('REV-C', orderNumber)).row?.quantity).toBe(5);
    expect(await receiptRow('REV-FG', orderNumber)).toEqual(expect.objectContaining({ quantity: 4 }));
    const journals = await withTenant(client, (tx) => tx.execute(sql`
      select status from journal_entry
       where client = ${client} and document_number = ${posted.journalDocumentNumber}
    `)) as unknown as Array<{ status: string }>;
    expect(journals[0]?.status).toBe('REVERSED');
    const mirrors = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as mirrors from journal_entry
       where client = ${client} and reversal_of = ${posted.journalDocumentNumber}
    `)) as unknown as Array<{ mirrors: number }>;
    expect(Number(mirrors[0]?.mirrors)).toBe(1);
  }, 60_000);

  it('does not let a receipt reversal change component demand, or an issue reversal change receipt supply', async () => {
    const orderNumber = await order('REV-OUT', 4, [{ materialNumber: 'REV-F', requiredQuantity: 5 }]);
    expect(await receiptRow('REV-OUT', orderNumber)).toEqual(expect.objectContaining({ quantity: 4 }));
    expect((await componentRow('REV-F', orderNumber)).row?.quantity).toBe(5);
    const received = await postProductionReceipt({
      client, changedBy: ACTOR, orderNumber, postingDate: DAY, documentDate: DAY,
      lines: [{ storageLocation: 'RS01', quantity: 2 }], requestKey: nextKey(),
    });
    expect(await receivedQuantityFor(client, orderNumber)).toBe(2);
    expect(await receiptRow('REV-OUT', orderNumber)).toEqual(expect.objectContaining({ quantity: 2 }));
    expect((await componentRow('REV-F', orderNumber)).row?.quantity).toBe(5);
    const supplied = await plan('REV-OUT');
    expect(Number(supplied.materials[0]?.supplyQuantity)).toBe(4);

    await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: received.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    expect(await receivedQuantityFor(client, orderNumber)).toBe(0);
    expect(await receiptRow('REV-OUT', orderNumber)).toEqual(expect.objectContaining({ quantity: 4 }));
    expect((await componentRow('REV-F', orderNumber)).row?.quantity).toBe(5);
    const restored = await plan('REV-OUT');
    expect(Number(restored.materials[0]?.supplyQuantity)).toBe(4);

    const issuedDoc = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '261', postingDate: DAY, documentDate: DAY,
      lines: [{ materialNumber: 'REV-F', plant: PLANT, storageLocation: 'RS01', quantity: 1, productionOrderNumber: orderNumber, productionOrderItem: 10 }],
      requestKey: nextKey(),
    }, 'MIGO');
    expect(await receiptRow('REV-OUT', orderNumber)).toEqual(expect.objectContaining({ quantity: 4 }));
    expect((await componentRow('REV-F', orderNumber)).row?.quantity).toBe(4);
    await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: issuedDoc.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    expect(await receivedQuantityFor(client, orderNumber)).toBe(0);
    expect(await receiptRow('REV-OUT', orderNumber)).toEqual(expect.objectContaining({ quantity: 4 }));
    expect((await componentRow('REV-F', orderNumber)).row?.quantity).toBe(5);
  }, 60_000);

  it('converts the issue and copies that base quantity onto the reversal', async () => {
    await defineUomConversion({
      client, changedBy: ACTOR, materialNumber: 'REV-D', alternativeUnit: 'BOX', numerator: 2, denominator: 1,
    });
    const orderNumber = await order('REV-FG', 4, [{ materialNumber: 'REV-D', requiredQuantity: 6 }]);
    const refused = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '261', postingDate: DAY, documentDate: DAY,
      lines: [{
        materialNumber: 'REV-D', plant: PLANT, storageLocation: 'RS01', quantity: 1, entryUnit: 'GAL',
        productionOrderNumber: orderNumber, productionOrderItem: 10,
      }],
      requestKey: nextKey(),
    }, 'MIGO').catch((error: unknown) => error);
    expect((refused as Error).message).toMatch(/no conversion from GAL/i);
    expect(await issued(orderNumber, 10)).toBe(0);

    const posted = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '261', postingDate: DAY, documentDate: DAY,
      lines: [{
        materialNumber: 'REV-D', plant: PLANT, storageLocation: 'RS01', quantity: 1, entryUnit: 'BOX',
        productionOrderNumber: orderNumber, productionOrderItem: 10,
      }],
      requestKey: nextKey(),
    }, 'MIGO');
    expect(await issued(orderNumber, 10)).toBe(2);
    expect((await componentRow('REV-D', orderNumber)).row?.quantity).toBe(4);
    const reversed = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    const copied = await withTenant(client, (tx) => tx.execute(sql`
      select entry_quantity::text as entry_quantity, entry_unit, base_quantity::text as base_quantity, base_unit,
             production_order_number, production_order_item
        from material_document_line
       where client = ${client} and material_document_number = ${reversed.materialDocumentNumber}
    `)) as unknown as Array<{
      entry_quantity: string; entry_unit: string; base_quantity: string; base_unit: string;
      production_order_number: string; production_order_item: number;
    }>;
    expect(copied[0]).toEqual(expect.objectContaining({
      entry_quantity: '1.000', entry_unit: 'BOX', base_quantity: '2.000', base_unit: 'PC',
      production_order_number: orderNumber, production_order_item: 10,
    }));
    expect(await issued(orderNumber, 10)).toBe(0);
    expect((await componentRow('REV-D', orderNumber)).row?.quantity).toBe(6);
  }, 60_000);

  it('does not net a partial quantity, and a reversal cannot omit the line it cancels', async () => {
    const orderNumber = await order('REV-FG', 4, [{ materialNumber: 'REV-E', requiredQuantity: 4 }]);
    const posted = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '261', postingDate: DAY, documentDate: DAY,
      lines: [{
        materialNumber: 'REV-E', plant: PLANT, storageLocation: 'RS01', quantity: 4,
        productionOrderNumber: orderNumber, productionOrderItem: 10,
      }],
      requestKey: nextKey(),
    }, 'MIGO');
    const lines = await withTenant(client, (tx) => tx.execute(sql`
      select line_number from material_document_line
       where client = ${client} and material_document_number = ${posted.materialDocumentNumber}
    `)) as unknown as Array<{ line_number: number }>;
    await withTenant(client, (tx) => tx.execute(sql`
      insert into material_document (
        client, material_document_number, document_year, document_date, posting_date, status, reversal_of, created_by
      ) values (${client}, 'RQ-PARTIAL', 2026, ${DAY}, ${DAY}, 'POSTED', ${posted.materialDocumentNumber}, ${ACTOR})
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      insert into material_document_line (
        client, material_document_number, line_number, movement_type, material_number, plant, storage_location,
        line_direction, entry_quantity, entry_unit, base_quantity, base_unit,
        production_order_number, production_order_item, reversal_of_document, reversal_of_line, created_by
      ) values (
        ${client}, 'RQ-PARTIAL', 1, 'PROD_ISSUE_ORDER_REV', 'REV-E', ${PLANT}, 'RS01',
        'RECEIPT', 1, 'PC', 1, 'PC', ${orderNumber}, 10, ${posted.materialDocumentNumber}, ${lines[0]!.line_number}, ${ACTOR}
      )
    `));
    const omitted = await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material_document (
          client, material_document_number, document_year, document_date, posting_date, status, reversal_of, created_by
        ) values (${client}, 'RQ-UNLINKED', 2026, ${DAY}, ${DAY}, 'POSTED', ${posted.materialDocumentNumber}, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant, storage_location,
          line_direction, entry_quantity, entry_unit, base_quantity, base_unit,
          production_order_number, production_order_item, reversal_of_document, reversal_of_line, created_by
        ) values (
          ${client}, 'RQ-UNLINKED', 1, 'PROD_ISSUE_ORDER_REV', 'REV-E', ${PLANT}, 'RS01',
          'RECEIPT', 4, 'PC', 4, 'PC', ${orderNumber}, 10, ${posted.materialDocumentNumber}, null, ${ACTOR}
        )
      `);
    }).catch((error: unknown) => error);
    expect((omitted as { message?: string }).message).toMatch(/material_document_line_reversal_ck/);

    expect(await issued(orderNumber, 10)).toBe(4);
    const warned = await componentRow('REV-E', orderNumber);
    expect(warned.row).toBeUndefined();
    expect(warned.warnings.join(' ')).toMatch(/does not cancel the production line in full/);
    const shown = await getProductionOrderDisplay(client, orderNumber);
    expect(shown?.gaps.join(' ')).toMatch(/does not cancel the production line in full/);
    const planned = await plan('REV-E');
    expect(planned.diagnostics.some((row) => row.diagnosticCode === 'REVERSAL_QUANTITY_DISAGREEMENT')).toBe(true);
    expect(demanded(planned, orderNumber)).toBeUndefined();

    const again = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      lines: [Number(lines[0]!.line_number)], postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    }).catch((error: unknown) => error);
    expect((again as MaterialReversalError).message).toMatch(/reversed in full or not at all/);
    expect((again as MaterialReversalError).remedy).toMatch(/would cancel more than was posted/);
    expect(await issued(orderNumber, 10)).toBe(4);
  }, 60_000);

  it('rejects a quantity, a missing line, and another tenant', async () => {
    const orderNumber = await order('REV-FG', 2, [{ materialNumber: 'REV-A', requiredQuantity: 2 }]);
    const posted = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '261', postingDate: DAY, documentDate: DAY,
      lines: [{ materialNumber: 'REV-A', plant: PLANT, storageLocation: 'RS01', quantity: 1, productionOrderNumber: orderNumber, productionOrderItem: 10 }],
      requestKey: nextKey(),
    }, 'MIGO');
    await expect(reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      quantity: 1, postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(/quantity cannot be entered/);
    await expect(reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      lines: [99], postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(/does not exist/);
    await expect(reverseMaterialDocument({
      client: other, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(/does not exist/);
    expect(await issued(orderNumber, 10)).toBe(1);
  }, 60_000);
});
