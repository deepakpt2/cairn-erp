import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { productionOrderMayBeCharged } from '../src/modules/production/production-order-status';

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

  it('follows the confirmation-service status rule and does not block technical completion by itself', () => {
    expect(productionOrderMayBeCharged('CREATED')).toBe(false);
    expect(productionOrderMayBeCharged('RELEASED')).toBe(true);
    expect(productionOrderMayBeCharged('TECHNICALLY_COMPLETED')).toBe(true);
    expect(form).toContain('productionOrderMayBeCharged(loaded.status)');
    expect(form).not.toContain("loaded.status !== 'RELEASED'");
    expect(form).toContain('loaded.eligible.length === 0');
    expect(form).toContain('disabled={!canConfirm || blocked || pending} data-co15-check');
    expect(form).toContain('disabled={!canConfirm || blocked || pending} data-co15-save');
    expect(service).toContain('productionOrderMayBeCharged(header.status)');
    expect(service).not.toContain("header.status !== 'RELEASED'");
    expect(service).toContain('ORDER_CONFIRMATION_CAPABILITY');
  });
});
