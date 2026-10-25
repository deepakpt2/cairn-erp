import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('MD02 screen contract', () => {
  const page = read('src/app/production/single-item-planning/page.tsx');
  const service = read('src/modules/production/mrp-run.ts');
  const seed = read('scripts/seed.ts');
  const plant = read('src/modules/production/mrp-run.ts');

  it('is a separate screen from the plant run', () => {
    expect(service).toContain("MRP_SINGLE_ROUTE = '/production/single-item-planning'");
    expect(service).toContain("MRP_SINGLE_ALIAS = 'MD02'");
    expect(seed).toContain("aliases: ['MD02']");
    expect(seed).toContain("route: '/production/single-item-planning'");
    expect(page).toContain('singleItemRefusal');
    expect(page).not.toContain('name="companyCode"');
    expect(plant).toContain('A bill of material is selected through the production version. It is not entered.');
    expect(plant).toContain("if (entryPoint === 'PLANT') explode = true;");
  });
});
