import { describe, expect, it } from 'vitest';
import {
  purchasingGroupChangeSetSchema,
  purchasingGroupDefinitionValuesSchema,
} from '@/modules/foundation/purchasing-group-maintenance';

describe('SCR-019 Purchasing Group input contract', () => {
  it('normalizes an alphanumeric three-character key and optional overview contact fields', () => {
    const parsed = purchasingGroupChangeSetSchema.parse({
      client: 'T982',
      changedBy: 'SCR019_TEST',
      changes: [{
        mode: 'CREATE',
        purchasingGroup: ' a1b ',
        expectedVersion: 0,
        values: { name: '  Maintenance team  ', telephone: '555 0100', emailAddress: 'buyer@example.test' },
      }],
    });

    expect(parsed.changes).toEqual([{
      mode: 'CREATE',
      purchasingGroup: 'A1B',
      expectedVersion: 0,
      values: {
        name: 'Maintenance team',
        telNoPurchGroup: null,
        faxNumber: null,
        telephone: '555 0100',
        extension: null,
        emailAddress: 'buyer@example.test',
      },
    }]);
  });

  it.each(['AB', 'ABCD', 'A-1', 'A_1', '  '])('rejects a non-three-character alphanumeric key: %s', (code) => {
    expect(purchasingGroupChangeSetSchema.safeParse({
      client: 'T982',
      changedBy: 'SCR019_TEST',
      changes: [{ mode: 'CREATE', purchasingGroup: code, expectedVersion: 0, values: { name: 'Valid team' } }],
    }).success).toBe(false);
  });

  it('requires a nonblank description and enforces contact field widths without assuming an email syntax', () => {
    expect(purchasingGroupDefinitionValuesSchema.safeParse({ name: '   ' }).success).toBe(false);
    // The reference screen exposes a free-form address field; do not impose an unverified format policy.
    expect(purchasingGroupDefinitionValuesSchema.safeParse({ name: 'Buyers', emailAddress: 'not-an-email' }).success).toBe(true);
    // Preserve the existing Cairn description width until a reviewed migration can normalize legacy seed labels.
    expect(purchasingGroupDefinitionValuesSchema.safeParse({ name: 'X'.repeat(19) }).success).toBe(true);
    expect(purchasingGroupDefinitionValuesSchema.safeParse({ name: 'X'.repeat(121) }).success).toBe(false);
    expect(purchasingGroupDefinitionValuesSchema.safeParse({ name: 'Buyers', telNoPurchGroup: '1'.repeat(13) }).success).toBe(false);
    expect(purchasingGroupDefinitionValuesSchema.safeParse({ name: 'Buyers', faxNumber: '1'.repeat(32) }).success).toBe(false);
    expect(purchasingGroupDefinitionValuesSchema.safeParse({ name: 'Buyers', telephone: '1'.repeat(31) }).success).toBe(false);
    expect(purchasingGroupDefinitionValuesSchema.safeParse({ name: 'Buyers', extension: '1'.repeat(11) }).success).toBe(false);
    expect(purchasingGroupDefinitionValuesSchema.safeParse({ name: 'Buyers', emailAddress: 'x'.repeat(242) }).success).toBe(false);
  });

  it('rejects assignment and legacy buyer fields outside the approved standalone definition', () => {
    const result = purchasingGroupChangeSetSchema.safeParse({
      client: 'T982',
      changedBy: 'SCR019_TEST',
      changes: [{
        mode: 'CREATE',
        purchasingGroup: 'A01',
        expectedVersion: 0,
        values: { name: 'Buyers', purchasingOrg: '1000', companyCode: '1000', plant: '1000' },
      }],
    });
    expect(result.success).toBe(false);
  });

  it('requires an expected version for change and delete, and restricts new entries to version zero', () => {
    const base = { client: 'T982', changedBy: 'SCR019_TEST' };
    expect(purchasingGroupChangeSetSchema.safeParse({
      ...base,
      changes: [{ mode: 'CREATE', purchasingGroup: 'A01', expectedVersion: 2, values: { name: 'Buyers' } }],
    }).success).toBe(false);
    expect(purchasingGroupChangeSetSchema.safeParse({
      ...base,
      changes: [{ mode: 'CHANGE', purchasingGroup: 'A01', values: { name: 'Buyers' } }],
    }).success).toBe(false);
    expect(purchasingGroupChangeSetSchema.safeParse({
      ...base,
      changes: [{ mode: 'DELETE', purchasingGroup: 'A01', expectedVersion: 1 }],
    }).success).toBe(true);
  });
});
