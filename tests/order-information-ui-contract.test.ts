import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('COOIS screen contract', () => {
  const page = read('src/app/production/order-information/page.tsx');
  const service = read('src/modules/production/order-information.ts');
  const result = read('src/app/production/order-information/OrderInformationResult.tsx');

  it('is a read-only list and does not offer an unavailable list as data', () => {
    expect(service).toContain("ORDER_INFORMATION_ROUTE = '/production/order-information'");
    expect(service).toContain("ORDER_INFORMATION_ALIAS = 'COOIS'");
    expect(page).toContain('orderInformationRefusal');
    expect(page).toContain('data-coois-unavailable');
    expect(page).toContain('Confirmation display is CO14; cancellation is CO13.');
    expect(result).toContain('/production/confirmation-display?confirmation=');
    expect(result).toContain('Open CO14 display');
    expect(service).toContain('Operations are not stored on the order');
    expect(service).not.toContain('unit_price');
    expect(service).not.toContain('postGoodsIssue');
    expect(service).not.toContain('postProductionReceipt');
    expect(service).toContain('written: false');
  });
});
