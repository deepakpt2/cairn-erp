import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  MAX_HITS_CAP,
  StockAgeingError,
  stockAgeing,
  type StockAgeingSelection,
} from '../src/modules/inventory/stock-ageing';
import { reconcileStock } from '../src/modules/inventory/stock-reconcile';
import { createTenant, destroyTenant } from './helpers';

/**
 * INV.STOCK.AGEING.DISPLAY (MC46 / MC50) acceptance.
 *
 * The fixture is a ledger written in the exact shape the posting services leave (a transfer is one
 * ISSUE and one RECEIPT line; a reversal line carries the opposite direction and points back through
 * reversal_of_document / reversal_of_line; the original becomes REVERSED or PARTIALLY_REVERSED),
 * with `asOf` injected so no test reads the clock.
 */
describe('Stock ageing and slow-moving analysis (MC46 / MC50)', () => {
  const ACTOR = 'MC46_TEST';
  const CURRENCY = 'USD';
  const ASOF = '2026-06-30';
  const P1 = 'Q170';
  const P2 = 'Q171';
  let client = '';
  let docSeq = 6_200_000_000;

  const day = (n: number) => new Date(Date.parse(`${ASOF}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  interface Line { material: string; plant: string; loc?: string; direction: 'ISSUE' | 'RECEIPT'; qty: number; type?: string; stockType?: string }

  async function document(
    tx: Parameters<Parameters<typeof withTenant>[1]>[0],
    opts: { date: string; status?: string; reversalOf?: string; lines: Array<Line & { movement: string; reversalOfLine?: number; reversalOfDocument?: string }> },
  ): Promise<string> {
    const number = String(++docSeq);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, reversal_of, created_by)
      values (${client}, ${number}, ${Number(opts.date.slice(0, 4))}, ${opts.date}, ${opts.date}, 'fixture', ${opts.status ?? 'POSTED'}, ${opts.reversalOf ?? null}, ${ACTOR})
    `);
    let n = 0;
    for (const l of opts.lines) {
      n += 1;
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant, storage_location, stock_type,
          line_direction, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, currency, value,
          reversal_of_document, reversal_of_line, created_by
        ) values (${client}, ${number}, ${n}, ${l.movement}, ${l.material}, ${l.plant}, ${l.loc ?? 'SL1'}, ${l.stockType ?? 'UNRESTRICTED'},
          ${l.direction}, ${l.qty}, 'PC', ${l.qty}, 'PC', 10, 1, ${CURRENCY}, ${l.qty * 10},
          ${l.reversalOfDocument ?? null}, ${l.reversalOfLine ?? null}, ${ACTOR})
      `);
    }
    return number;
  }

  const rec = (material: string, qty: number, plant = P1, loc = 'SL1') => ({ material, plant, loc, direction: 'RECEIPT' as const, qty, movement: 'GOODS_RECEIPT_PO' });
  const iss = (material: string, qty: number, plant = P1, loc = 'SL1') => ({ material, plant, loc, direction: 'ISSUE' as const, qty, movement: 'GI_SCRAP' });

  async function stock(tx: Parameters<Parameters<typeof withTenant>[1]>[0], material: string, plant: string, qty: number, loc = 'SL1', stockType = 'UNRESTRICTED') {
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values (${client}, ${material}, ${plant}, ${loc}, ${stockType}, ${qty}, ${ACTOR})
    `);
  }

  beforeAll(async () => {
    const tenant = await createTenant('mc46-ageing', { currency: CURRENCY });
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into plant (client, plant, name, country, created_by) values
          (${client}, ${P1}, 'Plant 170', 'KW', ${ACTOR}), (${client}, ${P2}, 'Plant 171', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, created_by) values
          (${client}, ${P1}, 'SL1', 'Store 1', true, ${ACTOR}), (${client}, ${P1}, 'SL2', 'Store 2', true, ${ACTOR}),
          (${client}, ${P2}, 'SL1', 'Store 1', true, ${ACTOR})
        on conflict do nothing
      `);
      const names = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'V1', 'V2', 'V3', 'V4', 'C1', 'C2', 'C3', 'C4', 'C5', 'D1', 'T1', 'T2', 'T3', 'T4'];
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MC-' || n, 'Material ' || n, t.material_type, 'PC', ${ACTOR}
          from (select material_type from material_type where client = ${client} order by material_type limit 1) t
         cross join unnest(${sql.raw(`array[${names.map((n) => `'${n}'`).join(',')}]`)}) as n
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
          (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt', 'RECEIPT', 'PURCHASE_ORDER', ${ACTOR}),
          (${client}, 'GI_SCRAP', 'Scrap issue', 'ISSUE', 'MATERIAL_DOCUMENT', ${ACTOR}),
          (${client}, 'RECEIPT_REVERSAL', 'Reversal movement type', 'REVERSAL', 'MATERIAL_DOCUMENT', ${ACTOR}),
          (${client}, 'TRANSFER_SLOC', 'Storage location transfer', 'TRANSFER', 'MATERIAL_DOCUMENT', ${ACTOR}),
          (${client}, 'TRANSFER_PLANT', 'Plant transfer', 'TRANSFER', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into valuation_class (client, valuation_class, name, allowed_material_types, created_by)
        select ${client}, 'TEST_CLASS', 'Test class', 'RAW,FINISHED,TRADE,SEMI', ${ACTOR} where not exists (
          select 1 from valuation_class where client = ${client} and valuation_class = 'TEST_CLASS')
      `);

      // A1: two receipts. A2: the same, then an issue of 12. A3: struck at an earlier asOf.
      await document(tx, { date: day(-75), lines: [rec('MC-A1', 10)] });
      await document(tx, { date: day(-10), lines: [rec('MC-A1', 10)] });
      await stock(tx, 'MC-A1', P1, 20);
      await document(tx, { date: day(-75), lines: [rec('MC-A2', 10)] });
      await document(tx, { date: day(-10), lines: [rec('MC-A2', 10)] });
      await document(tx, { date: day(-5), lines: [iss('MC-A2', 12)] });
      await stock(tx, 'MC-A2', P1, 8);
      await document(tx, { date: day(-75), lines: [rec('MC-A3', 10)] });
      await document(tx, { date: day(5), lines: [rec('MC-A3', 5)] });
      await stock(tx, 'MC-A3', P1, 15);
      // A4: a storage-location transfer of the whole quantity. A5: a plant-to-plant transfer.
      await document(tx, { date: day(-200), lines: [rec('MC-A4', 10)] });
      await document(tx, { date: day(-5), lines: [{ ...iss('MC-A4', 10), movement: 'TRANSFER_SLOC' }, { ...rec('MC-A4', 10, P1, 'SL2'), movement: 'TRANSFER_SLOC' }] });
      await stock(tx, 'MC-A4', P1, 10, 'SL2');
      await document(tx, { date: day(-200), lines: [rec('MC-A5', 10)] });
      await document(tx, { date: day(-5), lines: [{ ...iss('MC-A5', 10), movement: 'TRANSFER_PLANT' }, { ...rec('MC-A5', 10, P2), movement: 'TRANSFER_PLANT' }] });
      await stock(tx, 'MC-A5', P2, 10);
      // A6: half of a receipt reversed (two lines; line 1 reversed). A7: a receipt fully reversed beside a standing one.
      const a6 = await document(tx, { date: day(-75), status: 'PARTIALLY_REVERSED', lines: [rec('MC-A6', 6), rec('MC-A6', 4)] });
      await document(tx, { date: day(-3), reversalOf: a6, lines: [{ ...iss('MC-A6', 6), movement: 'GI_SCRAP', reversalOfDocument: a6, reversalOfLine: 1 }] });
      await stock(tx, 'MC-A6', P1, 4);
      const a7 = await document(tx, { date: day(-50), status: 'REVERSED', lines: [rec('MC-A7', 10)] });
      await document(tx, { date: day(-49), reversalOf: a7, lines: [{ ...iss('MC-A7', 10), movement: 'GI_SCRAP', reversalOfDocument: a7, reversalOfLine: 1 }] });
      await document(tx, { date: day(-20), lines: [rec('MC-A7', 3)] });
      await stock(tx, 'MC-A7', P1, 3);
      // A8: a reversal movement type posted directly is outbound. A9: hand-worked ages.
      await document(tx, { date: day(-60), lines: [rec('MC-A8', 10)] });
      await document(tx, { date: day(-30), lines: [{ ...rec('MC-A8', 4), movement: 'RECEIPT_REVERSAL' }] });
      await stock(tx, 'MC-A8', P1, 6);
      await document(tx, { date: day(-40), lines: [rec('MC-A9', 4)] });
      await document(tx, { date: day(-20), lines: [rec('MC-A9', 6)] });
      await stock(tx, 'MC-A9', P1, 10);

      // Valuation: V1 standard 12.5, V2 moving average 200 per 10, V3 none, V4 in EUR.
      for (const [m, qty] of [['V1', 4], ['V2', 7], ['V3', 5], ['V4', 2]] as const) {
        await document(tx, { date: day(-5), lines: [rec(`MC-${m}`, qty)] });
        await stock(tx, `MC-${m}`, P1, qty);
      }
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
          standard_price, moving_average_price, price_unit, currency, accounting_status, created_by) values
          (${client}, 'MC-V1', ${P1}, 'TEST_CLASS', 'STANDARD', 12.5, 0, 1, ${CURRENCY}, 'MAINTAINED', ${ACTOR}),
          (${client}, 'MC-V2', ${P1}, 'TEST_CLASS', 'MOVING_AVERAGE', 0, 200, 10, ${CURRENCY}, 'MAINTAINED', ${ACTOR}),
          (${client}, 'MC-V4', ${P1}, 'TEST_CLASS', 'STANDARD', 3, 0, 1, 'EUR', 'MAINTAINED', ${ACTOR})
      `);

      // Classification: issued 200 / 100 / 10 days ago; never issued, received 200 / 1 days ago.
      for (const [m, issued] of [['C1', -200], ['C2', -100], ['C3', -10]] as const) {
        await document(tx, { date: day(-300), lines: [rec(`MC-${m}`, 100)] });
        await document(tx, { date: day(issued), lines: [iss(`MC-${m}`, 10)] });
        await stock(tx, `MC-${m}`, P1, 90);
      }
      await document(tx, { date: day(-200), lines: [rec('MC-C4', 7)] });
      await stock(tx, 'MC-C4', P1, 7);
      await document(tx, { date: day(-1), lines: [rec('MC-C5', 7)] });
      await stock(tx, 'MC-C5', P1, 7);

      // D1: the stock record disagrees with the ledger.
      await document(tx, { date: day(-5), lines: [rec('MC-D1', 4)] });
      await stock(tx, 'MC-D1', P1, 1);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function report(selection: Partial<StockAgeingSelection> = {}) {
    return stockAgeing({ client, localCurrency: CURRENCY, selection: { asOf: ASOF, maxHits: 200, ...selection } });
  }
  const one = async (material: string, selection: Partial<StockAgeingSelection> = {}) => {
    const result = await report({ materialFrom: material, materialTo: material, ...selection });
    return { result, row: result.rows[0]! };
  };

  it('ages two receipts into their own buckets', async () => {
    const { row, result } = await one('MC-A1');
    expect(result.capability).toBe('INV.STOCK.AGEING.DISPLAY');
    expect(result.buckets.map((b) => b.upToDays)).toEqual([30, 60, 90, 180, 365, null]);
    expect(row.bucketQuantities).toEqual([10, 0, 10, 0, 0, 0]);
    expect(row.quantityOnHand).toBe(20);
    expect(row.drift).toBeNull();
  });

  it('consumes the oldest layer first', async () => {
    const { row } = await one('MC-A2');
    expect(row.bucketQuantities).toEqual([8, 0, 0, 0, 0, 0]);
    expect(row.quantityOnHand).toBe(8);
  });

  it('strikes the age at asOf, not today, and ignores later receipts', async () => {
    const { row } = await one('MC-A3', { asOf: day(-30) });
    expect(row.bucketQuantities).toEqual([0, 10, 0, 0, 0, 0]);
    expect(row.lastReceiptDate).toBe(day(-75));
  });

  it('does not make stock young by a storage-location transfer', async () => {
    const { row } = await one('MC-A4');
    expect(row.bucketQuantities).toEqual([0, 0, 0, 0, 10, 0]);
    expect(row.oldestLayerDate).toBe(day(-200));
    expect(row.lastIssueDate).toBeNull();
    expect(row.drift).toBeNull();
  });

  it('dates stock from a plant-to-plant transfer at the receiving plant', async () => {
    const { result } = await one('MC-A5', { displayZero: true });
    const receiving = result.rows.find((r) => r.plant === P2)!;
    expect(receiving.bucketQuantities).toEqual([10, 0, 0, 0, 0, 0]);
    expect(receiving.oldestLayerDate).toBe(day(-5));
    const sending = result.rows.find((r) => r.plant === P1);
    expect(sending?.quantityOnHand ?? 0).toBe(0);
  });

  it('keeps the standing half of a partly reversed receipt at its original date', async () => {
    const { row } = await one('MC-A6');
    expect(row.bucketQuantities).toEqual([0, 0, 4, 0, 0, 0]);
    expect(row.oldestLayerDate).toBe(day(-75));
    expect(row.drift).toBeNull();
  });

  it('lets a fully reversed receipt contribute nothing', async () => {
    const { row } = await one('MC-A7');
    expect(row.bucketQuantities).toEqual([3, 0, 0, 0, 0, 0]);
    expect(row.oldestLayerDate).toBe(day(-20));
    expect(row.drift).toBeNull();
  });

  it('reads a reversal movement type as outbound', async () => {
    const { row } = await one('MC-A8');
    expect(row.bucketQuantities).toEqual([0, 6, 0, 0, 0, 0]);
    expect(row.lastIssueDate).toBe(day(-30));
    expect(row.daysSinceLastIssue).toBe(30);
  });

  it('matches a hand-worked oldest layer and weighted average age', async () => {
    const { row } = await one('MC-A9');
    // 4 units aged 40 days, 6 aged 20: (160 + 120) / 10 = 28.
    expect(row.oldestLayerDate).toBe(day(-40));
    expect(row.weightedAverageAgeDays).toBe(28);
  });

  it('values by price control and price unit, to two decimals', async () => {
    expect((await one('MC-V1')).row).toMatchObject({ priceControl: 'STANDARD', price: 12.5, value: 50, currency: CURRENCY });
    expect((await one('MC-V2')).row).toMatchObject({ priceControl: 'MOVING_AVERAGE', price: 200, priceUnit: 10, value: 140 });
  });

  it('carries no value for a material without a valuation row, names it, and leaves it out of the total', async () => {
    const result = await report({ materialFrom: 'MC-V1', materialTo: 'MC-V3' });
    const unvalued = result.rows.find((r) => r.materialNumber === 'MC-V3')!;
    expect(unvalued.value).toBeNull();
    expect(unvalued.price).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/No valuation stands for 1 material\(s\): MC-V3.*unknown, not zero/);
    expect(result.totals.value).toBe(190);
  });

  it('nulls the footer value across two currencies and says so', async () => {
    const result = await report({ materialFrom: 'MC-V1', materialTo: 'MC-V4' });
    expect(result.totals.value).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/valued in EUR rather than USD; no translation/);
  });

  it('classifies by days since the last issue, or since the last receipt when never issued', async () => {
    const result = await report({ materialFrom: 'MC-C1', materialTo: 'MC-C5' });
    const cls = Object.fromEntries(result.rows.map((r) => [r.materialNumber, r.movementClass]));
    expect(cls).toEqual({
      'MC-C1': 'NON_MOVING', 'MC-C2': 'SLOW_MOVING', 'MC-C3': 'ACTIVE', 'MC-C4': 'NON_MOVING', 'MC-C5': 'ACTIVE',
    });
    const never = result.rows.find((r) => r.materialNumber === 'MC-C5')!;
    expect(never.daysSinceLastIssue).toBeNull();
    expect(result.totals.byClass).toEqual({ ACTIVE: 2, SLOW_MOVING: 1, NON_MOVING: 2 });
  });

  it('refuses a non-moving threshold that does not exceed the slow-moving one', async () => {
    await expect(report({ slowMovingDays: 90, nonMovingDays: 90 })).rejects.toBeInstanceOf(StockAgeingError);
    await expect(report({ slowMovingDays: 90, nonMovingDays: 30 })).rejects.toThrow(/must exceed/);
  });

  it('refuses malformed buckets and dates', async () => {
    await expect(report({ ageBuckets: [] })).rejects.toBeInstanceOf(StockAgeingError);
    await expect(report({ ageBuckets: [30, 30] })).rejects.toThrow(/ascending/);
    await expect(report({ ageBuckets: [1, 2, 3, 4, 5, 6, 7] })).rejects.toThrow(/At most/);
    await expect(report({ ageBuckets: [0, 5] })).rejects.toThrow(/positive/);
    await expect(report({ asOf: '30/06/2026' })).rejects.toMatchObject({ remedy: expect.stringMatching(/YYYY-MM-DD/) });
  });

  it('reports drift against the stock record and points to MB5L', async () => {
    const { result, row } = await one('MC-D1');
    expect(row.drift).toBe(3);
    expect(result.warnings.join(' ')).toMatch(/disagree for 1 material\/plant combinations; run MB5L at \/inventory\/stock-reconcile/);
  });

  it('honours maxHits, flags truncation and caps an excessive request', async () => {
    const small = await report({ materialFrom: 'MC-A1', materialTo: 'MC-A9', maxHits: 2 });
    expect(small.rows).toHaveLength(2);
    expect(small.truncated).toBe(true);
    expect(small.warnings.join(' ')).toMatch(/truncated at 2 hits/);
    const capped = await report({ materialFrom: 'MC-A1', materialTo: 'MC-A1', maxHits: MAX_HITS_CAP + 1 });
    expect(capped.maxHits).toBe(MAX_HITS_CAP);
    expect(capped.warnings.join(' ')).toMatch(/capped at 5000/);
  });

  it('refuses inverted ranges and things that do not stand', async () => {
    await expect(report({ materialFrom: 'MC-A9', materialTo: 'MC-A1' })).rejects.toThrow(/material range is inverted/);
    await expect(report({ plantFrom: P2, plantTo: P1 })).rejects.toThrow(/plant range is inverted/);
    await expect(report({ materialFrom: 'NOPE-1' })).rejects.toThrow(/material NOPE-1 does not stand/);
    await expect(report({ plantFrom: 'ZZZZ' })).rejects.toThrow(/plant ZZZZ does not stand/);
    await expect(report({ stockType: 'NOSUCH' })).rejects.toThrow(/stock type NOSUCH does not stand/);
  });

  it('documents the MB5L status-filter discrepancy (reported, not fixed)', async () => {
    // MC-A6 is a partly reversed receipt whose stock record (4) is the true position, and this report
    // agrees (no drift). MB5L filters documents on ('POSTED','REVERSED'), so it drops the PARTIALLY_REVERSED
    // original while keeping the reversal document, and reports the material as drifted.
    const { row } = await one('MC-A6');
    expect(row.drift).toBeNull();
    const reconcile = await reconcileStock(client, { plant: P1 });
    const flagged = reconcile.drift.find((d) => d.materialNumber === 'MC-A6');
    expect(flagged).toBeDefined();
  });

  it('writes nothing', async () => {
    const count = () => withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select (select count(*) from stock_quantity) as s, (select count(*) from material_document) as d,
               (select count(*) from material_document_line) as l, (select count(*) from material_valuation) as v
      `) as unknown as Array<Record<string, unknown>>;
      return JSON.stringify(rows[0]);
    });
    const before = await count();
    await report();
    expect(await count()).toBe(before);
  });
});
