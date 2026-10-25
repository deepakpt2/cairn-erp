import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('SCR-166 total planning screen contract', () => {
  const page = read('src/app/production/mrp-run/page.tsx');
  const shell = read('src/app/production/mrp-run/MrpRunWorkbench.tsx');
  const actions = read('src/app/production/mrp-run/actions.ts');
  const service = read('src/modules/production/mrp-run.ts');
  const messages = read('src/platform/i18n/index.ts');
  const seed = read('scripts/seed.ts');

  it('is one screen, and the alias is not a second route', () => {
    expect(service).toContain("MRP_RUN_ROUTE = '/production/mrp-run'");
    expect(service).toContain("MRP_RUN_ALIASES = ['MD01']");
    expect(seed).toContain("aliases: ['MD01']");
    expect(seed).toContain("route: '/production/mrp-run'");
    expect(messages).toContain("'md01.code': 'PROD.MRP.RUN · MD01'");
    expect(page).not.toContain('name="companyCode"');
  });

  it('checks without planning, and separates regenerative planning', () => {
    expect(shell).toContain('name="intent" value="check"');
    expect(shell).toContain('name="intent" value="plan"');
    expect(actions).toContain("text(form, 'intent') === 'check'");
    expect(actions).toContain('MRP_REGENERATE_CAPABILITY');
    expect(shell).toContain('if (state.ok) setRequestKey(newRequestKey());');
    expect(shell).not.toContain('const [requestKey] = useState(newRequestKey);');
  });

  it('refuses the second path by name and does not post', () => {
    expect(service).toContain('An MRP area does not stand.');
    expect(service).toContain('A bill of material is selected through the production version. It is not entered.');
    expect(service).toContain('explodePlannedSupply');
    expect(service).toContain('A planning run posts nothing.');
    expect(service).toContain('A financial period is not read.');
    expect(service).not.toContain('posting_period');
    expect(service).not.toContain('mrp_planning_change');
    expect(service).not.toContain('physical_inventory_count');
    expect(actions).toContain('mrpNamedRefusal');
    expect(page).toContain('data-mrp-refused');
  });

  it('shows the company code as context and links to the live list', () => {
    expect(shell).toContain('data-mrp-company');
    expect(shell).toContain('/production/stock-requirements?material=');
    expect(shell).toContain('data-mrp-dependents');
    expect(shell).toContain('data-mrp-diagnostics');
    expect(messages).toContain("'md01.nothingPosted'");
  });
});
