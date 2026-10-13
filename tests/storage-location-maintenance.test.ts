import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { changeHistory } from '@/platform/change';
import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';
import { configActivityStatus } from '@/platform/tables/registry';
import { plant, storageLocation as storageLocationTable } from '@/modules/foundation/schema';
import {
  deactivateStorageLocation,
  getStorageLocationVersion,
  StorageLocationMaintenanceError,
  saveStorageLocation,
} from '@/modules/foundation/storage-location-maintenance';

const ACTIVITY = 'CFG.ORG.STORAGELOC.DEFINE';
const ACTOR = 'B136_STORAGE_TEST';

let alpha: TestTenant | undefined;
let beta: TestTenant | undefined;

function alphaTenant(): TestTenant {
  if (!alpha) throw new Error('B-136 primary tenant fixture was not initialized.');
  return alpha;
}

function betaTenant(): TestTenant {
  if (!beta) throw new Error('B-136 second tenant fixture was not initialized.');
  return beta;
}

function objectKey(plantCode: string, storageLocationCode: string) {
  return `${plantCode.length}:${plantCode}${storageLocationCode.length}:${storageLocationCode}`;
}

function definition(name: string, allowNegativeStock?: boolean) {
  return {
    name,
    ...(allowNegativeStock === undefined ? {} : { allowNegativeStock }),
  };
}

async function setStorageLocationActivity(
  client: string,
  status: 'NOT_STARTED' | 'COMPLETED' = 'NOT_STARTED',
) {
  await withTenant(client, async (tx) => {
    await tx
      .insert(configActivityStatus)
      .values({ client, activityCode: ACTIVITY, status: 'NOT_STARTED', createdBy: ACTOR })
      .onConflictDoNothing();
    await tx
      .update(configActivityStatus)
      .set({
        status,
        completedAt: status === 'COMPLETED' ? new Date() : null,
        completedBy: status === 'COMPLETED' ? ACTOR : null,
        changedBy: ACTOR,
        changedAt: new Date(),
      })
      .where(
        and(
          eq(configActivityStatus.client, client),
          eq(configActivityStatus.activityCode, ACTIVITY),
        ),
      );
  });
}

async function addPlant(
  tenant: TestTenant,
  plantCode: string,
  isActive = true,
): Promise<void> {
  await withTenant(tenant.client, (tx) =>
    tx.insert(plant).values({
      client: tenant.client,
      plant: plantCode,
      name: `B-136 ${plantCode}`,
      companyCode: null,
      country: 'KW',
      isActive,
      createdBy: ACTOR,
    }),
  );
}

async function readLocation(client: string, plantCode: string, storageLocationCode: string) {
  return withTenant(client, async (tx) =>
    (await tx
      .select()
      .from(storageLocationTable)
      .where(
        and(
          eq(storageLocationTable.client, client),
          eq(storageLocationTable.plant, plantCode),
          eq(storageLocationTable.storageLocation, storageLocationCode),
        ),
      ))[0] ?? null,
  );
}

async function readHistory(client: string, plantCode: string, storageLocationCode: string) {
  return withTenant(client, (tx) =>
    changeHistory(tx, client, 'storage_location', objectKey(plantCode, storageLocationCode)),
  );
}

async function createLocation(
  tenant: TestTenant,
  plantCode: string,
  storageLocationCode: string,
  name: string,
  allowNegativeStock?: boolean,
) {
  return saveStorageLocation({
    client: tenant.client,
    changedBy: ACTOR,
    mode: 'CREATE',
    plant: plantCode,
    storageLocation: storageLocationCode,
    expectedVersion: 0,
    values: definition(name, allowNegativeStock),
  });
}

beforeAll(async () => {
  alpha = await createTenant('b136-storage-location-alpha');
  beta = await createTenant('b136-storage-location-beta');
  await setStorageLocationActivity(alpha.client);
  await setStorageLocationActivity(beta.client);
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

describe('B-136 Storage Location maintenance on disposable PostgreSQL', () => {
  it('creates under an active same-tenant Plant without a Company Code, defaults negative stock off, and records audit/activity', async () => {
    const tenant = alphaTenant();
    const plantCode = 'B136FREE';
    const storageLocationCode = 'B136BASE';
    await addPlant(tenant, plantCode);

    const result = await createLocation(
      tenant,
      plantCode,
      ` ${storageLocationCode} `,
      '  Unassigned plant store  ',
    );

    expect(result).toEqual({
      plant: plantCode,
      storageLocation: storageLocationCode,
      created: true,
      changed: true,
      isActive: true,
      version: 1,
    });
    expect(await readLocation(tenant.client, plantCode, storageLocationCode)).toMatchObject({
      client: tenant.client,
      plant: plantCode,
      storageLocation: storageLocationCode,
      name: 'Unassigned plant store',
      allowNegativeStock: false,
      isActive: true,
      createdBy: ACTOR,
    });
    const [parent] = await withTenant(tenant.client, (tx) =>
      tx.select().from(plant).where(and(eq(plant.client, tenant.client), eq(plant.plant, plantCode))),
    );
    expect(parent.companyCode).toBeNull();

    const history = await readHistory(tenant.client, plantCode, storageLocationCode);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      changeType: 'CREATE',
      changedBy: ACTOR,
      transactionCode: ACTIVITY,
    });
    expect(history[0].items.map((item) => item.fieldName)).toEqual(
      expect.arrayContaining(['plant', 'storageLocation', 'name', 'allowNegativeStock', 'isActive']),
    );
    expect(history[0].items.find((item) => item.fieldName === 'allowNegativeStock')).toMatchObject({
      oldValue: null,
      newValue: 'false',
      isSecurityRelevant: 'true',
    });

    const [activity] = await withTenant(tenant.client, (tx) =>
      tx
        .select()
        .from(configActivityStatus)
        .where(
          and(
            eq(configActivityStatus.client, tenant.client),
            eq(configActivityStatus.activityCode, ACTIVITY),
          ),
        ),
    );
    expect(activity).toMatchObject({ status: 'COMPLETED', completedBy: ACTOR });
  });

  it('refuses missing, cross-tenant, and inactive Plants without writing a Storage Location', async () => {
    const first = alphaTenant();
    const second = betaTenant();
    const inactivePlant = 'B136OFF';
    const betaOnlyPlant = 'B136ONLY';
    await addPlant(first, inactivePlant, false);
    await addPlant(second, betaOnlyPlant, true);

    await expect(
      createLocation(first, inactivePlant, 'B136OFFLOC', 'Inactive parent'),
    ).rejects.toMatchObject({ message: `Plant ${inactivePlant} is inactive.` });
    await expect(
      createLocation(first, betaOnlyPlant, 'B136XLOC', 'Cross-tenant parent'),
    ).rejects.toMatchObject({ message: `Plant ${betaOnlyPlant} does not exist in this tenant.` });
    await expect(
      createLocation(first, 'B136MISS', 'B136MLOC', 'Missing parent'),
    ).rejects.toBeInstanceOf(StorageLocationMaintenanceError);

    expect(await readLocation(first.client, inactivePlant, 'B136OFFLOC')).toBeNull();
    expect(await readLocation(first.client, betaOnlyPlant, 'B136XLOC')).toBeNull();
    expect(await readHistory(first.client, inactivePlant, 'B136OFFLOC')).toHaveLength(0);
  });

  it('changes only name and negative-stock configuration, keeps no-ops silent, and rejects stale versions', async () => {
    const tenant = alphaTenant();
    const plantCode = '1000';
    const storageLocationCode = 'B136EDIT';
    await createLocation(tenant, plantCode, storageLocationCode, 'Before', true);

    const changed = await saveStorageLocation({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CHANGE',
      plant: plantCode,
      storageLocation: storageLocationCode,
      expectedVersion: 1,
      reason: 'B-136 definition update',
      values: definition('After', false),
    });
    expect(changed).toMatchObject({ changed: true, isActive: true, version: 2 });
    expect(await readLocation(tenant.client, plantCode, storageLocationCode)).toMatchObject({
      name: 'After',
      allowNegativeStock: false,
      isActive: true,
      changedBy: ACTOR,
    });
    expect(await getStorageLocationVersion(tenant.client, plantCode, storageLocationCode)).toBe(2);

    const unchanged = await saveStorageLocation({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CHANGE',
      plant: plantCode,
      storageLocation: storageLocationCode,
      expectedVersion: 2,
      values: definition('After', false),
    });
    expect(unchanged).toMatchObject({ changed: false, version: 2 });

    await expect(
      saveStorageLocation({
        client: tenant.client,
        changedBy: ACTOR,
        mode: 'CHANGE',
        plant: plantCode,
        storageLocation: storageLocationCode,
        expectedVersion: 1,
        values: definition('Stale overwrite', true),
      }),
    ).rejects.toBeInstanceOf(StorageLocationMaintenanceError);
    expect(await readLocation(tenant.client, plantCode, storageLocationCode)).toMatchObject({
      name: 'After',
      allowNegativeStock: false,
    });

    const history = await readHistory(tenant.client, plantCode, storageLocationCode);
    expect(history).toHaveLength(2);
    const items = history.find((entry) => entry.changeType === 'CHANGE')?.items ?? [];
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldName: 'name', oldValue: 'Before', newValue: 'After' }),
        expect.objectContaining({
          fieldName: 'allowNegativeStock',
          oldValue: 'true',
          newValue: 'false',
          isSecurityRelevant: 'true',
        }),
      ]),
    );
  });

  it('deactivates in place, records the active-state change, and is idempotent', async () => {
    const tenant = alphaTenant();
    const plantCode = '1000';
    const storageLocationCode = 'B136DEACT';
    await createLocation(tenant, plantCode, storageLocationCode, 'Retained location');

    const deactivated = await deactivateStorageLocation({
      client: tenant.client,
      changedBy: ACTOR,
      plant: plantCode,
      storageLocation: storageLocationCode,
      expectedVersion: 1,
      reason: 'B-136 retain without operational use',
    });
    expect(deactivated).toEqual({
      plant: plantCode,
      storageLocation: storageLocationCode,
      changed: true,
      isActive: false,
      version: 2,
    });
    expect(await readLocation(tenant.client, plantCode, storageLocationCode)).toMatchObject({
      name: 'Retained location',
      isActive: false,
      createdBy: ACTOR,
      changedBy: ACTOR,
    });

    const repeated = await deactivateStorageLocation({
      client: tenant.client,
      changedBy: ACTOR,
      plant: plantCode,
      storageLocation: storageLocationCode,
      expectedVersion: 2,
    });
    expect(repeated).toEqual({
      plant: plantCode,
      storageLocation: storageLocationCode,
      changed: false,
      isActive: false,
      version: 2,
    });

    const history = await readHistory(tenant.client, plantCode, storageLocationCode);
    expect(history).toHaveLength(2);
    const deactivation = history.find((entry) => entry.items.some((item) => item.fieldName === 'isActive'));
    expect(deactivation).toBeDefined();
    expect(deactivation?.items.find((item) => item.fieldName === 'isActive')).toMatchObject({
      oldValue: 'true',
      newValue: 'false',
      isSecurityRelevant: 'true',
    });
  });

  it('isolates same Plant/Storage Location keys, versions and histories by tenant', async () => {
    const first = alphaTenant();
    const second = betaTenant();
    const plantCode = '1000';
    const storageLocationCode = 'B136SAME';

    await createLocation(first, plantCode, storageLocationCode, 'Alpha location');
    await createLocation(second, plantCode, storageLocationCode, 'Beta location');
    await saveStorageLocation({
      client: first.client,
      changedBy: ACTOR,
      mode: 'CHANGE',
      plant: plantCode,
      storageLocation: storageLocationCode,
      expectedVersion: 1,
      values: definition('Alpha changed'),
    });

    expect(await readLocation(first.client, plantCode, storageLocationCode)).toMatchObject({ name: 'Alpha changed' });
    expect(await readLocation(second.client, plantCode, storageLocationCode)).toMatchObject({ name: 'Beta location' });
    expect(await getStorageLocationVersion(first.client, plantCode, storageLocationCode)).toBe(2);
    expect(await getStorageLocationVersion(second.client, plantCode, storageLocationCode)).toBe(1);
    expect(await readHistory(first.client, plantCode, storageLocationCode)).toHaveLength(2);
    expect(await readHistory(second.client, plantCode, storageLocationCode)).toHaveLength(1);
  });
});
