import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { defineUomConversion } from '../src/modules/inventory/unit-conversion';
import {
  createPhysicalInventory,
  cancelPhysicalInventory,
} from '../src/modules/inventory/physical-inventory';
import {
  PhysicalInventoryCountError,
  clearCount,
  getCountDocument,
  getCountHistory,
  getCountStatus,
  searchCountDocuments,
  submitCounts,
} from '../src/modules/inventory/physical-inventory-count';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-147 / MI04 acceptance — a count records what a person saw and posts nothing.
 *
 * The suite pins the counting behaviour the package asks for: a positive count, an explicit zero
 * distinguishable from a missing count, conversion into the base unit, the provisional difference
 * against the frozen book quantity, the header advancing only when every item is counted, a
 * correction that keeps its history, a clear that removes the count but not the evidence, and the
 * refusals — zero beside quantity, negative, missing date, stale version, an item of another
 * document, a posted document, an unconvertible unit.
 *
 * And the sentence the whole round exists for: after all of it, `material_document`,
 * `journal_entry` and `stock_quantity` are exactly as they were.
 */
describe('SCR-147 physical inventory count (MI04)', () => {
  const ACTOR = 'SCR147_COUNTER';
  const SUPERVISOR = 'SCR147_SUPERVISOR';
  const DAY = '2026-10-15';
  const PLANT = '1000';
  const SLOC = '0001';
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let client = '';
  let documentNumber = '';
  let fiscalYear = 2026;
  let key = 0;
  const nextKey = () => `scr147-${++key}`;

  /** Everything that must not move, read as one string so a difference is impossible to miss. */
  async function ledgerFingerprint(): Promise<string> {
    return withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select
          (select count(*) from material_document where client = ${client})::int as documents,
          (select count(*) from journal_entry where client = ${client})::int as journals,
          (select coalesce(sum(quantity), 0)::text from stock_quantity where client = ${client}) as stock,
          (select coalesce(sum(stock_value), 0)::text from material_valuation where client = ${client}) as value
      `) as unknown as Array<{ documents: number; journals: number; stock: string; value: string }>;
      const row = rows[0];
      return `${row.documents}/${row.journals}/${row.stock}/${row.value}`;
    });
  }

  async function itemOf(number: number) {
    const view = await getCountDocument(client, { documentNumber, fiscalYear });
    const item = view!.items.find((i) => i.itemNumber === number);
    if (!item) throw new Error(`item ${number} is not on the document`);
    return item;
  }

  beforeAll(async () => {
    tenant = await createTenant('scr147-mi04');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, {
        client, objectCode: 'PHYINV', subObject: '*', prefix: 'PI', numberLength: 7, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${client}, ${PLANT}, 'Count plant', c.company_code, 'KW', ${ACTOR}
        from (select company_code from company_code where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by)
        values (${client}, ${PLANT}, ${SLOC}, 'Count store', false, true, ${ACTOR})
        on conflict (client, plant, storage_location) do update set is_active = true
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, m.number, m.description, t.material_type, m.unit, ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        cross join (values
          ('MI04-A', 'Counted steel', 'PC'),
          ('MI04-B', 'Counted bolts', 'PC'),
          ('MI04-C', 'Counted with alternative unit', 'PC')
        ) m(number, description, unit)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        select ${client}, m.number, ${PLANT}, ${ACTOR}
        from (values ('MI04-A'), ('MI04-B'), ('MI04-C')) m(number)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        select ${client}, c.company_code, 2026, 10, 2026, 9, true, ${ACTOR}
        from (select company_code from company_code where client = ${client} limit 1) c
        on conflict (client, company_code) do update set
          current_fiscal_year = 2026, current_period = 10,
          previous_fiscal_year = 2026, previous_period = 9, allow_backposting = true
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
          (${client}, 'MI04-A', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 100, ${ACTOR}),
          (${client}, 'MI04-A', ${PLANT}, ${SLOC}, 'QUALITY', 10, ${ACTOR}),
          (${client}, 'MI04-B', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 40, ${ACTOR}),
          (${client}, 'MI04-C', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 24, ${ACTOR})
        on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
        do update set quantity = excluded.quantity
      `);
    });

    // BOX converts to 12 PC, so a count entered in boxes proves the conversion is real.
    await defineUomConversion({
      client, changedBy: ACTOR, materialNumber: 'MI04-C',
      alternativeUnit: 'BOX', numerator: 12, denominator: 1,
    } as Parameters<typeof defineUomConversion>[0]);

    const created = await createPhysicalInventory({
      client, createdBy: ACTOR, plant: PLANT, storageLocation: SLOC,
      plannedCountDate: DAY, postingBlock: true,
      materials: ['MI04-A', 'MI04-B', 'MI04-C'],
    });
    documentNumber = created.inventoryDocumentNumber;
    fiscalYear = created.fiscalYear;
  });

  afterAll(async () => {
    await destroyTenant(client);
  });

  it('creates one item per material per stock type, freezing the book quantity with its basis', async () => {
    const view = await getCountDocument(client, { documentNumber, fiscalYear });
    expect(view).not.toBeNull();
    expect(view!.items.map((i) => `${i.materialNumber}/${i.stockType}`)).toEqual([
      'MI04-A/QUALITY', 'MI04-A/UNRESTRICTED', 'MI04-B/UNRESTRICTED', 'MI04-C/UNRESTRICTED',
    ]);
    const a = view!.items.find((i) => i.materialNumber === 'MI04-A' && i.stockType === 'UNRESTRICTED')!;
    expect(a.bookQuantity, 'the book quantity is frozen at creation').toBe('100.000');
    expect(a.bookBasis).toBe('DOCUMENT_CREATION');
    expect(view!.counts).toMatchObject({ items: 4, counted: 0, uncounted: 4 });
    expect(view!.status).toBe('CREATED');
  });

  it('records a positive count and a provisional difference against the frozen book', async () => {
    const view = await submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear,
      countDate: DAY, counterName: 'A. Counter', requestKey: nextKey(),
      lines: [{ itemNumber: 20, quantity: 95 }],
    });
    const item = view.items.find((i) => i.itemNumber === 20)!;
    expect(item.countStatus).toBe('COUNTED');
    expect(item.countedQuantity).toBe('95.000');
    expect(item.baseQuantity).toBe('95.000');
    expect(item.differenceQuantity, 'counted minus book').toBe('-5.000');
    expect(item.counterName).toBe('A. Counter');
    expect(view.status, 'one counted item does not count the document').toBe('PARTIALLY_COUNTED');
  });

  it('records a zero count as a fact and leaves an uncounted item uncounted', async () => {
    const view = await submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear,
      countDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: 10, zeroCount: true }],
    });
    const zero = view.items.find((i) => i.itemNumber === 10)!;
    expect(zero.zeroCount).toBe(true);
    expect(zero.countedQuantity, 'the server sets the quantity, not the caller').toBe('0.000');
    expect(zero.differenceQuantity).toBe('-10.000');

    const untouched = view.items.find((i) => i.itemNumber === 30)!;
    expect(untouched.countStatus, 'a missing count is not a zero count').toBe('UNCOUNTED');
    expect(untouched.countedQuantity).toBeNull();
    expect(view.counts).toMatchObject({ items: 4, counted: 2, uncounted: 2 });
  });

  it('converts an entry unit into the base unit and takes the difference from base', async () => {
    const view = await submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear,
      countDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: 40, quantity: 1, entryUnit: 'BOX' }],
    });
    const item = view.items.find((i) => i.itemNumber === 40)!;
    expect(item.countedQuantity, 'the line keeps what was entered').toBe('1.000');
    expect(item.entryUnit).toBe('BOX');
    expect(item.baseQuantity, 'and says what it means in the base unit').toBe('12.000');
    expect(item.differenceQuantity).toBe('-12.000');
  });

  it('advances the header only when every item is counted', async () => {
    const before = await getCountDocument(client, { documentNumber, fiscalYear });
    expect(before!.status).toBe('PARTIALLY_COUNTED');

    const after = await submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear,
      countDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: 10, zeroCount: true }, { itemNumber: 30, quantity: 38 }],
    });
    expect(after.counts).toMatchObject({ items: 4, counted: 4, uncounted: 0 });
    expect(after.status).toBe('COUNTED');
  });

  it('refuses a zero flag beside a quantity, and a line carrying neither', async () => {
    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: 20, quantity: 4, zeroCount: true }],
    })).rejects.toThrow(/zero count and as 4 at once/);

    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: 20 }],
    })).rejects.toThrow(/carries no quantity and no zero count/);

    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: 20, quantity: -3 }],
    })).rejects.toThrow(/not valid/);
  });

  it('refuses an item of another document, a bad document, and a unit with no conversion', async () => {
    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: 999, quantity: 1 }],
    })).rejects.toThrow(/Item 999 does not belong to document/);

    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber: 'PI-2026-0009999', fiscalYear, countDate: DAY,
      requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 1 }],
    })).rejects.toThrow(/does not exist/);

    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: 20, quantity: 2, entryUnit: 'GAL' }],
    })).rejects.toThrow(PhysicalInventoryCountError);
  });

  it('refuses a count date in the future and a date that is not a date', async () => {
    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: '2099-01-01', requestKey: nextKey(),
      lines: [{ itemNumber: 20, quantity: 1 }],
    })).rejects.toThrow(/lies in the future/);

    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: '15/10/2026', requestKey: nextKey(),
      lines: [{ itemNumber: 20, quantity: 1 }],
    })).rejects.toThrow(/not valid/);
  });

  it('corrects a count, keeps the difference against the same frozen book, and writes history', async () => {
    const before = await itemOf(20);
    expect(before.countedQuantity).toBe('95.000');
    const corrected = await submitCounts({
      client, changedBy: SUPERVISOR, documentNumber, fiscalYear, countDate: DAY,
      requestKey: nextKey(), reason: 'Miscount: a pallet was double counted.',
      lines: [{ itemNumber: 20, quantity: 100, expectedVersion: before.version }],
    });
    const after = corrected.items.find((i) => i.itemNumber === 20)!;
    expect(after.countedQuantity).toBe('100.000');
    expect(after.bookQuantity, 'the book did not move with the correction').toBe(before.bookQuantity);
    expect(after.differenceQuantity).toBe('0.000');

    const history = await getCountHistory(client, { documentNumber, fiscalYear, itemNumber: 20 });
    expect(history.length).toBeGreaterThanOrEqual(2);
    const correction = history[0];
    expect(correction.changedBy).toBe(SUPERVISOR);
    expect(correction.reason).toBe('Miscount: a pallet was double counted.');
    expect(correction.correlationId).toBeTruthy();
    const quantityField = correction.fields.find((f) => f.field === 'countedQuantity');
    expect(quantityField?.oldValue).toBe('95.000');
    expect(quantityField?.newValue).toBe('100.000');
  });

  it('refuses a stale submission and hands back the version that stands', async () => {
    const item = await itemOf(20);
    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: 20, quantity: 12, expectedVersion: item.version - 1 }],
    })).rejects.toThrow(new RegExp(`it now stands at version ${item.version}`));

    const unchanged = await itemOf(20);
    expect(unchanged.countedQuantity, 'the stale write changed nothing').toBe('100.000');
  });

  it('clears a count back to uncounted and keeps the cleared value in the history', async () => {
    const item = await itemOf(20);
    const cleared = await clearCount({
      client, changedBy: SUPERVISOR, documentNumber, fiscalYear, itemNumber: 20,
      reason: 'Counted the wrong material.', requestKey: nextKey(), expectedVersion: item.version,
    });
    const after = cleared.items.find((i) => i.itemNumber === 20)!;
    expect(after.countStatus).toBe('UNCOUNTED');
    expect(after.countedQuantity).toBeNull();
    expect(after.zeroCount).toBe(false);
    expect(cleared.status, 'the document falls back with the item').toBe('PARTIALLY_COUNTED');
    expect(cleared.counts.uncountedItems).toContain(20);

    const history = await getCountHistory(client, { documentNumber, fiscalYear, itemNumber: 20 });
    expect(history[0].reason).toBe('Counted the wrong material.');
    expect(history[0].fields.find((f) => f.field === 'countedQuantity')?.oldValue).toBe('100.000');

    await expect(clearCount({
      client, changedBy: SUPERVISOR, documentNumber, fiscalYear, itemNumber: 20,
      reason: 'again', requestKey: nextKey(),
    })).rejects.toThrow(/carries no count to clear/);
  });

  it('rolls the whole submission back when one line in it fails', async () => {
    const before = await getCountDocument(client, { documentNumber, fiscalYear });
    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      lines: [
        { itemNumber: 30, quantity: 77 },
        { itemNumber: 999, quantity: 1 },
      ],
    })).rejects.toThrow(/Item 999 does not belong/);

    const after = await getCountDocument(client, { documentNumber, fiscalYear });
    expect(after!.items.find((i) => i.itemNumber === 30)!.countedQuantity, 'the good line did not land')
      .toBe(before!.items.find((i) => i.itemNumber === 30)!.countedQuantity);
  });

  it('keeps a cancelled document closed to counting', async () => {
    const other = await createPhysicalInventory({
      client, createdBy: ACTOR, plant: PLANT, storageLocation: SLOC,
      plannedCountDate: DAY, postingBlock: false, materials: ['MI04-B'],
    });
    await cancelPhysicalInventory({
      client, changedBy: ACTOR, inventoryDocumentNumber: other.inventoryDocumentNumber,
      fiscalYear: other.fiscalYear,
    });
    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber: other.inventoryDocumentNumber,
      fiscalYear: other.fiscalYear, countDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: 10, quantity: 1 }],
    })).rejects.toThrow(/was cancelled/);
  });

  it('posts nothing at all: no material document, no journal, no stock moved', async () => {
    const fingerprint = await ledgerFingerprint();
    await submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: 20, quantity: 99 }],
    });
    await clearCount({
      client, changedBy: SUPERVISOR, documentNumber, fiscalYear, itemNumber: 20,
      reason: 'Proof that clearing posts nothing either.', requestKey: nextKey(),
    });
    expect(await ledgerFingerprint(), 'the ledger after all this counting').toBe(fingerprint);
  });

  it('serves the search and the aggregate status the count screen reads', async () => {
    const rows = await searchCountDocuments(client, { plant: PLANT });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const mine = rows.find((r) => r.documentNumber === documentNumber)!;
    expect(mine.counts.items).toBe(4);
    expect(mine.counts.uncounted).toBe(1);

    const status = await getCountStatus(client, { documentNumber, fiscalYear });
    expect(status).toMatchObject({ items: 4, counted: 3, uncounted: 1 });
    expect(status!.uncountedItems).toEqual([20]);
  });

  it('refuses a batch, a company code, and a client difference by name, and writes nothing', async () => {
    const before = await itemOf(20);
    const fingerprint = await ledgerFingerprint();
    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      named: { batch: 'BATCH-1' },
      lines: [{ itemNumber: 20, quantity: 4 }],
    })).rejects.toThrow(/A batch is not part of this count/);
    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      named: { companyCode: '1000' },
      lines: [{ itemNumber: 20, quantity: 4 }],
    })).rejects.toThrow(/not a key of the count/);
    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      named: { differenceQuantity: '1' },
      lines: [{ itemNumber: 20, quantity: 4 }],
    })).rejects.toThrow(/The difference is not entered/);
    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      named: { post: 'yes' },
      lines: [{ itemNumber: 20, quantity: 4 }],
    })).rejects.toThrow(/A count posts nothing/);
    const after = await itemOf(20);
    expect(after.version).toBe(before.version);
    expect(after.countStatus).toBe(before.countStatus);
    expect(await ledgerFingerprint()).toBe(fingerprint);
  });

  it('replays the same request without a second revision, and refuses a different one', async () => {
    const key = nextKey();
    const first = await submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: key,
      lines: [{ itemNumber: 20, quantity: 12 }],
    });
    const counted = first.items.find((item) => item.itemNumber === 20)!;
    expect(counted.countedQuantity).toBe('12.000');
    const history = await getCountHistory(client, { documentNumber, fiscalYear, itemNumber: 20 });

    const replay = await submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: key,
      lines: [{ itemNumber: 20, quantity: 12 }],
    });
    const again = replay.items.find((item) => item.itemNumber === 20)!;
    expect(again.version).toBe(counted.version);
    expect(again.countedQuantity).toBe('12.000');
    const after = await getCountHistory(client, { documentNumber, fiscalYear, itemNumber: 20 });
    expect(after).toHaveLength(history.length);

    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: key,
      lines: [{ itemNumber: 20, quantity: 13 }],
    })).rejects.toThrow(/retry cannot change it/);
    const standing = await itemOf(20);
    expect(standing.countedQuantity).toBe('12.000');
    expect(standing.version).toBe(counted.version);
  });
});
