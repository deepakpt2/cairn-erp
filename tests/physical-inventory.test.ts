import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  PHYSICAL_INVENTORY_CANCEL_CAPABILITY,
  PHYSICAL_INVENTORY_CREATE_CAPABILITY,
  PhysicalInventoryError,
  cancelPhysicalInventory,
  createPhysicalInventory,
  listPhysicalInventory,
} from '../src/modules/inventory/physical-inventory';
import { postTransfer, TransferPostingError } from '../src/modules/inventory/transfer-posting';
import { postGoodsIssue, GoodsIssueError } from '../src/modules/inventory/goods-issue';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * SCR-142 / MI01 — the count document, and the block that has to be real.
 *
 * A count moves nothing; a count with a posting block refuses the movements of the materials
 * it names until it is done or cancelled. Both halves are asserted here, the second against
 * the posting services themselves rather than against a flag.
 */
const ACTOR = 'SCR142_PI_TEST';
const PLANT = 'QP01';
const COMPANY = '1000';

describe('SCR-142 physical inventory document (MI01)', () => {
  let fx: TestTenant;
  let client = '';

  const create = (overrides: Record<string, unknown> = {}) => createPhysicalInventory({
    client, createdBy: ACTOR, plant: PLANT, storageLocation: 'SP01',
    plannedCountDate: '2026-10-20', postingBlock: true,
    materials: ['PI-MAT'], requestKey: `pi-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  } as Parameters<typeof createPhysicalInventory>[0]);

  beforeAll(async () => {
    fx = await createTenant('scr142-pi');
    client = fx.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, v.n, v.d, t.material_type, 'PC', ${ACTOR}
        from (values ('PI-MAT', 'Counted material'), ('PI-OTHER', 'Not counted')) as v(n, d)
        cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${client}, ${PLANT}, 'Count plant', c.company_code, 'KW', ${ACTOR}
        from (select company_code from company_code where client = ${client} order by company_code limit 1) c
        on conflict (client, plant) do update set company_code = excluded.company_code
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        select ${client}, v.n, ${PLANT}, ${ACTOR}
        from (values ('PI-MAT'), ('PI-OTHER')) as v(n)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${client}, ${PLANT}, 'SP01', 'Count store', true, false, ${ACTOR}),
               (${client}, ${PLANT}, 'SP02', 'Other store', true, false, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        select ${client}, v.n, ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, c.currency, 100, 1000, ${ACTOR}
        from (values ('PI-MAT'), ('PI-OTHER')) as v(n)
        cross join (select currency from company_code where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        select ${client}, v.n, ${PLANT}, 'SP01', 'UNRESTRICTED', 100, ${ACTOR}
        from (values ('PI-MAT'), ('PI-OTHER')) as v(n)
        on conflict (client, material_number, plant, storage_location, stock_type) do update set quantity = 100
      `);
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
        select ${client}, c.chart_of_accounts, v.n, v.d, v.t,
               v.balance, false, null, false, false, 'GENL', v.kind, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values
          ('124960', 'Counted inventory', 'ASSET', true, 'BALANCE_SHEET'),
          ('595960', 'Scrapping', 'EXPENSE', false, 'PL_STATEMENT')
        ) as v(n, d, t, balance, kind)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        select ${client}, c.chart_of_accounts, v.e, 'RAW_INVENTORY', '', v.a, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values ('INVENTORY', '124960'), ('SCRAP', '595960')) as v(e, a)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        select ${client}, c.company_code, 2026, 10, 2026, 9, true, ${ACTOR}
        from (select company_code from company_code where client = ${client} limit 1) c
        on conflict (client, company_code) do update set current_fiscal_year = 2026, current_period = 10
      `);
    });
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'PHYINV', subObject: '*', prefix: 'PI', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: 'MD', numberLength: 8, createdBy: ACTOR });
      await defineRange(tx, {
        client, objectCode: 'RF_BELEG', companyCode: COMPANY, subObject: 'GENERAL',
        fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: ACTOR,
      });
    });
  }, 180_000);

  afterAll(async () => {
    if (client) await destroyTenant(client);
  }, 180_000);

  it('names its capabilities and SAP’s codes as aliases', () => {
    expect(PHYSICAL_INVENTORY_CREATE_CAPABILITY).toBe('INV.PHYINV.CREATE');
    expect(PHYSICAL_INVENTORY_CANCEL_CAPABILITY).toBe('INV.PHYINV.CANCEL');
  });

  it('draws a document number and carries the plant’s company code, derived', async () => {
    const view = await create();
    expect(view.inventoryDocumentNumber).toBe('PI-2026-0000001');
    expect(view.companyCode).toBe(COMPANY);
    expect(view.fiscalYear).toBe(2026);
    expect(view.status).toBe('CREATED');
    expect(view.postingBlock).toBe(true);
    expect(view.items.map((i) => i.materialNumber)).toEqual(['PI-MAT']);

    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
       where table_name = 'physical_inventory_document'
    `)) as unknown as Array<{ column_name: string }>;
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('company_code');
    expect(names).not.toContain('is_counted');
    expect(names).not.toContain('batch');
    expect(names).not.toContain('special_stock');
  });

  it('counts a whole plant when no storage location is named', async () => {
    const view = await create({ storageLocation: undefined });
    expect(view.storageLocation).toBeNull();
  });

  it('reads the stock the count will be measured against, and moves none of it', async () => {
    const view = await create();
    expect(view.items[0].stockQuantity).toBe('100.000');
    expect(view.items[0].unit).toBe('PC');

    const after = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select quantity::text from stock_quantity where client = ${client}
          and material_number = 'PI-MAT' and plant = ${PLANT} and storage_location = 'SP01') as stock,
        (select stock_value::text from material_valuation where client = ${client}
          and material_number = 'PI-MAT' and valuation_area = ${PLANT}) as value,
        (select count(*)::int from material_document where client = ${client}) as documents,
        (select count(*)::int from journal_entry where client = ${client}) as journals
    `)) as unknown as Array<{ stock: string; value: string; documents: number; journals: number }>;
    expect(Number(after[0].stock)).toBe(100);
    expect(Number(after[0].value)).toBe(1000);
    expect(after[0].documents).toBe(0);
    expect(after[0].journals).toBe(0);
  });

  it('refuses a material named twice, an empty count, a missing plant and a foreign location', async () => {
    await expect(create({ materials: ['PI-MAT', 'PI-MAT'] }))
      .rejects.toThrow(/appears twice/);
    await expect(create({ materials: [] }))
      .rejects.toThrow(/at least one material/);
    await expect(create({ plant: 'ZZZZ' }))
      .rejects.toThrow(/Plant ZZZZ does not exist/);
    await expect(create({ storageLocation: 'ZZZZ' }))
      .rejects.toThrow(/does not stand in plant/);
  });

  it('refuses a material that was never extended to the plant', async () => {
    await withTenant(client, (tx) => tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'PI-EXT', 'Not extended', t.material_type, 'PC', ${ACTOR}
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `));
    await expect(create({ materials: ['PI-EXT'] }))
      .rejects.toThrow(/is not extended to plant/);
  });

  it('refuses a count date outside the open period', async () => {
    await expect(create({ plannedCountDate: '2025-03-01' }))
      .rejects.toThrow(/is not a date|period/i);
  });

  it('blocks the transfer of a counted material, naming the count', async () => {
    // The document created in the first test still stands, blocking PI-MAT in QP01/SP01.
    const error = await postTransfer({
      client, changedBy: ACTOR, movementTypeCode: '311',
      materialNumber: 'PI-MAT', quantity: 5,
      issuingPlant: PLANT, issuingStorageLocation: 'SP01',
      receivingPlant: PLANT, receivingStorageLocation: 'SP02',
      postingDate: '2026-10-20', documentDate: '2026-10-20',
      requestKey: 'block-311',
    }).catch((e: unknown) => e as TransferPostingError);
    expect(error).toBeInstanceOf(TransferPostingError);
    expect(error.message).toMatch(/blocks postings for material PI-MAT in plant QP01/);
  });

  it('blocks a goods issue of the counted material, and lets another material through', async () => {
    const blocked = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '551',
      postingDate: '2026-10-20', documentDate: '2026-10-20',
      lines: [{ materialNumber: 'PI-MAT', plant: PLANT, storageLocation: 'SP01', quantity: 1 }],
      requestKey: 'block-551',
    }).catch((e: unknown) => e as GoodsIssueError);
    expect(blocked.message).toMatch(/blocks postings/);

    const allowed = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '551',
      postingDate: '2026-10-20', documentDate: '2026-10-20',
      lines: [{ materialNumber: 'PI-OTHER', plant: PLANT, storageLocation: 'SP01', quantity: 1 }],
      requestKey: 'allow-551',
    });
    expect(allowed.materialDocumentNumber).toMatch(/^MD-/);
  });

  it('blocks nothing when the document carries no posting block', async () => {
    await create({ postingBlock: false, materials: ['PI-OTHER'] });
    const posted = await postTransfer({
      client, changedBy: ACTOR, movementTypeCode: '311',
      materialNumber: 'PI-OTHER', quantity: 1,
      issuingPlant: PLANT, issuingStorageLocation: 'SP01',
      receivingPlant: PLANT, receivingStorageLocation: 'SP02',
      postingDate: '2026-10-20', documentDate: '2026-10-20',
      requestKey: 'no-block-311',
    });
    expect(posted.materialDocumentNumber).toMatch(/^MD-/);
  });

  it('cancels an uncounted document, releasing its block', async () => {
    const view = await create({ materials: ['PI-OTHER'] });
    const cancelled = await cancelPhysicalInventory({
      client, changedBy: ACTOR,
      inventoryDocumentNumber: view.inventoryDocumentNumber, fiscalYear: view.fiscalYear,
    });
    expect(cancelled.status).toBe('CANCELLED');

    const transfer = await postTransfer({
      client, changedBy: ACTOR, movementTypeCode: '311',
      materialNumber: 'PI-OTHER', quantity: 2,
      issuingPlant: PLANT, issuingStorageLocation: 'SP01',
      receivingPlant: PLANT, receivingStorageLocation: 'SP02',
      postingDate: '2026-10-20', documentDate: '2026-10-20',
      requestKey: 'after-cancel-311',
    });
    expect(transfer.materialDocumentNumber).toMatch(/^MD-/);
  });

  it('records both acts in the change document and lists a plant’s documents', async () => {
    const listed = await listPhysicalInventory(client, { plant: PLANT });
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((v) => v.plant === PLANT)).toBe(true);

    const changes = await withTenant(client, (tx) => tx.execute(sql`
      select change_type as action, count(*)::int as n from change_document
       where client = ${client} and object_class = 'physical_inventory_document'
       group by action order by action
    `)) as unknown as Array<{ action: string; n: number }>;
    expect(changes.find((c) => c.action === 'CREATE')?.n).toBeGreaterThan(0);
    expect(changes.find((c) => c.action === 'CHANGE')?.n).toBeGreaterThan(0);
  });

  it('replays a request key instead of making a second document', async () => {
    const key = 'pi-replay-1';
    const first = await create({ requestKey: key });
    const second = await create({ requestKey: key });
    expect(second.inventoryDocumentNumber).toBe(first.inventoryDocumentNumber);
    const counted = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from physical_inventory_document
       where client = ${client} and request_key = ${key}
    `)) as unknown as Array<{ n: number }>;
    expect(counted[0].n).toBe(1);
  });

  it('refuses to cancel a document that does not exist', async () => {
    await expect(cancelPhysicalInventory({
      client, changedBy: ACTOR, inventoryDocumentNumber: 'PI-9999999', fiscalYear: 2026,
    })).rejects.toBeInstanceOf(PhysicalInventoryError);
  });
});
