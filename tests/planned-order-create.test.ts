import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { changeDocument, changeDocumentItem } from '../src/platform/tables/audit-trail';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { mrpController } from '../src/modules/inventory/schema';
import { planMaterials } from '../src/modules/production/mrp-run';
import { plannedOrder } from '../src/modules/production/schema';
import {
  PlannedOrderCreateError,
  createPlannedOrder,
  holdsPlannedOrderCreateAuthority,
  plannedOrderCreateRefusal,
} from '../src/modules/production/planned-order-create';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'MD11_TEST';
let tenant: TestTenant;
let other: TestTenant;

async function materialOf(client: string, materialNumber: string, procurement?: 'MAKE' | 'BUY' | 'BOTH', days = 0) {
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Create test', view: 'BASIC', description: materialNumber, materialType: 'RAW',
    materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
    grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
  });
  if (!procurement) return;
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Create test', view: 'MRP', plant: '1000',
    mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: procurement, lotSizing: 'EXACT',
    fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: '0', reorderPoint: '0',
    plannedDeliveryDays: 0, inHouseProductionDays: days,
  });
}

beforeAll(async () => {
  tenant = await createTenant('md11-create');
  other = await createTenant('md11-create-other');
  await withTenant(tenant.client, async (tx) => {
    await tx.insert(mrpController).values({
      client: tenant.client, controller: '001', name: 'Controller 001', isActive: true, createdBy: ACTOR,
    }).onConflictDoNothing();
    await defineRange(tx, { client: tenant.client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
  });
  await materialOf(tenant.client, 'FG-11', 'MAKE', 2);
  await materialOf(tenant.client, 'BUY-11', 'BUY');
  await materialOf(tenant.client, 'BOTH-11', 'BOTH');
  await materialOf(tenant.client, 'BASIC-11');
});

afterAll(async () => {
  await destroyTenant(tenant.client);
  await destroyTenant(other.client);
  await closeDb();
});

async function footprint(materialNumber = 'FG-11') {
  const [row] = await withTenant(tenant.client, (tx) => tx.execute(sql`
    select
      (select count(*) from production_order where client = ${tenant.client} and material_number = ${materialNumber})::int as orders,
      (select count(*) from purchase_requisition_item where client = ${tenant.client} and material_number = ${materialNumber})::int as requisitions,
      (select count(*) from material_document where client = ${tenant.client})::int as documents,
      (select count(*) from journal_entry where client = ${tenant.client})::int as journals,
      (select count(*) from mrp_dependent_requirement where client = ${tenant.client})::int as demand
  `)) as unknown as Array<{ orders: number; requisitions: number; documents: number; journals: number; demand: number }>;
  return row;
}

describe('MD11 create planned order', () => {
  it('creates a firmed manual order and writes nothing downstream', async () => {
    const before = await footprint();
    const result = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'md11-1',
      materialNumber: 'FG-11', plant: '1000', quantity: '12.5', finishDate: '2026-10-24',
    });
    expect(result.created).toBe(true);
    expect(result.order).toMatchObject({
      materialNumber: 'FG-11', plant: '1000', quantity: '12.500', unit: 'KG',
      startDate: '2026-10-22', finishDate: '2026-10-24', firmingStatus: 'FIRMED', origin: 'MANUAL', version: 1,
    });
    expect(result.order.orderNumber.length).toBeLessThanOrEqual(12);
    expect(result.warnings.join(' ')).toMatch(/does not explode/);
    expect(await footprint()).toEqual(before);
    const again = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'md11-1',
      materialNumber: 'FG-11', plant: '1000', quantity: '12.5', finishDate: '2026-10-24',
    });
    expect(again.created).toBe(false);
    expect(again.order.orderNumber).toBe(result.order.orderNumber);
    const [audit] = await withTenant(tenant.client, (tx) => tx.select().from(changeDocument).where(and(
      eq(changeDocument.client, tenant.client),
      eq(changeDocument.objectClass, 'planned_order'),
      eq(changeDocument.objectKey, result.order.orderNumber),
    )));
    expect(audit?.changeType).toBe('CREATE');
    expect(audit?.transactionCode).toBe('MD11');
    const items = await withTenant(tenant.client, (tx) => tx.select().from(changeDocumentItem).where(eq(changeDocumentItem.changeDocumentId, audit!.id)));
    expect(items.find((item) => item.fieldName === 'origin')?.newValue).toBe('MANUAL');
    expect(items.find((item) => item.fieldName === 'firmingStatus')?.newValue).toBe('FIRMED');
    await expect(createPlannedOrder({
      client: other.client, changedBy: ACTOR, requestKey: 'md11-other',
      materialNumber: 'FG-11', plant: '1000', quantity: '1', finishDate: '2026-10-24',
    })).rejects.toThrow(/does not stand/);
  });

  it('rejects a bought material, a missing plant view, a bad quantity, a substituted unit, and a typed number', async () => {
    const before = await footprint('BUY-11');
    await expect(createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'md11-buy',
      materialNumber: 'BUY-11', plant: '1000', quantity: '1', finishDate: '2026-10-24',
    })).rejects.toThrow(/not a purchase requisition/);
    await expect(createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'md11-basic',
      materialNumber: 'BASIC-11', plant: '1000', quantity: '1', finishDate: '2026-10-24',
    })).rejects.toThrow(/not extended/);
    await expect(createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'md11-zero',
      materialNumber: 'FG-11', plant: '1000', quantity: '0', finishDate: '2026-10-24',
    })).rejects.toThrow(/positive/);
    await expect(createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'md11-unit',
      materialNumber: 'FG-11', plant: '1000', quantity: '1', unit: 'PC', finishDate: '2026-10-24',
    })).rejects.toThrow(/not substituted/);
    await expect(createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'md11-dates',
      materialNumber: 'FG-11', plant: '1000', quantity: '1', startDate: '2026-10-24', finishDate: '2026-10-01',
    })).rejects.toThrow(/before the start/);
    await expect(createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'md11-number',
      materialNumber: 'FG-11', plant: '1000', quantity: '1', finishDate: '2026-10-24',
      named: { orderNumber: 'PL-9999999' },
    })).rejects.toThrow(/number range/);
    expect(plannedOrderCreateRefusal({ profile: 'LA' })).toMatch(/profile is not stored/);
    expect(plannedOrderCreateRefusal({ mrpArea: '001' })).toMatch(/MRP area/);
    expect(plannedOrderCreateRefusal({ productionVersion: '0001' })).toMatch(/does not select/);
    expect(holdsPlannedOrderCreateAuthority(['PROD.PLANNEDORDER.CREATE'])).toBe(true);
    expect(holdsPlannedOrderCreateAuthority(['PROD.PLANNEDORDER.DISPLAY'])).toBe(false);
    expect(await footprint('BUY-11')).toEqual(before);
    const source = readFileSync('src/modules/production/planned-order-create.ts', 'utf8');
    expect(source).not.toMatch(/explodePlannedSupply|selectProductionVersion|createRequisition|createProductionOrder/);
    const page = readFileSync('src/app/production/planned-order-create/page.tsx', 'utf8');
    expect(page).toContain('The first was not opened.');
    expect(page).not.toContain('name="profile"');
    expect(page).not.toContain('name="mrpArea"');
  });

  it('copies a reference into a new number and leaves the original unchanged', async () => {
    const both = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'md11-both',
      materialNumber: 'BOTH-11', plant: '1000', quantity: '3', startDate: '2026-10-01', finishDate: '2026-10-03',
    });
    expect(both.order.origin).toBe('MANUAL');
    const [before] = await withTenant(tenant.client, (tx) => tx.select({
      version: plannedOrder.version, changedAt: plannedOrder.changedAt, orderNumber: plannedOrder.orderNumber,
    }).from(plannedOrder).where(and(eq(plannedOrder.client, tenant.client), eq(plannedOrder.orderNumber, both.order.orderNumber))));
    const copied = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'md11-copy', referenceOrder: both.order.orderNumber,
    });
    expect(copied.copied).toBe(true);
    expect(copied.order.orderNumber).not.toBe(both.order.orderNumber);
    expect(copied.order).toMatchObject({
      materialNumber: 'BOTH-11', quantity: '3.000', startDate: '2026-10-01', finishDate: '2026-10-03',
      firmingStatus: 'FIRMED', origin: 'MANUAL',
    });
    const [after] = await withTenant(tenant.client, (tx) => tx.select({
      version: plannedOrder.version, changedAt: plannedOrder.changedAt,
    }).from(plannedOrder).where(and(eq(plannedOrder.client, tenant.client), eq(plannedOrder.orderNumber, before!.orderNumber))));
    expect(after).toEqual({ version: before!.version, changedAt: before!.changedAt });
  });

  it('draws two different numbers for two creates', async () => {
    const [left, right] = await Promise.all([
      createPlannedOrder({
        client: tenant.client, changedBy: ACTOR, requestKey: 'md11-parallel-a',
        materialNumber: 'FG-11', plant: '1000', quantity: '1', startDate: '2026-10-10', finishDate: '2026-10-11',
      }),
      createPlannedOrder({
        client: tenant.client, changedBy: ACTOR, requestKey: 'md11-parallel-b',
        materialNumber: 'FG-11', plant: '1000', quantity: '2', startDate: '2026-10-10', finishDate: '2026-10-12',
      }),
    ]);
    expect(left.order.orderNumber).not.toBe(right.order.orderNumber);
    expect(left.created && right.created).toBe(true);
  });
});

describe('MD11 firming is respected by planning', () => {
  it('does not let a later planning run overwrite the hand-created order', async () => {
    const client = tenant.client;
    const today = new Date().toISOString().slice(0, 10);
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'MRPRUN', subObject: '*', prefix: 'MR', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
    });
    await saveMaterialView({
      client, materialNumber: 'MD11-MAKE', changedBy: ACTOR, expectedVersion: 0,
      reason: 'Create test', view: 'BASIC', description: 'MD11 make', materialType: 'RAW',
      materialGroup: 'RAW', baseUnit: 'PC', industrySector: 'M', barcode: '',
      grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    });
    await saveMaterialView({
      client, materialNumber: 'MD11-MAKE', changedBy: ACTOR, expectedVersion: 0,
      reason: 'Create test', view: 'MRP', plant: '1000',
      mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: 'MAKE', lotSizing: 'EXACT',
      fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: '12', reorderPoint: '0',
      plannedDeliveryDays: 0, inHouseProductionDays: 0,
    });
    const created = await createPlannedOrder({
      client, changedBy: ACTOR, requestKey: 'md11-plan',
      materialNumber: 'MD11-MAKE', plant: '1000', quantity: '9', startDate: today, finishDate: today,
    });
    const run = await planMaterials({
      client, requestedBy: ACTOR, requestKey: 'md11-plan-run', processingKey: 'NETCH', plantFrom: '1000',
      materialFrom: 'MD11-MAKE', materialTo: 'MD11-MAKE',
    });
    expect(run.proposals.some((row) => row.action === 'CONFLICT' && row.documentNumber === created.order.orderNumber)).toBe(true);
    const [after] = await withTenant(client, (tx) => tx.select({
      quantity: plannedOrder.quantity, firmingStatus: plannedOrder.firmingStatus, origin: plannedOrder.origin,
    }).from(plannedOrder).where(and(eq(plannedOrder.client, client), eq(plannedOrder.orderNumber, created.order.orderNumber))));
    expect(after).toMatchObject({ quantity: '9.000', firmingStatus: 'FIRMED', origin: 'MANUAL' });
    const orders = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as count from production_order where client = ${client} and material_number = 'MD11-MAKE'
    `)) as unknown as Array<{ count: number }>;
    expect(orders[0]?.count).toBe(0);
  });
});
