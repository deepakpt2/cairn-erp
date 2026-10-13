import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const service = readFileSync('src/modules/foundation/purchasing-group-maintenance.ts', 'utf8');
const supplierConsumer = readFileSync('src/modules/foundation/supplier-purchasing.ts', 'utf8');

describe('SCR-019 Purchasing Group maintenance service contract', () => {
  it('accepts only a three-character alphanumeric key and the overview fields', () => {
    expect(service).toContain("z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3}$/)");
    expect(service).toContain("name: z.string().trim().min(1).max(120)");
    expect(service).toContain('optionalText(12)');
    expect(service).toContain('optionalText(31)');
    expect(service).toContain('emailAddress: optionalText(241)');
    for (const field of ['telNoPurchGroup', 'faxNumber', 'telephone', 'extension', 'emailAddress']) {
      expect(service).toContain(`${field}:`);
    }
    expect(service).toContain('.strict()');
    expect(service).not.toContain('companyCode:');
    expect(service).not.toContain('plant:');
  });

  it('scopes reads and writes to the verified client, with audit-backed optimistic concurrency', () => {
    expect(service).toContain('withTenant(client');
    expect(service).toContain('eq(purchasingGroupTable.client, client)');
    expect(service).toContain('pg_advisory_xact_lock');
    expect(service).toContain('purchasingGroupAuditVersion');
    expect(service).toContain('changeDocument.objectClass');
    expect(service).toContain("const PURCHASING_GROUP_ACTIVITY = 'CFG.PROC.PURGROUP.DEFINE'");
    expect(service).toContain('recordChange(tx');
    expect(service).toContain('markActivityComplete(tx, client, PURCHASING_GROUP_ACTIVITY, changedBy)');
  });

  it('keeps new definitions unassigned and prevents delete while existing consumers reference a group', () => {
    expect(service).toContain('purchasingOrg: null');
    expect(service).toContain('responsibleBuyer: null');
    expect(service).toContain('await tx.delete(purchasingGroupTable)');
    expect(service).toContain("hasSqlState(error, '23503')");
    expect(service).toContain('cannot be deleted while Material or Supplier purchasing records reference it');
    expect(service).not.toMatch(/'ACTIVATE'|'REACTIVATE'/);
  });

  it('leaves existing supplier consumers intact while making unassigned definitions reusable across organisations', () => {
    expect(supplierConsumer).toContain('buyer.purchasingOrg&&buyer.purchasingOrg!==org');
    expect(supplierConsumer).toContain('groups:groups.filter(row=>!row.org||row.org===org)');
    expect(service).toContain('purchasingOrg: null');
  });

  it('treats no-op changes as silent and rejects stale versions and key reuse after deletion', () => {
    expect(service).toContain('if (sameDefinition(current, fields))');
    expect(service).toContain('if (change.expectedVersion !== version) throw staleVersion(code)');
    expect(service).toContain('has prior change history and cannot be reused');
    expect(service).toContain('for (const code of [...codes].sort()) await lockPurchasingGroup');
  });
});
