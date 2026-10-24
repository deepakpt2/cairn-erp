import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('CO02 screen contract', () => {
  it('changes the standing order and does not invent operations', () => {
    const page = readFileSync('src/app/production/production-order-change/page.tsx', 'utf8');
    const service = readFileSync('src/modules/production/production-order-change.ts', 'utf8');
    expect(service).toContain("PRODUCTION_ORDER_CHANGE_ALIAS = 'CO02'");
    expect(service).toContain('PRODUCTION_ORDER_LOCK');
    expect(service).not.toContain('insert(productionOrder)');
    expect(service).toContain('not rescaled');
    expect(page).toContain('The first was not opened.');
    expect(page).not.toContain('name="orderType"');
    expect(page).not.toContain('name="operation"');
  });
});
