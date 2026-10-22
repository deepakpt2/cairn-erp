import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-165 — the vendor-evaluation screen's contract.
 *
 * One supplier, one purchasing organisation, and a period. The alias stays in
 * the catalogue. A check writes nothing. An automatic score is not a column.
 */
describe('SCR-165 vendor evaluation screen contract', () => {
  const page = read('src/app/purchasing/vendor-evaluation/page.tsx');
  const form = read('src/app/purchasing/vendor-evaluation/ManualScoreForm.tsx');
  const actions = read('src/app/purchasing/vendor-evaluation/actions.ts');
  const service = read('src/modules/purchasing/vendor-evaluation.ts');
  const seed = read('scripts/seed.ts');
  const sql = read('drizzle/9101_vendor_evaluation.sql');

  it('reads a period and stores only a manual score', () => {
    expect(page).toContain('checkVendorEvaluation(');
    expect(page).toContain('kind="supplier-purchasing"');
    expect(page).toContain('kind="purchasing-org"');
    expect(page).toContain('data-ve-nothing-written');
    expect(page).toContain('data-ve-no-period');
    expect(page).toContain('data-ve-overall');
    expect(page).not.toContain('ME61');
    expect(page).not.toContain('postJournalEntry');
    expect(form).not.toContain('crypto.randomUUID');
    expect(form).not.toContain('name="overallScore"');
    expect(form).not.toContain('name="weight"');
    expect(actions).not.toContain('revalidatePath');
    expect(actions).not.toContain('redirect(');
    expect(service).toContain('insert into vendor_evaluation_assessment');
    expect(service).not.toContain('posting_period');
    expect(service).not.toContain('postJournalEntry');
    expect(service).not.toContain('insert into journal');
    expect(service).not.toContain('insert into material_document');
    expect(service).not.toContain('insert into supplier_invoice');
    expect(sql).not.toContain('overall_score');
    expect(sql).not.toContain('company_code');
    expect(sql).not.toContain('evaluation_run');
    expect(seed).toContain("aliases: ['ME61']");
    expect(seed).toContain('PROC.VENDOR.EVALUATE');
    expect(seed).toContain("'PRICE', 'Price', 'AUTOMATIC', 'PRICE'");
    expect(seed).toContain("'QUALITY', 'Quality', 'MANUAL', 'NONE'");
    expect(seed).not.toContain("'ME61', 'ME63'");
  });
});
