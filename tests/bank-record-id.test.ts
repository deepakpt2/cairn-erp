import { describe, expect, it } from 'vitest';
import { generateBankRecordId, isBankRecordId } from '../src/platform/security/bank-record-id';

describe('server-generated bank-record IDs', () => {
  it('generates unique canonical lowercase UUIDv4 identifiers', () => {
    const ids = Array.from({ length: 64 }, () => generateBankRecordId());

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(isBankRecordId(id)).toBe(true);
    }
  });

  it('rejects sequential IDs, non-v4 UUIDs, and non-canonical casing', () => {
    expect(isBankRecordId('bank-row-001')).toBe(false);
    expect(isBankRecordId('00000000-0000-1000-8000-000000000001')).toBe(false);
    expect(isBankRecordId('00000000-0000-4000-8000-00000000000A')).toBe(false);
  });

  it('treats UUID validation as a shape check, not proof of trusted provenance', () => {
    const syntacticallyValidButUnissued = '00000000-0000-4000-8000-000000000001';
    expect(isBankRecordId(syntacticallyValidButUnissued)).toBe(true);
  });
});
