import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { purchasingOrg, purchasingOrgPlant, plant } from '@/modules/foundation/schema';
import {
  deactivatePurchasingOrg,
  getPurchasingOrgDefinitionVersion,
  PurchasingOrgMaintenanceError,
  savePurchasingOrgDefinition,
} from '@/modules/foundation/purchasing-org-maintenance';
import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';

const ACTIVITY = 'CFG.PROC.PURORG.DEFINE';
const ACTOR = 'B144_PURORG_TEST';

let alpha: TestTenant | undefined;
let beta: TestTenant | undefined;

function alphaTenant(): TestTenant {
  if (!alpha) throw new Error('B-144 primary tenant fixture was not initialized.');
  return alpha;
}

function betaTenant(): TestTenant {
  if (!beta) throw new Error('B-144 second tenant fixture was not initialized.');
  return beta;
}

async function setActivity(client: string) {
  await withTenant(client, async (tx) => {
    await tx
      .insert(configActivityStatus)
      .values({ client, activityCode: ACTIVITY, status: 'NOT_STARTED', createdBy: ACTOR })
      .onConflictDoNothing();
    await tx
      .update(configActivityStatus)
      .set({
        status: 'NOT_STARTED',
        completedAt: null,
        completedBy: null,
        changedBy: ACTOR,
        changedAt: new Date(),
      })
      .where(and(eq(configActivityStatus.client, client), eq(configActivityStatus.activityCode, ACTIVITY)));
  });
}

async function readPurchasingOrg(client: string, code: string) {
  return withTenant(client, async (tx) =>
    (await tx
      .select()
      .from(purchasingOrg)
      .where(and(eq(purchasingOrg.client, client), eq(purchasingOrg.purchasingOrg, code))))[0] ?? null,
  );
}

async function readHistory(client: string, code: string) {
  return withTenant(client, (tx) => changeHistory(tx, client, 'purchasing_org', code));
}

async function readPlantAssignments(client: string, code: string) {
  return withTenant(client, (tx) =>
    tx
      .select()
      .from(purchasingOrgPlant)
      .where(and(
        eq(purchasingOrgPlant.client, client),
        eq(purchasingOrgPlant.purchasingOrg, code),
      )),
  );
}

async function createDefinition(tenant: TestTenant, code: string, name: string) {
  return savePurchasingOrgDefinition({
    client: tenant.client,
    changedBy: ACTOR,
    mode: 'CREATE',
    purchasingOrg: code,
    expectedVersion: 0,
    values: { name },
  });
}

beforeAll(async () => {
  alpha = await createTenant('b144-purchasing-org-maintenance-alpha');
  beta = await createTenant('b144-purchasing-org-maintenance-beta');
  await setActivity(alpha.client);
  await setActivity(beta.client);
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

describe('B-144 Purchasing Organisation definition service on disposable PostgreSQL', () => {
  it('creates a trimmed, unassigned definition with audit history and completed activity', async () => {
    const tenant = alphaTenant();
    const result = await savePurchasingOrgDefinition({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CREATE',
      purchasingOrg: ' B144NEW ',
      expectedVersion: 0,
      reason: 'B-144 initial definition',
      values: { name: '  North buying team  ' },
    });

    expect(result).toEqual({
      purchasingOrg: 'B144NEW',
      created: true,
      changed: true,
      isActive: true,
      version: 1,
    });
    expect(await readPurchasingOrg(tenant.client, 'B144NEW')).toMatchObject({
      client: tenant.client,
      purchasingOrg: 'B144NEW',
      name: 'North buying team',
      companyCode: null,
      isActive: true,
      createdBy: ACTOR,
    });
    expect(await getPurchasingOrgDefinitionVersion(tenant.client, 'B144NEW')).toBe(1);

    const history = await readHistory(tenant.client, 'B144NEW');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      changeType: 'CREATE',
      changedBy: ACTOR,
      reason: 'B-144 initial definition',
      transactionCode: ACTIVITY,
    });
    const createFields = history[0].items.map((item) => item.fieldName);
    expect(createFields).toEqual(expect.arrayContaining(['purchasingOrg', 'name', 'isActive']));
    expect(createFields).not.toContain('companyCode');
    expect(createFields).not.toContain('plant');

    const [activity] = await withTenant(tenant.client, (tx) =>
      tx
        .select()
        .from(configActivityStatus)
        .where(and(
          eq(configActivityStatus.client, tenant.client),
          eq(configActivityStatus.activityCode, ACTIVITY),
        )),
    );
    expect(activity).toMatchObject({ status: 'COMPLETED', completedBy: ACTOR });
  });

  it('changes only the definition and deactivates in place without losing Company Code or Plant assignments', async () => {
    const tenant = alphaTenant();
    const code = 'B144KEEP';
    const plantCode = 'B144PLANT';

    // Fixture an existing organisation with assignment data written by the separate assignment activities.
    await withTenant(tenant.client, async (tx) => {
      await tx.insert(plant).values({
        client: tenant.client,
        plant: plantCode,
        name: 'B-144 assignment fixture',
        companyCode: null,
        country: 'KW',
        createdBy: ACTOR,
      });
      await tx.insert(purchasingOrg).values({
        client: tenant.client,
        purchasingOrg: code,
        name: 'Before change',
        companyCode: tenant.companyCode,
        isActive: true,
        createdBy: ACTOR,
      });
      await tx.insert(purchasingOrgPlant).values({
        client: tenant.client,
        purchasingOrg: code,
        plant: plantCode,
        createdBy: ACTOR,
      });
    });

    const changed = await savePurchasingOrgDefinition({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CHANGE',
      purchasingOrg: code,
      expectedVersion: 0,
      reason: 'B-144 rename only',
      values: { name: '  After change  ' },
    });
    expect(changed).toEqual({
      purchasingOrg: code,
      created: false,
      changed: true,
      isActive: true,
      version: 1,
    });
    expect(await readPurchasingOrg(tenant.client, code)).toMatchObject({
      name: 'After change',
      companyCode: tenant.companyCode,
      isActive: true,
      createdBy: ACTOR,
      changedBy: ACTOR,
    });
    expect(await readPlantAssignments(tenant.client, code)).toEqual([
      expect.objectContaining({ purchasingOrg: code, plant: plantCode }),
    ]);

    const changedHistory = await readHistory(tenant.client, code);
    expect(changedHistory).toHaveLength(1);
    expect(changedHistory[0]).toMatchObject({ changeType: 'CHANGE', reason: 'B-144 rename only' });
    const changedFields = changedHistory[0].items.map((item) => item.fieldName);
    expect(changedFields).toEqual(['name']);
    expect(changedFields).not.toContain('companyCode');
    expect(changedFields).not.toContain('plant');

    const deactivated = await deactivatePurchasingOrg({
      client: tenant.client,
      changedBy: ACTOR,
      purchasingOrg: code,
      expectedVersion: 1,
      reason: 'B-144 retain references',
    });
    expect(deactivated).toEqual({
      purchasingOrg: code,
      changed: true,
      isActive: false,
      version: 2,
    });
    expect(await readPurchasingOrg(tenant.client, code)).toMatchObject({
      name: 'After change',
      companyCode: tenant.companyCode,
      isActive: false,
      createdBy: ACTOR,
      changedBy: ACTOR,
    });
    expect(await readPlantAssignments(tenant.client, code)).toHaveLength(1);
    expect(await getPurchasingOrgDefinitionVersion(tenant.client, code)).toBe(2);

    const historyAfterDeactivation = await readHistory(tenant.client, code);
    expect(historyAfterDeactivation).toHaveLength(2);
    const activeChange = historyAfterDeactivation.flatMap((entry) => entry.items)
      .find((item) => item.fieldName === 'isActive');
    expect(activeChange).toMatchObject({
      oldValue: 'true',
      newValue: 'false',
      isSecurityRelevant: 'true',
    });
  });

  it('keeps no-ops silent, increments audit-backed versions, rejects stale writes and never recreates inactive rows', async () => {
    const tenant = alphaTenant();
    const code = 'B144VERS';
    await createDefinition(tenant, code, 'Versioned buyers');

    const unchanged = await savePurchasingOrgDefinition({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CHANGE',
      purchasingOrg: code,
      expectedVersion: 1,
      values: { name: 'Versioned buyers' },
    });
    expect(unchanged).toEqual({
      purchasingOrg: code,
      created: false,
      changed: false,
      isActive: true,
      version: 1,
    });
    expect(await readHistory(tenant.client, code)).toHaveLength(1);

    await expect(savePurchasingOrgDefinition({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CHANGE',
      purchasingOrg: code,
      expectedVersion: 0,
      values: { name: 'Stale overwrite' },
    })).rejects.toBeInstanceOf(PurchasingOrgMaintenanceError);
    expect((await readPurchasingOrg(tenant.client, code))?.name).toBe('Versioned buyers');

    const changed = await savePurchasingOrgDefinition({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CHANGE',
      purchasingOrg: code,
      expectedVersion: 1,
      values: { name: 'Current version accepted' },
    });
    expect(changed.version).toBe(2);

    const deactivated = await deactivatePurchasingOrg({
      client: tenant.client,
      changedBy: ACTOR,
      purchasingOrg: code,
      expectedVersion: 2,
    });
    expect(deactivated).toMatchObject({ changed: true, isActive: false, version: 3 });

    await expect(createDefinition(tenant, code, 'Attempted reactivation')).rejects.toMatchObject({
      message: `Purchasing Organisation ${code} already exists.`,
    });
    expect(await readPurchasingOrg(tenant.client, code)).toMatchObject({
      name: 'Current version accepted',
      isActive: false,
    });
    expect(await readHistory(tenant.client, code)).toHaveLength(3);
  });

  it('isolates identical keys and histories by tenant and rejects cross-tenant changes', async () => {
    const first = alphaTenant();
    const second = betaTenant();
    const code = 'B144SAME';

    await createDefinition(first, code, 'Alpha buyers');
    await createDefinition(second, code, 'Beta buyers');
    await savePurchasingOrgDefinition({
      client: first.client,
      changedBy: ACTOR,
      mode: 'CHANGE',
      purchasingOrg: code,
      expectedVersion: 1,
      values: { name: 'Alpha updated' },
    });

    expect(await readPurchasingOrg(first.client, code)).toMatchObject({ name: 'Alpha updated' });
    expect(await readPurchasingOrg(second.client, code)).toMatchObject({ name: 'Beta buyers' });
    expect(await getPurchasingOrgDefinitionVersion(first.client, code)).toBe(2);
    expect(await getPurchasingOrgDefinitionVersion(second.client, code)).toBe(1);
    expect(await readHistory(first.client, code)).toHaveLength(2);
    expect(await readHistory(second.client, code)).toHaveLength(1);

    await expect(savePurchasingOrgDefinition({
      client: second.client,
      changedBy: ACTOR,
      mode: 'CHANGE',
      purchasingOrg: 'B144ONLY',
      expectedVersion: 0,
      values: { name: 'Must not cross tenants' },
    })).rejects.toMatchObject({ message: 'Purchasing Organisation B144ONLY does not exist in this tenant.' });
    expect(await readPurchasingOrg(second.client, 'B144ONLY')).toBeNull();
  });

  it('rejects invalid keys, blank names and assignment fields before writing', async () => {
    const tenant = alphaTenant();
    const base = {
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CREATE' as const,
      expectedVersion: 0,
      values: { name: 'Valid name' },
    };

    await expect(savePurchasingOrgDefinition({ ...base, purchasingOrg: 'lower' }))
      .rejects.toBeInstanceOf(PurchasingOrgMaintenanceError);
    await expect(savePurchasingOrgDefinition({
      ...base,
      purchasingOrg: 'B144BLNK',
      values: { name: '   ' },
    })).rejects.toBeInstanceOf(PurchasingOrgMaintenanceError);
    await expect(savePurchasingOrgDefinition({
      ...base,
      purchasingOrg: 'B144EXTR',
      values: { name: 'Valid name', companyCode: tenant.companyCode } as never,
    })).rejects.toBeInstanceOf(PurchasingOrgMaintenanceError);

    expect(await readPurchasingOrg(tenant.client, 'B144BLNK')).toBeNull();
    expect(await readPurchasingOrg(tenant.client, 'B144EXTR')).toBeNull();
    expect(await readHistory(tenant.client, 'B144BLNK')).toHaveLength(0);
    expect(await readHistory(tenant.client, 'B144EXTR')).toHaveLength(0);
  });
});
