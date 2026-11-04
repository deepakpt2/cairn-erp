import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CONFIRMATION_DISPLAY_ROUTE,
  ConfirmationDisplayError,
  validateConfirmationDisplaySelection,
} from '@/modules/production/confirmation-display';
import { PRODUCTION_ORDER_DISPLAY_CAPABILITY } from '@/modules/production/production-order-display';
import { SCREENS } from '@/ui/shell/screen-catalog';

const read = (path: string) => readFileSync(path, 'utf8');

describe('CO14 confirmation display contract', () => {
  it('validates only fields backed by the confirmation records and supports paging and sorting', () => {
    const selection = validateConfirmationDisplaySelection({
      confirmationNumber: 'cnf0000042',
      productionOrder: 'prd0000134',
      operation: '0010',
      plant: '1000',
      recordedFrom: '2026-10-01',
      recordedTo: '2026-10-31',
      postingFrom: '2026-10-01',
      postingTo: '2026-10-31',
      page: 2,
      sort: 'posting',
      direction: 'asc',
    });
    expect(selection).toMatchObject({
      confirmationNumber: 'CNF0000042',
      productionOrder: 'PRD0000134',
      operation: '0010',
      plant: '1000',
      page: 2,
      sort: 'posting',
      direction: 'asc',
    });
  });

  it('refuses an unbounded selection and invalid dates, ranges, and operation numbers', () => {
    expect(() => validateConfirmationDisplaySelection({})).toThrow(ConfirmationDisplayError);
    expect(() => validateConfirmationDisplaySelection({ recordedFrom: '2026-02-30' })).toThrow(/valid calendar date/);
    expect(() => validateConfirmationDisplaySelection({ recordedFrom: '2026-10-02', recordedTo: '2026-10-01' })).toThrow(/on or before/);
    expect(() => validateConfirmationDisplaySelection({ operation: '010' })).toThrow(/four-character/);
    expect(validateConfirmationDisplaySelection({ productionOrder: 'PRD1', sort: 'constructor' as never }).sort).toBe('confirmation');
  });

  it('uses the existing display capability and route, and performs reads only', () => {
    const page = read('src/app/production/confirmation-display/page.tsx');
    const service = read('src/modules/production/confirmation-display.ts');
    const registry = read('src/platform/registry/index.ts');
    expect(CONFIRMATION_DISPLAY_ROUTE).toBe('/production/confirmation-display');
    expect(PRODUCTION_ORDER_DISPLAY_CAPABILITY).toBe('PROD.ORDER.DISPLAY');
    expect(SCREENS.find((screen) => screen.path === CONFIRMATION_DISPLAY_ROUTE)).toMatchObject({
      code: PRODUCTION_ORDER_DISPLAY_CAPABILITY,
      accepts: expect.arrayContaining(['confirmation', 'order', 'plant']),
    });
    expect(page).toContain('requireSession(CONFIRMATION_DISPLAY_ROUTE)');
    expect(page).toContain('can(session, PRODUCTION_ORDER_DISPLAY_CAPABILITY)');
    expect(page).toContain('getProductionConfirmationDisplay');
    expect(page).toContain('searchProductionConfirmations');
    expect(page).toContain('production-order-display?order=');
    expect(page).toContain('data-co14-cancellation');
    expect(page).toContain('id="co14-material-documents-heading"');
    expect(page).toContain('data-co14-personnel-note');
    expect(registry).toContain("ranked.matchedText.toUpperCase() === 'CO14'");
    expect(registry).toContain("'/production/confirmation-display'");
    expect(service).not.toMatch(/\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i);
    expect(service).toContain('withTenant(client');
    expect(service).toContain('production_confirmation_cancellation');
    expect(service).toContain('production_confirmation_operation');
    expect(service).toContain('production_confirmation_activity');
    expect(service).toContain('movementRequestKey');
  });
});
