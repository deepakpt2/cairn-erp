import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync('src/modules/foundation/schema.ts', 'utf8');
const migration = readFileSync('drizzle/0021_storage_location_plant_fk.sql', 'utf8');
const storageLocationSchema = schema.slice(
  schema.indexOf("export const storageLocation = pgTable("),
  schema.indexOf('/** Purchasing organisation'),
);

describe('Storage Location Plant-reference schema contract', () => {
  it('keeps the tenant/Plant/Storage Location key and adds a composite Plant reference', () => {
    expect(storageLocationSchema).toContain(
      "primaryKey({ columns: [t.client, t.plant, t.storageLocation] })",
    );
    expect(storageLocationSchema).toContain("name: 'storage_location_client_plant_fk'");
    expect(storageLocationSchema).toContain('columns: [t.client, t.plant]');
    expect(storageLocationSchema).toContain('foreignColumns: [plant.client, plant.plant]');
  });

  it('fails closed on orphan rows before installing the no-action foreign key', () => {
    expect(migration).toContain('LEFT JOIN public.plant AS p');
    expect(migration).toContain('p.client = sl.client');
    expect(migration).toContain('p.plant = sl.plant');
    expect(migration).toContain('WHERE p.client IS NULL');
    expect(migration).toContain('ADD CONSTRAINT storage_location_client_plant_fk');
    expect(migration).toContain('FOREIGN KEY (client, plant)');
    expect(migration).toContain('ON DELETE NO ACTION');
  });
});
