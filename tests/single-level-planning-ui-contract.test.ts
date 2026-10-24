import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('MD03 screen contract', () => {
  const page = read('src/app/production/single-level-planning/page.tsx');
  const form = read('src/app/production/single-level-planning/SingleLevelWorkbench.tsx');
  const service = read('src/modules/production/mrp-run.ts');
  const seed = read('scripts/seed.ts');

  it('is a separate screen and does not offer an unimplemented control', () => {
    expect(service).toContain("MRP_SINGLE_LEVEL_ROUTE = '/production/single-level-planning'");
    expect(service).toContain("MRP_SINGLE_LEVEL_ALIAS = 'MD03'");
    expect(seed).toContain("aliases: ['MD03']");
    expect(page).toContain('singleLevelRefusal');
    expect(page).toContain('data-md03-gaps');
    expect(form).not.toContain('name="mrpArea"');
    expect(form).not.toContain('name="scheduleLine"');
    expect(form).not.toContain('name="mrpList"');
    expect(form).not.toContain('name="proposalMode"');
    expect(form).not.toContain('value="3"');
    expect(page).not.toContain('planSingleItem');
  });
});
