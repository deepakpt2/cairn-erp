/**
 * Posting period control — CAIRN.md §14.3
 *
 * The rule under test: a posting to a closed period is refused, and the refusal
 * explains which period is closed and how to reopen it. This is the seam that was
 * a documented pass-through in M1a; it is now real, so it needs real tests.
 *
 * The most valuable case here is the last one: a vendor line and a general ledger
 * line in the same document, where only one of the two account types is closed.
 * That is the situation the account-type design exists for, and the one a simpler
 * implementation would get wrong.
 */
import { describe, expect, it, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenant, closeDb } from '@/platform/db/client';
import { postJournalEntry, PostingError } from '@/platform/posting';
import { derivePosition, periodStatus, PeriodError } from '@/platform/periods';
import { postingPeriodRule } from '@/modules/foundation/schema';
import { createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';

const tenant: TestTenant = await createTenant('periods');
await defineTestRanges(tenant);

// The fixture already applied the standard configuration package, so the accounts
// and period rules below are the real ones a user would have.

const fiscalYear = new Date().getUTCFullYear();
const openDate = `${fiscalYear}-06-15`;
const openPeriod = 6;

afterAll(async () => {
  await destroyTenant(tenant.client);
  await closeDb();
});

function post(overrides: Partial<Parameters<typeof postJournalEntry>[1]> = {}) {
  return withTenant(tenant.client, (tx) =>
    postJournalEntry(tx, {
      client: tenant.client,
      companyCode: tenant.companyCode,
      documentType: 'SA',
      documentDate: openDate,
      postingDate: openDate,
      fiscalYear,
      postingPeriod: openPeriod,
      currency: 'USD',
      localCurrency: 'USD',
      postedBy: 'TEST',
      lines: [
        { glAccount: '510000', debitCredit: 'S', amount: '100.0000', costCenter: 'CC-1000' },
        { glAccount: '200000', debitCredit: 'H', amount: '100.0000' },
      ],
      ...overrides,
    }),
  );
}

describe('fiscal year derivation', () => {
  it('maps a calendar-year date to the right period', async () => {
    for (const [date, expected] of [
      [`${fiscalYear}-01-01`, 1],
      [`${fiscalYear}-03-15`, 3],
      [`${fiscalYear}-06-30`, 6],
      [`${fiscalYear}-12-31`, 12],
    ] as Array<[string, number]>) {
      const position = await withTenant(tenant.client, (tx) =>
        derivePosition(tx, tenant.client, 'K4', date),
      );
      expect(position.period, `date ${date}`).toBe(expected);
      expect(position.fiscalYear).toBe(fiscalYear);
      expect(position.periodType).toBe('REGULAR');
    }
  });

  it('covers every day of the year, with no gaps', async () => {
    // A fiscal year variant with a hole in it would surface months later as
    // "no period found for 15 March", which tells the user nothing.
    for (let month = 1; month <= 12; month++) {
      for (const day of [1, 15, 28]) {
        const date = `${fiscalYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const position = await withTenant(tenant.client, (tx) =>
          derivePosition(tx, tenant.client, 'K4', date),
        );
        expect(position.period, date).toBe(month);
      }
    }
  });

  it('refuses a date that falls outside the variant', async () => {
    const error = (await withTenant(tenant.client, (tx) =>
      derivePosition(tx, tenant.client, 'K4', 'not-a-date'),
    ).catch((e) => e)) as PeriodError;

    expect(error).toBeInstanceOf(PeriodError);
  });
});

describe('posting period control', () => {
  it('posts to an open period', async () => {
    const result = await post();
    expect(result.debitTotal).toBe('100.0000');
  });

  it('refuses a document whose period disagrees with its posting date', async () => {
    const error = (await post({ postingPeriod: 11 }).catch((e) => e)) as PostingError;

    expect(error).toBeInstanceOf(PostingError);
    expect(error.message).toContain('belongs to period 6');
    expect(error.message).toContain('specifies period 11');
    expect(error.remedy).toContain('agree');
  });

  it('refuses a document whose fiscal year disagrees with its posting date', async () => {
    const error = (await post({ fiscalYear: fiscalYear + 5 }).catch((e) => e)) as PostingError;

    expect(error).toBeInstanceOf(PostingError);
    expect(error.message).toContain(`belongs to fiscal year ${fiscalYear}`);
  });

  it('refuses posting to a closed period, naming the open range', async () => {
    // Close periods 1 to 5 for the general ledger.
    await withTenant(tenant.client, (tx) =>
      tx
        .update(postingPeriodRule)
        .set({ periodFrom: 6, periodTo: 12 })
        .where(
          and(
            eq(postingPeriodRule.client, tenant.client),
            eq(postingPeriodRule.variant, 'C001'),
            eq(postingPeriodRule.accountType, 'S'),
          ),
        ),
    );

    const error = (await post({
      postingDate: `${fiscalYear}-02-10`,
      postingPeriod: 2,
      documentDate: `${fiscalYear}-02-10`,
    }).catch((e) => e)) as PostingError;

    expect(error).toBeInstanceOf(PostingError);
    expect(error.message).toContain('Period 2');
    expect(error.message).toContain('closed');
    expect(error.message).toContain('Open periods are 6 to 12');
    expect(error.remedy).toContain('FIN.CLOSE.PERIOD');
  });

  it('refuses a vendor line when only the vendor account type is closed', async () => {
    // General ledger stays open all year; vendor periods close at period 6.
    await withTenant(tenant.client, (tx) =>
      tx
        .update(postingPeriodRule)
        .set({ periodFrom: 1, periodTo: 12 })
        .where(
          and(
            eq(postingPeriodRule.client, tenant.client),
            eq(postingPeriodRule.variant, 'C001'),
            eq(postingPeriodRule.accountType, 'S'),
          ),
        ),
    );
    await withTenant(tenant.client, (tx) =>
      tx
        .update(postingPeriodRule)
        .set({ periodFrom: 1, periodTo: 6 })
        .where(
          and(
            eq(postingPeriodRule.client, tenant.client),
            eq(postingPeriodRule.variant, 'C001'),
            eq(postingPeriodRule.accountType, 'K'),
          ),
        ),
    );

    // Account 200000 is the vendor reconciliation account, so this document
    // carries a K line even though both accounts are ordinary G/L accounts.
    const error = (await post({
      postingDate: `${fiscalYear}-09-10`,
      postingPeriod: 9,
      documentDate: `${fiscalYear}-09-10`,
    }).catch((e) => e)) as PostingError;

    expect(error).toBeInstanceOf(PostingError);
    expect(error.message).toContain('Vendor');
    expect(error.message).toContain('Period 9');

    // The same date is fine for a document that touches no vendor account.
    const allowed = await post({
      postingDate: `${fiscalYear}-09-11`,
      postingPeriod: 9,
      documentDate: `${fiscalYear}-09-11`,
      lines: [
        { glAccount: '510000', debitCredit: 'S', amount: '50.0000', costCenter: 'CC-1000' },
        { glAccount: '210000', debitCredit: 'H', amount: '50.0000' },
      ],
    });
    expect(allowed.debitTotal).toBe('50.0000');
  });

  it('refuses a document that names an account which does not exist', async () => {
    const error = (await post({
      lines: [
        { glAccount: '999999', debitCredit: 'S', amount: '10.0000' },
        { glAccount: '200000', debitCredit: 'H', amount: '10.0000' },
      ],
    }).catch((e) => e)) as PostingError;

    expect(error).toBeInstanceOf(PostingError);
    expect(error.message).toContain('999999');
    expect(error.message).toContain('does not exist');
    expect(error.remedy).toContain('FIN.GL.MASTER.CREATE');
  });

  it('reports the open-period picture for the close cockpit', async () => {
    const status = await withTenant(tenant.client, (tx) =>
      periodStatus(tx, tenant.client, tenant.companyCode, fiscalYear),
    );

    expect(status.fiscalYearVariant).toBe('K4');
    expect(status.regularPeriods).toBe(12);
    expect(status.specialPeriods).toBe(4);
    expect(status.rules.length).toBeGreaterThanOrEqual(5);

    const generalLedger = status.rules.find((r) => r.accountType === 'S');
    expect(generalLedger?.allowSpecialPeriods).toBe(true);

    const vendor = status.rules.find((r) => r.accountType === 'K');
    expect(vendor?.allowSpecialPeriods).toBe(false);
  });
});
