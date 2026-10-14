import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { changeHistory } from '@/platform/change';
import { closeDb, withTenant } from '@/platform/db/client';
import { configActivityStatus } from '@/platform/tables/registry';
import {
  division,
  salesArea,
  salesOrg,
  salesOrgDivision,
} from '@/modules/foundation/schema';
import {
  assignSalesOrgDivision,
  listSalesOrgDivisionAssignments,
  salesOrgDivisionF4Choices,
  unassignSalesOrgDivision,
} from '@/modules/foundation/sales-org-division-assignment';
import {
  deactivateDivision,
  saveDivisionDefinition,
} from '@/modules/foundation/distribution-channel-division-maintenance';
import {
  deactivateSalesOrg,
  saveSalesOrgDefinition,
} from '@/modules/foundation/sales-organization-maintenance';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const SALES_ORG_ACTIVITY = 'CFG.ORG.SALESORG.DEFINE';
const DIVISION_ACTIVITY = 'CFG.ORG.DIVISION.DEFINE';
const ASSIGNMENT_ACTIVITY = 'CFG.ORG.SALESORG.ASSIGN_DIVISION';
const ACTOR = 'OVXA_ASSIGN_TEST';

let alpha: TestTenant | undefined;
let beta: TestTenant | undefined;

function primaryTenant(): TestTenant {
  if (!alpha) throw new Error('OVXA primary tenant fixture was not initialized.');
  return alpha;
}

function secondaryTenant(): TestTenant {
  if (!beta) throw new Error('OVXA secondary tenant fixture was not initialized.');
  return beta;
}

async function setActivity(client: string, activityCode: string, status: 'NOT_STARTED' | 'COMPLETED') {
  await withTenant(client, async (tx) => {
    await tx.insert(configActivityStatus).values({
      client,
      activityCode,
      status: 'NOT_STARTED',
      createdBy: ACTOR,
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

async function setPrerequisites(client: string, status: 'NOT_STARTED' | 'COMPLETED' = 'COMPLETED') {
  await setActivity(client, SALES_ORG_ACTIVITY, status);
  await setActivity(client, DIVISION_ACTIVITY, status);
  await setActivity(client, ASSIGNMENT_ACTIVITY, 'NOT_STARTED');
}

async function defineSalesOrg(client: string, code: string) {
  await saveSalesOrgDefinition({
    client,
    changedBy: ACTOR,
    mode: 'CREATE',
    salesOrg: code,
    expectedVersion: 0,
    values: { name: `OVXA Sales Org ${code}`, address: { country: 'KW' } },
  });
}

async function defineDivision(client: string, code: string) {
  await saveDivisionDefinition({
    client,
    changedBy: ACTOR,
    mode: 'CREATE',
    division: code,
    expectedVersion: 0,
    values: { name: `OVXA Division ${code}` },
  });
}

async function readPair(client: string, org: string, div: string) {
  return withTenant(client, async (tx) =>
    (await tx.select().from(salesOrgDivision).where(and(
      eq(salesOrgDivision.client, client),
      eq(salesOrgDivision.salesOrg, org),
      eq(salesOrgDivision.division, div),
    )))[0] ?? null,
  );
}

async function readHistory(client: string, org: string, div: string) {
  return withTenant(client, (tx) => changeHistory(tx, client, 'sales_org_division', `${org}/${div}`));
}

async function readAssignmentActivity(client: string) {
  return withTenant(client, async (tx) =>
    (await tx.select().from(configActivityStatus).where(and(
      eq(configActivityStatus.client, client),
      eq(configActivityStatus.activityCode, ASSIGNMENT_ACTIVITY),
    )))[0] ?? null,
  );
}

beforeAll(async () => {
  alpha = await createTenant('ovxa-division-assign-alpha');
  beta = await createTenant('ovxa-division-assign-beta');
  for (const tenant of [alpha, beta]) await setPrerequisites(tenant.client);
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

describe('OVXA Sales Organization / Division assignment on the static test database', () => {
  it('seeds the standard pair before its Sales Area and retains the setup change document', async () => {
    const tenant = primaryTenant();
    const pair = await readPair(tenant.client, '1000', '01');
    expect(pair).toMatchObject({
      client: tenant.client,
      salesOrg: '1000',
      division: '01',
      createdBy: 'TEST',
    });
    const area = await withTenant(tenant.client, async (tx) =>
      (await tx.select().from(salesArea).where(and(
        eq(salesArea.client, tenant.client),
        eq(salesArea.salesOrg, '1000'),
        eq(salesArea.division, '01'),
      )))[0] ?? null,
    );
    expect(area).not.toBeNull();
    const history = await readHistory(tenant.client, '1000', '01');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      changeType: 'CREATE',
      changedBy: 'TEST',
      transactionCode: ASSIGNMENT_ACTIVITY,
    });
    expect(history[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: 'salesOrg', newValue: '1000', isSecurityRelevant: 'true' }),
      expect.objectContaining({ fieldName: 'division', newValue: '01', isSecurityRelevant: 'true' }),
    ]));
  });

  it('validates exact field widths and supplies active tenant-local F4 choices', async () => {
    const tenant = primaryTenant();
    await expect(assignSalesOrgDivision({
      client: tenant.client, changedBy: ACTOR, salesOrg: '100', division: '02',
    })).rejects.toThrow(/Sales Organization must be four uppercase alphanumeric characters/);
    await expect(assignSalesOrgDivision({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', division: '2',
    })).rejects.toThrow(/Division must be two uppercase alphanumeric characters/);

    await defineSalesOrg(tenant.client, 'S911');
    await deactivateSalesOrg({
      client: tenant.client, changedBy: ACTOR, salesOrg: 'S911', expectedVersion: 1,
      reason: 'OVXA inactive F4 fixture',
    });
    await defineDivision(tenant.client, 'D9');
    await deactivateDivision({
      client: tenant.client, changedBy: ACTOR, division: 'D9', expectedVersion: 1,
      reason: 'OVXA inactive F4 fixture',
    });

    const choices = await salesOrgDivisionF4Choices(tenant.client);
    expect(choices.salesOrganizations).toContain('1000');
    expect(choices.salesOrganizations).not.toContain('S911');
    expect(choices.divisions.map((item) => item.code)).toEqual(expect.arrayContaining(['01', '02', '03']));
    expect(choices.divisions.map((item) => item.code)).not.toContain('D9');
    await expect(assignSalesOrgDivision({
      client: tenant.client, changedBy: ACTOR, salesOrg: 'S911', division: '02',
    })).rejects.toThrow(/Sales Organization S911 is inactive/);
    await expect(assignSalesOrgDivision({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', division: 'D9',
    })).rejects.toThrow(/Division D9 is inactive/);
  });

  it('requires both definition activities before accepting even a duplicate assignment', async () => {
    const tenant = primaryTenant();
    await setActivity(tenant.client, DIVISION_ACTIVITY, 'NOT_STARTED');
    await expect(assignSalesOrgDivision({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', division: '01',
    })).rejects.toThrow(/OVXA prerequisites are incomplete: CFG.ORG.DIVISION.DEFINE/);
    await expect(readAssignmentActivity(tenant.client)).resolves.toMatchObject({ status: 'NOT_STARTED' });
    await setActivity(tenant.client, DIVISION_ACTIVITY, 'COMPLETED');
  });

  it('creates a pair once, treats repeats as no-ops, and retains create/delete history', async () => {
    const tenant = primaryTenant();
    const code = { salesOrg: '1000', division: '02' };

    const results = await Promise.all([
      assignSalesOrgDivision({ client: tenant.client, changedBy: ACTOR, ...code }),
      assignSalesOrgDivision({ client: tenant.client, changedBy: ACTOR, ...code }),
    ]);
    expect(results.filter((result) => result.assigned)).toHaveLength(1);
    expect(results.filter((result) => !result.assigned)).toHaveLength(1);
    expect(await readPair(tenant.client, code.salesOrg, code.division)).toMatchObject({
      client: tenant.client, ...code, createdBy: ACTOR,
    });
    expect(await readHistory(tenant.client, code.salesOrg, code.division)).toHaveLength(1);
    expect(await readAssignmentActivity(tenant.client)).toMatchObject({ status: 'COMPLETED', completedBy: ACTOR });

    const assignments = await listSalesOrgDivisionAssignments(tenant.client);
    expect(assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ salesOrg: '1000', division: '02', divisionName: 'Traded goods', divisionActive: true }),
    ]));

    const removed = await unassignSalesOrgDivision({ client: tenant.client, changedBy: ACTOR, ...code });
    expect(removed).toMatchObject({ removed: true, ...code });
    expect(await readPair(tenant.client, code.salesOrg, code.division)).toBeNull();
    const history = await readHistory(tenant.client, code.salesOrg, code.division);
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.changeType).sort()).toEqual(['CREATE', 'DELETE']);
    expect(history.find((entry) => entry.changeType === 'DELETE')).toMatchObject({
      changedBy: ACTOR, transactionCode: ASSIGNMENT_ACTIVITY,
    });
    await expect(unassignSalesOrgDivision({ client: tenant.client, changedBy: ACTOR, ...code }))
      .rejects.toThrow(/is not assigned to Sales Organization/);
  });

  it('blocks removal when any Sales Area uses the same pair across any channel, even if inactive', async () => {
    const tenant = primaryTenant();
    const pair = { salesOrg: '1000', division: '03' };
    await assignSalesOrgDivision({ client: tenant.client, changedBy: ACTOR, ...pair });
    await withTenant(tenant.client, (tx) => tx.insert(salesArea).values({
      client: tenant.client,
      salesOrg: pair.salesOrg,
      distributionChannel: '02',
      division: pair.division,
      name: 'OVXA cross-channel removal dependency',
      isActive: false,
      createdBy: ACTOR,
    }));

    await expect(unassignSalesOrgDivision({ client: tenant.client, changedBy: ACTOR, ...pair }))
      .rejects.toThrow(/while a Sales Area uses the pair/);
    expect(await readPair(tenant.client, pair.salesOrg, pair.division)).not.toBeNull();

    await withTenant(tenant.client, (tx) => tx.delete(salesArea).where(and(
      eq(salesArea.client, tenant.client),
      eq(salesArea.salesOrg, pair.salesOrg),
      eq(salesArea.distributionChannel, '02'),
      eq(salesArea.division, pair.division),
    )));
    await expect(unassignSalesOrgDivision({ client: tenant.client, changedBy: ACTOR, ...pair }))
      .resolves.toMatchObject({ removed: true });
  });

  it('prevents OVX5 and OVXB soft deactivation while Division assignments still depend on either definition', async () => {
    const tenant = primaryTenant();
    await defineSalesOrg(tenant.client, 'S912');
    await defineDivision(tenant.client, 'D1');
    await assignSalesOrgDivision({ client: tenant.client, changedBy: ACTOR, salesOrg: 'S912', division: 'D1' });

    await expect(deactivateSalesOrg({
      client: tenant.client, changedBy: ACTOR, salesOrg: 'S912', expectedVersion: 1,
      reason: 'OVXA assignment dependency',
    })).rejects.toThrow(/Division assignments and cannot be deactivated/);
    await expect(deactivateDivision({
      client: tenant.client, changedBy: ACTOR, division: 'D1', expectedVersion: 1,
      reason: 'OVXA assignment dependency',
    })).rejects.toThrow(/still assigned to one or more Sales Organizations/);

    await unassignSalesOrgDivision({ client: tenant.client, changedBy: ACTOR, salesOrg: 'S912', division: 'D1' });
    await expect(deactivateSalesOrg({
      client: tenant.client, changedBy: ACTOR, salesOrg: 'S912', expectedVersion: 1,
      reason: 'OVXA assignment removed',
    })).resolves.toMatchObject({ changed: true, isActive: false });
    await expect(deactivateDivision({
      client: tenant.client, changedBy: ACTOR, division: 'D1', expectedVersion: 1,
      reason: 'OVXA assignment removed',
    })).resolves.toMatchObject({ changed: true, isActive: false });
  });

  it('keeps assignment rows tenant-local', async () => {
    const first = primaryTenant();
    const second = secondaryTenant();
    await assignSalesOrgDivision({ client: first.client, changedBy: ACTOR, salesOrg: '1000', division: '02' });
    const secondBefore = await listSalesOrgDivisionAssignments(second.client);
    expect(secondBefore.map((row) => `${row.salesOrg}/${row.division}`)).not.toContain('1000/02');

    await assignSalesOrgDivision({ client: second.client, changedBy: ACTOR, salesOrg: '1000', division: '02' });
    expect(await readPair(first.client, '1000', '02')).not.toBeNull();
    expect(await readPair(second.client, '1000', '02')).not.toBeNull();
    expect(await listSalesOrgDivisionAssignments(first.client)).toEqual(expect.arrayContaining([
      expect.objectContaining({ salesOrg: '1000', division: '02' }),
    ]));
    expect(await listSalesOrgDivisionAssignments(second.client)).toEqual(expect.arrayContaining([
      expect.objectContaining({ salesOrg: '1000', division: '02' }),
    ]));
    expect(await withTenant(first.client, (tx) => tx.select().from(salesOrg).where(and(
      eq(salesOrg.client, first.client), eq(salesOrg.salesOrg, '1000'),
    )))).toHaveLength(1);
    expect(await withTenant(second.client, (tx) => tx.select().from(division).where(and(
      eq(division.client, second.client), eq(division.division, '02'),
    )))).toHaveLength(1);
  });
});
