import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-163 — the GR/IR clearing screen's contract.
 *
 * One residual, cleared by the canonical journal. The search alias stays out
 * of the identifiers. The screen does not move stock.
 */
describe('SCR-163 GR/IR clearing screen contract', () => {
  const page = read('src/app/purchasing/grir-clearing/page.tsx');
  const forms = read('src/app/purchasing/grir-clearing/GrirClearingForms.tsx');
  const actions = read('src/app/purchasing/grir-clearing/actions.ts');
  const service = read('src/modules/purchasing/grir-clearing.ts');
  const seed = read('scripts/seed.ts');
  const migration = read('drizzle/9100_gr_ir_maintenance_link.sql');

  it('lists a residual and posts through the journal, not through stock', () => {
    expect(page).toContain('listGrIrResiduals(');
    expect(page).toContain('kind="company"');
    expect(page).toContain('kind="plant"');
    expect(page).toContain('kind="purchase-order"');
    expect(page).toContain('data-grir-check-writes-nothing');
    expect(page).toContain('data-grir-no-stock');
    expect(forms).toContain('data-grir-nothing-written');
    expect(page).not.toContain('MR11');
    expect(forms).not.toContain('MR11');
    expect(actions).toContain('deliveryCost');
    expect(service).toContain('postJournalEntry');
    expect(service).toContain('reverseJournalEntry');
    expect(service).not.toContain('stockQuantity');
    expect(service).not.toContain('materialDocument');
    expect(seed).toContain("aliases: ['MR11']");
    expect(seed).toContain('PROC.GRIR.MAINTAIN.POST');
    expect(migration).toContain('gr_ir_maintenance_link');
    expect(migration).not.toContain('uuid');
  });
});
