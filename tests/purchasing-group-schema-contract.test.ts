import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const foundation = readFileSync('src/modules/foundation/schema.ts', 'utf8');
const inventory = readFileSync('src/modules/inventory/schema.ts', 'utf8');
const supplier = readFileSync('src/modules/foundation/supplier-purchasing-schema.ts', 'utf8');
const migration = readFileSync('drizzle/0024_purchasing_group_definition.sql', 'utf8');

describe('SCR-019 Purchasing Group persistence contract', () => {
  it('uses the three-character key and preserves composite client-scoped references', () => {
    const definitionStart = foundation.indexOf('/** Buyer/team definition.');
    const definitionEnd = foundation.indexOf('/** Sales organisation', definitionStart);
    const definition = foundation.slice(definitionStart, definitionEnd);
    expect(definition).toContain("purchasingGroup: varchar('purchasing_group', { length: 3 }).notNull()");
    expect(definition).toContain("name: varchar('name', { length: 120 }).notNull()");
    expect(definition).toContain("telNoPurchGroup: varchar('tel_no_purch_group', { length: 12 })");
    expect(definition).toContain("faxNumber: varchar('fax_number', { length: 31 })");
    expect(definition).toContain("telephone: varchar('telephone', { length: 30 })");
    expect(definition).toContain("emailAddress: varchar('email_address', { length: 241 })");
    expect(definition).toContain("check('purchasing_group_key_format_ck'");
    expect(definition).toContain("~ '^[A-Z0-9]{3}$'");
    expect(inventory).toContain("purchasingGroup: varchar('purchasing_group', { length: 3 })");
    expect(supplier).toContain("purchasingGroup:varchar('purchasing_group',{length:3})");
    expect(definition).toContain('purchasingOrg: varchar');
    expect(definition).toContain('responsibleBuyer: varchar');
  });

  it('adds overview contact fields without dropping legacy consumer columns', () => {
    expect(foundation).toContain("telNoPurchGroup: varchar('tel_no_purch_group', { length: 12 })");
    expect(foundation).toContain("faxNumber: varchar('fax_number', { length: 31 })");
    expect(foundation).toContain("telephone: varchar('telephone', { length: 30 })");
    expect(foundation).toContain("extension: varchar('extension', { length: 10 })");
    expect(foundation).toContain("emailAddress: varchar('email_address', { length: 241 })");
    expect(migration).toContain('ADD COLUMN "tel_no_purch_group" varchar(12)');
    expect(migration).toContain('ADD COLUMN "fax_number" varchar(31)');
    expect(migration).toContain('ADD COLUMN "email_address" varchar(241)');
    expect(migration).not.toContain('ALTER COLUMN "name"');
    expect(migration).toContain("Keep the existing description width");
    expect(migration).not.toMatch(/DROP COLUMN.*purchasing_org/is);
    expect(migration).not.toMatch(/DROP COLUMN.*responsible_buyer/is);
  });

  it('guards existing keys before narrowing and restores both material and supplier foreign keys', () => {
    expect(migration).toContain("WHERE purchasing_group !~ '^[A-Z0-9]{3}$'");
    expect(migration).toContain('RAISE EXCEPTION');
    expect(migration).toContain('ALTER COLUMN "purchasing_group" TYPE varchar(3)');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS "material_plant_client_purchasing_group_purchasing_group_client_purchasing_group_fk"');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS "supplier_purchasing_org_client_purchasing_group_purchasing_group_client_purchasing_group_fk"');
    expect(migration).toContain('REFERENCES "purchasing_group" ("client", "purchasing_group")');
  });
});
