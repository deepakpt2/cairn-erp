/** FOUND-02. Factors are relative to the dimension's base unit (TIME: HR). */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { convertUnits, UnitConversionError } from '../src/modules/inventory/unit-conversion';
import { db } from '../src/platform/db/client';
import { closeDb } from './helpers';

const run = (quantity: number, fromUnit: string, toUnit: string) =>
  db().transaction((tx) => convertUnits(tx, { quantity, fromUnit, toUnit }));
const refusal = async (p: Promise<unknown>): Promise<UnitConversionError> => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(UnitConversionError); return e as UnitConversionError; }
  throw new Error('expected a refusal');
};

beforeAll(async () => {
  await db().execute(sql`insert into unit_of_measure (code, name, dimension, decimal_places, is_base_unit) values
    ('XT1','Test unseeded','TIME',2,false), ('XB1','Test no base a','XBASE',2,false), ('XB2','Test no base b','XBASE',2,false)
    on conflict (code) do nothing`);
});
afterAll(async () => {
  await db().execute(sql`delete from unit_of_measure where code in ('XT1','XB1','XB2')`);
  await closeDb();
});

describe('convertUnits', () => {
  it('MIN → HR and back', async () => {
    expect((await run(90, 'MIN', 'HR')).quantity).toBe(1.5);
    expect((await run(1.5, 'HR', 'MIN')).quantity).toBe(90);
  });
  it('DAY → HR, and the base unit converts', async () => {
    expect((await run(1, 'DAY', 'HR')).quantity).toBe(24);
    expect((await run(60, 'MIN', 'DAY')).quantity).toBe(0);
    expect((await run(1, 'HR', 'DAY')).quantity).toBe(0);
  });
  it('round trip returns the original', async () => {
    const hours = (await run(90, 'MIN', 'HR')).quantity;
    expect((await run(hours, 'HR', 'MIN')).quantity).toBe(90);
  });
  it('same unit is unchanged, even when never seeded', async () => {
    expect(await run(7.123456, 'XT1', 'XT1')).toEqual({ quantity: 7.123456, unit: 'XT1' });
  });
  it('different dimensions refuse naming both', async () => {
    const e = await refusal(run(1, 'MIN', 'KG'));
    expect(e.message).toContain('UNIT_DIMENSION_MISMATCH');
    expect(e.message).toMatch(/MIN.*TIME.*KG.*MASS/);
    expect(e.remedy).toBeTruthy();
  });
  it('unknown unit refuses', async () => {
    const e = await refusal(run(1, 'NOPE', 'HR'));
    expect(e.message).toContain('UNIT_NOT_FOUND');
    expect(e.message).toContain('NOPE');
  });
  it('an unseeded unit refuses when converting, naming it', async () => {
    const e = await refusal(run(1, 'XT1', 'MIN'));
    expect(e.message).toContain('UNIT_FACTOR_MISSING');
    expect(e.message).toContain('XT1');
    await refusal(run(1, 'HR', 'XT1'));
  });
  it('a dimension with no base unit refuses', async () => {
    const e = await refusal(run(1, 'XB1', 'XB2'));
    expect(e.message).toContain('UNIT_NO_BASE');
    expect(e.message).toContain('XBASE');
  });
  it('negative and zero pass through', async () => {
    expect((await run(-90, 'MIN', 'HR')).quantity).toBe(-1.5);
    expect((await run(0, 'MIN', 'HR')).quantity).toBe(0);
  });
  it('rounds once, at the end, to the target decimals', async () => {
    // 1 MIN = 0.016666… HR; rounding the base first would not change this, but 100 MIN must give 1.67 not 1.68.
    expect((await run(100, 'MIN', 'HR')).quantity).toBe(1.67);
    expect((await run(1, 'MIN', 'HR')).quantity).toBe(0.02);
    expect((await run(25, 'HR', 'DAY')).quantity).toBe(1);
  });
  it('the check constraint rejects a bad factor', async () => {
    for (const bad of ['numerator = -1', 'denominator = 0', 'exponent = 31']) {
      await expect(db().execute(sql.raw(`update unit_of_measure set ${bad} where code = 'XT1'`))).rejects.toThrow();
    }
  });
});
