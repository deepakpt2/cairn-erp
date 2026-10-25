import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { changeDocument } from '../src/platform/tables/audit-trail';
import { withTenant } from '../src/platform/db/client';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { productionOrder, productionOrderComponent } from '../src/modules/inventory/schema';
import { changeMaterialBom, createMaterialBom, getMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { createRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { productionOrderType, productionVersion } from '../src/modules/production/schema';
import {
  PRODUCTION_VERSION_CREATE_CAPABILITY,
  PRODUCTION_VERSION_DISPLAY_CAPABILITY,
  ProductionVersionError,
  changeProductionVersion,
  checkProductionVersion,
  copyProductionVersion,
  createProductionVersion,
  deleteProductionVersion,
  getProductionVersion,
  holdsProductionVersionAuthority,
  lockProductionVersion,
  saveProductionVersionRule,
  selectProductionVersion,
} from '../src/modules/production/production-version';
import { displayProductionVersion } from '../src/modules/production/production-version-display';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'C223_TEST';
let tenant: TestTenant;
let other: TestTenant;

async function materialOf(client: string, materialNumber: string, make: boolean) {
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Version test', view: 'BASIC', description: materialNumber, materialType: 'RAW',
    materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
    grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
  });
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Version test', view: 'PURCHASING', plant: '1000',
    purchasingGroup: '', orderUnit: 'KG', overdeliveryTolerance: '0',
    underdeliveryTolerance: '0', manufacturerPartNumber: '',
  });
  if (make) {
    await saveMaterialView({
      client, materialNumber, changedBy: ACTOR, expectedVersion: 1,
      reason: 'Version test', view: 'MRP', plant: '1000',
      mrpType: 'NONE', mrpController: '', procurementType: 'MAKE', lotSizing: 'EXACT',
      fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: '0', reorderPoint: '0',
      plannedDeliveryDays: 0, inHouseProductionDays: 0,
    });
  }
}

beforeAll(async () => {
  tenant = await createTenant('c223-version');
  other = await createTenant('c223-version-other');
  await materialOf(tenant.client, 'FG-1', true);
  await materialOf(tenant.client, 'COMP-1', false);
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
    items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'COMP-1', quantity: '2', unit: 'KG' }],
  });
  await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
  await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
  await saveRoutingControlKey({ client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Internal' });
  await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
  await createWorkCenter({
    client: tenant.client, changedBy: ACTOR, plant: '1000', workCenter: 'WC01', category: 'MACH', description: 'Assembly',
  });
  await createRouting({
    client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: '1000', usage: '1',
    routingGroup: '50000001', groupCounter: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
    assignments: [{ materialNumber: 'FG-1' }],
    operations: [{ operationNumber: '0010', shortText: 'Cut', workCenter: 'WC01', controlKey: 'PP01' }],
  });
});

afterAll(async () => {
  await destroyTenant(tenant.client);
  await destroyTenant(other.client);
  await closeDb();
});

function version(extra: Record<string, unknown> = {}) {
  return {
    client: tenant.client,
    changedBy: ACTOR,
    materialNumber: 'FG-1',
    plant: '1000',
    productionVersion: '0001',
    validFrom: '2026-01-01',
    lotFrom: '0',
    lotTo: '100',
    lotUnit: 'KG',
    bomUsage: 'P',
    bomAlternative: '01',
    taskListType: 'N',
    routingGroup: '50000001',
    groupCounter: '01',
    ...extra,
  };
}

describe('production version', () => {
  it('creates a version that names a BOM and a routing without copying them', async () => {
    const saved = await createProductionVersion(version({ description: 'Standard' }));
    expect(saved.productionVersion).toBe('0001');
    expect(saved.bomAlternative).toBe('01');
    expect(saved.routingGroup).toBe('50000001');
    expect(saved.groupCounter).toBe('01');
    expect(saved.checkStatus).toBe('1');
    expect(saved.stale).toBe(false);
    expect(saved.validTo).toBe('9999-12-31');
    expect(saved.findings).toHaveLength(0);
  });

  it('rejects a missing material, BOM, routing, date, unit, and duplicate', async () => {
    await expect(createProductionVersion(version({ productionVersion: '0009', materialNumber: 'MISSING' }))).rejects.toThrow(/MISSING/);
    await expect(createProductionVersion(version({ productionVersion: '0009', bomAlternative: '99' }))).rejects.toThrow(/does not exist/);
    await expect(createProductionVersion(version({ productionVersion: '0009', routingGroup: '99999999' }))).rejects.toThrow(/does not exist/);
    await expect(createProductionVersion(version({ productionVersion: '0009', validTo: '2025-01-01' }))).rejects.toThrow(/Valid-to is before/);
    await expect(createProductionVersion(version({ productionVersion: '0009', lotUnit: 'PC' }))).rejects.toThrow(/no conversion/);
    await expect(createProductionVersion(version())).rejects.toThrow(/already exists/);
    await expect(createProductionVersion(version({ productionVersion: '0009', changeNumber: '500000000001' }))).rejects.toThrow(/Engineering change management is not implemented/);
  });

  it('keeps two alternatives and does not pick the first of an overlap', async () => {
    await createProductionVersion(version({ productionVersion: '0002', lotFrom: '200', lotTo: '300' }));
    expect(await selectProductionVersion(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', keyDate: '2026-06-01', quantity: '10', unit: 'KG',
    })).toMatchObject({ productionVersion: '0001' });
    expect(await selectProductionVersion(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', keyDate: '2026-06-01', quantity: '250', unit: 'KG',
    })).toMatchObject({ productionVersion: '0002' });
    await expect(selectProductionVersion(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', keyDate: '2026-06-01', quantity: '150', unit: 'KG',
    })).rejects.toThrow(/No production version covers/);
    await createProductionVersion(version({ productionVersion: '0003' }));
    await expect(selectProductionVersion(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', keyDate: '2026-06-01', quantity: '10', unit: 'KG',
    })).rejects.toMatchObject({ code: 'AMBIGUOUS', remedy: expect.stringMatching(/first row was not selected/) });
    await saveProductionVersionRule({ client: tenant.client, changedBy: ACTOR, refuseOverlap: 'X' });
    await expect(createProductionVersion(version({ productionVersion: '0004' }))).rejects.toThrow(/already covers/);
    await saveProductionVersionRule({ client: tenant.client, changedBy: ACTOR, refuseOverlap: ' ' });
  });

  it('copies without the source identity and records a change', async () => {
    const source = await getProductionVersion(tenant.client, 'FG-1', '1000', '0001');
    const copied = await copyProductionVersion({ ...version(), newProductionVersion: '0005', requestKey: 'copy-1' });
    expect(copied.productionVersion).toBe('0005');
    expect(copied.requestKey).toBe('copy-1');
    expect(copied.version).toBe(1);
    const sourceAfter = await getProductionVersion(tenant.client, 'FG-1', '1000', '0001');
    expect(sourceAfter?.version).toBe(source?.version);
    const changed = await changeProductionVersion(version({ version: sourceAfter?.version, description: 'Changed' }));
    expect(changed.productionVersion).toBe('0001');
    expect(changed.description).toBe('Changed');
    expect(changed.version).toBe((sourceAfter?.version ?? 1) + 1);
    const rows = await withTenant(tenant.client, (tx) => tx.select().from(changeDocument).where(and(
      eq(changeDocument.client, tenant.client),
      eq(changeDocument.objectClass, 'production_version'),
      eq(changeDocument.objectKey, '1000/FG-1/0001'),
    )));
    expect(rows.some((row) => row.transactionCode === 'C223')).toBe(true);
  });

  it('refuses a stale update and does not write from display', async () => {
    const standing = await getProductionVersion(tenant.client, 'FG-1', '1000', '0001');
    const results = await Promise.allSettled([
      changeProductionVersion(version({ version: standing?.version, description: 'Left' })),
      changeProductionVersion(version({ version: standing?.version, description: 'Right' })),
    ]);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const [stamp] = await withTenant(tenant.client, (tx) => tx.select({
      version: productionVersion.version, changedAt: productionVersion.changedAt,
    }).from(productionVersion).where(and(eq(productionVersion.client, tenant.client), eq(productionVersion.productionVersion, '0001'))));
    const displayed = await displayProductionVersion(tenant.client, 'FG-1', '1000', '0001');
    expect(displayed?.version).toBe(stamp.version);
    const [after] = await withTenant(tenant.client, (tx) => tx.select({
      version: productionVersion.version, changedAt: productionVersion.changedAt,
    }).from(productionVersion).where(and(eq(productionVersion.client, tenant.client), eq(productionVersion.productionVersion, '0001'))));
    expect(after).toEqual(stamp);
    const source = readFileSync('src/modules/production/production-version-display.ts', 'utf8');
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    const page = readFileSync('src/app/production/production-version-display/page.tsx', 'utf8');
    expect(page).not.toMatch(/createProductionVersion|changeProductionVersion|checkProductionVersion/);
  });

  it('locks a version out of selection and refreshes a stale check', async () => {
    const standing = await getProductionVersion(tenant.client, 'FG-1', '1000', '0002');
    await lockProductionVersion(tenant.client, 'FG-1', '1000', '0002', ACTOR, true, standing?.version ?? 1);
    await expect(selectProductionVersion(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', keyDate: '2026-06-01', quantity: '250', unit: 'KG', productionVersion: '0002',
    })).rejects.toThrow(/locked/);
    const standingBom = await getMaterialBom(tenant.client, 'FG-1', '1000', 'P', '01');
    const bom = await changeMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-1', plant: '1000', usage: 'P', alternative: '01',
      version: standingBom?.version, baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01', headerText: 'After version',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'COMP-1', quantity: '2', unit: 'KG' }],
    });
    expect(bom.headerText).toBe('After version');
    const stale = await getProductionVersion(tenant.client, 'FG-1', '1000', '0001');
    expect(stale?.stale).toBe(true);
    await expect(selectProductionVersion(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', keyDate: '2026-06-01', quantity: '10', unit: 'KG', productionVersion: '0001',
    })).rejects.toThrow(/stale/);
    const checked = await checkProductionVersion(tenant.client, 'FG-1', '1000', '0001', ACTOR);
    expect(checked.stale).toBe(false);
    expect(checked.findings.length).toBeGreaterThanOrEqual(0);
  });

  it('does not rewrite a production order and does not remove a referenced version', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.insert(productionOrderType).values({
        client: tenant.client, orderType: 'PP01', description: 'Standard production', orderCategory: '10', createdBy: ACTOR,
      });
      await tx.insert(productionOrder).values({
        client: tenant.client, orderNumber: '000000000093', materialNumber: 'FG-1', plant: '1000',
        orderQuantity: '1', unitOfMeasure: 'KG', scheduledStart: '2026-01-01', scheduledFinish: '2026-01-02',
        orderType: 'PP01', createdBy: ACTOR,
      });
      await tx.insert(productionOrderComponent).values({
        client: tenant.client, orderNumber: '000000000093', itemNumber: 10, materialNumber: 'COMP-1',
        plant: '1000', requiredQuantity: '7', unitOfMeasure: 'KG', createdBy: ACTOR,
      });
    });
    const standing = await getProductionVersion(tenant.client, 'FG-1', '1000', '0001');
    await changeProductionVersion(version({ version: standing?.version, description: 'After order' }));
    const [componentRow] = await withTenant(tenant.client, (tx) => tx.select().from(productionOrderComponent).where(and(
      eq(productionOrderComponent.client, tenant.client), eq(productionOrderComponent.orderNumber, '000000000093'),
    )));
    expect(Number(componentRow.requiredQuantity)).toBe(7);
    const current = await getProductionVersion(tenant.client, 'FG-1', '1000', '0005');
    const removed = await deleteProductionVersion(tenant.client, 'FG-1', '1000', '0005', ACTOR, current?.version ?? 1);
    expect(removed.mode).toBe('DEACTIVATED');
    expect(await getProductionVersion(tenant.client, 'FG-1', '1000', '0005')).toMatchObject({ deletionFlag: 'X' });
    const orderSource = readFileSync('src/modules/inventory/production-orders.ts', 'utf8');
    const planningSource = readFileSync('src/modules/production/mrp-run.ts', 'utf8');
    expect(orderSource).not.toMatch(/selectProductionVersion/);
    expect(planningSource).not.toMatch(/selectProductionVersion/);
    expect(planningSource).toContain('explodePlannedSupply');
    expect(planningSource).toContain('A bill of material is selected through the production version. It is not entered.');
  });

  it('does not show another tenant the version and refuses costing', async () => {
    expect(await getProductionVersion(other.client, 'FG-1', '1000', '0001')).toBeNull();
    expect(holdsProductionVersionAuthority([PRODUCTION_VERSION_CREATE_CAPABILITY], 'CREATE')).toBe(true);
    expect(holdsProductionVersionAuthority([PRODUCTION_VERSION_CREATE_CAPABILITY], 'DISPLAY')).toBe(false);
    expect(holdsProductionVersionAuthority([PRODUCTION_VERSION_DISPLAY_CAPABILITY], 'DISPLAY')).toBe(true);
    expect(holdsProductionVersionAuthority([], 'DELETE')).toBe(false);
    await expect(selectProductionVersion(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', keyDate: '2026-06-01', quantity: '10', unit: 'KG', context: 'COSTING',
    })).rejects.toBeInstanceOf(ProductionVersionError);
  });
});
