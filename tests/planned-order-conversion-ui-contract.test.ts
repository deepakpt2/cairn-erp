import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('CO40 and CO41 screen contract', () => {
  const single = read('src/app/production/planned-order-conversion/page.tsx');
  const collective = read('src/app/production/planned-order-conversion-collective/page.tsx');
  const service = read('src/modules/production/planned-order-conversion.ts');
  const seed = read('scripts/seed.ts');

  it('uses one conversion service and does not open the first match', () => {
    expect(service).toContain("PLANNED_ORDER_CONVERT_ROUTE = '/production/planned-order-conversion'");
    expect(service).toContain("PLANNED_ORDER_CONVERT_ALIAS = 'CO40'");
    expect(service).toContain("PLANNED_ORDER_CONVERT_COLLECTIVE_ALIAS = 'CO41'");
    expect(service).toContain('createProductionOrder');
    expect(service).toContain('selectProductionVersion');
    expect(service).toContain('componentRequirementQuantity');
    expect(service).not.toContain('explodePlannedSupply');
    expect(service).not.toContain('insert(productionOrder)');
    expect(single).toContain('The first was not opened.');
    expect(collective).toContain('Search did not convert.');
    expect(collective).not.toContain('convertPlannedOrder(');
    expect(seed).toContain("aliases: ['CO40']");
    expect(seed).toContain("aliases: ['CO41']");
    expect(single).not.toContain('name="mrpArea"');
    expect(collective).not.toContain('name="availability"');
  });
});
