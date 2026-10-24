import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('CO15 screen contract', () => {
  const page = read('src/app/production/order-confirmation/page.tsx');
  const form = read('src/app/production/order-confirmation/OrderConfirmationWorkbench.tsx');
  const service = read('src/modules/production/order-confirmation.ts');

  it('is a header confirmation and does not offer an unimplemented control', () => {
    expect(service).toContain("ORDER_CONFIRMATION_ROUTE = '/production/order-confirmation'");
    expect(service).toContain("ORDER_CONFIRMATION_ALIAS = 'CO15'");
    expect(page).toContain('orderConfirmationRefusal');
    expect(page).toContain('data-co15-gaps');
    expect(form).not.toContain('name="backflush"');
    expect(form).not.toContain('name="personnel"');
    expect(form).not.toContain('value="AUTOMATIC"');
    expect(form).not.toContain('name="confirmationNumber"');
    expect(form).not.toContain('name="operationNumber"');
    expect(service).not.toContain('postGoodsIssue');
    expect(service).not.toContain('postProductionReceipt');
    expect(service).toContain("confirmation_level, yield_quantity");
    expect(service).toContain("'HEADER'");
  });
});
