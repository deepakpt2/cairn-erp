import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('SCR-159 quotation comparison screen contract', () => {
  const page = read('src/app/purchasing/quotation-comparison/page.tsx');
  const service = read('src/modules/purchasing/quotation-comparison.ts');
  const maintain = [
    'src/app/purchasing/quotation/page.tsx',
    'src/app/purchasing/quotation/Quotation.tsx',
    'src/app/purchasing/quotation/actions.ts',
  ].map(read).join('\n');
  const messages = read('src/platform/i18n/index.ts');
  const seed = read('scripts/seed.ts');
  const kinds = read('src/modules/foundation/constrained-kinds.ts');
  const values = read('src/modules/foundation/constrained-values.ts');

  it('compares standing quotations and does not write', () => {
    expect(page).toContain('compareQuotations(');
    expect(page).toContain('kind="quotation-event"');
    expect(page).toContain('kind="purchasing-org"');
    expect(page).toContain('kind="plant"');
    expect(page).toContain('kind="material-rfq"');
    expect(page).toContain('data-comparison-rank');
    expect(page).toContain('data-comparison-price');
    expect(page).toContain('data-comparison-no-award');
    expect(page).toContain('data-comparison-nothing-written');
    expect(page).toContain('data-comparison-quotation');
    expect(page).toContain('data-comparison-maintain');
    expect(page).not.toContain('name="price"');
    expect(page).not.toContain('name="status"');
    expect(page).not.toContain('name="currency"');
    expect(page).not.toContain('name="revision"');
    expect(page).not.toContain('name="award"');
    expect(page).not.toContain('name="freight"');
    expect(page).not.toContain('createQuotation(');
    expect(page).not.toContain('changeQuotation(');
    expect(service).not.toContain('recordChange(');
    expect(service).not.toContain('allocateNumber(');
    expect(service).not.toContain('.insert(');
    expect(service).not.toContain('.update(');
    expect(service).not.toContain('.delete(');
    expect(service).not.toContain('unit-conversion');
    expect(service).not.toMatch(/from ['"].*exchange/);
    expect(existsSync(join(root, 'src/app/purchasing/quotation-comparison/actions.ts'))).toBe(false);
    expect(existsSync(join(root, 'drizzle/9098_purchasing_quotation_comparison.sql'))).toBe(false);
  });

  it('keeps the alias in the catalogue and the code line, and out of the maintain screen', () => {
    expect(page).not.toMatch(/ME49/);
    expect(messages).toContain("'quotationComparison.code': 'PROC.RFQ.COMPARISON · ME49'");
    expect(seed).toMatch(/code: 'PROC\.RFQ\.COMPARISON'[\s\S]{0,500}posting: false/);
    expect(seed).toContain("aliases: ['ME49']");
    expect(seed).toContain("route: '/purchasing/quotation-comparison'");
    expect(kinds).toContain("'quotation-event'");
    expect(values).toContain("case 'quotation-event'");
    expect(values).not.toMatch(/collective_number ilike/);
    expect(maintain).not.toMatch(/ME49/);
  });
});
