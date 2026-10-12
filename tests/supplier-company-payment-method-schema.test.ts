import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { supplierCompany } from '@/platform/schema';

const table = getTableConfig(supplierCompany);
const migration = readFileSync('drizzle/0017_supplier_company_payment_methods.sql', 'utf8');

describe('Supplier company Payment Methods storage contract', () => {
  it('adds the nullable field to the existing tenant/company-code segment', () => {
    const column = table.columns.find((candidate) => candidate.name === 'payment_methods');
    expect(table.name).toBe('supplier_company_code');
    expect(column).toBeDefined();
    expect(column?.notNull).toBe(false);
    expect(table.primaryKeys[0].columns.map((item) => item.name)).toEqual([
      'client',
      'partner_number',
      'company_code',
    ]);
  });

  it('uses a nullable additive migration without rewriting or dropping existing data', () => {
    expect(migration).toMatch(/ALTER TABLE "supplier_company_code" ADD COLUMN "payment_methods" varchar\(40\);/);
    expect(migration).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|UPDATE|DELETE)\b/i);
  });
});
