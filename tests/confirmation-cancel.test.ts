import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { createProductionOrder, releaseProductionOrder } from '../src/modules/inventory/production-orders';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { changeProductionOrder, technicallyCompleteProductionOrder } from '../src/modules/production/production-order-change';
import {
  cancelConfirmation,
  holdsConfirmationCancelAuthority,
  loadConfirmationCancellation,
} from '../src/modules/production/confirmation-cancel';
import { enterOrderConfirmation } from '../src/modules/production/order-confirmation';
import { getProductionOrderDisplay } from '../src/modules/production/production-order-display';
import { checkProductionVersion, createProductionVersion } from '../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingStandardValueKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { enterTimeTicket, loadTimeTicket } from '../src/modules/production/time-ticket';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'CO13_CLERK';
const PLANT = '1000';
const AUTH = ['PROD.CONFIRM.CANCEL'] as const;

describe('CO13 cancel confirmation', () => {
  let tenant: TestTenant;
  let other: TestTenant;
  let version = 1;
  let orderNumber = '';
  let key = 0;
  const nextKey = () => `co13-${++key}`;

  async function extend(client: string, materialNumber: string) {
    await saveMaterialView({
      client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'CO13', view: 'BASIC', description: materialNumber, materialType: 'RAW',
      materialGroup: 'RAW', baseUnit: 'PC', industrySector: 'M', barcode: '',
      grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    });
    await saveMaterialView({
      client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'CO13', view: 'PURCHASING', plant: PLANT,
      purchasingGroup: '001', orderUnit: 'PC',
      overdeliveryTolerance: '0', underdeliveryTolerance: '0', manufacturerPartNumber: '',
    });
    await saveMaterialView({
      client, materialNumber, changedBy: ACTOR, expectedVersion: 1,
      reason: 'CO13', view: 'MRP', plant: PLANT,
      mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: materialNumber.startsWith('FG') ? 'MAKE' : 'BUY',
      lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0',
      safetyStock: '0', reorderPoint: '0', plannedDeliveryDays: 0, inHouseProductionDays: 0,
    });
  }

  async function makeOrder(requestKey: string) {
    const created = await createProductionOrder({
      orderType: 'PP01',
      client: tenant.client, createdBy: ACTOR, materialNumber: 'FG-13', plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey,
      components: [{ materialNumber: 'RM-13', plant: PLANT, requiredQuantity: 1 }],
    });
    const released = await releaseProductionOrder({ client: tenant.client, orderNumber: created.orderNumber, releasedBy: ACTOR });
    const stamped = await withTenant(tenant.client, async (tx) => {
      const found = await tx.execute(sql`select version from production_order where client = ${tenant.client} and order_number = ${released.orderNumber}`) as unknown as Array<{ version: number }>;
      return Number(found[0]?.version);
    });
    return { orderNumber: released.orderNumber, version: stamped };
  }

  async function counts(order: string) {
    return withTenant(tenant.client, async (tx) => {
      const found = await tx.execute(sql`
        select (select count(*) from production_confirmation where client = ${tenant.client} and order_number = ${order})::int as confirmations,
               (select count(*) from production_confirmation_cancellation where client = ${tenant.client} and order_number = ${order})::int as cancellations,
               (select count(*) from production_confirmation_activity a
                  join production_confirmation c on c.client = a.client and c.confirmation_number = a.confirmation_number
                 where c.client = ${tenant.client} and c.order_number = ${order})::int as activities,
               (select count(*) from material_document where client = ${tenant.client})::int as documents,
               (select count(*) from material_document_line where client = ${tenant.client})::int as lines,
               (select count(*) from journal_entry where client = ${tenant.client})::int as journals,
               (select count(*) from reservation_header where client = ${tenant.client})::int as reservations,
               (select count(*) from planned_order where client = ${tenant.client})::int as planned,
               (select status from production_order where client = ${tenant.client} and order_number = ${order}) as status,
               (select version from production_order where client = ${tenant.client} and order_number = ${order})::int as version
      `) as unknown as Array<Record<string, number | string>>;
      return found[0];
    });
  }

  beforeAll(async () => {
    tenant = await createTenant('co13-cancel');
    other = await createTenant('co13-other');
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into production_order_type (client, order_type, description, order_category, created_by)
        values (${tenant.client}, 'PP01', 'Standard production', '10', ${ACTOR})
        on conflict (client, order_type) do nothing
      `);
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODCONF', subObject: '*', prefix: 'CNF', numberLength: 7, createdBy: ACTOR });
    });
    await extend(tenant.client, 'FG-13');
    await extend(tenant.client, 'RM-13');
    await saveBomUsage({
      client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({
      client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock',
      materialEntry: '+', quantityEntry: '+',
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-13', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'RM-13', quantity: '1', unit: 'PC' }],
    });
    await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
    await saveRoutingControlKey({
      client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Confirm', confirmation: 'X',
    });
    await saveRoutingStandardValueKey({
      client: tenant.client, changedBy: ACTOR, standardValueKey: 'SV13', description: 'Labor',
      parameters: [{ parameter: 'LABOR', description: 'Labor', unit: 'HR' }],
    });
    await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
    await createWorkCenter({
      client: tenant.client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC13', category: 'MACH', description: 'Assembly',
    });
    await createRouting({
      client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup: '50000013', groupCounter: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      assignments: [{ materialNumber: 'FG-13' }],
      operations: [{
        operationNumber: '0010', shortText: 'Cut', workCenter: 'WC13', controlKey: 'PP01', standardValueKey: 'SV13',
        values: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
      }],
    });
    await createProductionVersion({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-13', plant: PLANT, productionVersion: '0001',
      validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000013', groupCounter: '01',
    });
    await checkProductionVersion(tenant.client, 'FG-13', PLANT, '0001', ACTOR);
    const first = await makeOrder('co13-order');
    orderNumber = first.orderNumber;
    version = first.version;
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
    await closeDb();
  });

  it('refuses cancellation without the cancel authority, including a confirmation authority', async () => {
    expect(holdsConfirmationCancelAuthority([])).toBe(false);
    expect(holdsConfirmationCancelAuthority(['PROD.CONFIRM.ENTER'])).toBe(false);
    expect(holdsConfirmationCancelAuthority(['PROD.CONFIRM.*'])).toBe(true);
    const posted = await enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: version,
      activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
    });
    await expect(loadConfirmationCancellation(tenant.client, {
      confirmationNumber: posted.confirmationNumber, capabilities: ['PROD.CONFIRM.ENTER'],
    })).rejects.toThrow(/PROD\.CONFIRM\.CANCEL/);
    await expect(cancelConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber: posted.confirmationNumber,
      confirmed: true, capabilities: [],
    })).rejects.toThrow(/PROD\.CONFIRM\.CANCEL/);
    const after = await counts(orderNumber);
    expect(after?.cancellations).toBe(0);
  });

  it('loads a confirmation without writing', async () => {
    const before = await counts(orderNumber);
    const number = await withTenant(tenant.client, async (tx) => {
      const found = await tx.execute(sql`
        select confirmation_number from production_confirmation
         where client = ${tenant.client} and order_number = ${orderNumber}
         order by confirmation_number limit 1
      `) as unknown as Array<{ confirmation_number: string }>;
      return String(found[0]?.confirmation_number);
    });
    const loaded = await loadConfirmationCancellation(tenant.client, {
      confirmationNumber: number, capabilities: AUTH,
    });
    expect(loaded.detail?.confirmationNumber).toBe(number);
    expect(loaded.detail?.eligible).toBe(true);
    expect(loaded.detail?.activities).toHaveLength(1);
    const listed = await loadConfirmationCancellation(tenant.client, {
      orderNumber, capabilities: ['PROD.CONFIRM.*'],
    });
    expect(listed.matches.map((row) => row.confirmationNumber)).toContain(number);
    expect(await counts(orderNumber)).toEqual(before);
  });

  it('does not disclose an unknown or another tenant confirmation', async () => {
    const number = await withTenant(tenant.client, async (tx) => {
      const found = await tx.execute(sql`
        select confirmation_number from production_confirmation
         where client = ${tenant.client} and order_number = ${orderNumber} limit 1
      `) as unknown as Array<{ confirmation_number: string }>;
      return String(found[0]?.confirmation_number);
    });
    await expect(loadConfirmationCancellation(tenant.client, {
      confirmationNumber: 'MISSING', capabilities: AUTH,
    })).rejects.toThrow(/does not stand/);
    await expect(loadConfirmationCancellation(other.client, {
      confirmationNumber: number, capabilities: AUTH,
    })).rejects.toThrow(/does not stand/);
    await expect(cancelConfirmation(other.client, {
      requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber: number, confirmed: true, capabilities: AUTH,
    })).rejects.toThrow(/does not stand/);
    const leaked = await withTenant(other.client, async (tx) => {
      const found = await tx.execute(sql`select count(*)::int as rows from production_confirmation`) as unknown as Array<{ rows: number }>;
      return found[0]?.rows;
    });
    expect(leaked).toBe(0);
  });

  it('cancels an operation confirmation once and leaves the original and activities unchanged', async () => {
    const number = await withTenant(tenant.client, async (tx) => {
      const found = await tx.execute(sql`
        select confirmation_number, yield_quantity::text as yield, note, created_by
          from production_confirmation
         where client = ${tenant.client} and order_number = ${orderNumber}
      `) as unknown as Array<{ confirmation_number: string; yield: string; note: string | null; created_by: string }>;
      return found[0];
    });
    const before = await counts(orderNumber);
    await expect(cancelConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber: number?.confirmation_number ?? '',
      reason: 'x'.repeat(201), confirmed: true, capabilities: AUTH,
    })).rejects.toThrow(/too long/);
    await expect(cancelConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber: number?.confirmation_number ?? '',
      confirmed: false, capabilities: AUTH,
    })).rejects.toThrow(/not confirmed/);
    const requestKey = nextKey();
    const cancelled = await cancelConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey, confirmationNumber: number?.confirmation_number ?? '',
      reason: 'Wrong shift', confirmed: true, capabilities: AUTH,
    });
    expect(cancelled.written).toBe(true);
    expect(cancelled.replayed).toBe(false);
    expect(cancelled.movementsPosted).toBe(0);
    expect(cancelled.orderStatus).toBe('RELEASED');
    const again = await cancelConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey, confirmationNumber: number?.confirmation_number ?? '',
      reason: 'Wrong shift', confirmed: true, capabilities: AUTH,
    });
    expect(again.cancellationNumber).toBe(cancelled.cancellationNumber);
    expect(again.replayed).toBe(true);
    await expect(cancelConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey, confirmationNumber: number?.confirmation_number ?? '',
      reason: 'Different', confirmed: true, capabilities: AUTH,
    })).rejects.toThrow(/different details/);
    await expect(cancelConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber: number?.confirmation_number ?? '',
      confirmed: true, capabilities: AUTH,
    })).rejects.toThrow(/already cancelled/);
    const afterRow = await withTenant(tenant.client, async (tx) => {
      const found = await tx.execute(sql`
        select c.yield_quantity::text as yield, c.note, c.created_by, a.quantity::text as activity,
               o.status, o.version::int as version
          from production_confirmation c
          join production_confirmation_activity a on a.client = c.client and a.confirmation_number = c.confirmation_number
          join production_order o on o.client = c.client and o.order_number = c.order_number
         where c.client = ${tenant.client} and c.confirmation_number = ${number?.confirmation_number}
      `) as unknown as Array<{ yield: string; note: string | null; created_by: string; activity: string; status: string; version: number }>;
      return found[0];
    });
    expect(afterRow).toMatchObject({
      yield: number?.yield,
      note: number?.note,
      created_by: number?.created_by,
      activity: '1.000',
      status: 'RELEASED',
      version: before?.version,
    });
    const after = await counts(orderNumber);
    expect(after).toMatchObject({
      confirmations: before?.confirmations,
      cancellations: 1,
      activities: before?.activities,
      documents: 0,
      lines: 0,
      journals: 0,
      reservations: before?.reservations,
      planned: 0,
      status: 'RELEASED',
    });
    const audit = await withTenant(tenant.client, async (tx) => {
      const found = await tx.execute(sql`
        select change_type, transaction_code from change_document
         where client = ${tenant.client} and object_class = 'production_confirmation_cancellation'
           and object_key = ${cancelled.cancellationNumber}
      `) as unknown as Array<{ change_type: string; transaction_code: string }>;
      return found;
    });
    expect(audit).toEqual([{ change_type: 'REVERSE', transaction_code: 'CO13' }]);
  });

  it('blocks a final confirmation until it is cancelled, then allows one new final', async () => {
    const finalTicket = await enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber, operationNumber: '0010',
      confirmationType: 'FINAL', confirmFinal: true, yieldQuantity: '2', postingDate: '2026-10-24', expectedVersion: version,
      activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
    });
    await expect(enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: version,
      activities: [{ parameter: 'LABOR', quantity: '0', unit: 'HR' }],
    })).rejects.toThrow(/final confirmation already stands/);
    const blocked = await loadTimeTicket(tenant.client, { orderNumber, postingDate: '2026-10-24' });
    expect(blocked.operations[0]?.finallyConfirmed).toBe(true);
    const cancelled = await cancelConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber: finalTicket.confirmationNumber,
      confirmed: true, capabilities: AUTH,
    });
    const opened = await loadTimeTicket(tenant.client, { orderNumber, postingDate: '2026-10-24' });
    expect(opened.operations[0]?.finallyConfirmed).toBe(false);
    expect(opened.operations[0]?.cancellationNote).toContain(cancelled.cancellationNumber);
    expect(Number(opened.operations[0]?.yieldQuantity)).toBe(0);
    const replacement = await enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber, operationNumber: '0010',
      confirmationType: 'FINAL', confirmFinal: true, yieldQuantity: '3', postingDate: '2026-10-24', expectedVersion: version,
      activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
    });
    expect(replacement.confirmationNumber).not.toBe(finalTicket.confirmationNumber);
    await expect(enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: version,
    })).rejects.toThrow(/final confirmation already stands/);
    const shown = await getProductionOrderDisplay(tenant.client, orderNumber);
    const original = shown?.confirmations.find((row) => row.confirmationNumber === finalTicket.confirmationNumber);
    const standing = shown?.confirmations.find((row) => row.confirmationNumber === replacement.confirmationNumber);
    expect(original?.cancelled).toBe(true);
    expect(original?.cancellationNumber).toBe(cancelled.cancellationNumber);
    expect(standing?.cancelled).toBe(false);
    expect(standing?.cancellationNumber).toBeNull();
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: version, quantity: '12',
    })).rejects.toThrow(/has a confirmation/);
  });

  it('cancels a header confirmation and then allows another header final', async () => {
    const header = await makeOrder('co13-header');
    const posted = await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: header.orderNumber,
      confirmationType: 'FINAL', confirmFinal: true, yieldQuantity: '4', postingDate: '2026-10-24', expectedVersion: header.version,
    });
    await expect(enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: header.orderNumber,
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: header.version,
    })).rejects.toThrow(/No operation can be confirmed/);
    const cancelled = await cancelConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber: posted.confirmationNumber,
      confirmed: true, capabilities: AUTH,
    });
    expect(cancelled.orderStatus).toBe('RELEASED');
    const progress = await loadTimeTicket(tenant.client, { orderNumber: header.orderNumber, postingDate: '2026-10-24' });
    expect(progress.operations[0]?.finallyConfirmed).toBe(false);
    expect(Number(progress.operations[0]?.yieldQuantity)).toBe(0);
    const replacement = await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: header.orderNumber,
      confirmationType: 'FINAL', confirmFinal: true, yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: header.version,
    });
    expect(replacement.confirmationNumber).not.toBe(posted.confirmationNumber);
    const shown = await getProductionOrderDisplay(tenant.client, header.orderNumber);
    expect(shown?.confirmations.find((row) => row.confirmationNumber === posted.confirmationNumber)?.cancellationNumber).toBe(cancelled.cancellationNumber);
    expect(shown?.status).toBe('RELEASED');
    const effects = await withTenant(tenant.client, async (tx) => {
      const found = await tx.execute(sql`
        select count(*)::int as rows from production_confirmation_operation
         where client = ${tenant.client} and confirmation_number = ${posted.confirmationNumber}
      `) as unknown as Array<{ rows: number }>;
      return found[0]?.rows;
    });
    expect(effects).toBeGreaterThan(0);
  });

  it('keeps one cancellation and one active final when the same confirmation is posted or cancelled together', async () => {
    const race = await makeOrder('co13-race');
    const posted = await enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: race.orderNumber, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: race.version,
      activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
    });
    const results = await Promise.allSettled([
      cancelConfirmation(tenant.client, {
        requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber: posted.confirmationNumber, confirmed: true, capabilities: AUTH,
      }),
      cancelConfirmation(tenant.client, {
        requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber: posted.confirmationNumber, confirmed: true, capabilities: AUTH,
      }),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'rejected').map((row) => String((row as PromiseRejectedResult).reason))).toEqual([
      expect.stringMatching(/already cancelled/),
    ]);
    const stored = await counts(race.orderNumber);
    expect(stored?.cancellations).toBe(1);

    const finals = await makeOrder('co13-finals');
    const firstWave = await Promise.allSettled([
      enterTimeTicket(tenant.client, {
        requestedBy: ACTOR, requestKey: nextKey(), orderNumber: finals.orderNumber, operationNumber: '0010',
        confirmationType: 'FINAL', confirmFinal: true, yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: finals.version,
        activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
      }),
      enterTimeTicket(tenant.client, {
        requestedBy: ACTOR, requestKey: nextKey(), orderNumber: finals.orderNumber, operationNumber: '0010',
        confirmationType: 'FINAL', confirmFinal: true, yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: finals.version,
        activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
      }),
    ]);
    const winners = firstWave.filter((row) => row.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    const winner = winners[0]?.status === 'fulfilled' ? winners[0].value.confirmationNumber : '';
    await cancelConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber: winner, confirmed: true, capabilities: AUTH,
    });
    const secondWave = await Promise.allSettled([
      enterTimeTicket(tenant.client, {
        requestedBy: ACTOR, requestKey: nextKey(), orderNumber: finals.orderNumber, operationNumber: '0010',
        confirmationType: 'FINAL', confirmFinal: true, yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: finals.version,
        activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
      }),
      enterTimeTicket(tenant.client, {
        requestedBy: ACTOR, requestKey: nextKey(), orderNumber: finals.orderNumber, operationNumber: '0010',
        confirmationType: 'FINAL', confirmFinal: true, yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: finals.version,
        activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
      }),
    ]);
    expect(secondWave.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const active = await withTenant(tenant.client, async (tx) => {
      const found = await tx.execute(sql`
        select count(*)::int as rows
          from production_confirmation c
         where c.client = ${tenant.client} and c.order_number = ${finals.orderNumber}
           and c.confirmation_type = 'FINAL'
           and not exists (
             select 1 from production_confirmation_cancellation x
              where x.client = c.client and x.confirmation_number = c.confirmation_number
           )
      `) as unknown as Array<{ rows: number }>;
      return found[0]?.rows;
    });
    expect(active).toBe(1);
  });

  it('rejects a second active final in the database, including after a cancelled original', async () => {
    const raw = await makeOrder('co13-raw');
    const posted = await enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: raw.orderNumber, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: raw.version,
      activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
    });
    async function cloneFinal(number: string, requestKey: string) {
      await withTenant(tenant.client, async (tx) => {
        await tx.execute(sql`
          insert into production_confirmation (
            client, confirmation_number, order_number, operation_number, sequence, task_list_type, routing_group,
            group_counter, production_version, work_center, work_center_plant, control_key, short_text, confirmation_type,
            confirmation_level, yield_quantity, scrap_quantity, rework_quantity, unit, posting_date, note,
            request_key, order_version, created_by
          )
          select client, ${number}, order_number, operation_number, sequence, task_list_type, routing_group,
                 group_counter, production_version, work_center, work_center_plant, control_key, short_text, 'FINAL',
                 confirmation_level, yield_quantity, scrap_quantity, rework_quantity, unit, posting_date, note,
                 ${requestKey}, order_version, created_by
            from production_confirmation
           where client = ${tenant.client} and confirmation_number = ${posted.confirmationNumber}
        `);
      });
    }
    const raced = await Promise.allSettled([
      cloneFinal('CNFRAW000001', 'raw-a'),
      cloneFinal('CNFRAW000002', 'raw-b'),
    ]);
    expect(raced.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(String((raced.find((row) => row.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/active final confirmation already stands/);
    const standing = raced[0]?.status === 'fulfilled' ? 'CNFRAW000001' : 'CNFRAW000002';
    await expect(cloneFinal('CNFRAW000003', 'raw-c')).rejects.toThrow(/active final confirmation already stands/);
    await cancelConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber: standing, confirmed: true, capabilities: AUTH,
    });
    await cloneFinal('CNFRAW000004', 'raw-d');
    await expect(withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`update production_confirmation set note = 'changed' where client = ${tenant.client}`);
    })).rejects.toThrow(/permission denied|must be owner/);
    await expect(withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`update production_confirmation_cancellation set reason = 'changed' where client = ${tenant.client}`);
    })).rejects.toThrow(/permission denied|must be owner/);
  });

  it('cancels a confirmation of a technically completed order without changing that status', async () => {
    const made = await makeOrder('co13-teco');
    const completed = await technicallyCompleteProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: made.orderNumber,
      expectedVersion: made.version, held: ['PROD.ORDER.CHANGE'], confirmed: true,
    });
    const posted = await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: made.orderNumber,
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24',
      expectedVersion: completed.order.version,
    });
    const cancelled = await cancelConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber: posted.confirmationNumber,
      reason: 'Late completion', confirmed: true, capabilities: AUTH,
    });
    expect(cancelled.orderStatus).toBe('TECHNICALLY_COMPLETED');
    expect(cancelled.movementsPosted).toBe(0);
    const after = await counts(made.orderNumber);
    expect(after?.status).toBe('TECHNICALLY_COMPLETED');
    expect(after?.version).toBe(completed.order.version);
  });
});
