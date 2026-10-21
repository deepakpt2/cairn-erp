import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { withTenant } from '@/platform/db/client';
import { businessPartner, bpRole } from '@/modules/foundation/business-partner-schema';
import { supplierPurchasing } from '@/modules/foundation/supplier-purchasing-schema';
import { suggestConstrainedValues } from '@/modules/foundation/constrained-values';
import { material, materialPlant } from '@/modules/inventory/schema';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

let tenant: TestTenant | undefined;

beforeAll(async () => {
  tenant = await createTenant('constrained-values');
});

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

describe('constrained value suggestions', () => {
  it('shows a closed set without typing and hides an open set until the user types', async () => {
    const fixture = tenant!;
    const companies = await suggestConstrainedValues(fixture.client, 'company', '', {}, 5);
    expect(companies.map((row) => row.code)).toContain(fixture.companyCode);

    expect(await suggestConstrainedValues(fixture.client, 'unit', '   ', {}, 5)).toEqual([]);

    const [unit] = await withTenant(fixture.client, (tx) => tx.execute<{ code: string }>(sql`
      select code from unit_of_measure order by code limit 1
    `));
    expect(unit?.code).toBeTruthy();
    const typed = await suggestConstrainedValues(fixture.client, 'unit', unit.code.slice(0, 1), {}, 5);
    expect(typed.length).toBeGreaterThan(0);
    expect(typed.length).toBeLessThanOrEqual(5);
    expect(typed.some((row) => row.code === unit.code)).toBe(true);
  });

  it('offers a supplier the purchasing write would accept, and not an incomplete one', async () => {
    const fixture = tenant!;
    const [org] = await withTenant(fixture.client, (tx) => tx.execute<{ purchasing_org: string }>(sql`
      select purchasing_org from purchasing_org where client = ${fixture.client} and is_active limit 1
    `));
    expect(org?.purchasing_org).toBeTruthy();

    await withTenant(fixture.client, async (tx) => {
      for (const [number, name, status] of [
        ['SUP-READY', 'Ready mill', 'CREATED'],
        ['SUP-OPEN', 'Open mill', 'INCOMPLETE'],
      ] as const) {
        await tx.insert(businessPartner).values({
          client: fixture.client, partnerNumber: number, category: 'ORGANIZATION', name,
          country: 'KW', generalStatus: status, createdBy: 'TEST',
        });
        await tx.insert(bpRole).values({
          client: fixture.client, partnerNumber: number, roleCode: 'SUPPLIER', isActive: true, createdBy: 'TEST',
        });
        await tx.insert(supplierPurchasing).values({
          client: fixture.client, partnerNumber: number, purchasingOrg: org.purchasing_org,
          purchasingStatus: status, createdBy: 'TEST',
        });
      }
    });

    const matches = await suggestConstrainedValues(fixture.client, 'supplier-purchasing', 'mill', {
      purchasingOrg: org.purchasing_org,
    }, 5);
    expect(matches.map((row) => row.code)).toEqual(['SUP-READY']);
  });

  it('keeps a make-only material out of an info-record suggestion', async () => {
    const fixture = tenant!;
    const [seed] = await withTenant(fixture.client, (tx) => tx.execute<{ material_type: string; plant: string; unit: string }>(sql`
      select mt.material_type, p.plant, u.code as unit
        from material_type mt
        join plant p on p.client = mt.client and p.is_active
        join unit_of_measure u on true
       where mt.client = ${fixture.client}
       limit 1
    `));
    expect(seed?.material_type).toBeTruthy();

    await withTenant(fixture.client, async (tx) => {
      for (const [number, procurement] of [['MAT-BUY', 'BUY'], ['MAT-MAKE', 'MAKE']] as const) {
        await tx.insert(material).values({
          client: fixture.client, materialNumber: number, description: `${number} board`,
          materialType: seed.material_type, baseUnit: seed.unit, createdBy: 'TEST',
        });
        await tx.insert(materialPlant).values({
          client: fixture.client, materialNumber: number, plant: seed.plant,
          procurementType: procurement, createdBy: 'TEST',
        });
      }
    });

    const matches = await suggestConstrainedValues(fixture.client, 'material-info', 'board', {
      plant: seed.plant,
    }, 5);
    expect(matches.map((row) => row.code)).toEqual(['MAT-BUY']);
  });
});
