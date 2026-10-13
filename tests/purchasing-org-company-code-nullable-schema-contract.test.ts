import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync('src/modules/foundation/schema.ts', 'utf8');
const purchasingOrgSchema = schema.slice(
  schema.indexOf("export const purchasingOrg = pgTable("),
  schema.indexOf('/** Assignment: which purchasing organisations may buy for which plants. */'),
);
const migration = readFileSync('drizzle/0022_purchasing_org_company_code_nullable.sql', 'utf8');
const supplierPurchasing = readFileSync('src/modules/foundation/supplier-purchasing.ts', 'utf8');

describe('Purchasing Organisation separate Company Code assignment contract', () => {
  it('allows a pending Company Code assignment without rewriting existing assignments', () => {
    expect(purchasingOrgSchema).toContain("companyCode: varchar('company_code', { length: 10 }),");
    expect(purchasingOrgSchema).not.toContain(
      "companyCode: varchar('company_code', { length: 10 }).notNull()",
    );
    expect(migration).toContain(
      'ALTER TABLE "purchasing_org"\n  ALTER COLUMN "company_code" DROP NOT NULL;',
    );
    expect(migration).not.toMatch(/UPDATE\s+"?purchasing_org"?/i);
  });

  it('fails closed until one active Company Code is assigned', () => {
    expect(supplierPurchasing).toContain(
      "if(!scope.companyCode)throw new SupplierPurchasingError('A Company Code assignment is required before supplier purchasing can be used.'",
    );
    expect(supplierPurchasing).toContain('.innerJoin(companyCode');
    expect(supplierPurchasing).toContain('eq(companyCode.companyCode,purchasingOrg.companyCode)');
  });
});
