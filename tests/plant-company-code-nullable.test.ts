import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';
import { listPlants } from '@/modules/foundation/services';
import { plant } from '@/modules/foundation/schema';

let alpha: TestTenant;
let beta: TestTenant;

beforeAll(async () => {
  alpha = await createTenant('plant-company-code-nullable-alpha');
  beta = await createTenant('plant-company-code-nullable-beta', { companyCode: 'BETA' });
});

afterAll(async () => {
  await destroyTenant(alpha.client);
  await destroyTenant(beta.client);
  await closeDb();
});

describe('Plant Company Code nullable schema', () => {
  it('defines an unassigned Plant, then accepts only a Company Code in the same tenant', async () => {
    await withTenant(alpha.client, (tx) => tx.insert(plant).values({
      client: alpha.client,
      plant: 'DRAFT1',
      name: 'Unassigned draft plant',
      companyCode: null,
      country: 'KW',
      createdBy: 'TEST',
    }));

    const listed = await listPlants(alpha.client);
    expect(listed.find((row) => row.plant === 'DRAFT1')?.companyCode).toBeNull();

    const assignment = (companyCode: string) => withTenant(alpha.client, (tx) => tx
      .update(plant)
      .set({ companyCode })
      .where(and(eq(plant.client, alpha.client), eq(plant.plant, 'DRAFT1'))));

    await expect(assignment(beta.companyCode)).rejects.toThrow();
    await assignment(alpha.companyCode);
    expect((await listPlants(alpha.client)).find((row) => row.plant === 'DRAFT1')?.companyCode).toBe(alpha.companyCode);
  });

  it('stores structured logistics fields and preserves legacy free-text address without validating the pending calendar key', async () => {
    await withTenant(alpha.client, (tx) => tx.insert(plant).values({
      client: alpha.client,
      plant: 'STRUCT1',
      name: 'Structured address site',
      companyCode: null,
      country: 'KW',
      city: 'Al Jahra',
      region: 'Al Jahra',
      postalCode: '00000',
      street: 'Example Street',
      houseNumber: '12B',
      address: 'Legacy address remains untouched',
      factoryCalendar: 'NO-MASTER',
      language: 'EN',
      createdBy: 'TEST',
    }));

    const row = (await listPlants(alpha.client)).find((site) => site.plant === 'STRUCT1');
    expect(row).toMatchObject({
      companyCode: null,
      country: 'KW',
      city: 'Al Jahra',
      region: 'Al Jahra',
      postalCode: '00000',
      street: 'Example Street',
      houseNumber: '12B',
      address: 'Legacy address remains untouched',
      factoryCalendar: 'NO-MASTER',
      language: 'EN',
      isProductionSite: true,
      isStorageSite: true,
      defaultStorageLocation: null,
      isActive: true,
    });
  });
});
