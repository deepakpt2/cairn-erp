import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { createProductionOrder, releaseProductionOrder } from '../src/modules/inventory/production-orders';
import { cancelConfirmation } from '../src/modules/production/confirmation-cancel';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { enterOrderConfirmation, scaledEffectWithinLimit } from '../src/modules/production/order-confirmation';
import { runOrderInformation } from '../src/modules/production/order-information';
import { saveOrderTypeParameter } from '../src/modules/production/order-type-parameters';
import { changeProductionOrder } from '../src/modules/production/production-order-change';
import { getProductionOrderDisplay } from '../src/modules/production/production-order-display';
import { createProductionVersion } from '../src/modules/production/production-version';
import { changeRouting, createRouting, getRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { enterTimeTicket, loadTimeTicket } from '../src/modules/production/time-ticket';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'CO15_ALLOC';
const PLANT = '1000';
const AUTH = ['PROD.CONFIRM.CANCEL'] as const;

describe('operation effect allocation', () => {
  it('scales a stored operation quantity without rounding or inventing a split', () => {
    expect(scaledEffectWithinLimit('0', '12', '2', '1', 10_000n)).toBe(true);
    expect(scaledEffectWithinLimit('18', '4', '2', '1', 10_000n)).toBe(false);
    expect(scaledEffectWithinLimit('0', '1', '1', '3', 10_000n)).toBe(true);
  });
});

describe('CO15 allocation and progress', () => {
  let tenant: TestTenant;
  let key = 0;
  const nextKey = () => `alloc-${++key}`;

  beforeAll(async () => {
    tenant = await createTenant('co15-alloc');
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODCONF', subObject: '*', prefix: 'CNF', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into production_order_type (client, order_type, description, order_category, created_by)
        values (${tenant.client}, 'PP01', 'Standard production', '10', ${ACTOR})
        on conflict (client, order_type) do nothing
      `);
    });
    await saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      taskListType: '', productionVersionSelection: '0', version: 0, reason: 'Automatic selection',
    });
    for (const materialNumber of ['AL-FG', 'AL-RM']) {
      await saveMaterialView({
        client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
        reason: 'Allocation', view: 'BASIC', description: materialNumber, materialType: 'RAW',
        materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
        grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
      });
      await saveMaterialView({
        client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
        reason: 'Allocation', view: 'MRP', plant: PLANT,
        mrpType: 'NONE', mrpController: '001', procurementType: materialNumber.endsWith('RM') ? 'BUY' : 'MAKE',
        lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0',
        safetyStock: '0', reorderPoint: '0', plannedDeliveryDays: 0, inHouseProductionDays: 0,
      });
    }
    await saveBomUsage({
      client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({
      client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock', materialEntry: '+', quantityEntry: '+',
    });
    await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
    await saveRoutingControlKey({ client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Confirm', confirmation: 'X' });
    await saveRoutingControlKey({ client: tenant.client, changedBy: ACTOR, controlKey: 'PP02', description: 'No confirm' });
    await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
    await createWorkCenter({
      client: tenant.client, changedBy: ACTOR, plant: PLANT, workCenter: 'WCAL', category: 'MACH', description: 'Assembly',
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'AL-FG', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'KG', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'AL-RM', quantity: '1', unit: 'KG' }],
    });
    await createRouting({
      client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup: '50000091', groupCounter: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2020-01-01',
      assignments: [{ materialNumber: 'AL-FG' }],
      operations: [
        { operationNumber: '0030', shortText: 'Third', workCenter: 'WCAL', controlKey: 'PP01' },
        { operationNumber: '0010', shortText: 'Cut', workCenter: 'WCAL', controlKey: 'PP01' },
        { operationNumber: '0020', shortText: 'Skip', workCenter: 'WCAL', controlKey: 'PP02' },
        {
          operationNumber: '0040', shortText: 'Scale', workCenter: 'WCAL', controlKey: 'PP01',
          operationQuantity: '2', operationUnit: 'KG', baseQuantity: '1', baseUnit: 'KG',
        },
      ],
    });
    await createProductionVersion({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'AL-FG', plant: PLANT, productionVersion: '0001',
      validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'KG',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000091', groupCounter: '01',
    });
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await closeDb();
  });

  async function makeReleased(requestKey: string, components = false) {
    const created = await createProductionOrder({
      orderType: 'PP01', client: tenant.client, createdBy: ACTOR, materialNumber: 'AL-FG', plant: PLANT,
      orderQuantity: 10, scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey,
      ...(components ? { components: [{ materialNumber: 'AL-RM', plant: PLANT, requiredQuantity: 1 }] } : {}),
    });
    await releaseProductionOrder({ client: tenant.client, orderNumber: created.orderNumber, releasedBy: ACTOR });
    const [row] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select version from production_order where client = ${tenant.client} and order_number = ${created.orderNumber}
    `)) as unknown as Array<{ version: number }>;
    return { orderNumber: created.orderNumber, version: Number(row?.version) };
  }

  it('keeps header yield once when several operations receive an effect', async () => {
    const order = await makeReleased('alloc-multi');
    const shownBefore = await getProductionOrderDisplay(tenant.client, order.orderNumber);
    expect(shownBefore?.operations.map((row) => [row.operationNumber, row.executionOrder, row.sequence])).toEqual([
      ['0030', 1, '000000'],
      ['0010', 2, '000000'],
      ['0020', 3, '000000'],
      ['0040', 4, '000000'],
    ]);
    expect(shownBefore?.operations.every((row) => row.progress === 'UNCONFIRMED')).toBe(true);
    expect(shownBefore?.headerConfirmedYield).toBe('0.000');

    const requestKey = nextKey();
    const posted = await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey, orderNumber: order.orderNumber,
      confirmationType: 'PARTIAL', yieldQuantity: '6', postingDate: '2026-10-24', expectedVersion: order.version,
    });
    expect(posted.confirmationLevel).toBe('HEADER');
    expect(Number(posted.yieldQuantity)).toBe(6);
    expect(posted.effects.map((row) => row.operationNumber)).toEqual(['0030', '0010', '0040']);
    expect(posted.effects.find((row) => row.operationNumber === '0010')).toMatchObject({ quantityBasis: 'ORDER_QUANTITY' });
    expect(posted.effects.find((row) => row.operationNumber === '0030')).toMatchObject({ quantityBasis: 'ORDER_QUANTITY' });
    expect(posted.effects.find((row) => row.operationNumber === '0040')).toMatchObject({ quantityBasis: 'OPERATION_QUANTITY' });
    expect(Number(posted.effects.find((row) => row.operationNumber === '0010')?.yieldQuantity)).toBe(6);
    expect(Number(posted.effects.find((row) => row.operationNumber === '0030')?.yieldQuantity)).toBe(6);
    expect(Number(posted.effects.find((row) => row.operationNumber === '0040')?.yieldQuantity)).toBe(12);
    expect(posted.skipped.map((row) => row.operationNumber)).toEqual(['0020']);
    const again = await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey, orderNumber: order.orderNumber,
      confirmationType: 'PARTIAL', yieldQuantity: '6', postingDate: '2026-10-24', expectedVersion: order.version,
    });
    expect(again.confirmationNumber).toBe(posted.confirmationNumber);

    const shown = await getProductionOrderDisplay(tenant.client, order.orderNumber);
    expect(shown?.headerConfirmedYield).toBe('6.000');
    expect(shown?.confirmations).toHaveLength(1);
    expect(shown?.confirmations[0]).toMatchObject({ confirmationLevel: 'HEADER', operationNumber: null, cancelled: false });
    expect(shown?.operations.find((row) => row.operationNumber === '0010')).toMatchObject({ progress: 'PARTIAL', confirmedYield: '6.000' });
    expect(shown?.operations.find((row) => row.operationNumber === '0020')).toMatchObject({ progress: 'UNCONFIRMED', confirmedYield: '0' });
    expect(shown?.operations.find((row) => row.operationNumber === '0030')).toMatchObject({ progress: 'PARTIAL' });
    expect(shown?.operations.find((row) => row.operationNumber === '0040')).toMatchObject({ progress: 'PARTIAL' });
    const operationSum = (shown?.operations ?? []).reduce((sum, row) => sum + Number(row.confirmedYield), 0);
    expect(operationSum).toBe(24);
    expect(Number(shown?.headerConfirmedYield)).toBe(6);
    expect(operationSum).not.toBe(Number(shown?.headerConfirmedYield));

    const headers = await runOrderInformation(tenant.client, { listType: 'HEADERS', orderNumber: order.orderNumber });
    expect(Number(headers.rows[0]?.headerConfirmedYield)).toBe(6);
    const operations = await runOrderInformation(tenant.client, { listType: 'OPERATIONS', orderNumber: order.orderNumber });
    expect(operations.rows.map((row) => [row.operationNumber, row.sequence, row.executionOrder])).toEqual([
      ['0030', '000000', '1'],
      ['0010', '000000', '2'],
      ['0020', '000000', '3'],
      ['0040', '000000', '4'],
    ]);
    expect(operations.rows.find((row) => row.operationNumber === '0020')?.progress).toBe('UNCONFIRMED');
    expect(operations.notes.join(' ')).toMatch(/not added across operations/i);
    const confirmations = await runOrderInformation(tenant.client, { listType: 'CONFIRMATIONS', orderNumber: order.orderNumber });
    expect(confirmations.rows).toHaveLength(1);
    expect(confirmations.rows[0]?.confirmationLevel).toBe('HEADER');
    expect(confirmations.rows[0]?.operationNumber).toBeNull();
    expect(confirmations.rows[0]?.affectedOperations).toBe('0030, 0010, 0040');

    const counts = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select (select count(*) from production_confirmation where client = ${tenant.client} and order_number = ${order.orderNumber})::int as confirmations,
             (select count(*) from production_confirmation_operation where client = ${tenant.client} and order_number = ${order.orderNumber})::int as effects,
             (select sequence from production_confirmation where client = ${tenant.client} and confirmation_number = ${posted.confirmationNumber}) as confirmation_sequence
    `)) as unknown as Array<{ confirmations: number; effects: number; confirmation_sequence: string }>;
    expect(counts[0]?.confirmations).toBe(1);
    expect(counts[0]?.effects).toBe(3);
    expect(counts[0]?.confirmation_sequence).toBe('000000');

    const second = await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: order.orderNumber,
      confirmationType: 'PARTIAL', yieldQuantity: '4', postingDate: '2026-10-24', expectedVersion: order.version,
    });
    expect(Number(second.effects.find((row) => row.operationNumber === '0040')?.yieldQuantity)).toBe(8);
    const afterSecond = await getProductionOrderDisplay(tenant.client, order.orderNumber);
    expect(afterSecond?.headerConfirmedYield).toBe('10.000');
    expect(Number(afterSecond?.operations.find((row) => row.operationNumber === '0040')?.confirmedYield)).toBe(20);
    const beforeRefuse = afterSecond?.confirmations.length;
    await expect(enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: order.orderNumber,
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: order.version,
    })).rejects.toThrow(/was not reduced/);
    const afterRefuse = await getProductionOrderDisplay(tenant.client, order.orderNumber);
    expect(afterRefuse?.confirmations).toHaveLength(beforeRefuse ?? 0);
    expect(afterRefuse?.headerConfirmedYield).toBe('10.000');
  });

  it('does not add a time ticket to a scaled effect, or a scaled effect to a time ticket', async () => {
    const scaledFirst = await makeReleased('alloc-scaled-first');
    await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: scaledFirst.orderNumber,
      confirmationType: 'PARTIAL', yieldQuantity: '3', postingDate: '2026-10-24', expectedVersion: scaledFirst.version,
    });
    await expect(enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: scaledFirst.orderNumber, operationNumber: '0040',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: scaledFirst.version,
    })).rejects.toThrow(/operation-quantity effect/);
    const ticket = await enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: scaledFirst.orderNumber, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: scaledFirst.version,
    });
    expect(ticket.operationNumber).toBe('0010');
    const loadedTicket = await loadTimeTicket(tenant.client, { orderNumber: scaledFirst.orderNumber, operationNumber: '0010' });
    expect(loadedTicket.operations.map((row) => [row.operationNumber, row.executionOrder])).toEqual([
      ['0030', 1], ['0010', 2], ['0020', 3], ['0040', 4],
    ]);
    expect(loadedTicket.selected?.operationNumber).toBe('0010');
    expect(loadedTicket.selected?.sequence).toBe('000000');

    const ticketFirst = await makeReleased('alloc-ticket-first');
    await enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: ticketFirst.orderNumber, operationNumber: '0040',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: ticketFirst.version,
    });
    await expect(enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: ticketFirst.orderNumber,
      confirmationType: 'PARTIAL', yieldQuantity: '3', postingDate: '2026-10-24', expectedVersion: ticketFirst.version,
    })).rejects.toThrow(/not added to it/);
    const untouched = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as confirmations from production_confirmation
       where client = ${tenant.client} and order_number = ${ticketFirst.orderNumber} and confirmation_level = 'HEADER'
    `)) as unknown as Array<{ confirmations: number }>;
    expect(untouched[0]?.confirmations).toBe(0);
  });

  it('does not confirm an order with no operation snapshot and does not call that unconfirmed', async () => {
    const legacy = await makeReleased('alloc-legacy', true);
    const shown = await getProductionOrderDisplay(tenant.client, legacy.orderNumber);
    expect(shown?.operations).toEqual([]);
    expect(shown?.gaps.join(' ')).toMatch(/Operations are not stored/);
    expect(shown?.headerConfirmedYield).toBe('0.000');
    await expect(enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: legacy.orderNumber,
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: legacy.version,
    })).rejects.toThrow(/no operation snapshot/i);
    const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as confirmations from production_confirmation
       where client = ${tenant.client} and order_number = ${legacy.orderNumber}
    `)) as unknown as Array<{ confirmations: number }>;
    expect(rows[0]?.confirmations).toBe(0);
    const listed = await runOrderInformation(tenant.client, { listType: 'OPERATIONS', orderNumber: legacy.orderNumber });
    expect(listed.rows).toEqual([]);
  });

  it('drops a cancelled header confirmation from active progress and allows one replacement', async () => {
    const order = await makeReleased('alloc-cancel');
    const posted = await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: order.orderNumber,
      confirmationType: 'FINAL', confirmFinal: true, yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: order.version,
    });
    const before = await loadTimeTicket(tenant.client, { orderNumber: order.orderNumber });
    expect(before.operations.find((row) => row.operationNumber === '0010')?.finallyConfirmed).toBe(true);
    expect(Number(before.operations.find((row) => row.operationNumber === '0010')?.yieldQuantity)).toBe(1);
    expect(before.operations.find((row) => row.operationNumber === '0020')?.finallyConfirmed).toBe(false);
    await expect(enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: order.orderNumber,
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: order.version,
    })).rejects.toThrow(/No operation can be confirmed/);
    const cancelKey = nextKey();
    const cancelled = await cancelConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: cancelKey, confirmationNumber: posted.confirmationNumber,
      confirmed: true, capabilities: AUTH,
    });
    const replay = await cancelConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: cancelKey, confirmationNumber: posted.confirmationNumber,
      confirmed: true, capabilities: AUTH,
    });
    expect(replay.cancellationNumber).toBe(cancelled.cancellationNumber);
    const after = await getProductionOrderDisplay(tenant.client, order.orderNumber);
    expect(after?.headerConfirmedYield).toBe('0.000');
    expect(after?.operations.find((row) => row.operationNumber === '0010')?.progress).toBe('UNCONFIRMED');
    expect(after?.operations.find((row) => row.operationNumber === '0040')?.progress).toBe('UNCONFIRMED');
    expect(after?.confirmations.find((row) => row.confirmationNumber === posted.confirmationNumber)?.cancelled).toBe(true);
    const progress = await loadTimeTicket(tenant.client, { orderNumber: order.orderNumber });
    expect(Number(progress.operations.find((row) => row.operationNumber === '0010')?.yieldQuantity)).toBe(0);
    expect(progress.operations.find((row) => row.operationNumber === '0010')?.finallyConfirmed).toBe(false);
    const replacement = await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: order.orderNumber,
      confirmationType: 'FINAL', confirmFinal: true, yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: order.version,
    });
    expect(replacement.confirmationNumber).not.toBe(posted.confirmationNumber);
    const standing = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select (select count(*) from production_confirmation_cancellation where client = ${tenant.client} and confirmation_number = ${posted.confirmationNumber})::int as cancellations,
             (select yield_quantity::text from production_confirmation where client = ${tenant.client} and confirmation_number = ${posted.confirmationNumber}) as original_yield
    `)) as unknown as Array<{ cancellations: number; original_yield: string }>;
    expect(standing[0]?.cancellations).toBe(1);
    expect(Number(standing[0]?.original_yield)).toBe(1);
  });

  it('does not duplicate a snapshot on replay and does not rewrite it from CO02', async () => {
    const first = await createProductionOrder({
      orderType: 'PP01', client: tenant.client, createdBy: ACTOR, materialNumber: 'AL-FG', plant: PLANT,
      orderQuantity: 10, scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey: 'alloc-replay',
    });
    const second = await createProductionOrder({
      orderType: 'PP01', client: tenant.client, createdBy: ACTOR, materialNumber: 'AL-FG', plant: PLANT,
      orderQuantity: 10, scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey: 'alloc-replay',
    });
    expect(second.orderNumber).toBe(first.orderNumber);
    const copied = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select operation_number, sequence, execution_order, short_text
        from production_order_operation
       where client = ${tenant.client} and order_number = ${first.orderNumber}
       order by execution_order
    `)) as unknown as Array<{ operation_number: string; sequence: string; execution_order: number; short_text: string }>;
    expect(copied.map((row) => [row.operation_number, row.sequence, Number(row.execution_order), row.short_text])).toEqual([
      ['0030', '000000', 1, 'Third'],
      ['0010', '000000', 2, 'Cut'],
      ['0020', '000000', 3, 'Skip'],
      ['0040', '000000', 4, 'Scale'],
    ]);
    const changed = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: first.orderNumber, expectedVersion: 1, quantity: '12',
    });
    expect(changed.order.quantity).toBe('12.000');
    const after = await getProductionOrderDisplay(tenant.client, first.orderNumber);
    expect(after?.operations.map((row) => [row.operationNumber, row.shortText, row.executionOrder, row.sequence])).toEqual([
      ['0030', 'Third', 1, '000000'],
      ['0010', 'Cut', 2, '000000'],
      ['0020', 'Skip', 3, '000000'],
      ['0040', 'Scale', 4, '000000'],
    ]);
    const routingBefore = await getRouting(tenant.client, 'N', '50000091', '01');
    await changeRouting({
      client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup: '50000091', groupCounter: '01', version: routingBefore?.version,
      baseQuantity: '1', baseUnit: 'KG', validFrom: '2020-01-01',
      assignments: [{ materialNumber: 'AL-FG' }],
      operations: [
        { operationNumber: '0030', shortText: 'Third later', workCenter: 'WCAL', controlKey: 'PP01', executionOrder: 4 },
        { operationNumber: '0010', shortText: 'Cut later', workCenter: 'WCAL', controlKey: 'PP01', executionOrder: 3 },
        { operationNumber: '0020', shortText: 'Skip later', workCenter: 'WCAL', controlKey: 'PP02', executionOrder: 2 },
        {
          operationNumber: '0040', shortText: 'Scale later', workCenter: 'WCAL', controlKey: 'PP01', executionOrder: 1,
          operationQuantity: '2', operationUnit: 'KG', baseQuantity: '1', baseUnit: 'KG',
        },
      ],
    });
    const untouched = await getProductionOrderDisplay(tenant.client, first.orderNumber);
    expect(untouched?.operations.map((row) => [row.operationNumber, row.shortText, row.executionOrder])).toEqual([
      ['0030', 'Third', 1],
      ['0010', 'Cut', 2],
      ['0020', 'Skip', 3],
      ['0040', 'Scale', 4],
    ]);
    const reread = await getRouting(tenant.client, 'N', '50000091', '01');
    expect(reread?.operations.filter((row) => row.deletionFlag !== 'X').map((row) => [row.operationNumber, row.executionOrder])).toEqual([
      ['0040', 1], ['0020', 2], ['0010', 3], ['0030', 4],
    ]);
  });
});
