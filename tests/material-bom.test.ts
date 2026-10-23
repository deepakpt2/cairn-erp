import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasCapability } from '../src/platform/auth/session';
import { changeDocument } from '../src/platform/tables/audit-trail';
import { withTenant } from '../src/platform/db/client';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { defineUomConversion } from '../src/modules/inventory/unit-conversion';
import { productionOrder, productionOrderComponent } from '../src/modules/inventory/schema';
import { materialBom } from '../src/modules/production/schema';
import {
  BOM_CHANGE_CAPABILITY,
  BOM_CREATE_CAPABILITY,
  BOM_DISPLAY_CAPABILITY,
  MaterialBomError,
  changeMaterialBom,
  createMaterialBom,
  getMaterialBom,
  holdsMaterialBomAuthority,
  listMaterialBoms,
  resolveMaterialBom,
  saveBomItemCategory,
  saveBomStatus,
  saveBomUsage,
  selectEffectiveMaterialBom,
} from '../src/modules/production/material-bom';
import { displayMaterialBom } from '../src/modules/production/material-bom-display';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'CS01_TEST';
let tenant: TestTenant;
let other: TestTenant;

async function materialOf(client: string, materialNumber: string) {
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'BOM test', view: 'BASIC', description: materialNumber, materialType: 'RAW',
    materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
    grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
  });
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'BOM test', view: 'PURCHASING', plant: '1000',
    purchasingGroup: '', orderUnit: 'KG', overdeliveryTolerance: '0',
    underdeliveryTolerance: '0', manufacturerPartNumber: '',
  });
}

beforeAll(async () => {
  tenant = await createTenant('cs01-material-bom');
  other = await createTenant('cs01-material-bom-other');
  await materialOf(tenant.client, 'FG-1');
  await materialOf(tenant.client, 'COMP-1');
  await materialOf(tenant.client, 'COMP-2');
  await materialOf(tenant.client, 'FG-2');
  await withTenant(tenant.client, (tx) => tx.execute(sql`
    insert into unit_of_measure (code, name, dimension, decimal_places)
    values ('CSB0', 'BOM each', 'COUNT', 0)
    on conflict (code) do update set decimal_places = 0
  `));
  await saveBomUsage({
    client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
    productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
  });
  await saveBomItemCategory({
    client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock',
    materialEntry: '+', quantityEntry: '+', allowFixedQuantity: 'X', allowBulk: 'X', allowPhantom: 'X',
  });
  await saveBomStatus({
    client: tenant.client, changedBy: ACTOR, status: '1', description: 'Active',
    releasedForCosting: 'X', releasedForOrders: 'X',
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
    materialNumber: 'FG-1',
    plant: '1000',
    usage: 'P',
    alternative: '01',
    baseQuantity: '1',
    baseUnit: 'KG',
    validFrom: '2026-01-01',
    ...extra,
  };
}

function component(extra: Record<string, unknown> = {}) {
  return {
    itemNumber: '0010',
    itemCategory: 'S',
    componentMaterial: 'COMP-1',
    quantity: '2',
    unit: 'KG',
    ...extra,
  };
}

describe('material BOM', () => {
  it('creates a BOM with two components and does not invent a usage', async () => {
    const saved = await createMaterialBom(header({
      headerText: 'Assembly',
      status: '1',
      items: [component(), component({ itemNumber: '0020', componentMaterial: 'COMP-2', quantity: '1' })],
    }));
    expect(saved.bomNumber).toMatch(/^[0-9]{8}$/);
    expect(saved.alternative).toBe('01');
    expect(saved.items).toHaveLength(2);
    expect(saved.items[0].itemNumber).toBe('0010');
    expect(saved.items[1].componentMaterial).toBe('COMP-2');
    expect(saved.validTo).toBe('9999-12-31');
    expect(saved.items[0].componentDescription).toBe('COMP-1');
  });

  it('refuses an unknown material, plant, usage, status, and item category', async () => {
    await expect(createMaterialBom(header({ materialNumber: 'MISSING', alternative: '02' }))).rejects.toThrow(/does not exist/);
    await expect(createMaterialBom(header({ plant: '9999', alternative: '02' }))).rejects.toThrow(/Plant 9999/);
    await expect(createMaterialBom(header({ usage: 'Z', alternative: '02' }))).rejects.toThrow(/not defined/);
    await expect(createMaterialBom(header({ status: '99', alternative: '02' }))).rejects.toThrow(/not defined/);
    await expect(createMaterialBom(header({
      alternative: '02',
      items: [component({ itemCategory: 'Q' })],
    }))).rejects.toThrow(/not defined/);
  });

  it('refuses a duplicate identity and does not open the first of several alternatives', async () => {
    await expect(createMaterialBom(header())).rejects.toBeInstanceOf(MaterialBomError);
    await createMaterialBom(header({ alternative: '02', headerText: 'Second' }));
    await expect(resolveMaterialBom(tenant.client, 'FG-1', '1000', 'P')).rejects.toThrow(/Choose an alternative/);
    const chosen = await resolveMaterialBom(tenant.client, 'FG-1', '1000', 'P', '02');
    expect(chosen?.headerText).toBe('Second');
  });

  it('refuses a quantity the unit cannot hold and a unit with no conversion', async () => {
    await expect(createMaterialBom(header({
      alternative: '03',
      baseUnit: 'CSB0',
      baseQuantity: '1.5',
    }))).rejects.toThrow(/decimal places/);
    await expect(createMaterialBom(header({
      alternative: '03',
      items: [component({ unit: 'CSB0', quantity: '1' })],
    }))).rejects.toThrow(/no conversion/);
    await defineUomConversion({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'COMP-1',
      alternativeUnit: 'CSB0', numerator: 1, denominator: 1,
    });
    const saved = await createMaterialBom(header({
      alternative: '03',
      items: [component({ unit: 'CSB0', quantity: '1' })],
    }));
    expect(saved.items[0].unit).toBe('CSB0');
    expect(Number(saved.items[0].quantity)).toBe(1);
  });

  it('refuses an inverted validity interval and scrap above the column', async () => {
    await expect(createMaterialBom(header({
      alternative: '04', validFrom: '2026-02-01', validTo: '2026-01-01',
    }))).rejects.toThrow(/before valid-from/);
    await expect(createMaterialBom(header({
      alternative: '04',
      items: [component({ scrapPercent: '1000' })],
    }))).rejects.toThrow(/not clamped/);
  });

  it('changes a header and an item without renumbering, and keeps an omitted item', async () => {
    const changed = await changeMaterialBom(header({
      version: 1,
      headerText: 'Changed',
      items: [component({ quantity: '4' })],
    }));
    expect(changed.headerText).toBe('Changed');
    expect(changed.version).toBe(2);
    expect(changed.items.find((item) => item.itemNumber === '0010')?.quantity).toBeTruthy();
    expect(Number(changed.items.find((item) => item.itemNumber === '0010')?.quantity)).toBe(4);
    const omitted = changed.items.find((item) => item.itemNumber === '0020');
    expect(omitted?.deletionFlag).toBe('X');
    expect(omitted?.componentMaterial).toBe('COMP-2');
  });

  it('refuses a stale version and a repeated request does not create a second BOM', async () => {
    await expect(changeMaterialBom(header({ version: 1, headerText: 'Lost' }))).rejects.toThrow(/someone else/);
    expect((await getMaterialBom(tenant.client, 'FG-1', '1000', 'P', '01'))?.headerText).toBe('Changed');
    const first = await createMaterialBom(header({
      materialNumber: 'FG-2', alternative: '01', requestKey: 'CS01-ONCE', items: [component()],
    }));
    const replay = await createMaterialBom(header({
      materialNumber: 'FG-2', alternative: '09', requestKey: 'CS01-ONCE', headerText: 'Should not apply',
    }));
    expect(replay.alternative).toBe(first.alternative);
    expect(replay.headerText).not.toBe('Should not apply');
    expect(replay.warnings.some((warning) => /already saved/.test(warning))).toBe(true);
  });

  it('rolls back when a child write fails, and an invalid item leaves no header', async () => {
    await expect(withTenant(tenant.client, async (tx) => {
      await tx.insert(materialBom).values({
        client: tenant.client, materialNumber: 'FG-1', plant: '1000', usage: 'P', alternative: '90',
        bomNumber: '00000990', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01', validTo: '9999-12-31',
        createdBy: ACTOR,
      });
      throw new Error('child write failed');
    })).rejects.toThrow('child write failed');
    expect(await getMaterialBom(tenant.client, 'FG-1', '1000', 'P', '90')).toBeNull();
    await expect(createMaterialBom(header({
      alternative: '91',
      items: [component(), component({ itemNumber: '0020', itemCategory: 'Q' })],
    }))).rejects.toThrow(/not defined/);
    expect(await getMaterialBom(tenant.client, 'FG-1', '1000', 'P', '91')).toBeNull();
  });

  it('warns on a direct self-reference and a cycle, and still saves', async () => {
    const self = await createMaterialBom(header({
      materialNumber: 'FG-2', alternative: '02', items: [component({ componentMaterial: 'FG-2' })],
    }));
    expect(self.warnings.some((warning) => /circular/.test(warning))).toBe(true);
    await createMaterialBom(header({
      materialNumber: 'COMP-1', alternative: '01', items: [component({ componentMaterial: 'COMP-2' })],
    }));
    const cycle = await createMaterialBom(header({
      materialNumber: 'COMP-2', alternative: '01', items: [component({ componentMaterial: 'COMP-1' })],
    }));
    expect(cycle.warnings.some((warning) => /circular/.test(warning))).toBe(true);
  });

  it('refuses a change number and a blank plant', async () => {
    await expect(createMaterialBom(header({ alternative: '05', changeNumber: 'ECN1' }))).rejects.toThrow(/not implemented/);
    await expect(createMaterialBom(header({ plant: ' ', alternative: '05' }))).rejects.toThrow(/Plant is required/);
  });

  it('display reads the BOM and does not change its version', async () => {
    const before = await getMaterialBom(tenant.client, 'FG-1', '1000', 'P', '01');
    const shown = await displayMaterialBom(tenant.client, 'FG-1', '1000', 'P', '01');
    const after = await getMaterialBom(tenant.client, 'FG-1', '1000', 'P', '01');
    expect(shown?.items.map((item) => item.itemNumber)).toEqual(before?.items.map((item) => item.itemNumber));
    expect(after?.version).toBe(before?.version);
    const displaySource = readFileSync('src/modules/production/material-bom-display.ts', 'utf8');
    const displayPage = readFileSync('src/app/production/bom-display/page.tsx', 'utf8');
    expect(displaySource).not.toMatch(/\.(insert|update|delete)\(/);
    expect(displayPage).not.toMatch(/saveBomAction|openChangeForSession/);
  });

  it('keeps another tenant from reading this BOM', async () => {
    expect(await getMaterialBom(other.client, 'FG-1', '1000', 'P', '01')).toBeNull();
    expect(holdsMaterialBomAuthority(['PROD.*'], 'CREATE')).toBe(true);
    expect(holdsMaterialBomAuthority(['PROD.ORDER.CREATE'], 'CHANGE')).toBe(false);
    expect(hasCapability(['PROD.BOM.DISPLAY'], BOM_DISPLAY_CAPABILITY)).toBe(true);
    expect(hasCapability(['PROD.BOM.CREATE'], BOM_CHANGE_CAPABILITY)).toBe(false);
    expect(BOM_CREATE_CAPABILITY).toBe('PROD.BOM.CREATE');
  });

  it('records create and change history', async () => {
    const rows = await withTenant(tenant.client, (tx) => tx.select().from(changeDocument).where(and(
      eq(changeDocument.client, tenant.client),
      eq(changeDocument.objectClass, 'material_bom'),
      eq(changeDocument.objectKey, '1000/FG-1/P/01'),
    )));
    expect(rows.some((row) => row.changeType === 'CREATE' && row.transactionCode === 'CS01')).toBe(true);
    expect(rows.some((row) => row.changeType === 'CHANGE' && row.transactionCode === 'CS02')).toBe(true);
  });

  it('selects the effective BOM for a key date and exposes quantities without posting', async () => {
    const inside = await selectEffectiveMaterialBom(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', usage: 'P', alternative: '01', keyDate: '2026-06-01', forUse: 'COSTING',
    });
    expect(inside?.items.some((item) => item.itemNumber === '0010' && Number(item.quantity) === 4)).toBe(true);
    expect(await selectEffectiveMaterialBom(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', usage: 'P', alternative: '01', keyDate: '2025-01-01',
    })).toBeNull();
    await expect(selectEffectiveMaterialBom(tenant.client, {
      materialNumber: 'FG-1', plant: '1000', usage: 'P', alternative: '01', keyDate: '2026-06-01', forUse: 'MRP',
    })).rejects.toThrow(/not released for MRP/);
  });

  it('does not rewrite a production-order component when the BOM changes', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.insert(productionOrder).values({
        client: tenant.client, orderNumber: '000000000091', materialNumber: 'FG-1', plant: '1000',
        orderQuantity: '1', unitOfMeasure: 'KG', scheduledStart: '2026-01-01', scheduledFinish: '2026-01-02',
        createdBy: ACTOR,
      });
      await tx.insert(productionOrderComponent).values({
        client: tenant.client, orderNumber: '000000000091', itemNumber: 10, materialNumber: 'COMP-1',
        plant: '1000', requiredQuantity: '7', unitOfMeasure: 'KG', createdBy: ACTOR,
      });
    });
    const standing = await getMaterialBom(tenant.client, 'FG-1', '1000', 'P', '01');
    await changeMaterialBom(header({ version: standing?.version, headerText: 'After order', items: [component({ quantity: '9' })] }));
    const [componentRow] = await withTenant(tenant.client, (tx) => tx.select().from(productionOrderComponent).where(and(
      eq(productionOrderComponent.client, tenant.client),
      eq(productionOrderComponent.orderNumber, '000000000091'),
    )));
    expect(Number(componentRow.requiredQuantity)).toBe(7);
    const columns = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'production_order' and column_name in ('bom_number', 'work_center')
    `));
    expect(columns).toHaveLength(0);
  });

  it('one of two overlapping saves is refused', async () => {
    const standing = await getMaterialBom(tenant.client, 'FG-1', '1000', 'P', '02');
    const results = await Promise.allSettled([
      changeMaterialBom(header({ alternative: '02', version: standing?.version, headerText: 'Left' })),
      changeMaterialBom(header({ alternative: '02', version: standing?.version, headerText: 'Right' })),
    ]);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const after = await getMaterialBom(tenant.client, 'FG-1', '1000', 'P', '02');
    expect(['Left', 'Right']).toContain(after?.headerText);
    expect(after?.version).toBe((standing?.version ?? 1) + 1);
  });
});
