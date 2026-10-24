import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('MD12 screen contract', () => {
  const page = read('src/app/production/planned-order-change/page.tsx');
  const service = read('src/modules/production/planned-order-change.ts');
  const seed = read('scripts/seed.ts');
  const action = read('src/app/production/planned-order-change/actions.ts');

  it('changes the standing order and does not open the first match', () => {
    expect(service).toContain("PLANNED_ORDER_CHANGE_ROUTE = '/production/planned-order-change'");
    expect(service).toContain("PLANNED_ORDER_CHANGE_ALIAS = 'MD12'");
    expect(seed).toContain("aliases: ['MD12']");
    expect(seed).toContain("route: '/production/planned-order-change'");
    expect(page).toContain('The first was not opened.');
    expect(page).not.toContain('name="companyCode"');
    expect(page).not.toContain('name="mrpArea"');
    expect(action).toContain('assertChangeForSession');
    expect(service).not.toContain('createProductionOrder');
    expect(service).not.toContain('explodePlannedSupply');
  });
});
