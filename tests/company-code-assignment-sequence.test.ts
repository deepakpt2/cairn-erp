/** Company Code definition may precede the assignments in CAIRN.md §6.2. */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenant, closeDb } from '@/platform/db/client';
import { companyCode } from '@/modules/foundation/schema';
import { getCompanyCodeDetail } from '@/modules/foundation/services';
import { supplierCompanyChoices } from '@/modules/foundation/supplier-companies';
import { customerCompanyChoices } from '@/modules/foundation/customer-companies';
import { periodStatus, PeriodError } from '@/platform/periods';
import { postJournalEntry, PostingError } from '@/platform/posting';
import { journalRangeReadiness } from '@/modules/foundation/number-ranges';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const tenant: TestTenant = await createTenant('ccassignments');
const unassignedCode = 'NOASSIGN';
const year = new Date().getUTCFullYear();
const postingDate = `${year}-06-15`;

await withTenant(tenant.client, (tx) =>
  tx.insert(companyCode).values({
    client: tenant.client,
    companyCode: unassignedCode,
    name: 'Unassigned Company Code',
    chartOfAccounts: null,
    fiscalYearVariant: null,
    postingPeriodVariant: null,
    currency: 'USD',
    country: 'KW',
    createdBy: 'TEST',
  }),
);

afterAll(async () => {
  await withTenant(tenant.client, (tx) =>
    tx.delete(companyCode).where(
      and(
        eq(companyCode.client, tenant.client),
        eq(companyCode.companyCode, unassignedCode),
      ),
    ),
  );
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('unassigned Company Code behavior', () => {
  it('returns an honest read model with no chart, fiscal variant, or account count', async () => {
    const detail = await getCompanyCodeDetail(tenant.client, unassignedCode);
    expect(detail?.company.chartOfAccounts).toBeNull();
    expect(detail?.company.fiscalYearVariant).toBeNull();
    expect(detail?.company.postingPeriodVariant).toBeNull();
    expect(detail?.chartOfAccounts).toBeNull();
    expect(detail?.fiscalYearVariant).toBeNull();
    expect(detail?.accountCount).toBe(0);
  });

  it('does not offer the code for Supplier or Customer company accounting data before COA assignment', async () => {
    const supplier = await supplierCompanyChoices(tenant.client, unassignedCode);
    const customer = await customerCompanyChoices(tenant.client, unassignedCode);
    expect(supplier.selected).toBeUndefined();
    expect(supplier.companies.some((row) => row.code === unassignedCode)).toBe(false);
    expect(customer.selected).toBeUndefined();
    expect(customer.companies.some((row) => row.code === unassignedCode)).toBe(false);
  });

  it('reports incomplete assignments in journal readiness instead of treating ranges as sufficient', async () => {
    const readiness = await withTenant(tenant.client, (tx) =>
      journalRangeReadiness(tx, tenant.client, year),
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toContainEqual({
      companyCode: unassignedCode,
      subObject: 'ASSIGNMENTS',
      state: 'ASSIGNMENTS_INCOMPLETE',
    });
  });

  it('accepts a valid chart assignment on its own, while the later assignments remain pending', async () => {
    await withTenant(tenant.client, (tx) =>
      tx.update(companyCode)
        .set({ chartOfAccounts: 'CAIRN' })
        .where(
          and(
            eq(companyCode.client, tenant.client),
            eq(companyCode.companyCode, unassignedCode),
          ),
        ),
    );
    const detail = await getCompanyCodeDetail(tenant.client, unassignedCode);
    expect(detail?.company.chartOfAccounts).toBe('CAIRN');
    expect(detail?.company.fiscalYearVariant).toBeNull();
    expect(detail?.company.postingPeriodVariant).toBeNull();
    await expect(
      withTenant(tenant.client, (tx) =>
        periodStatus(tx, tenant.client, unassignedCode, year),
      ),
    ).rejects.toThrow(PeriodError);
    await withTenant(tenant.client, (tx) =>
      tx.update(companyCode)
        .set({ chartOfAccounts: null })
        .where(
          and(
            eq(companyCode.client, tenant.client),
            eq(companyCode.companyCode, unassignedCode),
          ),
        ),
    );
  });

  it('retains tenant-local reference validation for a non-null assignment', async () => {
    await expect(
      withTenant(tenant.client, (tx) =>
        tx.update(companyCode)
          .set({ chartOfAccounts: 'NOTREAL' })
          .where(
            and(
              eq(companyCode.client, tenant.client),
              eq(companyCode.companyCode, unassignedCode),
            ),
          ),
      ),
    ).rejects.toThrow(/CAIRN_CONFIG_MISSING/);
  });

  it('blocks period status until all three assignments are complete', async () => {
    await expect(
      withTenant(tenant.client, (tx) =>
        periodStatus(tx, tenant.client, unassignedCode, year),
      ),
    ).rejects.toThrow(PeriodError);
  });

  it('blocks posting before allocating a number or writing a journal entry', async () => {
    await expect(
      withTenant(tenant.client, (tx) =>
        postJournalEntry(tx, {
          client: tenant.client,
          companyCode: unassignedCode,
          documentType: 'SA',
          documentDate: postingDate,
          postingDate,
          fiscalYear: year,
          postingPeriod: 6,
          currency: 'USD',
          localCurrency: 'USD',
          postedBy: 'TEST',
          lines: [
            { glAccount: '510000', debitCredit: 'S', amount: '100.0000' },
            { glAccount: '200000', debitCredit: 'H', amount: '100.0000' },
          ],
        }),
      ),
    ).rejects.toThrow(PostingError);
  });
});
