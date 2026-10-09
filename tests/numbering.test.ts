/**
 * Number range engine — CAIRN.md §5.2 (E3), D-019, §16.5
 *
 * The claims under test:
 *   1. Numbers are allocated in sequence with no gaps.
 *   2. Concurrent callers never receive the same number.
 *   3. A rolled-back transaction consumes no number, so no gap is created.
 *   4. Running out produces an explanation naming the range, not a generic failure.
 */
import { describe, expect, it, afterAll } from 'vitest';
import { withTenant, closeDb } from '@/platform/db/client';
import { allocateNumber, NumberRangeError, rangeStatus } from '@/platform/numbering';
import { createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';

const tenant: TestTenant = await createTenant('numbering');
await defineTestRanges(tenant);
const fiscalYear = new Date().getUTCFullYear();

afterAll(async () => {
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('number range engine', () => {
  it('allocates sequentially with no gaps', async () => {
    const numbers: number[] = [];
    for (let i = 0; i < 5; i++) {
      const allocated = await withTenant(tenant.client, (tx) =>
        allocateNumber(tx, {
          client: tenant.client,
          objectCode: 'JOURNAL_ENTRY',
          companyCode: tenant.companyCode,
          subObject: 'GENERAL',
          fiscalYear,
          allocatedBy: 'TEST',
        }),
      );
      numbers.push(allocated.value);
    }

    expect(numbers).toHaveLength(5);
    // Contiguous: every step is exactly one.
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBe(numbers[i - 1] + 1);
    }
  });

  it('formats the number for display (D-030 readable style)', async () => {
    const allocated = await withTenant(tenant.client, (tx) =>
      allocateNumber(tx, {
        client: tenant.client,
        objectCode: 'JOURNAL_ENTRY',
        companyCode: tenant.companyCode,
        subObject: 'GENERAL',
        fiscalYear,
        allocatedBy: 'TEST',
      }),
    );
    // READABLE style: prefix-year-padded number.
    expect(allocated.display).toMatch(new RegExp(`^JE-${fiscalYear}-\\d{6}$`));
  });

  it('gives every concurrent caller a unique number, leaving no gaps', async () => {
    const COUNT = 40;

    const results = await Promise.all(
      Array.from({ length: COUNT }, () =>
        withTenant(tenant.client, (tx) =>
          allocateNumber(tx, {
            client: tenant.client,
            objectCode: 'JOURNAL_ENTRY',
            companyCode: tenant.companyCode,
            subObject: 'GENERAL',
            fiscalYear,
            allocatedBy: 'CONCURRENT',
          }),
        ),
      ),
    );

    const values = results.map((r) => r.value).sort((a, b) => a - b);

    // No duplicates — the property that a naive read-then-write would break.
    expect(new Set(values).size).toBe(COUNT);

    // No gaps — every consecutive pair differs by exactly one.
    for (let i = 1; i < values.length; i++) {
      expect(values[i] - values[i - 1]).toBe(1);
    }
  });

  it('consumes no number when the transaction rolls back', async () => {
    const before = await currentCounter(tenant);

    // Allocate inside a transaction, then deliberately fail it.
    await expect(
      withTenant(tenant.client, async (tx) => {
        await allocateNumber(tx, {
          client: tenant.client,
          objectCode: 'JOURNAL_ENTRY',
          companyCode: tenant.companyCode,
          subObject: 'GENERAL',
          fiscalYear,
          allocatedBy: 'TEST',
        });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    const after = await currentCounter(tenant);

    // The counter is exactly where it was: the number was released, not burned.
    // This is what makes a gap evidence of tampering rather than evidence of failure.
    expect(after).toBe(before);

    // And the next allocation reuses that number, so no gap appears in the sequence.
    const next = await withTenant(tenant.client, (tx) =>
      allocateNumber(tx, {
        client: tenant.client,
        objectCode: 'JOURNAL_ENTRY',
        companyCode: tenant.companyCode,
        subObject: 'GENERAL',
        fiscalYear,
        allocatedBy: 'TEST',
      }),
    );
    expect(next.value).toBe(before + 1);
  });

  it('explains an exhausted range instead of failing obscurely', async () => {
    const small = await createTenant('numbering-small');
    try {
      await withTenant(small.client, (tx) =>
        defineTestRanges0(tx, small.client, fiscalYear),
      );

      // Drain the two-number range.
      await withTenant(small.client, (tx) =>
        allocateNumber(tx, {
          client: small.client,
          objectCode: 'JOURNAL_ENTRY',
          subObject: EXHAUST_SUB_OBJECT,
          fiscalYear,
          allocatedBy: 'TEST',
        }),
      );
      await withTenant(small.client, (tx) =>
        allocateNumber(tx, {
          client: small.client,
          objectCode: 'JOURNAL_ENTRY',
          subObject: EXHAUST_SUB_OBJECT,
          fiscalYear,
          allocatedBy: 'TEST',
        }),
      );

      const error = (await withTenant(small.client, (tx) =>
        allocateNumber(tx, {
          client: small.client,
          objectCode: 'JOURNAL_ENTRY',
          subObject: EXHAUST_SUB_OBJECT,
          fiscalYear,
          allocatedBy: 'TEST',
        }),
      ).catch((e) => e)) as NumberRangeError;

      expect(error).toBeInstanceOf(NumberRangeError);
      expect(error.message).toContain('exhausted');
      // The remedy names the screen, so a user knows where to go.
      expect(error.remedy).toContain('CFG.PLT.NUMBERRANGE.DEFINE');
    } finally {
      await destroyTenant(small.client);
    }
  });

  it('reports range state for the monitor', async () => {
    const ranges = await withTenant(tenant.client, (tx) =>
      rangeStatus(tx, tenant.client, 'JOURNAL_ENTRY'),
    );
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges[0].currentNumber).toBeGreaterThan(0);
  });
});

async function currentCounter(t: TestTenant): Promise<number> {
  const ranges = await withTenant(t.client, (tx) =>
    rangeStatus(tx, t.client, 'JOURNAL_ENTRY'),
  );
  return Number(ranges[0].currentNumber);
}

/**
 * A deliberately tiny range, to exercise exhaustion.
 *
 * It uses its own document type rather than reusing 'SA', so the test is
 * self-contained: a leftover range from an earlier run cannot make the drain
 * start from an exhausted position, which is a failure that would look like a
 * product defect and is not one.
 */
import { defineRange } from '@/platform/numbering';
import type { Tx } from '@/platform/db/client';

const EXHAUST_SUB_OBJECT = 'ZZ';

async function defineTestRanges0(tx: Tx, client: string, fiscalYear: number) {
  await defineRange(tx, {
    client,
    objectCode: 'JOURNAL_ENTRY',
    subObject: EXHAUST_SUB_OBJECT,
    fiscalYear,
    prefix: 'ZZ',
    fromNumber: 1,
    toNumber: 2,
    createdBy: 'TEST',
  });
}
