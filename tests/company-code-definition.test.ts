/** Create-only Company Code definition and separate §6.2 assignments. */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenant, closeDb } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { companyCode } from '@/modules/foundation/schema';
import {
  CompanyCodeDefinitionError,
  defineCompanyCode,
} from '@/modules/foundation/company-code-definition';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const tenant: TestTenant = await createTenant('ccdefine');
await withTenant(tenant.client, (tx) =>
  tx.insert(configActivityStatus).values({
    client: tenant.client,
    activityCode: 'CFG.ORG.COMPANYCODE.DEFINE',
    status: 'NOT_STARTED',
    createdBy: 'TEST',
  }).onConflictDoNothing(),
);
const definedCode = '2000';
const definition = {
  client: tenant.client,
  changedBy: 'B108_TEST',
  companyCode: definedCode,
  name: 'Second company',
  country: 'KW',
  currency: 'KWD',
  city: 'Al Jahra',
  taxRegistrationNumber: 'TAX-2000',
};

afterAll(async () => {
  await withTenant(tenant.client, (tx) =>
    tx.delete(companyCode).where(
      and(
        eq(companyCode.client, tenant.client),
        eq(companyCode.companyCode, definedCode),
      ),
    ),
  );
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('create-only Company Code definition', () => {
  it('creates a tenant-scoped, audited Company Code with all three assignments unset', async () => {
    const result = await defineCompanyCode(definition);
    expect(result).toEqual({ created: true, companyCode: definedCode });

    const row = await withTenant(tenant.client, async (tx) =>
      (await tx.select().from(companyCode).where(
        and(
          eq(companyCode.client, tenant.client),
          eq(companyCode.companyCode, definedCode),
        ),
      ))[0],
    );
    expect(row).toMatchObject({
      companyCode: definedCode,
      name: 'Second company',
      country: 'KW',
      currency: 'KWD',
      city: 'Al Jahra',
      taxRegistrationNumber: 'TAX-2000',
      chartOfAccounts: null,
      fiscalYearVariant: null,
      postingPeriodVariant: null,
      createdBy: 'B108_TEST',
    });

    const [history, activity] = await withTenant(tenant.client, async (tx) =>
      Promise.all([
        changeHistory(tx, tenant.client, 'company_code', definedCode),
        tx.select().from(configActivityStatus).where(
          and(
            eq(configActivityStatus.client, tenant.client),
            eq(configActivityStatus.activityCode, 'CFG.ORG.COMPANYCODE.DEFINE'),
          ),
        ),
      ]),
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      changeType: 'CREATE',
      changedBy: 'B108_TEST',
      transactionCode: 'CFG.ORG.COMPANYCODE.DEFINE',
    });
    expect(activity[0]).toMatchObject({ status: 'COMPLETED', completedBy: 'B108_TEST' });
  });

  it('refuses duplicates without overwriting the existing definition or assignments', async () => {
    await expect(
      defineCompanyCode({ ...definition, name: 'Attempted overwrite', country: 'US', currency: 'USD' }),
    ).rejects.toBeInstanceOf(CompanyCodeDefinitionError);

    const [row] = await withTenant(tenant.client, (tx) =>
      tx.select().from(companyCode).where(
        and(
          eq(companyCode.client, tenant.client),
          eq(companyCode.companyCode, definedCode),
        ),
      ),
    );
    expect(row).toMatchObject({
      name: 'Second company',
      country: 'KW',
      currency: 'KWD',
      chartOfAccounts: null,
      fiscalYearVariant: null,
      postingPeriodVariant: null,
    });
    expect(await withTenant(tenant.client, (tx) =>
      changeHistory(tx, tenant.client, 'company_code', definedCode),
    )).toHaveLength(1);
  });

  it('requires existing country and active currency reference rows', async () => {
    await expect(
      defineCompanyCode({ ...definition, companyCode: '2001', country: 'ZZ' }),
    ).rejects.toThrow(/Country ZZ is not in the reference catalogue/);
    await expect(
      defineCompanyCode({ ...definition, companyCode: '2002', currency: 'ZZZ' }),
    ).rejects.toThrow(/Currency ZZZ is not active in the reference catalogue/);

    const failedCodes = await withTenant(tenant.client, (tx) =>
      tx.select({ code: companyCode.companyCode }).from(companyCode).where(
        and(
          eq(companyCode.client, tenant.client),
          eq(companyCode.companyCode, '2001'),
        ),
      ),
    );
    expect(failedCodes).toEqual([]);
  });
});
