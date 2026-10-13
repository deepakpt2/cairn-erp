import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync('src/modules/foundation/schema.ts', 'utf8');
const migration = readFileSync('drizzle/0023_purchasing_org_company_code_fk.sql', 'utf8');

describe('SCR-018 Purchasing Organisation Company Code FK contract', () => {
  it('keeps pending assignments nullable while enforcing a same-tenant Company Code reference', () => {
    expect(schema).toContain("index('purchasing_org_company_code_idx').on(t.client, t.companyCode)");
    expect(schema).toContain("name: 'purchasing_org_client_company_code_fk'");
    expect(schema).toContain('foreignColumns: [companyCode.client, companyCode.companyCode]');
    expect(migration).toContain('ALTER TABLE "purchasing_org"');
    expect(migration).toContain('FOREIGN KEY ("client", "company_code")');
    expect(migration).toContain('REFERENCES "company_code" ("client", "company_code")');
    expect(migration).toContain('ON DELETE NO ACTION');
    expect(migration).toContain('ON UPDATE NO ACTION');
  });

  it('fails closed on existing tenant-local orphan assignments before adding the FK', () => {
    expect(migration).toMatch(/LEFT JOIN company_code cc[\s\S]*?cc\.client\s*=\s*po\.client[\s\S]*?cc\.company_code\s*=\s*po\.company_code[\s\S]*?po\.company_code IS NOT NULL[\s\S]*?cc\.company_code IS NULL/);
    expect(migration).toContain('tenant-local orphan assignment exists');
    expect(migration.indexOf('orphan assignment exists')).toBeLessThan(migration.indexOf('ADD CONSTRAINT'));
  });
});
