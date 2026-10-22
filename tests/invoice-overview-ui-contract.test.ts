import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-161 — the invoice overview screen's contract.
 *
 * One list. The search alias stays out of the identifiers. This screen does not post.
 */
describe('SCR-161 invoice overview screen contract', () => {
  const page = read('src/app/purchasing/invoice-overview/page.tsx');
  const service = read('src/modules/purchasing/invoice-overview.ts');
  const seed = read('scripts/seed.ts');

  it('lists parked and posted invoices, and does not post', () => {
    expect(page).toContain('listInvoiceOverview(');
    expect(page).toContain('readInvoiceOverviewDocument(');
    expect(page).toContain('kind="company"');
    expect(page).toContain('kind="supplier-invoice"');
    expect(page).toContain('data-invoice-overview-no-post');
    expect(page).toContain('data-invoice-overview-nothing-written');
    expect(page).toContain('data-invoice-overview-no-journal');
    expect(page).not.toContain('name="status"');
    expect(page).not.toContain('name="paymentBlock"');
    expect(page).not.toContain('name="export"');
    expect(page).not.toContain('name="draft"');
    expect(page).not.toContain('MIR6');
    expect(page).not.toContain('MIR6');
    expect(`${page}\n${service}`).not.toContain('postJournalEntry');
    expect(service).not.toContain('postSupplierInvoice');
    expect(service).not.toContain('assertPeriodOpen');
    expect(service).not.toContain('derivePosition');
    expect(service).not.toContain('allocateNumber');
    expect(service).not.toContain('recordChange');
  });

  it('keeps the alias in the catalogue and refuses what does not stand', () => {
    expect(seed).toContain("code: 'PROC.INV.OVERVIEW'");
    expect(seed).toContain('posting: false');
    expect(seed).toContain("aliases: ['MIR6']");
    expect(service).toContain('A draft is not an invoice on this list.');
    expect(service).toContain('A payment block is not on this list.');
    expect(service).toContain('A reversal is not a status on this list.');
    expect(service).toContain('There is no company-code authorization object.');
    expect(service).toContain('This list does not convert an amount.');
    expect(service).toContain('An invoice without a purchase order is not this list.');
  });
});
