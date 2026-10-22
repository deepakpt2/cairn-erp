import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-164 — the purchase-order display's contract.
 *
 * One order, read. The search alias stays out of the identifiers. The screen
 * does not post, release, or receive.
 */
describe('SCR-164 purchase order display screen contract', () => {
  const page = read('src/app/purchasing/purchase-order-display/page.tsx');
  const service = read('src/modules/purchasing/purchase-order-display.ts');
  const seed = read('scripts/seed.ts');

  it('reads an order and does not write one', () => {
    expect(page).toContain('openPurchaseOrderDisplay(');
    expect(page).toContain('kind="purchase-order"');
    expect(page).toContain('kind="plant"');
    expect(page).toContain('kind="purchasing-org"');
    expect(page).toContain('data-po-nothing-written');
    expect(page).toContain('data-po-no-period');
    expect(page).not.toContain('ME23N');
    expect(page).not.toContain('method="post"');
    expect(service).toContain('gr_ir_maintenance_link');
    expect(service).toContain('material_document_line');
    expect(service).not.toContain('.insert(');
    expect(service).not.toContain('.update(');
    expect(service).not.toContain('.delete(');
    expect(service).not.toContain('postJournalEntry');
    expect(service).not.toContain('posting_period');
    expect(seed).toContain("aliases: ['ME23N']");
    expect(seed).toContain('PROC.PO.DISPLAY');
    expect(seed).not.toContain("'ME23N', 'ME28'");
  });
});
