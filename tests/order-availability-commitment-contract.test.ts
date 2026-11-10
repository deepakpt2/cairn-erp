import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  EXPLICIT_GRANT_ONLY_CAPABILITIES,
  PRODUCTION_ORDER_AVAILABILITY_COMMIT_CAPABILITY,
  PRODUCTION_ORDER_AVAILABILITY_RESET_CAPABILITY,
} from '../src/platform/auth/capability-policy';
import {
  holdsOrderAvailabilityCommitAuthority,
  holdsOrderAvailabilityResetAuthority,
} from '../src/modules/production/order-availability-commitment';

describe('CO09 Slice 2 commitment contract', () => {
  const migration = readFileSync('drizzle/history/9214_co09_requirement_commitments.sql', 'utf8');
  const service = readFileSync('src/modules/production/order-availability-commitment.ts', 'utf8');
  const availability = readFileSync('src/modules/production/order-availability.ts', 'utf8');
  const orderSchema = readFileSync('src/modules/inventory/schema.ts', 'utf8');
  const bomSnapshot = readFileSync('src/modules/production/order-bom-snapshot.ts', 'utf8');

  it('registers separate exact-grant-only capabilities', () => {
    expect(EXPLICIT_GRANT_ONLY_CAPABILITIES.has(PRODUCTION_ORDER_AVAILABILITY_COMMIT_CAPABILITY)).toBe(true);
    expect(EXPLICIT_GRANT_ONLY_CAPABILITIES.has(PRODUCTION_ORDER_AVAILABILITY_RESET_CAPABILITY)).toBe(true);
    expect(holdsOrderAvailabilityCommitAuthority([PRODUCTION_ORDER_AVAILABILITY_COMMIT_CAPABILITY])).toBe(true);
    expect(holdsOrderAvailabilityCommitAuthority(['PROD.*'])).toBe(false);
    expect(holdsOrderAvailabilityResetAuthority([PRODUCTION_ORDER_AVAILABILITY_RESET_CAPABILITY])).toBe(true);
    expect(holdsOrderAvailabilityResetAuthority(['PROD.*'])).toBe(false);
  });

  it('preserves BOM eligibility facts and refuses to invent them for older/manual lines', () => {
    for (const field of ['bomItemCategory', 'bomStockRelevant', 'bomPhantom', 'bomBulkMaterial']) {
      expect(orderSchema).toContain(`${field}:`);
      expect(bomSnapshot).toContain(`${field}:`);
    }
    expect(bomSnapshot).toContain('stockRelevanceByCategory.get(item.itemCategory)');
    expect(bomSnapshot).toContain("stockRelevant.trim() === 'X' ? 'X' : ' '");
    expect(migration).toContain('ADD COLUMN bom_stock_relevant char(1)');
    expect(availability).toContain('does not preserve all eligibility facts');
    expect(availability).toContain('does not infer missing facts from today');
  });

  it('makes run snapshots and commitment events tenant-scoped and append-only', () => {
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('current_setting(\'cairn.client\', true)');
    expect(migration).toContain('REVOKE UPDATE, DELETE, TRUNCATE');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration).toContain('pg_trigger_depth() > 1');
    expect(migration).toContain('NOT EXISTS (SELECT 1 FROM public.client c WHERE c.client = OLD.client)');
    expect(migration).toContain("event_kind IN ('COMMITTED', 'RELEASED', 'RESET')");
    expect(migration).toContain('committed_quantity > 0');
    expect(migration).toContain("event_kind IN ('RELEASED', 'RESET') AND committed_quantity = 0");
    expect(migration).toContain('supersedes_event_number');
  });

  it('fingerprints retries, serialises competing checks, and keeps resets append-only', () => {
    expect(service).toContain('requestFingerprint');
    expect(service).toContain('already used for different CO09 input');
    expect(service).toContain('pg_advisory_xact_lock');
    expect(service).toContain('supersedesEventNumber: previous?.eventNumber ?? null');
    expect(service).toContain("eventKind: 'RESET'");
    expect(service).not.toMatch(/delete\s+from\s+production_order_component_commitment_event/i);
    expect(service).toContain("changeType: 'REVERSE'");
  });
});
