import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-160 — the parked invoice screen's contract.
 *
 * One screen parks an invoice against one order. A check writes nothing.
 * The search alias stays out of the identifiers. This screen does not post.
 */
describe('SCR-160 parked invoice screen contract', () => {
  const page = read('src/app/purchasing/parked-invoice/page.tsx');
  const shell = read('src/app/purchasing/parked-invoice/ParkedInvoice.tsx');
  const actions = read('src/app/purchasing/parked-invoice/actions.ts');
  const service = read('src/modules/purchasing/parked-invoice.ts');
  const seed = read('scripts/seed.ts');
  const identifiers = `${page}\n${shell}\n${actions}`;

  it('opens an order and a parked invoice by suggestion, and does not post', () => {
    expect(page).toContain('openOrderForPark(');
    expect(page).toContain('getParkedInvoice(');
    expect(page).toContain('PARKED_INVOICE_ROUTE');
    expect(shell).toContain('kind="purchase-order"');
    expect(shell).toContain('kind="parked-invoice"');
    expect(shell).toContain('data-parked-invoice-check');
    expect(shell).toContain('data-parked-invoice-save');
    expect(shell).toContain('data-parked-invoice-nothing-written');
    expect(shell).toContain('data-parked-invoice-no-post');
    expect(shell).toContain('data-parked-invoice-history');
    expect(shell).not.toContain('name="status"');
    expect(shell).not.toContain('name="currency"');
    expect(shell).not.toContain('name="companyCode"');
    expect(shell).not.toContain('name="category"');
    expect(shell).not.toContain('name="post"');
    expect(shell).not.toContain('name="delete"');
    expect(identifiers).not.toContain('MIR7');
    expect(page).toContain('/purchasing/invoice-verification');
  });

  it('checks without writing and does not call the posting engine', () => {
    const check = actions.slice(
      actions.indexOf('export async function checkParkedInvoiceAction'),
      actions.indexOf('export async function saveParkedInvoiceAction'),
    );
    expect(check).toContain('previewParkedInvoice(');
    expect(check).toContain('previewParkedInvoiceChange(');
    expect(check).not.toContain('parkSupplierInvoice(');
    expect(check).not.toContain('changeParkedInvoice(');
    expect(check).not.toContain('revalidatePath');
    expect(check).not.toContain('allocateNumber');
    expect(service).not.toContain('postJournalEntry');
    expect(service).not.toContain('postSupplierInvoice');
    expect(service).not.toContain('assertPeriodOpen');
    expect(service).toContain('A credit memo is not parked this round.');
    expect(service).toContain('This screen does not post a journal');
    expect(seed).toContain("code: 'PROC.INV.PARK'");
    expect(seed).toContain('posting: false');
    expect(seed).toContain("aliases: ['MIR7']");
  });
});
