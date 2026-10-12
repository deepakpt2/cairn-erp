import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync('src/modules/foundation/schema.ts', 'utf8');
const plantSchema = schema.slice(schema.indexOf("export const plant = pgTable("), schema.indexOf('/** Storage location'));
const migration = readFileSync('drizzle/0020_plant_logistics_fields.sql', 'utf8');

describe('Plant logistics field migration contract', () => {
  it('adds the structured address and Factory Calendar fields as nullable columns', () => {
    const definitions = [
      "region: varchar('region', { length: 80 }),",
      "postalCode: varchar('postal_code', { length: 20 }),",
      "street: varchar('street', { length: 160 }),",
      "houseNumber: varchar('house_number', { length: 40 }),",
      "factoryCalendar: varchar('factory_calendar', { length: 10 }),",
    ];
    const columns: Array<[string, string]> = [
      ['region', 'varchar(80)'],
      ['postal_code', 'varchar(20)'],
      ['street', 'varchar(160)'],
      ['house_number', 'varchar(40)'],
      ['factory_calendar', 'varchar(10)'],
    ];
    for (const definition of definitions) expect(plantSchema).toContain(definition);
    for (const [column, type] of columns) expect(migration).toContain(`ADD COLUMN "${column}" ${type}`);
    expect(plantSchema).toContain("country: char('country', { length: 2 }).notNull()");
    expect(plantSchema).toContain("language: char('language', { length: 2 }).notNull().default('EN')");
    expect(plantSchema).toContain("isProductionSite: boolean('is_production_site').notNull().default(true)");
    expect(plantSchema).toContain("isStorageSite: boolean('is_storage_site').notNull().default(true)");
    expect(plantSchema).toContain("defaultStorageLocation: varchar('default_storage_location', { length: 10 }),");
    expect(plantSchema).toContain("isActive: boolean('is_active').notNull().default(true)");
  });

  it('preserves free-text address and leaves the pending calendar key unvalidated', () => {
    expect(plantSchema).toContain("address: text('address')");
    expect(migration).not.toContain('UPDATE "plant"');
    expect(migration).not.toContain('DROP COLUMN "address"');
    expect(migration).not.toContain('FOREIGN KEY');
    expect(migration).not.toContain('NOT NULL');
  });
});
