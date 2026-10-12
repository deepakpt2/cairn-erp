import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenant, closeDb } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { chartOfAccounts, companyCode } from '@/modules/foundation/schema';
import { defineCompanyCode } from '@/modules/foundation/company-code-definition';
import {
  assignCompanyCodeCoa,
  CompanyCodeCoaAssignmentError,
} from '@/modules/foundation/company-code-coa-assignment';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const DEFINE_ACTIVITY = 'CFG.ORG.COMPANYCODE.DEFINE';
const COA_DEFINE_ACTIVITY = 'CFG.FIN.COA.DEFINE';
const ASSIGN_ACTIVITY = 'CFG.ORG.COMPANYCODE.ASSIGN_COA';
const TEST_ACTOR = 'B113_TEST';

let tenant: TestTenant | undefined;
let otherTenant: TestTenant | undefined;
const companyCodes = ['2000', '2001', '2002', '2003', '2004'];

function currentTenant(): TestTenant {
  if (!tenant) throw new Error('B-113 tenant fixture was not initialized.');
  return tenant;
}

async function defineUnassignedCompanyCode(code: string) {
  const fixture = currentTenant();
  await defineCompanyCode({
    client: fixture.client,
    changedBy: TEST_ACTOR,
    companyCode: code,
    name: `B-113 test company ${code}`,
    country: 'KW',
    currency: fixture.currency,
  });
}

async function setActivityStatus(activityCode: string, status: 'NOT_STARTED' | 'COMPLETED') {
  const fixture = currentTenant();
  await withTenant(fixture.client, (tx) =>
    tx.update(configActivityStatus)
      .set({
        status,
        completedAt: status === 'COMPLETED' ? new Date() : null,
        completedBy: status === 'COMPLETED' ? TEST_ACTOR : null,
        changedBy: TEST_ACTOR,
        changedAt: new Date(),
      })
      .where(
        and(
          eq(configActivityStatus.client, fixture.client),
          eq(configActivityStatus.activityCode, activityCode),
        ),
      ),
  );
}

async function readCompanyCode(code: string) {
  const fixture = currentTenant();
  return withTenant(fixture.client, async (tx) =>
    (await tx.select().from(companyCode).where(
      and(eq(companyCode.client, fixture.client), eq(companyCode.companyCode, code)),
    ))[0] ?? null,
  );
}

async function readCompanyCodeHistory(code: string) {
  const fixture = currentTenant();
  return withTenant(fixture.client, (tx) =>
    changeHistory(tx, fixture.client, 'company_code', code),
  );
}

beforeAll(async () => {
  tenant = await createTenant('b113-coa-assignment-a');
  otherTenant = await createTenant('b113-coa-assignment-b');

  const setupCompletedAt = new Date();
  await withTenant(tenant.client, (tx) =>
    tx.insert(configActivityStatus).values([
      {
        client: tenant!.client,
        activityCode: DEFINE_ACTIVITY,
        status: 'COMPLETED',
        completedAt: setupCompletedAt,
        completedBy: TEST_ACTOR,
        createdBy: TEST_ACTOR,
      },
      {
        client: tenant!.client,
        activityCode: COA_DEFINE_ACTIVITY,
        status: 'COMPLETED',
        completedAt: setupCompletedAt,
        completedBy: TEST_ACTOR,
        createdBy: TEST_ACTOR,
      },
      {
        client: tenant!.client,
        activityCode: ASSIGN_ACTIVITY,
        status: 'NOT_STARTED',
        createdBy: TEST_ACTOR,
      },
    ]).onConflictDoNothing(),
  );

  for (const code of companyCodes) await defineUnassignedCompanyCode(code);

  await withTenant(tenant.client, (tx) =>
    tx.insert(chartOfAccounts).values([
      {
        client: tenant!.client,
        chartOfAccounts: 'ALT',
        name: 'B-113 alternate active chart',
        language: 'EN',
        accountNumberLength: 6,
        isActive: true,
        createdBy: TEST_ACTOR,
      },
      {
        client: tenant!.client,
        chartOfAccounts: 'OFF',
        name: 'B-113 inactive chart',
        language: 'EN',
        accountNumberLength: 6,
        isActive: false,
        createdBy: TEST_ACTOR,
      },
    ]),
  );

  await withTenant(otherTenant.client, (tx) =>
    tx.insert(chartOfAccounts).values({
      client: otherTenant!.client,
      chartOfAccounts: 'REMOTE',
      name: 'B-113 other-tenant chart',
      language: 'EN',
      accountNumberLength: 6,
      isActive: true,
      createdBy: TEST_ACTOR,
    }),
  );

  // Exercise real SCR-013 completion rather than inheriting the standard-package fixture.
  await setActivityStatus(ASSIGN_ACTIVITY, 'NOT_STARTED');
}, 30_000);

afterAll(async () => {
  try {
    if (tenant) await destroyTenant(tenant.client);
  } finally {
    try {
      if (otherTenant) await destroyTenant(otherTenant.client);
    } finally {
      await closeDb();
    }
  }
});

describe('protected initial Company Code CoA assignment', () => {
  it('assigns only the CoA, records security-relevant history and completes SCR-013 atomically', async () => {
    const fixture = currentTenant();
    const result = await assignCompanyCodeCoa({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      companyCode: '2000',
      chartOfAccounts: 'CAIRN',
    });

    expect(result).toEqual({ assigned: true, companyCode: '2000', chartOfAccounts: 'CAIRN' });
    expect(await readCompanyCode('2000')).toMatchObject({
      chartOfAccounts: 'CAIRN',
      fiscalYearVariant: null,
      postingPeriodVariant: null,
      changedBy: TEST_ACTOR,
    });

    const history = await readCompanyCodeHistory('2000');
    expect(history).toHaveLength(2); // original definition plus one assignment event
    const assignmentEvent = history.find((event) => event.transactionCode === ASSIGN_ACTIVITY);
    expect(assignmentEvent).toBeDefined();
    expect(assignmentEvent?.changeType).toBe('CHANGE');
    expect(assignmentEvent?.changedBy).toBe(TEST_ACTOR);
    expect(assignmentEvent?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldName: 'chartOfAccounts',
          oldValue: null,
          newValue: 'CAIRN',
          isSecurityRelevant: 'true',
        }),
      ]),
    );

    const [activity] = await withTenant(fixture.client, (tx) =>
      tx.select().from(configActivityStatus).where(
        and(
          eq(configActivityStatus.client, fixture.client),
          eq(configActivityStatus.activityCode, ASSIGN_ACTIVITY),
        ),
      ),
    );
    expect(activity).toMatchObject({ status: 'COMPLETED', completedBy: TEST_ACTOR });
  });

  it('makes the same assignment idempotent and refuses a different CoA without adding history', async () => {
    const fixture = currentTenant();
    await expect(assignCompanyCodeCoa({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      companyCode: '2000',
      chartOfAccounts: 'CAIRN',
    })).resolves.toEqual({ assigned: false, companyCode: '2000', chartOfAccounts: 'CAIRN' });

    await expect(assignCompanyCodeCoa({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      companyCode: '2000',
      chartOfAccounts: 'ALT',
    })).rejects.toBeInstanceOf(CompanyCodeCoaAssignmentError);

    expect((await readCompanyCode('2000'))?.chartOfAccounts).toBe('CAIRN');
    expect(await readCompanyCodeHistory('2000')).toHaveLength(2);
  });

  it('denies missing Company Codes and missing, inactive, or cross-tenant charts without mutation', async () => {
    const fixture = currentTenant();
    await expect(assignCompanyCodeCoa({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      companyCode: '9999',
      chartOfAccounts: 'CAIRN',
    })).rejects.toThrow(/does not exist in this tenant/);

    for (const [code, chart, message] of [
      ['2001', 'MISSING', /not defined in this tenant/],
      ['2002', 'OFF', /not defined in this tenant/],
      ['2003', 'REMOTE', /not defined in this tenant/],
    ] as const) {
      await expect(assignCompanyCodeCoa({
        client: fixture.client,
        changedBy: TEST_ACTOR,
        companyCode: code,
        chartOfAccounts: chart,
      })).rejects.toThrow(message);
      expect((await readCompanyCode(code))?.chartOfAccounts).toBeNull();
      expect(await readCompanyCodeHistory(code)).toHaveLength(1); // definition only
    }
  });

  it('fails closed until both Company Code definition and CoA definition are complete', async () => {
    const fixture = currentTenant();
    for (const prerequisite of [DEFINE_ACTIVITY, COA_DEFINE_ACTIVITY]) {
      await setActivityStatus(prerequisite, 'NOT_STARTED');
      try {
        await expect(assignCompanyCodeCoa({
          client: fixture.client,
          changedBy: TEST_ACTOR,
          companyCode: '2004',
          chartOfAccounts: 'CAIRN',
        })).rejects.toThrow(prerequisite);
        expect((await readCompanyCode('2004'))?.chartOfAccounts).toBeNull();
        expect(await readCompanyCodeHistory('2004')).toHaveLength(1);
      } finally {
        await setActivityStatus(prerequisite, 'COMPLETED');
      }
    }
  });
});
