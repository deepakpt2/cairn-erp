import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { createProductionOrder, releaseProductionOrder } from '../src/modules/inventory/production-orders';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { changeProductionOrder } from '../src/modules/production/production-order-change';
import { getProductionOrderDisplay } from '../src/modules/production/production-order-display';
import { checkProductionVersion, createProductionVersion } from '../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingStandardValueKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import {
  enterOrderConfirmation,
  loadOrderConfirmation,
  operationEffectQuantity,
  orderConfirmationRefusal,
  previewOrderConfirmation,
} from '../src/modules/production/order-confirmation';
import { enterTimeTicket, getTimeTicket, loadTimeTicket } from '../src/modules/production/time-ticket';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';
import type { RoutingOperationInput } from '../src/modules/production/routing';

const ACTOR = 'CO15_CLERK';
const PLANT = '1000';

describe('operation effect quantity', () => {
  it('does not round an inexact scale and does not split a header quantity', () => {
    expect(() => operationEffectQuantity('1', '1', '3', '0030')).toThrow(/not rounded/);
    expect(operationEffectQuantity('3', '2', '1', '0010')).toEqual({ quantity: '6.000', basis: 'OPERATION_QUANTITY' });
    expect(operationEffectQuantity('4', null, '1', '0010')).toEqual({ quantity: '4', basis: 'ORDER_QUANTITY' });
  });
});

describe('CO15 order confirmation', () => {
  let tenant: TestTenant;
  let released = '';
  let created = '';
  let activityOrder = '';
  let scaledOrder = '';
  let ticketOrder = '';
  let version = 1;
  let createdVersion = 1;
  let activityVersion = 1;
  let scaledVersion = 1;
  let ticketVersion = 1;
  let key = 0;
  const nextKey = () => `co15-${++key}`;

  async function extend(materialNumber: string) {
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'CO15', view: 'BASIC', description: materialNumber, materialType: 'RAW',
      materialGroup: 'RAW', baseUnit: 'PC', industrySector: 'M', barcode: '',
      grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    });
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'CO15', view: 'PURCHASING', plant: PLANT,
      purchasingGroup: '001', orderUnit: 'PC',
      overdeliveryTolerance: '0', underdeliveryTolerance: '0', manufacturerPartNumber: '',
    });
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 1,
      reason: 'CO15', view: 'MRP', plant: PLANT,
      mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: materialNumber.startsWith('FG') ? 'MAKE' : 'BUY',
      lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0',
      safetyStock: '0', reorderPoint: '0', plannedDeliveryDays: 0, inHouseProductionDays: 0,
    });
  }

  async function makeOrder(materialNumber: string, component: string, routingGroup: string, operations: RoutingOperationInput[], requestKey: string, release: boolean) {
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber, plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: component, quantity: '1', unit: 'PC' }],
    });
    await createRouting({
      client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup, groupCounter: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      assignments: [{ materialNumber }],
      operations,
    });
    await createProductionVersion({
      client: tenant.client, changedBy: ACTOR, materialNumber, plant: PLANT, productionVersion: '0001',
      validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup, groupCounter: '01',
    });
    await checkProductionVersion(tenant.client, materialNumber, PLANT, '0001', ACTOR);
    const order = await createProductionOrder({
      client: tenant.client, createdBy: ACTOR, materialNumber, plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey,
      components: [{ materialNumber: component, plant: PLANT, requiredQuantity: 1 }],
    });
    if (!release) return { orderNumber: order.orderNumber, version: 1 };
    const releasedOrder = await releaseProductionOrder({ client: tenant.client, orderNumber: order.orderNumber, releasedBy: ACTOR });
    const stamped = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`select version from production_order where client = ${tenant.client} and order_number = ${releasedOrder.orderNumber}`) as unknown as Array<{ version: number }>;
      return Number(rows[0]?.version);
    });
    return { orderNumber: releasedOrder.orderNumber, version: stamped };
  }

  beforeAll(async () => {
    tenant = await createTenant('co15-order');
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODCONF', subObject: '*', prefix: 'CNF', numberLength: 7, createdBy: ACTOR });
    });
    for (const material of ['FG-15', 'RM-15', 'FG-15A', 'RM-15A', 'FG-15S', 'RM-15S', 'FG-15T', 'RM-15T']) {
      await extend(material);
    }
    await saveBomUsage({
      client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({
      client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock',
      materialEntry: '+', quantityEntry: '+',
    });
    await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
    await saveRoutingControlKey({
      client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Confirm', confirmation: 'X',
    });
    await saveRoutingControlKey({
      client: tenant.client, changedBy: ACTOR, controlKey: 'PP02', description: 'No confirm',
    });
    await saveRoutingStandardValueKey({
      client: tenant.client, changedBy: ACTOR, standardValueKey: 'SV15', description: 'Labor',
      parameters: [{ parameter: 'LABOR', description: 'Labor', unit: 'HR', required: 'X' }],
    });
    await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
    await createWorkCenter({
      client: tenant.client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC15', category: 'MACH', description: 'Assembly',
    });
    const happy = await makeOrder('FG-15', 'RM-15', '50000015', [
      { operationNumber: '0010', shortText: 'Cut', workCenter: 'WC15', controlKey: 'PP01' },
      { operationNumber: '0020', shortText: 'Skip', workCenter: 'WC15', controlKey: 'PP02' },
    ], 'co15-order', true);
    const open = await createProductionOrder({
      client: tenant.client, createdBy: ACTOR, materialNumber: 'FG-15', plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey: 'co15-open',
      components: [{ materialNumber: 'RM-15', plant: PLANT, requiredQuantity: 1 }],
    });
    released = happy.orderNumber;
    version = happy.version;
    created = open.orderNumber;
    createdVersion = open.version ?? 1;
    const activity = await makeOrder('FG-15A', 'RM-15A', '50000016', [
      {
        operationNumber: '0010', shortText: 'Labor', workCenter: 'WC15', controlKey: 'PP01', standardValueKey: 'SV15',
        values: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
      },
    ], 'co15-activity', true);
    activityOrder = activity.orderNumber;
    activityVersion = activity.version;
    const scaled = await makeOrder('FG-15S', 'RM-15S', '50000017', [
      {
        operationNumber: '0010', shortText: 'Scale', workCenter: 'WC15', controlKey: 'PP01',
        operationQuantity: '2', operationUnit: 'PC', baseQuantity: '1', baseUnit: 'PC',
      },
      { operationNumber: '0020', shortText: 'Skip', workCenter: 'WC15', controlKey: 'PP02' },
      {
        operationNumber: '0030', shortText: 'Third', workCenter: 'WC15', controlKey: 'PP01',
        operationQuantity: '1', operationUnit: 'PC', baseQuantity: '3', baseUnit: 'PC',
      },
    ], 'co15-scaled', true);
    scaledOrder = scaled.orderNumber;
    scaledVersion = scaled.version;
    const ticket = await makeOrder('FG-15T', 'RM-15T', '50000018', [
      { operationNumber: '0010', shortText: 'Cut', workCenter: 'WC15', controlKey: 'PP01' },
    ], 'co15-ticket', true);
    ticketOrder = ticket.orderNumber;
    ticketVersion = ticket.version;
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await closeDb();
  });

  it('refuses an unimplemented confirmation control by name', () => {
    expect(orderConfirmationRefusal({ backflush: 'X' })).toMatch(/backflush/);
    expect(orderConfirmationRefusal({ automaticGoodsReceipt: 'X' })).toMatch(/not configured/);
    expect(orderConfirmationRefusal({ automaticFinal: 'X' })).toMatch(/not a stored rule/);
    expect(orderConfirmationRefusal({ personnel: '1' })).toMatch(/not validated/);
    expect(orderConfirmationRefusal({ operation: '0010' })).toMatch(/CO11N/);
    expect(orderConfirmationRefusal({ co13: '1' })).toMatch(/not implemented/);
  });

  it('does not confirm an unreleased order or invent an activity', async () => {
    await expect(enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: created,
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: createdVersion,
    })).rejects.toThrow(/not released/);
    const loaded = await loadOrderConfirmation(tenant.client, { orderNumber: released, postingDate: '2026-10-24' });
    expect(loaded.blockingReason).toBeNull();
    expect(loaded.eligible).toEqual(['0010']);
    expect(loaded.skipped.map((row) => row.operationNumber)).toEqual(['0020']);
    await expect(enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: activityOrder,
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: activityVersion,
    })).rejects.toThrow(/standard value was not substituted/);
  });

  it('checks without writing, then posts one header confirmation and one effect', async () => {
    const before = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as confirmations from production_confirmation where client = ${tenant.client} and order_number = ${released}
      `) as unknown as Array<{ confirmations: number }>;
      return rows[0]?.confirmations;
    });
    const preview = await previewOrderConfirmation(tenant.client, {
      orderNumber: released, confirmationType: 'PARTIAL', yieldQuantity: '4', scrapQuantity: '1',
      postingDate: '2026-10-24', expectedVersion: version,
    });
    expect(preview.written).toBe(false);
    expect(preview.confirmationNumber).toBe('');
    expect(preview.movementsPosted).toBe(0);
    expect(preview.effects).toHaveLength(1);
    expect(preview.effects[0]?.operationNumber).toBe('0010');
    expect(preview.effects[0]?.quantityBasis).toBe('ORDER_QUANTITY');
    expect(Number(preview.effects[0]?.yieldQuantity)).toBe(4);
    const afterPreview = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as confirmations from production_confirmation where client = ${tenant.client} and order_number = ${released}
      `) as unknown as Array<{ confirmations: number }>;
      return rows[0]?.confirmations;
    });
    expect(afterPreview).toBe(before);
    const requestKey = nextKey();
    const posted = await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey, orderNumber: released,
      confirmationType: 'PARTIAL', yieldQuantity: '4', scrapQuantity: '1', postingDate: '2026-10-24', expectedVersion: version,
      executionStartDate: '2026-10-24', executionStartTime: '22:30',
      executionFinishDate: '2026-10-25', executionFinishTime: '01:15',
    });
    expect(posted.confirmationNumber).toMatch(/^CNF/);
    expect(posted.confirmationLevel).toBe('HEADER');
    expect(posted.orderStatus).toBe('RELEASED');
    expect(posted.effects).toHaveLength(1);
    expect(posted.skipped.map((row) => row.operationNumber)).toEqual(['0020']);
    expect(await getTimeTicket(tenant.client, posted.confirmationNumber)).toBeNull();
    const again = await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey, orderNumber: released,
      confirmationType: 'PARTIAL', yieldQuantity: '4', scrapQuantity: '1', postingDate: '2026-10-24', expectedVersion: version,
      executionStartDate: '2026-10-24', executionStartTime: '22:30',
      executionFinishDate: '2026-10-25', executionFinishTime: '01:15',
    });
    expect(again.confirmationNumber).toBe(posted.confirmationNumber);
    const progress = await loadTimeTicket(tenant.client, { orderNumber: released, postingDate: '2026-10-24' });
    expect(Number(progress.operations.find((row) => row.operationNumber === '0010')?.yieldQuantity)).toBe(4);
    expect(Number(progress.operations.find((row) => row.operationNumber === '0020')?.yieldQuantity)).toBe(0);
    const counts = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select (select count(*) from production_confirmation where client = ${tenant.client} and order_number = ${released})::int as confirmations,
               (select count(*) from production_confirmation_operation where client = ${tenant.client} and order_number = ${released})::int as effects,
               (select count(*) from material_document where client = ${tenant.client})::int as documents,
               (select count(*) from journal_entry where client = ${tenant.client})::int as journals,
               (select status from production_order where client = ${tenant.client} and order_number = ${released}) as status
      `) as unknown as Array<{ confirmations: number; effects: number; documents: number; journals: number; status: string }>;
      return rows[0];
    });
    expect(counts).toMatchObject({ confirmations: 1, effects: 1, documents: 0, journals: 0, status: 'RELEASED' });
  });

  it('does not clamp an excessive yield, and a final confirmation blocks another without a second number', async () => {
    await expect(enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: released,
      confirmationType: 'PARTIAL', yieldQuantity: '11', postingDate: '2026-10-24', expectedVersion: version,
    })).rejects.toThrow(/was not reduced/);
    await expect(enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: released,
      confirmationType: 'AUTOMATIC_FINAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: version,
    })).rejects.toThrow(/not a stored rule/);
    const finalConfirmation = await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: released, confirmFinal: true,
      confirmationType: 'FINAL', yieldQuantity: '6', postingDate: '2026-10-24', expectedVersion: version,
    });
    expect(finalConfirmation.confirmationType).toBe('FINAL');
    expect(finalConfirmation.orderStatus).toBe('RELEASED');
    expect(finalConfirmation.effects).toHaveLength(1);
    const numbers = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select c.confirmation_number, c.confirmation_level, c.operation_number,
               e.confirmation_number as effect_number
          from production_confirmation c
          left join production_confirmation_operation e
            on e.client = c.client and e.confirmation_number = c.confirmation_number
         where c.client = ${tenant.client} and c.order_number = ${released}
         order by c.confirmation_number
      `) as unknown as Array<{ confirmation_number: string; confirmation_level: string; operation_number: string | null; effect_number: string | null }>;
      return rows;
    });
    expect(numbers.filter((row) => row.confirmation_level === 'HEADER')).toHaveLength(2);
    expect(numbers.every((row) => row.operation_number == null)).toBe(true);
    expect(numbers.every((row) => row.effect_number === row.confirmation_number)).toBe(true);
    await expect(enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: released,
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: version,
    })).rejects.toThrow(/No operation can be confirmed/);
    await expect(enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: released, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: version,
    })).rejects.toThrow(/final confirmation already stands/);
  });

  it('shows the header confirmation on CO03 and stops CO02 from changing the order', async () => {
    const shown = await getProductionOrderDisplay(tenant.client, released);
    expect(shown?.status).toBe('RELEASED');
    expect(shown?.confirmations).toHaveLength(2);
    expect(shown?.confirmations.every((row) => row.confirmationLevel === 'HEADER' && row.operationNumber == null)).toBe(true);
    expect(shown?.version).toBe(version);
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: released, expectedVersion: version, quantity: '12',
    })).rejects.toThrow(/has a confirmation/);
  });

  it('scales an operation quantity exactly and refuses an inexact scale without writing', async () => {
    await expect(enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: scaledOrder,
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: scaledVersion,
    })).rejects.toThrow(/not rounded/);
    const untouched = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as confirmations from production_confirmation where client = ${tenant.client} and order_number = ${scaledOrder}
      `) as unknown as Array<{ confirmations: number }>;
      return rows[0]?.confirmations;
    });
    expect(untouched).toBe(0);
    const posted = await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: scaledOrder,
      confirmationType: 'PARTIAL', yieldQuantity: '3', postingDate: '2026-10-24', expectedVersion: scaledVersion,
    });
    expect(posted.effects.map((row) => row.operationNumber)).toEqual(['0010', '0030']);
    expect(posted.effects.find((row) => row.operationNumber === '0010')).toMatchObject({ quantityBasis: 'OPERATION_QUANTITY' });
    expect(Number(posted.effects.find((row) => row.operationNumber === '0010')?.yieldQuantity)).toBe(6);
    expect(Number(posted.effects.find((row) => row.operationNumber === '0030')?.yieldQuantity)).toBe(1);
    expect(posted.confirmationLevel).toBe('HEADER');
  });

  it('does not overwrite a posted time ticket', async () => {
    const ticket = await enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: ticketOrder, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '4', postingDate: '2026-10-24', expectedVersion: ticketVersion,
    });
    await expect(enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: ticketOrder,
      confirmationType: 'PARTIAL', yieldQuantity: '7', postingDate: '2026-10-24', expectedVersion: ticketVersion,
    })).rejects.toThrow(/was not reduced/);
    const posted = await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: ticketOrder,
      confirmationType: 'PARTIAL', yieldQuantity: '2', postingDate: '2026-10-24', expectedVersion: ticketVersion,
    });
    expect(posted.confirmationNumber).not.toBe(ticket.confirmationNumber);
    const standing = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select confirmation_number, confirmation_level, operation_number, yield_quantity::text as yield
          from production_confirmation
         where client = ${tenant.client} and order_number = ${ticketOrder}
         order by confirmation_level
      `) as unknown as Array<{ confirmation_number: string; confirmation_level: string; operation_number: string | null; yield: string }>;
      return rows;
    });
    expect(standing).toHaveLength(2);
    expect(standing.find((row) => row.confirmation_level === 'OPERATION')).toMatchObject({
      confirmation_number: ticket.confirmationNumber,
      operation_number: '0010',
    });
    expect(Number(standing.find((row) => row.confirmation_level === 'OPERATION')?.yield)).toBe(4);
    const progress = await loadTimeTicket(tenant.client, { orderNumber: ticketOrder, postingDate: '2026-10-24' });
    expect(Number(progress.operations[0]?.yieldQuantity)).toBe(6);
  });
});
