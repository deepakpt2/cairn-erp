import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-162 — the blocked-invoice screen's contract.
 *
 * One manual hold. The search alias stays out of the identifiers. This screen
 * does not post, and the payment run reads the same hold.
 */
describe('SCR-162 blocked invoice screen contract', () => {
  const page = read('src/app/purchasing/blocked-invoice/page.tsx');
  const forms = read('src/app/purchasing/blocked-invoice/BlockedInvoiceForms.tsx');
  const actions = read('src/app/purchasing/blocked-invoice/actions.ts');
  const service = read('src/modules/purchasing/blocked-invoice.ts');
  const paymentRun = read('src/modules/finance/payment-run.ts');
  const seed = read('scripts/seed.ts');
  const migration = read('drizzle/9099_supplier_invoice_payment_block.sql');

  it('lists a manual hold and does not post', () => {
    expect(page).toContain('listBlockedInvoices(');
    expect(page).toContain('listBlockEvents(');
    expect(page).toContain('kind="company"');
    expect(page).toContain('kind="supplier-invoice"');
    expect(page).toContain('data-blocked-invoice-no-post');
    expect(page).toContain('data-blocked-invoice-manual-only');
    expect(forms).toContain('data-blocked-invoice-nothing-written');
    expect(page).not.toContain('name="price"');
    expect(page).not.toContain('name="quantity"');
    expect(page).not.toContain('name="batch"');
    expect(page).not.toContain('MRBR');
    expect(`${page}\n${forms}\n${actions}\n${service}`).not.toContain('postJournalEntry');
    expect(service).not.toContain('postSupplierInvoice');
    expect(service).not.toContain('assertPeriodOpen');
    expect(service).not.toContain('derivePosition');
    expect(service).not.toContain('allocateNumber');
    expect(paymentRun).toContain('activeBlockedInvoiceNumbers');
  });

  it('keeps the alias in the catalogue and refuses what does not stand', () => {
    expect(seed).toContain("code: 'PROC.INV.BLOCK.RELEASE'");
    expect(seed).toContain("code: 'PROC.INV.BLOCK'");
    expect(seed).toContain("aliases: ['MRBR']");
    expect(service).toContain('A price block is not on this screen.');
    expect(service).toContain('A quantity block is not on this screen.');
    expect(service).toContain('A quality block is not on this screen.');
    expect(service).toContain('A batch release is not this screen.');
    expect(service).toContain('This screen does not execute a payment.');
    expect(service).toContain('is not a posted invoice.');
    expect(service).toContain('already paid.');
    expect(migration).toContain("reason = 'MANUAL'");
    expect(migration).not.toContain('PRICE');
  });
});
