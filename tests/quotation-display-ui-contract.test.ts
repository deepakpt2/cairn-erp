import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('SCR-158 quotation display screen contract', () => {
  const page = read('src/app/purchasing/quotation-display/page.tsx');
  const service = read('src/modules/purchasing/quotation-display.ts');
  const maintain = read('src/app/purchasing/quotation/page.tsx') + read('src/app/purchasing/quotation/Quotation.tsx');
  const messages = read('src/platform/i18n/index.ts');
  const seed = read('scripts/seed.ts');
  const kinds = read('src/modules/foundation/constrained-kinds.ts');

  it('reads by quotation number and does not write', () => {
    expect(page).toContain('displayQuotation(');
    expect(page).toContain('displayQuotationForRequest(');
    expect(page).toContain('kind="quotation-number"');
    expect(page).toContain('kind="quotation-request"');
    expect(page).toContain('data-quotation-per-unit');
    expect(page).toContain('data-quotation-nothing-written');
    expect(page).toContain('data-quotation-no-award');
    expect(page).toContain('data-quotation-history');
    expect(page).not.toContain('name="netPrice"');
    expect(page).not.toContain('name="price"');
    expect(page).not.toContain('name="status"');
    expect(page).not.toContain('name="currency"');
    expect(page).not.toContain('name="revision"');
    expect(page).not.toContain('name="award"');
    expect(page).not.toContain('name="condition"');
    expect(page).not.toContain('createQuotation(');
    expect(page).not.toContain('changeQuotation(');
    expect(service).not.toContain('recordChange(');
    expect(service).not.toContain('allocateNumber(');
    expect(service).not.toContain('.insert(');
    expect(service).not.toContain('.update(');
    expect(service).not.toContain('.delete(');
    expect(existsSync(join(root, 'src/app/purchasing/quotation-display/actions.ts'))).toBe(false);
    expect(existsSync(join(root, 'drizzle/9098_purchasing_quotation_display.sql'))).toBe(false);
  });

  it('keeps the search alias out of identifiers and does not reopen the maintain screen', () => {
    expect(page).not.toMatch(/id="[^"]*ME48/);
    expect(page).not.toMatch(/data-[a-z-]*me48/);
    expect(page).not.toMatch(/name="[^"]*ME48/);
    expect(messages).toContain("'quotationDisplay.code': 'PROC.RFQ.QUOTATION.DISPLAY · ME48'");
    expect(seed).toMatch(/code: 'PROC\.RFQ\.QUOTATION\.DISPLAY'[\s\S]{0,400}posting: false/);
    expect(seed).toContain("aliases: ['ME48']");
    expect(seed).toContain("route: '/purchasing/quotation-display'");
    expect(kinds).toContain("'quotation-number'");
    expect(maintain).not.toMatch(/ME48/);
    expect(page).toContain('QUOTATION_CAPABILITY');
    expect(page).toContain('data-display-maintain');
  });
});
