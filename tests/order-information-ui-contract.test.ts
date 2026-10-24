import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('COOIS screen contract', () => {
  const page = read('src/app/production/order-information/page.tsx');
  const service = read('src/modules/production/order-information.ts');

  it('is a read-only list and does not offer an unavailable list as data', () => {
    expect(service).toContain("ORDER_INFORMATION_ROUTE = '/production/order-information'");
    expect(service).toContain("ORDER_INFORMATION_ALIAS = 'COOIS'");
    expect(page).toContain('orderInformationRefusal');
    expect(page).toContain('data-coois-unavailable');
    expect(page).toContain('CO14 are not implemented');
    expect(page).not.toContain('/production/confirmation-display');
    expect(service).toContain('Operations are not stored on the order');
    expect(service).not.toContain('unit_price');
    expect(service).not.toContain('postGoodsIssue');
    expect(service).not.toContain('postProductionReceipt');
    expect(service).toContain('written: false');
  });
});
