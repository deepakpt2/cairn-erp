import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync('src/modules/foundation/schema.ts', 'utf8');
const plantSchema = schema.slice(schema.indexOf("export const plant = pgTable("), schema.indexOf('/** Storage location'));
const migration = readFileSync('drizzle/0019_plant_company_code_nullable.sql', 'utf8');
const materials = readFileSync('src/modules/inventory/materials.ts', 'utf8');
const customerSalesAreas = readFileSync('src/modules/foundation/customer-sales-areas.ts', 'utf8');
const supplierPurchasing = readFileSync('src/modules/foundation/supplier-purchasing.ts', 'utf8');
const plantsPage = readFileSync('src/app/config/plants/page.tsx', 'utf8');

describe('Plant Company Code define/assign contract', () => {
  it('allows an unassigned Plant while preserving tenant-local Company Code references', () => {
    expect(plantSchema).toMatch(/companyCode: varchar\('company_code', \{ length: 10 \}\),/);
    expect(plantSchema).toMatch(/foreignKey\(\{[\s\S]*?name: 'plant_client_company_code_fk'[\s\S]*?columns: \[t\.client, t\.companyCode\][\s\S]*?foreignColumns: \[companyCode\.client, companyCode\.companyCode\]/);
    expect(migration).toContain('ALTER COLUMN "company_code" DROP NOT NULL');
    expect(migration).toContain('FOREIGN KEY ("client", "company_code")');
    expect(migration).toContain('REFERENCES "public"."company_code" ("client", "company_code")');
    expect(migration).not.toMatch(/UPDATE\s+"?plant"?/i);
  });

  it('fails closed in material, customer-delivery, and purchasing use until assignment', () => {
    expect(materials).toContain('isNotNull(plant.companyCode)');
    expect(materials).toContain('if (!assignedCompanyCode) throw new MaterialError');
    expect(customerSalesAreas).toContain('if(!site.companyCode)throw new CustomerSalesAreaError');
    expect(customerSalesAreas).toContain('eq(plant.companyCode,selected.companyCode)');
    expect(supplierPurchasing).toContain('if(!site.companyCode)throw new SupplierPurchasingError');
    expect(plantsPage).toContain('plant.companyCode ?? t(\'cc.unassigned\')');
  });
});
