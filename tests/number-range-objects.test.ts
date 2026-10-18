import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { changeHistory } from '../src/platform/change';
import { allocateNumber } from '../src/platform/numbering';
import {
  adjustNumberRangeCurrent,
  listNumberRangeObjects,
  maintainNumberRange,
  saveNumberRangeObject,
  type NumberRangeInput,
} from '../src/modules/foundation/number-ranges';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR050_SNRO_TEST';

/**
 * SCR-050 / SNRO acceptance: the object registry maintained, the great
 * rename standing in stored rows, external and buffered intervals
 * creatable through maintenance, buffered allocation consuming rolled-
 * back numbers, and the guarded current-number act.
 */
describe('SCR-050 number range objects (SNRO)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr050-snro');
      client = tenant.client;
    }
    return client;
  }

  const interval = (patch: Partial<NumberRangeInput>): NumberRangeInput => ({
    client,
    changedBy: ACTOR,
    objectCode: 'MATDOC',
    companyCode: '*',
    subObject: 'GENERAL',
    fiscalYear: 0,
    prefix: '',
    fromNumber: 100,
    toNumber: 199,
    numberLength: 6,
    displayStyle: 'CLASSIC',
    isExternal: false,
    isBuffered: false,
    bufferSize: 0,
    status: 'ACTIVE',
    mode: 'CREATE',
    reason: 'Stage 5 acceptance',
    ...patch,
  });

  it('reads the registry with the renamed objects', async () => {
    const c = await standingClient();
    const objects = await listNumberRangeObjects(c);
    expect(objects.map((o) => o.objectCode)).toContain('RF_BELEG');
    expect(objects.map((o) => o.objectCode)).toContain('MATERIALNR');
    expect(objects.every((o) => o.objectCode.length <= 10)).toBe(true);
    expect(objects.find((o) => o.objectCode === 'RF_BELEG')).toMatchObject({
      description: 'Accounting documents',
      yearRelevant: true,
    });
  });

  it('maintains registry facts and refuses an unknown object', async () => {
    const c = await standingClient();
    const saved = await saveNumberRangeObject({
      client: c, changedBy: ACTOR, objectCode: 'MATERIALNR',
      description: 'Material master numbering', numberLength: 18,
      warningPercent: '90.0', yearRelevant: false, subobjectHint: 'Range group',
      reason: 'Name it as it is used',
    });
    expect(saved.changed).toBe(true);
    const again = await saveNumberRangeObject({
      client: c, changedBy: ACTOR, objectCode: 'MATERIALNR',
      description: 'Material master numbering', numberLength: 18,
      warningPercent: '90.0', yearRelevant: false, subobjectHint: 'Range group',
      reason: 'Nothing moves',
    });
    expect(again.changed).toBe(false);
    await expect(
      saveNumberRangeObject({
        client: c, changedBy: ACTOR, objectCode: 'NOSUCH',
        description: 'Nope', numberLength: 10, warningPercent: '',
        yearRelevant: false, subobjectHint: '', reason: 'Trying',
      }),
    ).rejects.toThrow('does not stand');
    const history = await withTenant(c, (tx) =>
      changeHistory(tx, c, 'number_range_object', 'MATERIALNR'),
    );
    expect(history).toHaveLength(1);
  });

  it('creates an external interval through maintenance and refuses a flag change under it', async () => {
    const c = await standingClient();
    const created = await maintainNumberRange(interval({
      objectCode: 'MATERIALNR', subObject: 'XT', isExternal: true,
    }));
    expect(created.created).toBe(true);
    await expect(
      maintainNumberRange(interval({
        objectCode: 'MATERIALNR', subObject: 'XT', isExternal: false, mode: 'CHANGE',
      })),
    ).rejects.toThrow('never change under it');
    // External intervals refuse automatic allocation.
    await expect(
      withTenant(c, (tx) => allocateNumber(tx, {
        client: c, objectCode: 'MATERIALNR', subObject: 'XT', allocatedBy: ACTOR,
      })),
    ).rejects.toThrow('requires externally supplied numbers');
  });

  it('buffered allocation consumes rolled-back numbers', async () => {
    const c = await standingClient();
    await maintainNumberRange(interval({ subObject: 'BUF', isBuffered: true, bufferSize: 3 }));
    const first = await withTenant(c, (tx) => allocateNumber(tx, {
      client: c, objectCode: 'MATDOC', subObject: 'BUF', allocatedBy: ACTOR,
    }));
    expect(first.value).toBe(100);
    const second = await withTenant(c, (tx) => allocateNumber(tx, {
      client: c, objectCode: 'MATDOC', subObject: 'BUF', allocatedBy: ACTOR,
    }));
    expect(second.value).toBe(101);
    // A rolled-back allocation keeps its number: the block was already
    // reserved by an independent commit, so 102 is never given again.
    await expect(
      withTenant(c, async (tx) => {
        await allocateNumber(tx, {
          client: c, objectCode: 'MATDOC', subObject: 'BUF', allocatedBy: ACTOR,
        });
        throw new Error('document fails');
      }),
    ).rejects.toThrow('document fails');
    const fourth = await withTenant(c, (tx) => allocateNumber(tx, {
      client: c, objectCode: 'MATDOC', subObject: 'BUF', allocatedBy: ACTOR,
    }));
    expect(fourth.value).toBe(103);
    const [counter] = await withTenant(c, async (tx) => {
      const rows = await tx.execute(sql`
        select current_number from number_range
        where client = ${c} and object_code = 'MATDOC' and sub_object = 'BUF'
      `);
      return rows as unknown as { current_number: number }[];
    });
    expect(Number(counter.current_number)).toBe(105);
  });

  it('adjusts the current number only through its guarded act', async () => {
    const c = await standingClient();
    await maintainNumberRange(interval({ subObject: 'ADJ', fromNumber: 200, toNumber: 299 }));
    await withTenant(c, (tx) => allocateNumber(tx, {
      client: c, objectCode: 'MATDOC', subObject: 'ADJ', allocatedBy: ACTOR,
    }));
    await withTenant(c, (tx) => allocateNumber(tx, {
      client: c, objectCode: 'MATDOC', subObject: 'ADJ', allocatedBy: ACTOR,
    }));
    const rewound = await adjustNumberRangeCurrent({
      client: c, changedBy: ACTOR, objectCode: 'MATDOC', companyCode: '*',
      subObject: 'ADJ', fiscalYear: 0, currentNumber: 200, reason: 'Operator rewind',
    });
    expect(rewound).toMatchObject({ changed: true, wouldRepeat: true, lastIssued: 201 });
    const forward = await adjustNumberRangeCurrent({
      client: c, changedBy: ACTOR, objectCode: 'MATDOC', companyCode: '*',
      subObject: 'ADJ', fiscalYear: 0, currentNumber: 250, reason: 'Skip ahead',
    });
    expect(forward).toMatchObject({ changed: true, wouldRepeat: false });
    await expect(
      adjustNumberRangeCurrent({
        client: c, changedBy: ACTOR, objectCode: 'MATDOC', companyCode: '*',
        subObject: 'ADJ', fiscalYear: 0, currentNumber: 500, reason: 'Outside',
      }),
    ).rejects.toThrow('must stand between');
    await expect(
      adjustNumberRangeCurrent({
        client: c, changedBy: ACTOR, objectCode: 'MATDOC', companyCode: '*',
        subObject: 'ADJ', fiscalYear: 0, currentNumber: 250, reason: '  ',
      }),
    ).rejects.toThrow('A reason is required');
    const history = await withTenant(c, (tx) =>
      changeHistory(tx, c, 'number_range', 'MATDOC/*/ADJ/0'),
    );
    expect(history.length).toBeGreaterThanOrEqual(3);
  });
});
