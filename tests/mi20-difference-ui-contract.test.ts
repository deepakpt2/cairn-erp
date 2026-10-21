import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-148 stage 4 — the difference screen's contract.
 *
 * The list is a reading. Posting and recount are not controls on it, and a request that names
 * either is answered by the service's refusal rather than by a button that does nothing.
 */
describe('SCR-148 difference screen contract', () => {
  const page = read('src/app/inventory/physical-inventory-differences/page.tsx');
  const shell = read('src/app/inventory/physical-inventory-differences/DifferenceList.tsx');
  const actions = read('src/app/inventory/physical-inventory-differences/actions.ts');
  const messages = read('src/platform/i18n/index.ts');
  const service = read('src/modules/inventory/physical-inventory-differences.ts');

  it('requires a plant and a fiscal year, and does not list until the selection is run', () => {
    expect(shell).toContain('name="plantFrom"');
    expect(shell).toContain('name="fiscalYear"');
    expect(shell).toContain('required');
    expect(page).toContain("last(params.executed) === '1'");
    expect(page).toContain('listDifferences(');
  });

  it('names shortage and surplus in words, and shows the currency beside a monetary value', () => {
    expect(messages).toContain("'mi20.shortage': 'Shortage'");
    expect(messages).toContain("'mi20.surplus': 'Surplus'");
    expect(shell).toContain("t('mi20.shortage')");
    expect(shell).toContain("t('mi20.surplus')");
    expect(shell).toContain('data-difference-direction');
    expect(shell).toContain('data-difference-monetary');
    expect(shell).toContain('${row.monetaryDifference} ${row.currency');
    expect(shell).toContain("t('mi20.currentPrice')");
    expect(shell).toContain("t('mi20.unavailable')");
  });

  it('offers document display, links to posting, and does not post or recount', () => {
    expect(shell).toContain('data-difference-document');
    expect(shell).toContain("t('mi20.displayHint')");
    expect(shell).toContain("t('mi20.notPosted')");
    expect(shell).toContain('data-difference-posting-link');
    expect(shell).toContain('/inventory/physical-inventory-posting?');
    expect(shell).not.toContain('postDifferences');
    expect(shell).not.toContain('>Recount<');
    expect(shell).not.toContain("t('mi20.recount')");
    expect(page).toContain('openDifferenceWorkflow(');
    expect(page).toContain('data-difference-posting-link');
    expect(actions).toContain("workflow !== 'DISPLAY' && workflow !== 'POST' && workflow !== 'RECOUNT'");
    expect(actions).not.toContain('postJournalEntry');
    expect(actions).not.toContain('postDifferences');
    expect(service).toContain('A list does not post');
    expect(service).toContain('does not create a recount');
  });

  it('keeps the quantity filter and the unvalued filter as their own controls', () => {
    expect(shell).toContain('name="differenceExists"');
    expect(shell).toContain('name="includeUncounted"');
    expect(shell).toContain('name="includeUnvalued"');
    expect(shell).toContain('name="minimumDifferenceValue"');
    expect(shell).toContain('name="currency"');
    expect(shell).toContain('data-difference-other-currency');
    expect(shell).toContain('data-difference-unvalued-hidden');
  });

  it('pages on the server and notes a closed period without hiding the row', () => {
    expect(shell).toContain('data-difference-page');
    expect(shell).toContain("t('mi20.next')");
    expect(shell).toContain('data-difference-period');
    expect(page).toContain('showPeriodNote');
  });

  it('is gated on its own capability and reached from the count it reviews', () => {
    expect(page).toContain('PHYSICAL_INVENTORY_DIFF_LIST_CAPABILITY');
    expect(service).toContain("PHYSICAL_INVENTORY_DIFF_LIST_ROUTE = '/inventory/physical-inventory-differences'");
    expect(service).toContain("PHYSICAL_INVENTORY_DIFF_LIST_ALIASES = ['MI20']");
    expect(messages).toContain("'mi20.code': 'INV.PHYINV.DIFF.LIST · MI20'");
    const count = read('src/app/inventory/physical-inventory-count/page.tsx');
    expect(count).toContain('data-count-differences-link');
    expect(count).toContain('/inventory/physical-inventory-differences?');
  });

  it('says on the screen that a list posts nothing', () => {
    expect(messages).toContain('This list posts nothing and changes no count.');
  });
});
