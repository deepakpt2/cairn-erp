import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { changeOrder, createOrder } from '../src/modules/purchasing/orders';
import { displayPurchaseOrder } from '../src/modules/purchasing/purchase-order-display';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { createBatch } from '../src/modules/inventory/batch-master';
import { closeDb, createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'PO_BATCH_DISPLAY_TEST';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

async function standing(seed: string): Promise<string> {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  const client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
      values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V10000', 'ORGANIZATION', 'Test Supplier', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
      values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
      values (${client}, 'MAT-BATCH', 'Batch material', 'RAW', 'PC', true, ${ACTOR}),
             (${client}, 'MAT-PLAIN', 'Plain material', 'RAW', 'PC', false, ${ACTOR})
      on conflict (client, material_number) do update set batch_managed = excluded.batch_managed
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'MAT-BATCH', '1000', ${ACTOR}),
             (${client}, 'MAT-PLAIN', '1000', ${ACTOR})
    `);
  });
  await initializeMaterialPeriodControl({
    client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Order display',
  });
  await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
  return client;
}

function item(materialNumber: string, batch: string, quantity = 4) {
  return {
    materialNumber, shortText: materialNumber, quantity, unit: 'PC',
    netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '0001', batch,
    markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity }], assignments: [],
  };
}

describe('purchase order batch display', () => {
  it('shows the stored batch and a change keeps it', async () => {
    const client = await standing('po-batch-display');
    await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00012', reason: 'Order batch',
    });
    const created = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [item('MAT-BATCH', '00012'), item('MAT-PLAIN', '')],
    });
    const shown = await displayPurchaseOrder(client, created.orderNumber);
    expect(shown.found).toBe(true);
    if (!shown.found) return;
    expect(shown.order.items.find((row) => row.itemNumber === 10)?.batch).toBe('00012');
    expect(shown.order.items.find((row) => row.itemNumber === 20)?.batch).toBe('');

    await changeOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '', orderNumber: created.orderNumber,
      items: [{ ...item('MAT-BATCH', '00012', 5), itemNumber: 10 }],
    });
    const kept = await displayPurchaseOrder(client, created.orderNumber);
    expect(kept.found).toBe(true);
    if (!kept.found) return;
    expect(kept.order.items.find((row) => row.itemNumber === 10)?.batch).toBe('00012');
    expect(kept.order.items.find((row) => row.itemNumber === 10)?.orderedQuantity).toMatch(/^5/);

    await expect(changeOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '', orderNumber: created.orderNumber,
      items: [{ ...item('MAT-BATCH', 'MISSING', 5), itemNumber: 10 }],
    })).rejects.toThrow(/does not stand/i);
    const unchanged = await displayPurchaseOrder(client, created.orderNumber);
    expect(unchanged.found).toBe(true);
    if (!unchanged.found) return;
    expect(unchanged.order.items.find((row) => row.itemNumber === 10)?.batch).toBe('00012');
  });

  it('prints the batch and does not offer a field that could change it', () => {
    const page = readFileSync('src/app/purchasing/purchase-order-display/page.tsx', 'utf8');
    expect(page).toContain('item.batch');
    expect(page).toContain('Batch ${item.batch}');
    expect(page).not.toContain('name="batch"');
    expect(page).not.toContain('name={`batch-');
  });
});
