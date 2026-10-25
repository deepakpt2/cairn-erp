import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { changeDocument } from '../src/platform/tables/audit-trail';
import { withTenant } from '../src/platform/db/client';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { productionOrder, productionOrderComponent } from '../src/modules/inventory/schema';
import { createMaterialBom, getMaterialBom } from '../src/modules/production/material-bom';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { productionOrderType, routing } from '../src/modules/production/schema';
import {
  ROUTING_CHANGE_CAPABILITY,
  ROUTING_CREATE_CAPABILITY,
  ROUTING_DISPLAY_CAPABILITY,
  RoutingError,
  changeRouting,
  createRouting,
  getRouting,
  holdsRoutingAuthority,
  listRoutingConfiguration,
  listRoutings,
  resolveRouting,
  saveRoutingControlKey,
  saveRoutingStandardValueKey,
  saveRoutingStatus,
  saveRoutingTaskListType,
  saveRoutingUsage,
  selectEffectiveRouting,
} from '../src/modules/production/routing';
import { displayRouting } from '../src/modules/production/routing-display';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'CA01_TEST';
let tenant: TestTenant;
let other: TestTenant;

async function materialOf(client: string, materialNumber: string) {
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Routing test', view: 'BASIC', description: materialNumber, materialType: 'RAW',
    materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
    grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
  });
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Routing test', view: 'PURCHASING', plant: '1000',
    purchasingGroup: '', orderUnit: 'KG', overdeliveryTolerance: '0',
    underdeliveryTolerance: '0', manufacturerPartNumber: '',
  });
}

beforeAll(async () => {
  tenant = await createTenant('ca01-routing');
  other = await createTenant('ca01-routing-other');
  await materialOf(tenant.client, 'FG-1');
  await materialOf(tenant.client, 'COMP-1');
  await withTenant(tenant.client, (tx) => tx.execute(sql`
    insert into unit_of_measure (code, name, dimension, decimal_places)
    values ('H', 'Hour', 'TIME', 3)
    on conflict (code) do update set decimal_places = 3
  `));
  const empty = await listRoutingConfiguration(other.client);
  expect(empty.usages).toHaveLength(0);
  expect(empty.controlKeys).toHaveLength(0);
  expect(empty.standardValueKeys).toHaveLength(0);
  await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing', requireControlKey: 'X' });
  await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
  await saveRoutingStatus({
    client: tenant.client, changedBy: ACTOR, status: '4', description: 'Released',
    releasedForScheduling: 'X', releasedForCosting: 'X', releasedForOrders: 'X',
  });
  await saveRoutingControlKey({
    client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Internal',
    scheduling: 'X', requireWorkCenter: 'X',
  });
  await saveRoutingStandardValueKey({
    client: tenant.client, changedBy: ACTOR, standardValueKey: 'SAP1', description: 'Times',
    parameters: [{ parameter: 'SETUP', description: 'Setup', unit: 'H', required: 'X' }],
  });
  await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
  await createWorkCenter({
    client: tenant.client, changedBy: ACTOR, plant: '1000', workCenter: 'WC01', category: 'MACH',
    description: 'Assembly', controlKey: 'PP01', standardValueKey: 'SAP1', schedulingSetupFormula: 'SET001',
  });
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
    plant: '1000',
    usage: '1',
    status: '4',
    baseQuantity: '1',
    baseUnit: 'KG',
    validFrom: '2026-01-01',
    ...extra,
  };
}

function operation(extra: Record<string, unknown> = {}) {
  return {
    operationNumber: '0010',
    shortText: 'Cut',
    workCenter: 'WC01',
    controlKey: 'PP01',
    standardValueKey: 'SAP1',
    values: [{ parameter: 'SETUP', quantity: '0.5', unit: 'H' }],
    ...extra,
  };
}

describe('standard routing', () => {
  it('creates a routing with two operations and does not calculate a formula', async () => {
    const saved = await createRouting(header({
      routingGroup: '50000001',
      groupCounter: '1',
      description: 'Standard',
      lotFrom: '0',
      lotTo: '100',
      assignments: [{ materialNumber: 'FG-1' }],
      operations: [operation(), operation({ operationNumber: '0020', shortText: 'Pack' })],
    }));
    expect(saved.routingGroup).toBe('50000001');
    expect(saved.groupCounter).toBe('01');
    expect(saved.sequence).toBe('000000');
    expect(saved.sequenceType).toBe('0');
    expect(saved.operations.map((row) => row.operationNumber)).toEqual(['0010', '0020']);
    expect(saved.operations[0].schedulingFormula).toBe('SET001');
    expect(saved.operations[0].formulaCalculated).toBe(false);
    expect(saved.operations[0].values[0]).toMatchObject({ parameter: 'SETUP', unit: 'H' });
    expect(saved.validTo).toBe('9999-12-31');
    expect(saved.assignments).toHaveLength(1);
  });

  it('refuses a duplicate group and counter and an unextended material', async () => {
    await expect(createRouting(header({ routingGroup: '50000001', groupCounter: '01' }))).rejects.toThrow(/already exists/);
    await expect(createRouting(header({
      routingGroup: '50000009', assignments: [{ materialNumber: 'MISSING' }], operations: [operation()],
    }))).rejects.toThrow(/not extended/);
    const unassigned = await createRouting(header({ routingGroup: '50000002', operations: [operation()] }));
    expect(unassigned.assignments).toHaveLength(0);
    expect(await listRoutings(tenant.client, { materialNumber: 'FG-1', plant: '1000' })).toHaveLength(1);
  });

  it('refuses an inverted lot range and does not pick the first of two matches', async () => {
    await expect(createRouting(header({ routingGroup: '50000003', lotFrom: '10', lotTo: '1', operations: [operation()] }))).rejects.toThrow(/Lot-size from is above/);
    await createRouting(header({
      routingGroup: '50000003', groupCounter: '02', lotFrom: '0', lotTo: '5',
      assignments: [{ materialNumber: 'FG-1', validFrom: '2026-06-01', validTo: '2026-06-30' }],
      operations: [operation({ operationNumber: '0030' })],
    }));
    expect(await selectEffectiveRouting(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', keyDate: '2026-01-15', lotSize: '1',
    })).toMatchObject({ routingGroup: '50000001' });
    expect(await selectEffectiveRouting(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', keyDate: '2025-01-01', lotSize: '1',
    })).toBeNull();
    await expect(selectEffectiveRouting(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', keyDate: '2026-06-15', lotSize: '1',
    })).rejects.toThrow(/More than one routing/);
    expect(await selectEffectiveRouting(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', keyDate: '2026-06-15', lotSize: '50',
    })).toMatchObject({ routingGroup: '50000001' });
    await expect(resolveRouting(tenant.client, { materialNumber: 'FG-1', plant: '1000' })).rejects.toThrow(/first row was not opened|Choose a group/);
  });

  it('refuses a repeated operation, an unknown work center, and a value outside the key', async () => {
    await expect(createRouting(header({
      routingGroup: '50000004', operations: [operation(), operation()],
    }))).rejects.toThrow(/repeated/);
    await expect(createRouting(header({
      routingGroup: '50000004', operations: [operation({ workCenter: 'WC99' })],
    }))).rejects.toThrow(/does not exist/);
    await expect(createRouting(header({
      routingGroup: '50000004', operations: [operation({ controlKey: 'ZZZ' })],
    }))).rejects.toThrow(/not defined/);
    await expect(createRouting(header({
      routingGroup: '50000004',
      operations: [operation({ values: [{ parameter: 'LABOR', quantity: '1', unit: 'H' }] })],
    }))).rejects.toThrow(/not defined for standard value key/);
    await expect(createRouting(header({
      routingGroup: '50000004',
      operations: [operation({ values: [{ parameter: 'SETUP', quantity: '1', unit: 'KG' }] })],
    }))).rejects.toThrow(/must use unit H/);
    const rows = await listRoutings(tenant.client, { taskListType: 'N' });
    expect(rows.some((row) => row.routingGroup === '50000004')).toBe(false);
  });

  it('refuses an alternative sequence by name and does not store it', async () => {
    await expect(createRouting(header({
      routingGroup: '50000005', operations: [operation({ sequenceType: '2' })],
    }))).rejects.toThrow(/Alternative and parallel sequences are not implemented/);
    expect((await listRoutings(tenant.client)).some((row) => row.routingGroup === '50000005')).toBe(false);
    await expect(createRouting(header({
      routingGroup: '50000005', operations: [operation({ suboperation: '0001' })],
    }))).rejects.toThrow(/suboperation is not implemented/);
  });

  it('keeps the group and operation numbers, and marks an omitted operation deleted', async () => {
    const before = await getRouting(tenant.client, 'N', '50000001', '01');
    const changed = await changeRouting(header({
      routingGroup: '50000001',
      groupCounter: '01',
      version: before?.version,
      description: 'Changed',
      assignments: [{ materialNumber: 'FG-1' }],
      operations: [operation({ shortText: 'Cut again' })],
    }));
    expect(changed.routingGroup).toBe('50000001');
    expect(changed.groupCounter).toBe('01');
    expect(changed.operations.find((row) => row.operationNumber === '0010')?.shortText).toBe('Cut again');
    expect(changed.operations.find((row) => row.operationNumber === '0020')?.deletionFlag).toBe('X');
    expect(changed.version).toBe((before?.version ?? 1) + 1);
  });

  it('refuses a change number and does not write from display', async () => {
    const before = await getRouting(tenant.client, 'N', '50000001', '01');
    await expect(changeRouting(header({
      routingGroup: '50000001', groupCounter: '01', version: before?.version, changeNumber: '500000000001',
    }))).rejects.toThrow(/Engineering change management is not implemented/);
    const [stamp] = await withTenant(tenant.client, (tx) => tx.select({
      version: routing.version, changedAt: routing.changedAt,
    }).from(routing).where(and(eq(routing.client, tenant.client), eq(routing.routingGroup, '50000001'))));
    const displayed = await displayRouting(tenant.client, 'N', '50000001', '01');
    expect(displayed?.version).toBe(stamp.version);
    const [after] = await withTenant(tenant.client, (tx) => tx.select({
      version: routing.version, changedAt: routing.changedAt,
    }).from(routing).where(and(eq(routing.client, tenant.client), eq(routing.routingGroup, '50000001'))));
    expect(after).toEqual(stamp);
    const source = readFileSync('src/modules/production/routing-display.ts', 'utf8');
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    const page = readFileSync('src/app/production/routing-display/page.tsx', 'utf8');
    expect(page).not.toMatch(/saveRouting|changeRouting|createRouting/);
  });

  it('allocates a BOM item without changing the BOM', async () => {
    const { saveBomUsage, saveBomItemCategory } = await import('../src/modules/production/material-bom');
    await saveBomUsage({
      client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({
      client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock',
      materialEntry: '+', quantityEntry: '+',
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-1', plant: '1000', usage: 'P',
      alternative: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'COMP-1', quantity: '4', unit: 'KG' }],
    });
    const standing = await getRouting(tenant.client, 'N', '50000001', '01');
    const saved = await changeRouting(header({
      routingGroup: '50000001', groupCounter: '01', version: standing?.version,
      assignments: [{ materialNumber: 'FG-1' }],
      operations: [operation({
        allocations: [{ materialNumber: 'FG-1', bomUsage: 'P', alternative: '01', itemNumber: '0010', quantity: '2' }],
      })],
    }));
    expect(saved.operations[0].allocations[0].itemNumber).toBe('0010');
    expect(Number(saved.operations[0].allocations[0].allocatedQuantity)).toBe(2);
    const bom = await getMaterialBom(tenant.client, 'FG-1', '1000', 'P', '01');
    expect(Number(bom?.items[0].quantity)).toBe(4);
    await expect(changeRouting(header({
      routingGroup: '50000001', groupCounter: '01', version: saved.version,
      assignments: [{ materialNumber: 'FG-1' }],
      operations: [operation({
        allocations: [{ materialNumber: 'FG-1', bomUsage: 'P', alternative: '01', itemNumber: '0099' }],
      })],
    }))).rejects.toThrow(/does not exist/);
  });

  it('does not rewrite a production order and is not read by order creation or planning', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.insert(productionOrderType).values({
        client: tenant.client, orderType: 'PP01', description: 'Standard production', orderCategory: '10', createdBy: ACTOR,
      });
      await tx.insert(productionOrder).values({
        client: tenant.client, orderNumber: '000000000092', materialNumber: 'FG-1', plant: '1000',
        orderQuantity: '1', unitOfMeasure: 'KG', scheduledStart: '2026-01-01', scheduledFinish: '2026-01-02',
        orderType: 'PP01', createdBy: ACTOR,
      });
      await tx.insert(productionOrderComponent).values({
        client: tenant.client, orderNumber: '000000000092', itemNumber: 10, materialNumber: 'COMP-1',
        plant: '1000', requiredQuantity: '7', unitOfMeasure: 'KG', createdBy: ACTOR,
      });
    });
    const standing = await getRouting(tenant.client, 'N', '50000001', '01');
    await changeRouting(header({
      routingGroup: '50000001', groupCounter: '01', version: standing?.version, description: 'After order',
      assignments: [{ materialNumber: 'FG-1' }],
      operations: [operation()],
    }));
    const [componentRow] = await withTenant(tenant.client, (tx) => tx.select().from(productionOrderComponent).where(and(
      eq(productionOrderComponent.client, tenant.client),
      eq(productionOrderComponent.orderNumber, '000000000092'),
    )));
    expect(Number(componentRow.requiredQuantity)).toBe(7);
    const columns = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'production_order' and column_name in ('routing_group', 'task_list_type')
    `));
    expect(columns).toHaveLength(0);
    const orderSource = readFileSync('src/modules/inventory/production-orders.ts', 'utf8');
    const planningSource = readFileSync('src/modules/production/mrp-run.ts', 'utf8');
    expect(orderSource).not.toMatch(/selectEffectiveRouting|from '\.\/routing'|from '@\/modules\/production\/routing'/);
    expect(planningSource).not.toMatch(/selectEffectiveRouting|routing/);
    const selected = await selectEffectiveRouting(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', keyDate: '2026-02-01', lotSize: '1', routingGroup: '50000001', groupCounter: '01',
    });
    expect(selected?.operations.map((row) => row.operationNumber)).toEqual(['0010']);
    expect(selected?.operations[0].formulaCalculated).toBe(false);
  });

  it('returns the first request, refuses a stale version, and records the change', async () => {
    const first = await createRouting(header({
      routingGroup: '50000006', description: 'First', requestKey: 'req-1', operations: [operation()],
    }));
    const replay = await createRouting(header({
      routingGroup: '50000007', description: 'Second', requestKey: 'req-1', operations: [operation()],
    }));
    expect(replay.routingGroup).toBe(first.routingGroup);
    expect(replay.description).toBe('First');
    expect(replay.warnings[0]).toMatch(/already saved/);
    const standing = await getRouting(tenant.client, 'N', '50000001', '01');
    const results = await Promise.allSettled([
      changeRouting(header({ routingGroup: '50000001', groupCounter: '01', version: standing?.version, description: 'Left', assignments: [{ materialNumber: 'FG-1' }], operations: [operation()] })),
      changeRouting(header({ routingGroup: '50000001', groupCounter: '01', version: standing?.version, description: 'Right', assignments: [{ materialNumber: 'FG-1' }], operations: [operation()] })),
    ]);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(changeRouting(header({
      routingGroup: '50000001', groupCounter: '01', version: 1, description: 'Stale', assignments: [{ materialNumber: 'FG-1' }], operations: [operation()],
    }))).rejects.toBeInstanceOf(RoutingError);
    const rows = await withTenant(tenant.client, (tx) => tx.select().from(changeDocument).where(and(
      eq(changeDocument.client, tenant.client),
      eq(changeDocument.objectClass, 'routing'),
      eq(changeDocument.objectKey, 'N/50000001/01'),
    )));
    expect(rows.some((row) => row.transactionCode === 'CA01')).toBe(true);
    expect(rows.some((row) => row.transactionCode === 'CA02')).toBe(true);
  });

  it('does not show another tenant the routing and checks the named capability', async () => {
    expect(await getRouting(other.client, 'N', '50000001', '01')).toBeNull();
    expect(holdsRoutingAuthority([ROUTING_CREATE_CAPABILITY], 'CREATE')).toBe(true);
    expect(holdsRoutingAuthority([ROUTING_CREATE_CAPABILITY], 'DISPLAY')).toBe(false);
    expect(holdsRoutingAuthority([ROUTING_CHANGE_CAPABILITY], 'CHANGE')).toBe(true);
    expect(holdsRoutingAuthority([ROUTING_DISPLAY_CAPABILITY], 'DISPLAY')).toBe(true);
    expect(holdsRoutingAuthority([], 'CREATE')).toBe(false);
  });
});
