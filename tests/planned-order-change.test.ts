import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { changeDocument, changeDocumentItem } from '../src/platform/tables/audit-trail';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { mrpController, productionOrder } from '../src/modules/inventory/schema';
import { planMaterials } from '../src/modules/production/mrp-run';
import { mrpDependentRequirement, plannedOrder } from '../src/modules/production/schema';
import {
  PlannedOrderChangeError,
  changePlannedOrder,
  holdsPlannedOrderChangeAuthority,
  plannedOrderChangeRefusal,
} from '../src/modules/production/planned-order-change';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'MD12_TEST';
let tenant: TestTenant;
let other: TestTenant;

async function materialOf(client: string, materialNumber: string) {
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Change test', view: 'BASIC', description: materialNumber, materialType: 'RAW',
    materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
    grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
  });
}

beforeAll(async () => {
  tenant = await createTenant('md12-change');
  other = await createTenant('md12-change-other');
  await withTenant(tenant.client, (tx) => tx.insert(mrpController).values({
    client: tenant.client, controller: '001', name: 'Controller 001', isActive: true, createdBy: ACTOR,
  }).onConflictDoNothing());
  await materialOf(tenant.client, 'FG-12');
  await materialOf(tenant.client, 'COMP-12');
  await withTenant(tenant.client, async (tx) => {
    await tx.insert(plannedOrder).values({
      client: tenant.client, orderNumber: 'PL-0000012', materialNumber: 'FG-12', plant: '1000',
      quantity: '12.500', unit: 'KG', startDate: '2026-10-01', finishDate: '2026-10-05',
      firmingStatus: 'OPEN', origin: 'MRP', requestKey: 'md12-1', createdBy: ACTOR,
    });
    await tx.insert(mrpDependentRequirement).values({
      client: tenant.client, parentOrderNumber: 'PL-0000012', sourceMaterial: 'FG-12', itemNumber: '0010',
      materialNumber: 'COMP-12', plant: '1000', quantity: '25.000', unit: 'KG', requirementDate: '2026-10-01',
      parentMaterial: 'FG-12', status: 'OPEN', createdBy: ACTOR,
    });
    await tx.insert(productionOrder).values({
      client: tenant.client, orderNumber: '1000012', materialNumber: 'FG-12', plant: '1000',
      orderQuantity: '12.500', unitOfMeasure: 'KG', scheduledStart: '2026-10-01', scheduledFinish: '2026-10-05',
      status: 'CREATED', requestKey: 'md12-po', createdBy: ACTOR,
    });
  });
});

afterAll(async () => {
  await destroyTenant(tenant.client);
  await destroyTenant(other.client);
  await closeDb();
});

async function standing() {
  const [row] = await withTenant(tenant.client, (tx) => tx.select().from(plannedOrder).where(and(
    eq(plannedOrder.client, tenant.client), eq(plannedOrder.orderNumber, 'PL-0000012'),
  )));
  return row!;
}

async function footprint() {
  const [row] = await withTenant(tenant.client, (tx) => tx.execute(sql`
    select
      (select count(*) from production_order where client = ${tenant.client})::int as orders,
      (select count(*) from purchase_requisition_item where client = ${tenant.client})::int as requisitions,
      (select count(*) from material_document where client = ${tenant.client})::int as documents,
      (select quantity::text from mrp_dependent_requirement where client = ${tenant.client} and parent_order_number = 'PL-0000012') as demand
  `)) as unknown as Array<{ orders: number; requisitions: number; documents: number; demand: string }>;
  return row;
}

describe('MD12 change planned order', () => {
  it('changes the quantity, firms the order, and writes nothing downstream', async () => {
    const before = await footprint();
    const result = await changePlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: 'PL-0000012', expectedVersion: 1, quantity: '15',
    });
    expect(result.changed).toBe(true);
    expect(result.firmedByChange).toBe(true);
    expect(result.order).toMatchObject({
      orderNumber: 'PL-0000012', quantity: '15.000', unit: 'KG', firmingStatus: 'FIRMED', origin: 'MRP', version: 2,
    });
    expect(result.warnings.join(' ')).toMatch(/Component demand was not recalculated/);
    expect(await footprint()).toEqual(before);
    const row = await standing();
    expect(row.changedBy).toBe(ACTOR);
    expect(row.requestKey).toBe('md12-1');
    const [audit] = await withTenant(tenant.client, (tx) => tx.select().from(changeDocument).where(and(
      eq(changeDocument.client, tenant.client), eq(changeDocument.objectClass, 'planned_order'), eq(changeDocument.objectKey, 'PL-0000012'),
    )));
    expect(audit?.transactionCode).toBe('MD12');
    const items = await withTenant(tenant.client, (tx) => tx.select().from(changeDocumentItem).where(eq(changeDocumentItem.changeDocumentId, audit!.id)));
    expect(items.find((item) => item.fieldName === 'quantity')).toMatchObject({ oldValue: '12.500', newValue: '15.000' });
    expect(items.find((item) => item.fieldName === 'firmingStatus')).toMatchObject({ oldValue: 'OPEN', newValue: 'FIRMED' });
  });

  it('rejects a bad quantity, a substituted unit, a bad date, a fixed field, and a stale version', async () => {
    const before = await standing();
    await expect(changePlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: 'PL-0000012', expectedVersion: before.version, quantity: '0',
    })).rejects.toThrow(/positive/);
    await expect(changePlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: 'PL-0000012', expectedVersion: before.version, quantity: '1.0000',
    })).rejects.toThrow(/decimal places/);
    await expect(changePlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: 'PL-0000012', expectedVersion: before.version, unit: 'PC',
    })).rejects.toThrow(/not substituted/);
    await expect(changePlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: 'PL-0000012', expectedVersion: before.version,
      startDate: '2026-10-09', finishDate: '2026-10-01',
    })).rejects.toThrow(/before the start/);
    await expect(changePlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: 'PL-0000012', expectedVersion: before.version, finishDate: '2026-02-31',
    })).rejects.toThrow(/not a valid date/);
    await expect(changePlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: 'PL-0000012', expectedVersion: before.version, materialNumber: 'OTHER',
    })).rejects.toThrow(/material is fixed/);
    await expect(changePlannedOrder({
      client: other.client, changedBy: ACTOR, orderNumber: 'PL-0000012', expectedVersion: before.version, quantity: '1',
    })).rejects.toThrow(/does not stand/);
    await expect(changePlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: 'PL-0000012', expectedVersion: 1, quantity: '16',
    })).rejects.toThrow(/someone else/);
    expect(await standing()).toMatchObject({ quantity: before.quantity, version: before.version, firmingStatus: 'FIRMED' });
  });

  it('refuses fields that are not stored and does not convert', () => {
    expect(plannedOrderChangeRefusal({ mrpArea: '001' })).toMatch(/MRP area/);
    expect(plannedOrderChangeRefusal({ productionVersion: '0001' })).toMatch(/not stored/);
    expect(plannedOrderChangeRefusal({ convert: 'X' })).toMatch(/does not convert/);
    expect(plannedOrderChangeRefusal({ deletionIndicator: 'X' })).toMatch(/does not remove/);
    expect(plannedOrderChangeRefusal({ reexplode: 'X' })).toMatch(/not this save/);
    expect(plannedOrderChangeRefusal({ schedule: 'X' })).toMatch(/not carried/);
    expect(holdsPlannedOrderChangeAuthority(['PROD.PLANNEDORDER.CHANGE'])).toBe(true);
    expect(holdsPlannedOrderChangeAuthority(['PROD.PLANNEDORDER.DISPLAY'])).toBe(false);
    const source = readFileSync('src/modules/production/planned-order-change.ts', 'utf8');
    expect(source).not.toMatch(/purchase_requisition|explodePlannedSupply|selectProductionVersion|createRequisition|createProductionOrder|convertPlannedOrder/);
    expect(source).not.toMatch(/insert into production_order/i);
    const page = readFileSync('src/app/production/planned-order-change/page.tsx', 'utf8');
    const action = readFileSync('src/app/production/planned-order-change/actions.ts', 'utf8');
    expect(page).toContain('The first was not opened.');
    expect(action).toContain('assertChangeForSession');
    expect(action).not.toContain('createProductionOrder');
  });

  it('leaves an unchanged order untouched, then unfirms it in a separate save', async () => {
    const before = await standing();
    const same = await changePlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: 'PL-0000012', expectedVersion: before.version,
      quantity: before.quantity, startDate: before.startDate, finishDate: before.finishDate, firmingStatus: before.firmingStatus,
    });
    expect(same.changed).toBe(false);
    expect((await standing()).version).toBe(before.version);
    const unfirmed = await changePlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: 'PL-0000012', expectedVersion: before.version, firmingStatus: 'OPEN',
    });
    expect(unfirmed.order.firmingStatus).toBe('OPEN');
    expect(unfirmed.order.quantity).toBe(before.quantity);
    expect(unfirmed.firmedByChange).toBe(false);
  });
});

describe('MD12 firming is respected by planning', () => {
  it('does not let a later planning run overwrite the changed quantity', async () => {
    const client = tenant.client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'MRPRUN', subObject: '*', prefix: 'MR', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MD12-MAKE', 'MD12 make', t.material_type, 'PC', ${ACTOR}
          from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (
          client, material_number, plant, mrp_type, mrp_controller, procurement_type, lot_sizing,
          safety_stock, planned_delivery_days, in_house_production_days, purchasing_group, mrp_status, created_by
        ) values (
          ${client}, 'MD12-MAKE', '1000', 'REQUIREMENTS', '001', 'MAKE', 'EXACT', 5, 0, 0, '001', 'MAINTAINED', ${ACTOR}
        )
        on conflict (client, material_number, plant) do update set safety_stock = 5, mrp_status = 'MAINTAINED'
      `);
      await tx.execute(sql`
        insert into planning_file (client, material_number, plant, net_change, reason, last_changed_by)
        values (${client}, 'MD12-MAKE', '1000', true, 'Test', ${ACTOR})
        on conflict (client, material_number, plant) do update set net_change = true, last_changed_at = now()
      `);
    });
    const first = await planMaterials({
      client, requestedBy: ACTOR, requestKey: 'md12-plan-1', processingKey: 'NETCH', plantFrom: '1000',
      materialFrom: 'MD12-MAKE', materialTo: 'MD12-MAKE',
    });
    const number = first.proposals[0]?.documentNumber;
    expect(first.proposals[0]?.proposalType).toBe('PLANNED_ORDER');
    expect(number).toBeTruthy();
    const opened = await withTenant(client, (tx) => tx.select({ version: plannedOrder.version }).from(plannedOrder).where(and(
      eq(plannedOrder.client, client), eq(plannedOrder.orderNumber, number!),
    )));
    const changed = await changePlannedOrder({
      client, changedBy: ACTOR, orderNumber: number!, expectedVersion: opened[0]!.version, quantity: '9',
    });
    expect(changed.order.firmingStatus).toBe('FIRMED');
    expect(changed.order.quantity).toBe('9.000');
    await withTenant(client, (tx) => tx.execute(sql`
      update material_plant set safety_stock = 12
       where client = ${client} and material_number = 'MD12-MAKE' and plant = '1000'
    `));
    const second = await planMaterials({
      client, requestedBy: ACTOR, requestKey: 'md12-plan-2', processingKey: 'NETCH', plantFrom: '1000',
      materialFrom: 'MD12-MAKE', materialTo: 'MD12-MAKE',
    });
    expect(second.proposals.some((row) => row.action === 'CONFLICT' && row.documentNumber === number)).toBe(true);
    const [after] = await withTenant(client, (tx) => tx.select({
      quantity: plannedOrder.quantity, firmingStatus: plannedOrder.firmingStatus,
    }).from(plannedOrder).where(and(eq(plannedOrder.client, client), eq(plannedOrder.orderNumber, number!))));
    expect(after).toMatchObject({ quantity: '9.000', firmingStatus: 'FIRMED' });
    const orders = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as count from production_order where client = ${client} and material_number = 'MD12-MAKE'
    `)) as unknown as Array<{ count: number }>;
    expect(orders[0]?.count).toBe(0);
  });
});
