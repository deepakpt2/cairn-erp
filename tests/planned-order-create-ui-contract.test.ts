import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('MD11 screen contract', () => {
  const page = read('src/app/production/planned-order-create/page.tsx');
  const service = read('src/modules/production/planned-order-create.ts');
  const seed = read('scripts/seed.ts');

  it('creates a manual planned order and does not open the first match', () => {
    expect(service).toContain("PLANNED_ORDER_CREATE_ROUTE = '/production/planned-order-create'");
    expect(service).toContain("PLANNED_ORDER_CREATE_ALIAS = 'MD11'");
    expect(seed).toContain("aliases: ['MD11']");
    expect(seed).toContain("route: '/production/planned-order-create'");
    expect(page).toContain('The first was not opened.');
    expect(page).not.toContain('name="profile"');
    expect(page).not.toContain('name="companyCode"');
    expect(service).not.toContain('explodePlannedSupply');
    expect(service).toContain("'MANUAL'");
    expect(service).toContain("'FIRMED'");
  });
});
