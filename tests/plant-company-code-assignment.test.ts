import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { changeHistory } from '@/platform/change';
import { closeDb, withTenant } from '@/platform/db/client';
import { configActivityStatus } from '@/platform/tables/registry';
import { companyCode, plant } from '@/modules/foundation/schema';
import { defineCompanyCode } from '@/modules/foundation/company-code-definition';
import { savePlantDefinition } from '@/modules/foundation/plant-maintenance';
import { assignPlantCompanyCode } from '@/modules/foundation/plant-company-code-assignment';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const DEFINE_ACTIVITY = 'CFG.ORG.PLANT.DEFINE';
const ASSIGN_ACTIVITY = 'CFG.ORG.PLANT.ASSIGN_COMPANY';
const ACTOR = 'B128_PLANT_ASSIGN';

let alpha: TestTenant | undefined;
let beta: TestTenant | undefined;

function primaryTenant(): TestTenant {
  if (!alpha) throw new Error('B-128 primary tenant fixture was not initialized.');
  return alpha;
}

function secondaryTenant(): TestTenant {
  if (!beta) throw new Error('B-128 second tenant fixture was not initialized.');
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

async function definePlant(client: string, code: string) {
  await savePlantDefinition({
    client,
    changedBy: ACTOR,
    mode: 'CREATE',
    plant: code,
    expectedVersion: 0,
    values: { name: `B-128 Plant ${code}`, country: 'KW' },
  });
}

async function defineCompany(tenant: TestTenant, code: string) {
  await defineCompanyCode({
    client: tenant.client,
    changedBy: ACTOR,
    companyCode: code,
    name: `B-128 Company ${code}`,
    country: 'KW',
    currency: tenant.currency,
  });
}

async function readPlant(client: string, code: string) {
  return withTenant(client, async (tx) =>
    (await tx.select().from(plant).where(and(eq(plant.client, client), eq(plant.plant, code))))[0] ?? null,
  );
}

async function readPlantHistory(client: string, code: string) {
  return withTenant(client, (tx) => changeHistory(tx, client, 'plant', code));
}

async function readAssignmentActivity(client: string) {
  return withTenant(client, async (tx) =>
    (await tx.select().from(configActivityStatus).where(and(
      eq(configActivityStatus.client, client),
      eq(configActivityStatus.activityCode, ASSIGN_ACTIVITY),
    )))[0] ?? null,
  );
}

beforeAll(async () => {
  alpha = await createTenant('b128-plant-assignment-alpha');
  beta = await createTenant('b128-plant-assignment-beta');
  await defineCompany(primaryTenant(), '2000');
  await defineCompany(primaryTenant(), 'INACT');
  await withTenant(primaryTenant().client, (tx) =>
    tx.update(companyCode)
      .set({ isActive: false, changedBy: ACTOR, changedAt: new Date() })
      .where(and(
        eq(companyCode.client, primaryTenant().client),
        eq(companyCode.companyCode, 'INACT'),
      )),
  );
  await defineCompany(secondaryTenant(), 'REMOTE');
  await setActivity(primaryTenant().client, DEFINE_ACTIVITY, 'COMPLETED');
  await setActivity(secondaryTenant().client, DEFINE_ACTIVITY, 'COMPLETED');
  await setActivity(primaryTenant().client, ASSIGN_ACTIVITY, 'NOT_STARTED');
}, 30_000);

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

describe('B-128 Plant-to-Company-Code initial assignment on disposable PostgreSQL', () => {
  it('assigns only Company Code, records security-relevant history and completes SCR-015', async () => {
    const tenant = primaryTenant();
    const code = 'B128NEW';
    await setActivity(tenant.client, ASSIGN_ACTIVITY, 'NOT_STARTED');
    await definePlant(tenant.client, code);
    expect((await readPlant(tenant.client, code))?.companyCode).toBeNull();

    const result = await assignPlantCompanyCode({
      client: tenant.client,
      changedBy: ACTOR,
      plant: code,
      companyCode: tenant.companyCode,
    });

    expect(result).toEqual({ assigned: true, plant: code, companyCode: tenant.companyCode });
    expect(await readPlant(tenant.client, code)).toMatchObject({
      companyCode: tenant.companyCode,
      changedBy: ACTOR,
      name: `B-128 Plant ${code}`,
      country: 'KW',
    });

    const history = await readPlantHistory(tenant.client, code);
    expect(history).toHaveLength(2); // definition plus one assignment event
    const assignmentEvent = history.find((event) => event.transactionCode === ASSIGN_ACTIVITY);
    expect(assignmentEvent).toMatchObject({ changeType: 'CHANGE', changedBy: ACTOR });
    expect(assignmentEvent?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fieldName: 'companyCode',
        oldValue: null,
        newValue: tenant.companyCode,
        isSecurityRelevant: 'true',
      }),
    ]));
    expect(await readAssignmentActivity(tenant.client)).toMatchObject({
      status: 'COMPLETED',
      completedBy: ACTOR,
    });
  });

  it('makes the same assignment idempotent and refuses replacement without adding history', async () => {
    const tenant = primaryTenant();
    const code = 'B128LOCK';
    await setActivity(tenant.client, ASSIGN_ACTIVITY, 'NOT_STARTED');
    await definePlant(tenant.client, code);
    await assignPlantCompanyCode({
      client: tenant.client,
      changedBy: ACTOR,
      plant: code,
      companyCode: tenant.companyCode,
    });

    await expect(assignPlantCompanyCode({
      client: tenant.client,
      changedBy: ACTOR,
      plant: code,
      companyCode: tenant.companyCode,
    })).resolves.toEqual({ assigned: false, plant: code, companyCode: tenant.companyCode });

    await expect(assignPlantCompanyCode({
      client: tenant.client,
      changedBy: ACTOR,
      plant: code,
      companyCode: '2000',
    })).rejects.toMatchObject({
      name: 'PlantCompanyCodeAssignmentError',
      remedy: expect.stringContaining('deferred until after full application development'),
    });
    expect((await readPlant(tenant.client, code))?.companyCode).toBe(tenant.companyCode);
    expect(await readPlantHistory(tenant.client, code)).toHaveLength(2);
  });

  it('refuses missing Plants and missing, inactive, or cross-tenant Company Codes without mutation', async () => {
    const tenant = primaryTenant();
    await setActivity(tenant.client, ASSIGN_ACTIVITY, 'NOT_STARTED');
    await expect(assignPlantCompanyCode({
      client: tenant.client,
      changedBy: ACTOR,
      plant: 'B128MISS',
      companyCode: tenant.companyCode,
    })).rejects.toThrow(/does not exist in this tenant/);

    const code = 'B128DENY';
    await definePlant(tenant.client, code);
    for (const target of ['MISSING', 'INACT', 'REMOTE']) {
      await expect(assignPlantCompanyCode({
        client: tenant.client,
        changedBy: ACTOR,
        plant: code,
        companyCode: target,
      })).rejects.toMatchObject({
        name: 'PlantCompanyCodeAssignmentError',
        message: expect.stringMatching(/Active Company Code .* is not defined in this tenant/),
      });
    }
    expect((await readPlant(tenant.client, code))?.companyCode).toBeNull();
    expect(await readPlantHistory(tenant.client, code)).toHaveLength(1); // Plant definition only
  });

  it('fails closed until the Plant definition activity is complete', async () => {
    const tenant = primaryTenant();
    const code = 'B128PRER';
    await setActivity(tenant.client, ASSIGN_ACTIVITY, 'NOT_STARTED');
    await definePlant(tenant.client, code);
    await setActivity(tenant.client, DEFINE_ACTIVITY, 'NOT_STARTED');

    try {
      await expect(assignPlantCompanyCode({
        client: tenant.client,
        changedBy: ACTOR,
        plant: code,
        companyCode: tenant.companyCode,
      })).rejects.toThrow(/assignment prerequisites are incomplete/);
      expect((await readPlant(tenant.client, code))?.companyCode).toBeNull();
      expect(await readPlantHistory(tenant.client, code)).toHaveLength(1);
      expect(await readAssignmentActivity(tenant.client)).toMatchObject({ status: 'NOT_STARTED' });
    } finally {
      await setActivity(tenant.client, DEFINE_ACTIVITY, 'COMPLETED');
    }
  });

  it('serializes concurrent choices so only one initial Company Code can win', async () => {
    const tenant = primaryTenant();
    const code = 'B128RACE';
    await setActivity(tenant.client, ASSIGN_ACTIVITY, 'NOT_STARTED');
    await definePlant(tenant.client, code);

    const results = await Promise.allSettled([
      assignPlantCompanyCode({
        client: tenant.client,
        changedBy: ACTOR,
        plant: code,
        companyCode: tenant.companyCode,
      }),
      assignPlantCompanyCode({
        client: tenant.client,
        changedBy: ACTOR,
        plant: code,
        companyCode: '2000',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const assigned = (await readPlant(tenant.client, code))?.companyCode;
    expect([tenant.companyCode, '2000']).toContain(assigned);
    expect(await readPlantHistory(tenant.client, code)).toHaveLength(2);
  });
});
