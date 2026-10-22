import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-147 stage 4 — the count screen's contract.
 *
 * T846 proves the behaviour in a browser; this proves the wiring cannot drift away from it: the
 * lookup the package asks for, every column of the count grid, the zero flag as a control of its
 * own, the reason a correction must carry, and the two capabilities kept apart.
 */
describe('SCR-147 count screen contract', () => {
  const page = read('src/app/inventory/physical-inventory-count/page.tsx');
  const shell = read('src/app/inventory/physical-inventory-count/CountWorkbench.tsx');
  const actions = read('src/app/inventory/physical-inventory-count/actions.ts');
  const messages = read('src/platform/i18n/index.ts');

  it('finds a document by its number and its fiscal year, and says so when it finds none', () => {
    expect(page).toContain('name="doc"');
    expect(page).toContain('name="year"');
    expect(page).toContain('getCountDocument(');
    expect(page).toContain("t('mi04.notFound'");
    expect(page).toContain('searchCountDocuments(');
  });

  it('carries every column the package names for the count grid', () => {
    for (const key of [
      'mi04.columnItem', 'mi04.columnMaterial', 'mi04.columnStockType', 'mi04.columnBook',
      'mi04.columnCounted', 'mi04.columnUnit', 'mi04.columnZero', 'mi04.columnDate',
      'mi04.columnDifference', 'mi04.columnCountStatus',
    ]) {
      expect(messages).toContain(`'${key}'`);
      expect(shell).toContain(`t('${key}')`);
    }
    expect(shell).toContain('data-count-line');
    expect(shell).toContain('data-count-difference');
  });

  it('records a zero as its own control, and refuses to guess when neither is given', () => {
    expect(shell).toContain('name={`zero-${n}`}');
    expect(shell).toContain('disabled={!canCount || zero}');
    // An untouched row is not submitted at all — a blank quantity is not a count of zero.
    expect(actions).toContain('if (!zeroCount && rawQuantity === \'\') continue;');
    // And a quantity sent beside a zero flag reaches the service, which refuses the contradiction;
    // the screen must not normalise it away.
    expect(actions).toContain("quantity: rawQuantity === '' ? undefined : Number(rawQuantity),");
    expect(actions).toContain("if (lines.length === 0)");
  });

  it('carries the count date and the counter, and requires a reason to clear a count', () => {
    expect(shell).toContain('name="countDate"');
    expect(shell).toContain('name="counterName"');
    expect(shell).toContain('name="reason"');
    expect(shell).toContain('required');
    expect(actions).toContain('clearCount({');
  });

  it('separates entering a count from correcting one', () => {
    expect(actions).toContain('PHYSICAL_INVENTORY_COUNT_CAPABILITY');
    expect(actions).toContain('PHYSICAL_INVENTORY_COUNT_CORRECT_CAPABILITY');
    expect(page).toContain('canCount={can(session, PHYSICAL_INVENTORY_COUNT_CAPABILITY)}');
    expect(page).toContain('canCorrect={can(session, PHYSICAL_INVENTORY_COUNT_CORRECT_CAPABILITY)}');
  });

  it('moves the request key on after a save, so the next count is not a replay', () => {
    expect(shell).toContain('if (state.ok) setRequestKey(newRequestKey());');
    expect(shell).not.toContain('const [requestKey] = useState(newRequestKey);');
  });

  it('shows the history — including why a count was corrected — and the items still owed a count', () => {
    expect(shell).toContain('data-count-history');
    expect(messages).toContain("'mi04.historyReason'");
    expect(shell).toContain('entry.reason');
    expect(shell).toContain('data-count-remaining');
    expect(shell).toContain('data-count-document-status');
    expect(shell).toContain('data-count-uncounted');
  });

  it('says on the screen that a count posts nothing', () => {
    expect(messages).toContain("'mi04.subtitle': 'Record what the counter found against a physical inventory document. A count posts nothing");
    expect(shell).not.toContain('postTransfer');
    expect(actions).not.toContain('postJournalEntry');
  });

  it('shows the company code as context, and does not take it as a key', () => {
    expect(messages).toContain("'mi04.companyCode': 'Company code'");
    expect(shell).toContain('data-count-company');
    expect(shell).toContain("t('mi04.companyCode')");
    expect(page).not.toContain('name="companyCode"');
    expect(page).toContain('countNamedRefusal');
  });

  it('refuses a batch, a posted difference, and a second count by name', () => {
    const service = read('src/modules/inventory/physical-inventory-count.ts');
    expect(service).toContain('A batch is not part of this count.');
    expect(service).toContain('The difference is not entered.');
    expect(service).toContain('A count is the inventory item.');
    expect(service).toContain('A count posts nothing.');
    expect(service).toContain('Count history is the change document.');
    expect(service).not.toContain('physical_inventory_count');
    expect(actions).toContain('countNamedRefusal');
    expect(actions).toContain('namedFields');
  });

  it('is registered under its own route with MI04 as a search alias only', () => {
    expect(messages).toContain("'mi04.code': 'INV.PHYINV.COUNT · MI04'");
    const service = read('src/modules/inventory/physical-inventory-count.ts');
    expect(service).toContain("PHYSICAL_INVENTORY_COUNT_ROUTE = '/inventory/physical-inventory-count'");
    expect(service).toContain("PHYSICAL_INVENTORY_COUNT_ALIASES = ['MI04']");
  });
});
