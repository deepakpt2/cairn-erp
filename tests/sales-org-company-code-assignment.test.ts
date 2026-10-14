import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { changeHistory } from '@/platform/change';
import { closeDb, withTenant } from '@/platform/db/client';
import { configActivityStatus } from '@/platform/tables/registry';
import { companyCode, salesOrg } from '@/modules/foundation/schema';
import { defineCompanyCode } from '@/modules/foundation/company-code-definition';
import { deactivateSalesOrg, saveSalesOrgDefinition } from '@/modules/foundation/sales-organization-maintenance';
import { assignSalesOrgCompanyCode } from '@/modules/foundation/sales-org-company-code-assignment';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const COMPANY_ACTIVITY = 'CFG.ORG.COMPANYCODE.DEFINE';
const DEFINE_ACTIVITY = 'CFG.ORG.SALESORG.DEFINE';
const ASSIGN_ACTIVITY = 'CFG.ORG.SALESORG.ASSIGN_COMPANY';
const ACTOR = 'SCR021_ASSIGN_TEST';

let alpha: TestTenant | undefined;
let beta: TestTenant | undefined;

function primaryTenant(): TestTenant {
  if (!alpha) throw new Error('SCR-021 primary tenant fixture was not initialized.');
  return alpha;
}
function secondaryTenant(): TestTenant {
  if (!beta) throw new Error('SCR-021 second tenant fixture was not initialized.');
  return beta;
}

async function setActivity(client: string, activityCode: string, status: 'NOT_STARTED' | 'COMPLETED') {
  await withTenant(client, async (tx) => {
    await tx.insert(configActivityStatus).values({
      client, activityCode, status: 'NOT_STARTED', createdBy: ACTOR,
    }).onConflictDoNothing();
    await tx.update(configActivityStatus)
      .set({
        status,
        completedAt: status === 'COMPLETED' ? new Date() : null,
        completedBy: status === 'COMPLETED' ? ACTOR : null,
        changedBy: ACTOR,
        changedAt: new Date(),
      })
      .where(and(
        eq(configActivityStatus.client, client),
        eq(configActivityStatus.activityCode, activityCode),
      ));
  });
}

async function defineSalesOrg(client: string, code: string) {
  await saveSalesOrgDefinition({
    client,
    changedBy: ACTOR,
    mode: 'CREATE',
    salesOrg: code,
    expectedVersion: 0,
    values: { name: `SCR-021 Sales Org ${code}`, address: { country: 'KW' } },
  });
}

async function defineCompany(tenant: TestTenant, code: string) {
  await defineCompanyCode({
    client: tenant.client,
    changedBy: ACTOR,
    companyCode: code,
    name: `SCR-021 Company ${code}`,
    country: 'KW',
    currency: tenant.currency,
  });
}

async function readSalesOrg(client: string, code: string) {
  return withTenant(client, async (tx) =>
    (await tx.select().from(salesOrg).where(and(eq(salesOrg.client, client), eq(salesOrg.salesOrg, code))))[0] ?? null,
  );
}

async function readHistory(client: string, code: string) {
  return withTenant(client, (tx) => changeHistory(tx, client, 'sales_org', code));
}

async function readAssignActivity(client: string) {
  return withTenant(client, async (tx) =>
    (await tx.select().from(configActivityStatus).where(and(
      eq(configActivityStatus.client, client),
      eq(configActivityStatus.activityCode, ASSIGN_ACTIVITY),
    )))[0] ?? null,
  );
}

beforeAll(async () => {
  alpha = await createTenant('scr021-sales-org-assign-alpha');
  beta = await createTenant('scr021-sales-org-assign-beta');
  // Fixture tenants carry no activity-status rows (unlike real onboarding, which seeds one per
  // activity). The row must exist before markActivityComplete's UPDATE can act on it — otherwise
  // the definition step silently never completes and the assignment gate stays closed (B-156 class).
  for (const client of [alpha.client, beta.client]) {
    await setActivity(client, DEFINE_ACTIVITY, 'NOT_STARTED');
    await setActivity(client, COMPANY_ACTIVITY, 'COMPLETED');
    await setActivity(client, ASSIGN_ACTIVITY, 'NOT_STARTED');
  }
}, Number(process.env.CAIRN_TEST_HOOK_TIMEOUT_MS ?? 30_000));

afterAll(async () => {
  try {
    if (alpha) await destroyTenant(alpha.client);
  } finally {
    try {
      if (beta) await destroyTenant(beta.client);
    } finally {
      await closeDb();
    }
  }
});

describe('SCR-021 Sales Organization -> Company Code assignment on the test database', () => {
  it('rejects non-four-character OVX3 keys before any assignment is attempted', async () => {
    const tenant = primaryTenant();
    await expect(assignSalesOrgCompanyCode({
      client: tenant.client, changedBy: ACTOR, salesOrg: 'S21', companyCode: '2000',
    })).rejects.toThrow(/Sales Organization must be four uppercase alphanumeric characters/);
    await expect(assignSalesOrgCompanyCode({
      client: tenant.client, changedBy: ACTOR, salesOrg: 'S211', companyCode: '20000',
    })).rejects.toThrow(/Company Code must be four uppercase alphanumeric characters/);
  });

  it('assigns one active Company Code, records security-relevant history and completes SCR-021', async () => {
    const tenant = primaryTenant();
    const code = 'S211';
    await defineCompany(tenant, '2000');
    await defineSalesOrg(tenant.client, code);
    expect((await readSalesOrg(tenant.client, code))?.companyCode).toBeNull();

    const result = await assignSalesOrgCompanyCode({
      client: tenant.client,
      changedBy: ACTOR,
      salesOrg: code,
      companyCode: '2000',
    });
    expect(result).toMatchObject({ assigned: true, salesOrg: code, companyCode: '2000' });

    const stored = await readSalesOrg(tenant.client, code);
    expect(stored).toMatchObject({ companyCode: '2000', changedBy: ACTOR });
    const activity = await readAssignActivity(tenant.client);
    expect(activity).toMatchObject({ status: 'COMPLETED', completedBy: ACTOR });

    const history = await readHistory(tenant.client, code);
    expect(history).toHaveLength(2);
    const assignment = history.find((entry) => entry.transactionCode === ASSIGN_ACTIVITY);
    expect(assignment).toMatchObject({ changeType: 'CHANGE', changedBy: ACTOR });
    expect(assignment?.items.find((item) => item.fieldName === 'companyCode')).toMatchObject({
      newValue: '2000', isSecurityRelevant: 'true',
    });
  });

  it('makes the same assignment idempotent and permits an audited reassignment', async () => {
    const tenant = primaryTenant();
    const code = 'S211';
    const repeated = await assignSalesOrgCompanyCode({
      client: tenant.client,
      changedBy: ACTOR,
      salesOrg: code,
      companyCode: '2000',
    });
    expect(repeated).toMatchObject({ assigned: false, companyCode: '2000' });
    expect(await readHistory(tenant.client, code)).toHaveLength(2);

    await defineCompany(tenant, '3000');
    const reassigned = await assignSalesOrgCompanyCode({
      client: tenant.client,
      changedBy: ACTOR,
      salesOrg: code,
      companyCode: '3000',
    });
    expect(reassigned).toMatchObject({ assigned: true, reassigned: true, companyCode: '3000' });
    expect((await readSalesOrg(tenant.client, code))?.companyCode).toBe('3000');
    const afterReassignment = await readHistory(tenant.client, code);
    expect(afterReassignment).toHaveLength(3);
    const change = afterReassignment.find((entry) =>
      entry.transactionCode === ASSIGN_ACTIVITY && entry.items.some((item) => item.newValue === '3000'),
    );
    expect(change?.items.find((item) => item.fieldName === 'companyCode')).toMatchObject({
      oldValue: '2000', newValue: '3000', isSecurityRelevant: 'true',
    });

    const repeatedReplacement = await assignSalesOrgCompanyCode({
      client: tenant.client, changedBy: ACTOR, salesOrg: code, companyCode: '3000',
    });
    expect(repeatedReplacement).toMatchObject({ assigned: false, reassigned: false });
    expect(await readHistory(tenant.client, code)).toHaveLength(3);
  });

  it('refuses missing, inactive and cross-tenant targets without mutation', async () => {
    const tenant = primaryTenant();
    const other = secondaryTenant();

    await expect(assignSalesOrgCompanyCode({
      client: tenant.client, changedBy: ACTOR, salesOrg: 'ZZZZ', companyCode: '2000',
    })).rejects.toThrow(/does not exist in this tenant/);

    await defineSalesOrg(tenant.client, 'S212');
    await expect(assignSalesOrgCompanyCode({
      client: tenant.client, changedBy: ACTOR, salesOrg: 'S212', companyCode: '9999',
    })).rejects.toThrow(/Active Company Code 9999 is not defined/);

    await defineCompany(tenant, '4000');
    await withTenant(tenant.client, (tx) => tx.update(companyCode)
      .set({ isActive: false, changedBy: ACTOR, changedAt: new Date() })
      .where(and(eq(companyCode.client, tenant.client), eq(companyCode.companyCode, '4000'))));
    await expect(assignSalesOrgCompanyCode({
      client: tenant.client, changedBy: ACTOR, salesOrg: 'S212', companyCode: '4000',
    })).rejects.toThrow(/Active Company Code 4000 is not defined/);

    await defineCompany(other, '5000');
    await expect(assignSalesOrgCompanyCode({
      client: tenant.client, changedBy: ACTOR, salesOrg: 'S212', companyCode: '5000',
    })).rejects.toThrow(/Active Company Code 5000 is not defined/);

    expect((await readSalesOrg(tenant.client, 'S212'))?.companyCode).toBeNull();
    expect(await readHistory(tenant.client, 'S212')).toHaveLength(1);
  });

  it('fails closed until both definition activities are complete', async () => {
    const tenant = secondaryTenant();
    await defineCompany(tenant, '2000');
    await defineSalesOrg(tenant.client, 'S221');
    await setActivity(tenant.client, DEFINE_ACTIVITY, 'NOT_STARTED');

    await expect(assignSalesOrgCompanyCode({
      client: tenant.client, changedBy: ACTOR, salesOrg: 'S221', companyCode: '2000',
    })).rejects.toThrow(/prerequisites are incomplete: CFG.ORG.SALESORG.DEFINE/);

    await setActivity(tenant.client, DEFINE_ACTIVITY, 'COMPLETED');
    await setActivity(tenant.client, COMPANY_ACTIVITY, 'NOT_STARTED');
    await expect(assignSalesOrgCompanyCode({
      client: tenant.client, changedBy: ACTOR, salesOrg: 'S221', companyCode: '2000',
    })).rejects.toThrow(/prerequisites are incomplete: CFG.ORG.COMPANYCODE.DEFINE/);
    expect((await readSalesOrg(tenant.client, 'S221'))?.companyCode).toBeNull();
  });

  it('refuses an inactive Sales Organization even when its code is valid', async () => {
    const tenant = secondaryTenant();
    await setActivity(tenant.client, COMPANY_ACTIVITY, 'COMPLETED');
    await defineSalesOrg(tenant.client, 'S222');
    await deactivateSalesOrg({
      client: tenant.client, changedBy: ACTOR, salesOrg: 'S222', expectedVersion: 1,
      reason: 'Retire before assignment',
    });

    await expect(assignSalesOrgCompanyCode({
      client: tenant.client, changedBy: ACTOR, salesOrg: 'S222', companyCode: '2000',
    })).rejects.toThrow(/is inactive/);
    expect((await readSalesOrg(tenant.client, 'S222'))?.companyCode).toBeNull();
  });

  it('serializes concurrent choices into one current Company Code and audits both changes', async () => {
    const tenant = primaryTenant();
    const code = 'S213';
    await defineSalesOrg(tenant.client, code);
    await defineCompany(tenant, '6000');
    await defineCompany(tenant, '7000');
    await setActivity(tenant.client, ASSIGN_ACTIVITY, 'NOT_STARTED');

    const results = await Promise.allSettled([
      assignSalesOrgCompanyCode({ client: tenant.client, changedBy: ACTOR, salesOrg: code, companyCode: '6000' }),
      assignSalesOrgCompanyCode({ client: tenant.client, changedBy: ACTOR, salesOrg: code, companyCode: '7000' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0);
    const assigned = (await readSalesOrg(tenant.client, code))?.companyCode;
    expect(['6000', '7000']).toContain(assigned);
    const history = await readHistory(tenant.client, code);
    expect(history).toHaveLength(3);
    expect(history.filter((entry) => entry.transactionCode === ASSIGN_ACTIVITY)).toHaveLength(2);
  });
});
