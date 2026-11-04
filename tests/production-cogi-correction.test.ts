import { describe, expect, it } from 'vitest';

import { applyProductionCogiCorrections } from '../src/modules/production/production-cogi';
import type { StoredPayload } from '../src/modules/production/production-goods-movement-failures';
import { productionGoodsMovementFailureLine } from '../src/modules/production/schema';

const source: StoredPayload = {
  schemaVersion: 1,
  movementTypeCode: 'PROD_ISSUE_ORDER',
  postingDate: '2026-10-30',
  documentDate: '2026-10-30',
  headerText: 'CO11N 0000000012',
  requestKey: 'confirmation-12-issue',
  lines: [{
    materialNumber: 'MAT-1',
    plant: 'P100',
    storageLocation: 'S001',
    storageLocationMode: 'EXPLICIT',
    quantity: 10,
    entryUnit: null,
    productionOrderNumber: 'ORD-12',
    productionOrderItem: 10,
    batch: null,
    reservationNumber: null,
    reservationItem: null,
  }],
};

const normalizedLines = [{
  lineNumber: 1,
  materialNumber: 'MAT-1',
  plant: 'P100',
  quantity: '10.000',
  unit: 'EA',
  storageLocation: 'S001',
  batchNumber: '',
}] as unknown as Array<typeof productionGoodsMovementFailureLine.$inferSelect>;

describe('COGI correction snapshots', () => {
  it('reduces a quantity and changes supported fields without mutating the immutable source payload', () => {
    const corrected = applyProductionCogiCorrections(source, normalizedLines, [{
      lineNumber: 1,
      quantity: '8.500',
      storageLocation: 's002',
      batch: 'batch-a',
    }]);

    expect(corrected).not.toBe(source);
    expect(corrected.requestKey).toBe(source.requestKey);
    expect(corrected.lines[0]).toMatchObject({ quantity: 8.5, storageLocation: 'S002', batch: 'BATCH-A' });
    expect(source.lines[0]).toMatchObject({ quantity: 10, storageLocation: 'S001', batch: null });
  });

  it('does not allow a correction to exceed the confirmed source quantity', () => {
    expect(() => applyProductionCogiCorrections(source, normalizedLines, [{
      lineNumber: 1,
      quantity: '10.001',
    }])).toThrow(/cannot exceed the confirmed quantity/i);
  });

  it('rejects non-exact quantities and unsupported storage-location syntax', () => {
    expect(() => applyProductionCogiCorrections(source, normalizedLines, [{
      lineNumber: 1,
      quantity: '1.0001',
    }])).toThrow(/at most three fractional digits/i);
    expect(() => applyProductionCogiCorrections(source, normalizedLines, [{
      lineNumber: 1,
      storageLocation: 'BAD/LOC',
    }])).toThrow(/storage location/i);
  });

  it('rejects duplicate line edits, missing lines, and no-op corrections', () => {
    expect(() => applyProductionCogiCorrections(source, normalizedLines, [
      { lineNumber: 1, quantity: '9' },
      { lineNumber: 1, batch: 'B' },
    ])).toThrow(/only once/i);
    expect(() => applyProductionCogiCorrections(source, normalizedLines, [{
      lineNumber: 2,
      quantity: '1',
    }])).toThrow(/does not exist/i);
    expect(() => applyProductionCogiCorrections(source, normalizedLines, [{
      lineNumber: 1,
      quantity: '10',
      storageLocation: 'S001',
      batch: null,
    }])).toThrow(/no movement details changed/i);
  });
});
