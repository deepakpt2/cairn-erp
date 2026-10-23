import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { defineUomConversion } from '../src/modules/inventory/unit-conversion';
import {
  TransferPostingError,
  postTransfer,
  reverseTransfer,
  type PostTransferInput,
} from '../src/modules/inventory/transfer-posting';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

/**
 * SCR-131 / MB1B acceptance for INV.TRANSFER.POST.
 *
 * The suite pins the three transfer scenarios (311 storage location, 301 plant,
 * 321 stock type), the two-line document with its issuing and receiving sides,
 * the sufficiency rule with the configured negative, the value a plant move
 * carries and the price difference a standard-priced receiver posts, the
 * refusals by name, the closed period, the replay, and the counter-movement
 * reversal that is the only correction a posted transfer allows.
 */
describe('SCR-131 transfer posting (MB1B)', () => {
  const ACTOR = 'SCR131_MB1B_TEST';
  const DAY = '2026-10-15';
  const VALUATION_CLASS = 'RAW_INVENTORY';
  let client = '';
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let key = 0;

  const nextKey = () => `scr131-${++key}`;

  async function stock(mat: string, plant: string, location: string, type: string): Promise<number> {
    return withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select quantity from stock_quantity
        where client = ${client} and material_number = ${mat} and plant = ${plant}
          and storage_location = ${location} and stock_type = ${type}
      `) as unknown as Array<{ quantity: string }>;
      return rows[0] ? Number(rows[0].quantity) : 0;
    });
  }

  async function valuation(plant: string, mat = 'MAT-TR'): Promise<{ quantity: number; value: number }> {
    return withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select total_stock_quantity, stock_value from material_valuation
        where client = ${client} and material_number = ${mat} and valuation_area = ${plant}
      `) as unknown as Array<{ total_stock_quantity: string; stock_value: string }>;
      return { quantity: Number(rows[0].total_stock_quantity), value: Number(rows[0].stock_value) };
    });
  }

  const transfer = (overrides: Partial<PostTransferInput>): PostTransferInput => ({
    client,
    changedBy: ACTOR,
    movementTypeCode: '311',
    materialNumber: 'MAT-TR',
    quantity: 30,
    issuingPlant: '1000',
    issuingStorageLocation: '0001',
    receivingPlant: '1000',
    receivingStorageLocation: '0002',
    postingDate: DAY,
    documentDate: DAY,
    requestKey: nextKey(),
    ...overrides,
  });

  beforeAll(async () => {
    tenant = await createTenant('scr131-mb1b');
    client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(client, async (tx) => {
      await defineRange(tx, {
        client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into company_code (client, company_code, name, country, currency, chart_of_accounts, created_by)
        select ${client}, '2000', 'Second company', 'KW', ${tenant.currency}, c.chart_of_accounts, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by) values
          (${client}, '2000', 'Plant Two', '1000', 'KW', ${ACTOR}),
          (${client}, '3000', 'Plant Three', '2000', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by) values
          (${client}, '1000', '0001', 'Main store', false, true, ${ACTOR}),
          (${client}, '1000', '0002', 'Second store', false, true, ${ACTOR}),
          (${client}, '1000', '0003', 'Open store', true, true, ${ACTOR}),
          (${client}, '1000', '0004', 'Third store', false, true, ${ACTOR}),
          (${client}, '1000', '0099', 'Blocked store', false, false, ${ACTOR}),
          (${client}, '2000', '0001', 'Plant two store', false, true, ${ACTOR})
        on conflict (client, plant, storage_location) do update set
          allow_negative_stock = excluded.allow_negative_stock, is_active = excluded.is_active
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-TR', 'Transferred material', 'RAW', 'PC', ${ACTOR}
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-STD', 'Standard-priced material', 'RAW', 'PC', ${ACTOR}
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by) values
          (${client}, 'MAT-TR', '1000', ${ACTOR}), (${client}, 'MAT-TR', '2000', ${ACTOR}),
          (${client}, 'MAT-STD', '1000', ${ACTOR}), (${client}, 'MAT-STD', '2000', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by) values
          (${client}, 'MAT-TR', '1000', ${VALUATION_CLASS}, 'MOVING_AVERAGE', 0, 10, 1, ${tenant.currency}, 100, 1000, ${ACTOR}),
          (${client}, 'MAT-TR', '2000', ${VALUATION_CLASS}, 'MOVING_AVERAGE', 0, 10, 1, ${tenant.currency}, 0, 0, ${ACTOR}),
          (${client}, 'MAT-STD', '1000', ${VALUATION_CLASS}, 'MOVING_AVERAGE', 0, 10, 1, ${tenant.currency}, 30, 300, ${ACTOR}),
          (${client}, 'MAT-STD', '2000', ${VALUATION_CLASS}, 'STANDARD', 20, 0, 1, ${tenant.currency}, 0, 0, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by) values
          (${client}, 'CA01', 'INVENTORY', ${VALUATION_CLASS}, '', '120000', ${ACTOR}),
          (${client}, 'CA01', 'PRICE_DIFFERENCE', ${VALUATION_CLASS}, '', '300000', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        values (${client}, '1000', 2026, 10, 2026, 9, true, ${ACTOR})
        on conflict (client, company_code) do update set
          current_fiscal_year = 2026, current_period = 10,
          previous_fiscal_year = 2026, previous_period = 9, allow_backposting = true
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
          (${client}, 'MAT-TR', '1000', '0001', 'UNRESTRICTED', 100, ${ACTOR}),
          (${client}, 'MAT-TR', '1000', '0001', 'QUALITY', 40, ${ACTOR}),
          (${client}, 'MAT-TR', '1000', '0002', 'UNRESTRICTED', 0, ${ACTOR}),
          (${client}, 'MAT-STD', '1000', '0001', 'UNRESTRICTED', 30, ${ACTOR})
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('posts a 311 as two lines and moves stock between storage locations without a journal', async () => {
    const before = await stock('MAT-TR', '1000', '0001', 'UNRESTRICTED');
    const doc = await postTransfer(transfer({ quantity: 30 }));

    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[0].lineDirection).toBe('ISSUE');
    expect(doc.lines[0].storageLocation).toBe('0001');
    expect(doc.lines[1].lineDirection).toBe('RECEIPT');
    expect(doc.lines[1].storageLocation).toBe('0002');
    expect(doc.lines[0].movementType).toBe('TRANSFER_SLOC');
    expect(doc.lines[0].quantity).toBe('30.000');
    expect(doc.journalDocumentNumber).toBeNull();
    expect(await stock('MAT-TR', '1000', '0001', 'UNRESTRICTED')).toBe(before - 30);
    expect(await stock('MAT-TR', '1000', '0002', 'UNRESTRICTED')).toBe(30);
  });

  it('refuses a 311 whose two sides name the same storage location', async () => {
    await expect(postTransfer(transfer({ receivingStorageLocation: '0001' })))
      .rejects.toThrow(/both sides name 0001/);
  });

  it('refuses a quantity the issuing location does not carry, naming what stands', async () => {
    const error = await postTransfer(transfer({ quantity: 5000 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransferPostingError);
    expect((error as TransferPostingError).message).toMatch(/is 70\.000, short of the 5000\.000/);
    expect((error as TransferPostingError).remedy).toMatch(/release negative stock/);
  });

  it('moves quality stock to unrestricted in one storage location with a 321', async () => {
    const doc = await postTransfer(transfer({
      movementTypeCode: '321', quantity: 15, receivingStorageLocation: '0001',
    }));
    expect(doc.lines[0].stockType).toBe('QUALITY');
    expect(doc.lines[1].stockType).toBe('UNRESTRICTED');
    expect(await stock('MAT-TR', '1000', '0001', 'QUALITY')).toBe(25);
    expect(await stock('MAT-TR', '1000', '0001', 'UNRESTRICTED')).toBe(85);
  });

  it('refuses a 321 that names two different storage locations', async () => {
    await expect(postTransfer(transfer({
      movementTypeCode: '321', receivingStorageLocation: '0002',
    }))).rejects.toThrow(/inside one storage location/);
  });

  it('carries quantity and value between plants with a 301 and posts no journal when the prices agree', async () => {
    const beforeIssuing = await valuation('1000');
    const beforeReceiving = await valuation('2000');
    const doc = await postTransfer(transfer({
      movementTypeCode: '301', quantity: 10, receivingPlant: '2000', receivingStorageLocation: '0001',
    }));
    expect(doc.journalDocumentNumber).toBeNull();
    expect(doc.lines[0].value).toBe('100.0000');
    expect(doc.lines[1].value).toBe('100.0000');
    expect((await valuation('1000')).quantity).toBe(beforeIssuing.quantity - 10);
    expect((await valuation('2000')).quantity).toBe(beforeReceiving.quantity + 10);
    expect((await valuation('2000')).value).toBe(beforeReceiving.value + 100);
    expect(await stock('MAT-TR', '2000', '0001', 'UNRESTRICTED')).toBe(10);
  });

  it('posts the price difference when the receiving plant prices standard', async () => {
    const doc = await postTransfer(transfer({
      materialNumber: 'MAT-STD', movementTypeCode: '301', quantity: 10,
      receivingPlant: '2000', receivingStorageLocation: '0001',
    }));
    // 10 at the issuing moving average of 10 = 100 transferred, valued at 20 standard = 200.
    expect(doc.lines[0].value).toBe('100.0000');
    expect(doc.lines[1].value).toBe('200.0000');
    expect(doc.journalDocumentNumber).not.toBeNull();
    expect(await stock('MAT-STD', '2000', '0001', 'UNRESTRICTED')).toBe(10);
    expect((await valuation('2000', 'MAT-STD')).value).toBe(200);
  });

  it('refuses a 301 into the same plant and a 311 into another plant', async () => {
    await expect(postTransfer(transfer({ movementTypeCode: '301' })))
      .rejects.toThrow(/both sides name plant 1000/);
    await expect(postTransfer(transfer({ receivingPlant: '2000', receivingStorageLocation: '0001' })))
      .rejects.toThrow(/moves inside one plant/);
  });

  it('refuses an unknown movement type and a counter movement type by name', async () => {
    await expect(postTransfer(transfer({ movementTypeCode: '101' })))
      .rejects.toThrow(/101 is not a transfer/);
    const counter = await postTransfer(transfer({ movementTypeCode: '312' })).catch((e: unknown) => e);
    expect((counter as TransferPostingError).message).toMatch(/312 is the counter of 311/);
    expect((counter as TransferPostingError).remedy).toMatch(/Reverse the transfer document/);
  });

  it('refuses a storage location of another plant, an inactive one and a missing one', async () => {
    await expect(postTransfer(transfer({
      movementTypeCode: '301', receivingPlant: '2000', receivingStorageLocation: '0002',
    }))).rejects.toThrow(/Storage location 0002 does not stand in plant 2000/);
    await expect(postTransfer(transfer({ receivingStorageLocation: '0099' })))
      .rejects.toThrow(/blocked for postings/);
    await expect(postTransfer(transfer({ receivingStorageLocation: '7777' })))
      .rejects.toThrow(/Storage location 7777 does not stand in plant 1000/);
  });

  it('refuses a cross-company plant transfer by name', async () => {
    const error = await postTransfer(transfer({
      movementTypeCode: '301', receivingPlant: '3000', receivingStorageLocation: '0001',
    })).catch((e: unknown) => e);
    expect((error as TransferPostingError).message).toMatch(/Plant 3000 stands in company code 2000/);
    expect((error as TransferPostingError).remedy).toMatch(/intercompany clearing/);
  });

  it('refuses a posting date in a closed material period', async () => {
    await expect(postTransfer(transfer({ postingDate: '2026-01-15', documentDate: '2026-01-15' })))
      .rejects.toThrow(/material posting period 2026\/1 is closed/);
  });

  it('permits a negative balance only where the storage location configures it', async () => {
    const doc = await postTransfer(transfer({
      issuingStorageLocation: '0003', receivingStorageLocation: '0002', quantity: 5,
    }));
    expect(doc.materialDocumentNumber).toBeTruthy();
    expect(await stock('MAT-TR', '1000', '0003', 'UNRESTRICTED')).toBe(-5);
    await expect(postTransfer(transfer({ issuingStorageLocation: '0001', receivingStorageLocation: '0002', quantity: 100000 })))
      .rejects.toThrow(/short of the 100000\.000/);
  });

  it('returns the document already standing for a replayed request key', async () => {
    const request = transfer({ quantity: 1 });
    const first = await postTransfer(request);
    const second = await postTransfer(request);
    expect(second.materialDocumentNumber).toBe(first.materialDocumentNumber);
  });

  describe('reversal', () => {
    it('restores both sides, marks the original and reverses the journal', async () => {
      const original = await postTransfer(transfer({
        materialNumber: 'MAT-STD', movementTypeCode: '301', quantity: 10,
        receivingPlant: '2000', receivingStorageLocation: '0001',
      }));
      expect(original.journalDocumentNumber).not.toBeNull();

      const reversal = await reverseTransfer({
        client, changedBy: ACTOR, materialDocumentNumber: original.materialDocumentNumber,
        postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
      });

      expect(reversal.reversalOf).toBe(original.materialDocumentNumber);
      expect(reversal.lines[0].lineDirection).toBe('ISSUE');
      expect(reversal.lines[0].plant).toBe('2000');
      expect(reversal.lines[1].plant).toBe('1000');
      expect(reversal.journalDocumentNumber).not.toBeNull();
      expect(await stock('MAT-STD', '2000', '0001', 'UNRESTRICTED')).toBe(10);

      const originalNow = await withTenant(client, async (tx) => {
        const rows = await tx.execute(sql`
          select status, reversed_by from material_document
          where client = ${client} and material_document_number = ${original.materialDocumentNumber}
        `) as unknown as Array<{ status: string; reversed_by: string }>;
        return rows[0];
      });
      expect(originalNow.status).toBe('REVERSED');
      expect(originalNow.reversed_by).toBe(reversal.materialDocumentNumber);
    });

    it('refuses to reverse a reversal, and one whose returning stock has gone', async () => {
      const first = await postTransfer(transfer({
        issuingStorageLocation: '0001', receivingStorageLocation: '0004', quantity: 7,
      }));
      const reversal = await reverseTransfer({
        client, changedBy: ACTOR, materialDocumentNumber: first.materialDocumentNumber,
        postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
      });
      await expect(reverseTransfer({
        client, changedBy: ACTOR, materialDocumentNumber: reversal.materialDocumentNumber,
        postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
      })).rejects.toThrow(/A reversal document cannot itself be reversed/);

      const second = await postTransfer(transfer({
        issuingStorageLocation: '0001', receivingStorageLocation: '0004', quantity: 7,
      }));
      await postTransfer(transfer({
        issuingStorageLocation: '0004', receivingStorageLocation: '0001', quantity: 7,
      }));
      await expect(reverseTransfer({
        client, changedBy: ACTOR, materialDocumentNumber: second.materialDocumentNumber,
        postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
      })).rejects.toThrow(/no longer|is 0\.000, short of the 7\.000/);
    });
  });
  it('converts a transfer entered in an alternative unit into base quantity on both lines', async () => {
    await defineUomConversion({
      client, changedBy: ACTOR, materialNumber: 'MAT-TR',
      alternativeUnit: 'BOX', numerator: 12, denominator: 1,
    });
    const before = await stock('MAT-TR', '1000', '0001', 'UNRESTRICTED');
    const doc = await postTransfer(transfer({ quantity: 2, entryUnit: 'BOX' }));

    // Two boxes are twenty-four pieces: the ledger records the base quantity, not the entry.
    expect(doc.lines[0].quantity).toBe('24.000');
    expect(doc.lines[0].unit).toBe('PC');
    expect(doc.lines[1].quantity).toBe('24.000');
    expect(await stock('MAT-TR', '1000', '0001', 'UNRESTRICTED')).toBe(before - 24);
  });

  it('refuses a transfer in a unit the material carries no conversion from, naming it', async () => {
    const error = await postTransfer(transfer({ quantity: 2, entryUnit: 'GAL' }))
      .catch((e: unknown) => e as TransferPostingError);
    expect(error).toBeInstanceOf(TransferPostingError);
    expect(error.message).toMatch(/carries no conversion from GAL to its base unit PC/);
    expect(error.remedy).toMatch(/INV\.STOCK\.UOM/);
  });

});
