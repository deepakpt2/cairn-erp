import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { changeHistory } from '@/platform/change';
import { createTenant, destroyTenant, withTenant, closeDb, type TestTenant } from './helpers';
import { configActivityStatus } from '@/platform/tables/registry';
import { plant } from '@/modules/foundation/schema';
import {
  PlantMaintenanceError,
  savePlantDefinition,
} from '@/modules/foundation/plant-maintenance';

const ACTIVITY = 'CFG.ORG.PLANT.DEFINE';
const ACTOR = 'B123_PLANT_TEST';

let alpha: TestTenant | undefined;
let beta: TestTenant | undefined;

function alphaTenant(): TestTenant {
  if (!alpha) throw new Error('B-123 primary tenant fixture was not initialized.');
  return alpha;
}

function betaTenant(): TestTenant {
  if (!beta) throw new Error('B-123 second tenant fixture was not initialized.');
  return beta;
}

function definition(name: string, options: Partial<{
  country: string;
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
  region: string;
  factoryCalendar: string;
  language: string;
  isProductionSite: boolean;
  isStorageSite: boolean;
}> = {}) {
  return {
    name,
    country: options.country ?? 'KW',
    street: options.street,
    houseNumber: options.houseNumber,
    postalCode: options.postalCode,
    city: options.city,
    region: options.region,
    factoryCalendar: options.factoryCalendar,
    language: options.language,
    isProductionSite: options.isProductionSite,
    isStorageSite: options.isStorageSite,
  };
}

async function setPlantActivity(client: string, status: 'NOT_STARTED' | 'COMPLETED' = 'NOT_STARTED') {
  await withTenant(client, async (tx) => {
    await tx.insert(configActivityStatus).values({
      client,
      activityCode: ACTIVITY,
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
        eq(configActivityStatus.activityCode, ACTIVITY),
      ));
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

beforeAll(async () => {
  alpha = await createTenant('b123-plant-maintenance-alpha');
  beta = await createTenant('b123-plant-maintenance-beta');
  await setPlantActivity(alpha.client);
  await setPlantActivity(beta.client);
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

describe('B-123 Plant create/change service on disposable PostgreSQL', () => {
  it('creates an unassigned Plant with database defaults, normalized country/language, audit history and activity completion', async () => {
    const tenant = alphaTenant();
    await setPlantActivity(tenant.client);

    const result = await savePlantDefinition({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CREATE',
      plant: ' B123NEW ',
      expectedVersion: 0,
      reason: 'B-123 initial definition',
      values: definition(' New warehouse ', { country: 'kw' }),
    });

    expect(result).toEqual({ plant: 'B123NEW', created: true, changed: true, version: 1 });
    expect(await readPlant(tenant.client, 'B123NEW')).toMatchObject({
      plant: 'B123NEW',
      name: 'New warehouse',
      companyCode: null,
      country: 'KW',
      street: null,
      houseNumber: null,
      postalCode: null,
      city: null,
      region: null,
      factoryCalendar: null,
      language: 'EN',
      isProductionSite: true,
      isStorageSite: true,
      defaultStorageLocation: null,
      address: null,
      isActive: true,
      createdBy: ACTOR,
    });

    const history = await readPlantHistory(tenant.client, 'B123NEW');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      changeType: 'CREATE',
      changedBy: ACTOR,
      reason: 'B-123 initial definition',
      transactionCode: ACTIVITY,
    });
    expect(history[0].items.map((item) => item.fieldName)).toEqual(
      expect.arrayContaining(['plant', 'name', 'country', 'language', 'isProductionSite', 'isStorageSite']),
    );

    const [activity] = await withTenant(tenant.client, (tx) =>
      tx.select().from(configActivityStatus).where(and(
        eq(configActivityStatus.client, tenant.client),
        eq(configActivityStatus.activityCode, ACTIVITY),
      )),
    );
    expect(activity).toMatchObject({ status: 'COMPLETED', completedBy: ACTOR });
  });

  it('changes only approved definition fields, preserving Company Code, default location, legacy address and active status', async () => {
    const tenant = alphaTenant();
    const code = 'B123CHG';
    await setPlantActivity(tenant.client);
    await withTenant(tenant.client, (tx) => tx.insert(plant).values({
      client: tenant.client,
      plant: code,
      name: 'Before change',
      companyCode: tenant.companyCode,
      country: 'KW',
      city: 'Original city',
      address: 'Legacy free-text address stays',
      defaultStorageLocation: '0001',
      isProductionSite: true,
      isStorageSite: true,
      isActive: false,
      language: 'EN',
      createdBy: 'B123_FIXTURE',
    }));

    const result = await savePlantDefinition({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CHANGE',
      plant: code,
      expectedVersion: 0,
      reason: 'B-123 structured address update',
      values: definition(' After change ', {
        country: 'sa',
        street: 'King Road',
        houseNumber: '11B',
        postalCode: '15151',
        city: 'Riyadh',
        region: 'Riyadh',
        factoryCalendar: 'NO-MASTER',
        language: 'ar',
        isProductionSite: false,
        isStorageSite: false,
      }),
    });

    expect(result).toEqual({ plant: code, created: false, changed: true, version: 1 });
    expect(await readPlant(tenant.client, code)).toMatchObject({
      name: 'After change',
      companyCode: tenant.companyCode,
      country: 'SA',
      street: 'King Road',
      houseNumber: '11B',
      postalCode: '15151',
      city: 'Riyadh',
      region: 'Riyadh',
      factoryCalendar: 'NO-MASTER',
      language: 'AR',
      isProductionSite: false,
      isStorageSite: false,
      defaultStorageLocation: '0001',
      address: 'Legacy free-text address stays',
      isActive: false,
      createdBy: 'B123_FIXTURE',
      changedBy: ACTOR,
    });
    expect((await readPlant(tenant.client, code))?.changedAt).toBeInstanceOf(Date);

    const history = await readPlantHistory(tenant.client, code);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      changeType: 'CHANGE',
      changedBy: ACTOR,
      reason: 'B-123 structured address update',
      transactionCode: ACTIVITY,
    });
    const fieldNames = history[0].items.map((item) => item.fieldName);
    expect(fieldNames).toEqual(expect.arrayContaining([
      'name', 'country', 'street', 'houseNumber', 'postalCode', 'city', 'region',
      'factoryCalendar', 'language', 'isProductionSite', 'isStorageSite',
    ]));
    for (const excluded of ['companyCode', 'defaultStorageLocation', 'address', 'isActive']) {
      expect(fieldNames).not.toContain(excluded);
    }
  });

  it('allows both descriptive role flags false and stores an unregistered Factory Calendar key', async () => {
    const tenant = alphaTenant();
    const code = 'B123META';
    const result = await savePlantDefinition({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CREATE',
      plant: code,
      expectedVersion: 0,
      values: definition('Descriptive metadata', {
        factoryCalendar: 'NO-MASTER',
        isProductionSite: false,
        isStorageSite: false,
      }),
    });

    expect(result.version).toBe(1);
    expect(await readPlant(tenant.client, code)).toMatchObject({
      factoryCalendar: 'NO-MASTER',
      isProductionSite: false,
      isStorageSite: false,
    });
  });

  it('keeps no-op saves silent, increments the audit-backed version, and rejects stale changes', async () => {
    const tenant = alphaTenant();
    const code = 'B123VER';
    const values = definition('Versioned site', { city: 'Al Ahmadi' });

    const created = await savePlantDefinition({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CREATE',
      plant: code,
      expectedVersion: 0,
      values,
    });
    expect(created.version).toBe(1);

    const unchanged = await savePlantDefinition({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CHANGE',
      plant: code,
      expectedVersion: 1,
      values,
    });
    expect(unchanged).toEqual({ plant: code, created: false, changed: false, version: 1 });
    expect(await readPlantHistory(tenant.client, code)).toHaveLength(1);

    await expect(savePlantDefinition({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CHANGE',
      plant: code,
      expectedVersion: 0,
      values: definition('Stale overwrite'),
    })).rejects.toBeInstanceOf(PlantMaintenanceError);
    expect((await readPlant(tenant.client, code))?.name).toBe('Versioned site');
    expect(await readPlantHistory(tenant.client, code)).toHaveLength(1);

    const changed = await savePlantDefinition({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CHANGE',
      plant: code,
      expectedVersion: 1,
      values: definition('Current version accepted'),
    });
    expect(changed.version).toBe(2);
    expect(await readPlantHistory(tenant.client, code)).toHaveLength(2);
  });

  it('validates country references and isolates identical Plant keys and versions by tenant', async () => {
    const first = alphaTenant();
    const second = betaTenant();
    const sharedCode = 'B123SAME';

    await expect(savePlantDefinition({
      client: first.client,
      changedBy: ACTOR,
      mode: 'CREATE',
      plant: 'B123BAD',
      expectedVersion: 0,
      values: definition('Unsupported country', { country: 'ZZ' }),
    })).rejects.toThrow(/Country ZZ is not in the reference catalogue/);
    expect(await readPlant(first.client, 'B123BAD')).toBeNull();
    expect(await readPlantHistory(first.client, 'B123BAD')).toHaveLength(0);

    const firstCreate = await savePlantDefinition({
      client: first.client,
      changedBy: ACTOR,
      mode: 'CREATE',
      plant: sharedCode,
      expectedVersion: 0,
      values: definition('Alpha tenant site'),
    });
    const secondCreate = await savePlantDefinition({
      client: second.client,
      changedBy: ACTOR,
      mode: 'CREATE',
      plant: sharedCode,
      expectedVersion: 0,
      values: definition('Beta tenant site'),
    });
    expect(firstCreate.version).toBe(1);
    expect(secondCreate.version).toBe(1);

    await savePlantDefinition({
      client: first.client,
      changedBy: ACTOR,
      mode: 'CHANGE',
      plant: sharedCode,
      expectedVersion: 1,
      values: definition('Alpha updated'),
    });
    expect((await readPlant(first.client, sharedCode))?.name).toBe('Alpha updated');
    expect((await readPlant(second.client, sharedCode))?.name).toBe('Beta tenant site');
    expect(await readPlantHistory(first.client, sharedCode)).toHaveLength(2);
    expect(await readPlantHistory(second.client, sharedCode)).toHaveLength(1);
  });
});
