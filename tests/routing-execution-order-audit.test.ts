import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createProductionOrder, getProductionOrder } from '../src/modules/inventory/production-orders';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { mrpController } from '../src/modules/inventory/schema';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { runOrderInformation } from '../src/modules/production/order-information';
import { saveOrderTypeParameter } from '../src/modules/production/order-type-parameters';
import { createPlannedOrder } from '../src/modules/production/planned-order-create';
import { convertPlannedOrder } from '../src/modules/production/planned-order-conversion';
import { getProductionOrderDisplay } from '../src/modules/production/production-order-display';
import { createProductionVersion } from '../src/modules/production/production-version';
import { changeRouting, createRouting, getRouting, RoutingError, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { loadTimeTicket } from '../src/modules/production/time-ticket';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'SEQ_AUDIT';
const PLANT = '1000';

describe('routing execution-order audit', () => {
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('seq-audit');
    other = await createTenant('seq-audit-other');
    await withTenant(tenant.client, async (tx) => {
      await tx.insert(mrpController).values({
        client: tenant.client, controller: '001', name: 'Controller 001', isActive: true, createdBy: ACTOR,
      }).onConflictDoNothing();
      await defineRange(tx, { client: tenant.client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
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
    for (const materialNumber of ['SEQ-FG', 'SEQ-RM', 'SEQ-LEG']) {
      await saveMaterialView({
        client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
        reason: 'Execution order audit', view: 'BASIC', description: materialNumber, materialType: 'RAW',
        materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
        grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
      });
      await saveMaterialView({
        client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
        reason: 'Execution order audit', view: 'MRP', plant: PLANT,
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
    await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
    await createWorkCenter({
      client: tenant.client, changedBy: ACTOR, plant: PLANT, workCenter: 'WCSEQ', category: 'MACH', description: 'Sequence',
    });
    await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
    await saveRoutingControlKey({ client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Confirm', confirmation: 'X' });
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
    await closeDb();
  });

  function header(extra: Record<string, unknown> = {}) {
    return {
      client: tenant.client,
      changedBy: ACTOR,
      taskListType: 'N',
      plant: PLANT,
      usage: '1',
      baseQuantity: '1',
      baseUnit: 'KG',
      validFrom: '2020-01-01',
      ...extra,
    };
  }

  function operation(extra: Record<string, unknown> = {}) {
    return { operationNumber: '0010', shortText: 'Cut', workCenter: 'WCSEQ', controlKey: 'PP01', ...extra };
  }

  it('keeps the applied execution-order constraints deferred, positive, and scoped', async () => {
    const constraints = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select conname, pg_get_constraintdef(oid) as definition, condeferrable, condeferred
        from pg_constraint
       where conname in (
         'routing_operation_execution_order_ck',
         'routing_operation_execution_order_uq',
         'production_order_operation_execution_order_ck',
         'production_order_operation_execution_order_uq'
       )
       order by conname
    `)) as unknown as Array<{ conname: string; definition: string; condeferrable: boolean; condeferred: boolean }>;
    expect(constraints).toHaveLength(4);
    const byName = new Map(constraints.map((row) => [row.conname, row]));
    expect(byName.get('routing_operation_execution_order_ck')?.definition).toMatch(/execution_order > 0/);
    expect(byName.get('routing_operation_execution_order_ck')?.condeferrable).toBe(false);
    expect(byName.get('routing_operation_execution_order_uq')?.definition).toMatch(/client, task_list_type, routing_group, group_counter, sequence, execution_order/);
    expect(byName.get('routing_operation_execution_order_uq')?.condeferrable).toBe(true);
    expect(byName.get('routing_operation_execution_order_uq')?.condeferred).toBe(true);
    expect(byName.get('production_order_operation_execution_order_uq')?.definition).toMatch(/client, order_number, execution_order/);
    expect(byName.get('production_order_operation_execution_order_uq')?.condeferrable).toBe(true);
    expect(byName.get('production_order_operation_execution_order_ck')?.definition).toMatch(/execution_order > 0/);
  });

  it('ranks a missing execution order by operation number inside the tenant and does not overwrite a stored order', async () => {
    const ranked = await withTenant(tenant.client, (tx) => tx.execute(sql`
      with probe(client, order_number, operation_number, execution_order) as (
        values
          ('A001'::varchar, 'ORD1'::varchar, '0030'::varchar, null::integer),
          ('A001', 'ORD1', '0010', null),
          ('B002', 'ORD1', '0010', null),
          ('A001', 'ORD2', '0020', 9),
          ('A001', 'ORD3', '0010', 9),
          ('A001', 'ORD3', '0030', null)
      ), ranked as (
        select client, order_number, operation_number,
               row_number() over (
                 partition by client, order_number
                 order by operation_number
               )::integer as n,
               execution_order
          from probe
      )
      select client, order_number, operation_number,
             case when execution_order is null then n else execution_order end as execution_order
        from ranked
       order by client, order_number, operation_number
    `)) as unknown as Array<{ client: string; order_number: string; operation_number: string; execution_order: number }>;
    expect(ranked.map((row) => [row.client, row.order_number, row.operation_number, Number(row.execution_order)])).toEqual([
      ['A001', 'ORD1', '0010', 1],
      ['A001', 'ORD1', '0030', 2],
      ['A001', 'ORD2', '0020', 9],
      ['A001', 'ORD3', '0010', 9],
      ['A001', 'ORD3', '0030', 2],
      ['B002', 'ORD1', '0010', 1],
    ]);
  });

  it('appends a new operation after the highest stored order and does not fill a gap', async () => {
    const created = await createRouting(header({
      routingGroup: '50000072',
      operations: [
        operation({ operationNumber: '0010', executionOrder: 1 }),
        operation({ operationNumber: '0020', shortText: 'Later', executionOrder: 5 }),
      ],
    }));
    const changed = await changeRouting(header({
      routingGroup: '50000072', groupCounter: '01', version: created.version,
      operations: [
        operation({ operationNumber: '0010' }),
        operation({ operationNumber: '0030', shortText: 'Added' }),
      ],
    }));
    expect(changed.operations.map((row) => [row.operationNumber, row.executionOrder, row.deletionFlag])).toEqual([
      ['0010', 1, ' '],
      ['0020', 5, 'X'],
      ['0030', 6, ' '],
    ]);
    const orders = changed.operations.map((row) => row.executionOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('reactivates a deleted operation without duplicating an execution order', async () => {
    const created = await createRouting(header({
      routingGroup: '50000073',
      operations: [
        operation({ operationNumber: '0010', executionOrder: 1 }),
        operation({ operationNumber: '0020', shortText: 'Hold', executionOrder: 2 }),
      ],
    }));
    const deleted = await changeRouting(header({
      routingGroup: '50000073', groupCounter: '01', version: created.version,
      operations: [operation({ operationNumber: '0010' })],
    }));
    expect(deleted.operations.find((row) => row.operationNumber === '0020')).toMatchObject({ deletionFlag: 'X', executionOrder: 2 });
    await expect(changeRouting(header({
      routingGroup: '50000073', groupCounter: '01', version: deleted.version,
      operations: [
        operation({ operationNumber: '0010', executionOrder: 2 }),
        operation({ operationNumber: '0020', shortText: 'Hold', deletionFlag: ' ', executionOrder: 2 }),
      ],
    }))).rejects.toThrow(/Execution order 2 is used/);
    const standing = await getRouting(tenant.client, 'N', '50000073', '01');
    expect(standing?.version).toBe(deleted.version);
    expect(standing?.operations.find((row) => row.operationNumber === '0020')?.deletionFlag).toBe('X');
    const reactivated = await changeRouting(header({
      routingGroup: '50000073', groupCounter: '01', version: standing?.version,
      operations: [
        operation({ operationNumber: '0010', executionOrder: 2 }),
        operation({ operationNumber: '0020', shortText: 'Hold', deletionFlag: ' ', executionOrder: 1 }),
      ],
    }));
    expect(reactivated.operations.map((row) => [row.operationNumber, row.executionOrder, row.deletionFlag])).toEqual([
      ['0020', 1, ' '],
      ['0010', 2, ' '],
    ]);
  });

  it('rejects an invalid order without leaving a partial routing, and a stale reorder does not mix orders', async () => {
    await expect(createRouting(header({
      routingGroup: '50000074',
      operations: [operation({ executionOrder: -1 })],
    }))).rejects.toThrow(/not taken from the operation number/);
    await expect(createRouting(header({
      routingGroup: '50000074',
      operations: [operation({ executionOrder: '1.5' })],
    }))).rejects.toThrow(/not taken from the operation number/);
    expect(await getRouting(tenant.client, 'N', '50000074', '01')).toBeNull();

    const created = await createRouting(header({
      routingGroup: '50000075',
      operations: [
        operation({ operationNumber: '0010', executionOrder: 1 }),
        operation({ operationNumber: '0020', shortText: 'Pack', executionOrder: 2 }),
      ],
    }));
    const results = await Promise.allSettled([
      changeRouting(header({
        routingGroup: '50000075', groupCounter: '01', version: created.version, description: 'Left',
        operations: [
          operation({ operationNumber: '0010', executionOrder: 2 }),
          operation({ operationNumber: '0020', shortText: 'Pack', executionOrder: 1 }),
        ],
      })),
      changeRouting(header({
        routingGroup: '50000075', groupCounter: '01', version: created.version, description: 'Right',
        operations: [
          operation({ operationNumber: '0010', shortText: 'Other', executionOrder: 1 }),
          operation({ operationNumber: '0020', shortText: 'Pack', executionOrder: 2 }),
        ],
      })),
    ]);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RoutingError);
    expect(String(rejected.reason.message)).toMatch(/changed by someone else/);
    const standing = await getRouting(tenant.client, 'N', '50000075', '01');
    const pairs = standing?.operations.map((row) => [row.operationNumber, row.executionOrder, row.shortText]) ?? [];
    expect(pairs).toHaveLength(2);
    expect(new Set(pairs.map((row) => row[1])).size).toBe(2);
    const winner = results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<{ description: string | null }>;
    if (winner.value.description === 'Left') {
      expect(pairs).toEqual([['0020', 1, 'Pack'], ['0010', 2, 'Cut']]);
    } else {
      expect(pairs).toEqual([['0010', 1, 'Other'], ['0020', 2, 'Pack']]);
    }
    expect(await getRouting(other.client, 'N', '50000075', '01')).toBeNull();
  });


  it('denies the runtime role update, delete, and truncate of an operation snapshot', async () => {
    const privileges = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select current_user as role,
             (select count(*) from pg_auth_members am join pg_roles m on m.oid = am.member where m.rolname = current_user)::int as memberships,
             has_table_privilege(current_user, 'production_order_operation', 'SELECT') as can_select,
             has_table_privilege(current_user, 'production_order_operation', 'INSERT') as can_insert,
             has_table_privilege(current_user, 'production_order_operation', 'UPDATE') as can_update,
             has_table_privilege(current_user, 'production_order_operation', 'DELETE') as can_delete,
             has_table_privilege(current_user, 'production_order_operation', 'TRUNCATE') as can_truncate,
             has_table_privilege(current_user, 'production_order_operation_value', 'SELECT') as value_select,
             has_table_privilege(current_user, 'production_order_operation_value', 'INSERT') as value_insert,
             has_table_privilege(current_user, 'production_order_operation_value', 'UPDATE') as value_update,
             has_table_privilege(current_user, 'production_order_operation_value', 'DELETE') as value_delete,
             has_column_privilege(current_user, 'production_order_operation', 'execution_order', 'UPDATE') as column_update,
             (select relacl::text from pg_class where relname = 'production_order_operation') as operation_acl,
             (select relacl::text from pg_class where relname = 'production_order_operation_value') as value_acl
    `)) as unknown as Array<Record<string, string | number | boolean>>;
    const row = privileges[0];
    expect(row?.role).toBe('cairn_app');
    expect(Number(row?.memberships)).toBe(0);
    expect(row?.can_select).toBe(true);
    expect(row?.can_insert).toBe(true);
    expect(row?.can_update).toBe(false);
    expect(row?.can_delete).toBe(false);
    expect(row?.can_truncate).toBe(false);
    expect(row?.value_select).toBe(true);
    expect(row?.value_insert).toBe(true);
    expect(row?.value_update).toBe(false);
    expect(row?.value_delete).toBe(false);
    expect(row?.column_update).toBe(false);
    expect(String(row?.operation_acl)).toContain('cairn_app=ar/cairn');
    expect(String(row?.operation_acl)).not.toContain('cairn_app=arw');
    expect(String(row?.operation_acl)).toContain('cairn=arwdDxtm/cairn');
    expect(String(row?.value_acl)).toContain('cairn_app=ar/cairn');
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`truncate production_order_operation`))).rejects.toThrow(/permission denied|insufficient privilege|must be owner/i);
  });

  it('copies execution order onto CO01 and CO40 and does not reconstruct it from a later routing', async () => {
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'SEQ-FG', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'KG', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'SEQ-RM', quantity: '1', unit: 'KG' }],
    });
    await createRouting(header({
      routingGroup: '50000076',
      assignments: [{ materialNumber: 'SEQ-FG' }],
      operations: [
        operation({ operationNumber: '0030', shortText: 'Third', executionOrder: 1 }),
        operation({ operationNumber: '0010', shortText: 'First', executionOrder: 2 }),
      ],
    }));
    await createProductionVersion({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'SEQ-FG', plant: PLANT, productionVersion: '0001',
      validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'KG',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000076', groupCounter: '01',
    });
    const direct = await createProductionOrder({
      orderType: 'PP01', client: tenant.client, createdBy: ACTOR, materialNumber: 'SEQ-FG', plant: PLANT,
      orderQuantity: 4, scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey: 'seq-co01',
    });
    const before = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select operation_number, execution_order, sequence, short_text, work_center, control_key
        from production_order_operation
       where client = ${tenant.client} and order_number = ${direct.orderNumber}
       order by execution_order
    `)) as unknown as Array<Record<string, string | number>>;
    expect(before.map((row) => [row.operation_number, Number(row.execution_order), row.sequence, row.short_text, row.work_center])).toEqual([
      ['0030', 1, '000000', 'Third', 'WCSEQ'],
      ['0010', 2, '000000', 'First', 'WCSEQ'],
    ]);

    const planned = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'seq-plan',
      materialNumber: 'SEQ-FG', plant: PLANT, quantity: '3', finishDate: '2026-10-25',
    });
    const converted = await convertPlannedOrder({
      orderType: 'PP01', client: tenant.client, changedBy: ACTOR,
      orderNumber: planned.order.orderNumber, expectedVersion: planned.order.version,
    });
    expect(converted.status).toBe('CONVERTED');
    const convertedRows = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select operation_number, execution_order, short_text
        from production_order_operation
       where client = ${tenant.client} and order_number = ${converted.productionOrderNumber}
       order by execution_order
    `)) as unknown as Array<{ operation_number: string; execution_order: number; short_text: string }>;
    expect(convertedRows.map((row) => [row.operation_number, Number(row.execution_order), row.short_text])).toEqual([
      ['0030', 1, 'Third'],
      ['0010', 2, 'First'],
    ]);

    const routing = await getRouting(tenant.client, 'N', '50000076', '01');
    await changeRouting(header({
      routingGroup: '50000076', groupCounter: '01', version: routing?.version,
      assignments: [{ materialNumber: 'SEQ-FG' }],
      operations: [
        operation({ operationNumber: '0030', shortText: 'Third later', workCenter: 'WCSEQ', executionOrder: 2 }),
        operation({ operationNumber: '0010', shortText: 'First later', workCenter: 'WCSEQ', executionOrder: 1 }),
      ],
    }));
    const beforeTamper = await getProductionOrderDisplay(tenant.client, direct.orderNumber);
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      update production_order_operation
         set short_text = 'Tampered', execution_order = 9
       where client = ${tenant.client} and order_number = ${direct.orderNumber}
    `))).rejects.toThrow(/permission denied|insufficient privilege/i);
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      delete from production_order_operation
       where client = ${tenant.client} and order_number = ${direct.orderNumber}
    `))).rejects.toThrow(/permission denied|insufficient privilege/i);
    expect((await getProductionOrderDisplay(tenant.client, direct.orderNumber))?.operations).toEqual(beforeTamper?.operations);
    const quantityBefore = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select order_quantity::text as quantity from production_order
       where client = ${tenant.client} and order_number = ${direct.orderNumber}
    `)) as unknown as Array<{ quantity: string }>;
    await expect(withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update production_order set order_quantity = 99
         where client = ${tenant.client} and order_number = ${direct.orderNumber}
      `);
      await tx.execute(sql`
        update production_order_operation_value set quantity = 99
         where client = ${tenant.client} and order_number = ${direct.orderNumber}
      `);
    })).rejects.toThrow(/permission denied|insufficient privilege/i);
    const quantityAfter = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select order_quantity::text as quantity from production_order
       where client = ${tenant.client} and order_number = ${direct.orderNumber}
    `)) as unknown as Array<{ quantity: string }>;
    expect(quantityAfter[0]?.quantity).toBe(quantityBefore[0]?.quantity);
    const after = await getProductionOrderDisplay(tenant.client, direct.orderNumber);
    expect(after?.operations.map((row) => [row.operationNumber, row.executionOrder, row.shortText, row.workCenter, row.sequence])).toEqual([
      ['0030', 1, 'Third', 'WCSEQ', '000000'],
      ['0010', 2, 'First', 'WCSEQ', '000000'],
    ]);
    expect(after?.gaps.join(' ')).toMatch(/not proof of an earlier routing order/);
    expect(await getProductionOrder(other.client, direct.orderNumber)).toBeNull();

    const listed = await runOrderInformation(tenant.client, { listType: 'OPERATIONS', orderNumber: direct.orderNumber });
    expect(listed.rows.map((row) => [row.operationNumber, row.executionOrder, row.sequence])).toEqual([
      ['0030', '1', '000000'],
      ['0010', '2', '000000'],
    ]);
    expect(listed.notes.join(' ')).toMatch(/not proof of an earlier routing order/);
    const released = await import('../src/modules/inventory/production-orders').then((module) => module.releaseProductionOrder({
      client: tenant.client, orderNumber: direct.orderNumber, releasedBy: ACTOR,
    }));
    const ticket = await loadTimeTicket(tenant.client, { orderNumber: released.orderNumber, operationNumber: '0010' });
    expect(ticket.operations.map((row) => [row.operationNumber, row.executionOrder])).toEqual([['0030', 1], ['0010', 2]]);
    expect(ticket.selected?.operationNumber).toBe('0010');
    expect(ticket.selected?.sequence).toBe('000000');

    const legacy = await createProductionOrder({
      orderType: 'PP01', client: tenant.client, createdBy: ACTOR, materialNumber: 'SEQ-LEG', plant: PLANT,
      orderQuantity: 1, scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey: 'seq-legacy',
      components: [{ materialNumber: 'SEQ-RM', plant: PLANT, requiredQuantity: 1 }],
    });
    const legacyShown = await getProductionOrderDisplay(tenant.client, legacy.orderNumber);
    expect(legacyShown?.operations).toEqual([]);
    expect(legacyShown?.gaps.join(' ')).toMatch(/Operations are not stored/);
    expect(legacyShown?.gaps.join(' ')).not.toMatch(/UNCONFIRMED/);
  });
});
