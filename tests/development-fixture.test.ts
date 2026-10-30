import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, createTenant, destroyTenant, withTenant } from './helpers';
import { seedDevelopmentMaterials } from '../src/modules/inventory/development-fixture';
import { getMaterialDetail } from '../src/modules/inventory/materials';
import { material } from '../src/modules/inventory/schema';

afterAll(closeDb);

describe('development material fixtures', () => {
  it('seeds the same fixture set independently for two explicitly selected clients', async () => {
    const left = await createTenant('development-fixture-left');
    const right = await createTenant('development-fixture-right');
    try {
      expect(left.client).not.toBe(right.client);
      await seedDevelopmentMaterials(left.client);
      await seedDevelopmentMaterials(right.client);

      for (const client of [left.client, right.client]) {
        const detail = await getMaterialDetail(client, 'RAW-STEEL');
        expect(detail?.base.materialNumber).toBe('RAW-STEEL');
        expect(detail?.plants.some((view) => view.plant === '1000')).toBe(true);
      }

      const leftCannotReadRight = await withTenant(left.client, (tx) =>
        tx.select().from(material).where(eq(material.client, right.client)),
      );
      expect(leftCannotReadRight).toHaveLength(0);
    } finally {
      await destroyTenant(right.client);
      await destroyTenant(left.client);
    }
  });
});
