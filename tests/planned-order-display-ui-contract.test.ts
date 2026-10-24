import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('MD13 screen contract', () => {
  const page = read('src/app/production/planned-order-display/page.tsx');
  const service = read('src/modules/production/planned-order-display.ts');
  const seed = read('scripts/seed.ts');
  const stock = read('src/modules/production/stock-requirements.ts');

  it('is a read-only display with the stored order number as the key', () => {
    expect(service).toContain("PLANNED_ORDER_DISPLAY_ROUTE = '/production/planned-order-display'");
    expect(service).toContain("PLANNED_ORDER_DISPLAY_ALIAS = 'MD13'");
    expect(seed).toContain("aliases: ['MD13']");
    expect(seed).toContain("route: '/production/planned-order-display'");
    expect(page).toContain('plannedOrderDisplayRefusal');
    expect(page).not.toContain('name="companyCode"');
    expect(page).toContain('The first was not opened.');
    expect(stock).toContain('/production/planned-order-display?order=');
    expect(service).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });
});
