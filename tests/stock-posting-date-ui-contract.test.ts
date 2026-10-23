import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-126 / MB5B UI contract: the screen is gated on INV.STOCK.POSTINGDATE, takes
 * its tenant scope from the session, requires the material, plant and reporting
 * ranges, carries every selection and grid field the package names, drills to the
 * material document list on the same window, and never writes.
 */
const capability = 'INV.STOCK.POSTINGDATE';
const page = readFileSync('src/app/inventory/stock-posting-date/page.tsx', 'utf8');
const shell = readFileSync('src/app/inventory/stock-posting-date/StockOnPostingDateShell.tsx', 'utf8');
const service = readFileSync('src/modules/inventory/stock-posting-date.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-126 stocks on posting date UI contract', () => {
  it('gates the screen on the exact capability and takes tenant scope from the session', () => {
    expect(service).toContain(`export const STOCK_POSTINGDATE_CAPABILITY = '${capability}'`);
    expect(page).toContain('can(session, STOCK_POSTINGDATE_CAPABILITY)');
    expect(page).toContain('session.user.client');
    expect(page).not.toContain('params.client');
    expect(shell).toContain('stockDate.capabilityMissing');
  });

  it('requires the material, plant and reporting ranges on screen and in the service', () => {
    for (const name of ['materialFrom', 'plantFrom', 'dateFrom', 'dateTo']) {
      expect(shell, name).toMatch(new RegExp(`name="${name}"[^>]*required`));
    }
    expect(service).toContain('A material range is required.');
    expect(service).toContain('A plant range is required.');
    expect(service).toContain('A reporting date range is required.');
  });

  it('carries every selection the package names', () => {
    for (const name of [
      'materialFrom', 'materialTo', 'plantFrom', 'plantTo',
      'storageLocationFrom', 'storageLocationTo', 'dateFrom', 'dateTo',
      'stockType', 'displayZero', 'maxHits',
    ]) {
      expect(shell, name).toContain(`name="${name}"`);
    }
    // Defaults: unrestricted stock, zero lines suppressed, a bounded hit count.
    expect(shell).toContain("defaultValue={selection.stockType ?? 'UNRESTRICTED'}");
    expect(shell).toContain('defaultChecked={selection.displayZero === true}');
    expect(service).toContain("export const DEFAULT_STOCK_TYPE = 'UNRESTRICTED'");
  });

  it('shows every grid column the package names, quantity and value throughout', () => {
    for (const key of [
      'stockDate.material', 'stockDate.description', 'stockDate.plant', 'stockDate.storageLocation',
      'stockDate.unit', 'stockDate.opening', 'stockDate.receipts', 'stockDate.issues', 'stockDate.closing',
      'stockDate.stockType', 'stockDate.quantity', 'stockDate.value',
    ]) {
      expect(shell, key).toContain(key);
      expect(messages, key).toContain(`'${key}'`);
    }
    expect(shell).toContain('row.openingQuantity.toFixed(3)');
    expect(shell).toContain('row.openingValue.toFixed(2)');
    expect(shell).toContain('row.receiptQuantity.toFixed(3)');
    expect(shell).toContain('row.issueValue.toFixed(2)');
    expect(shell).toContain('row.closingQuantity.toFixed(3)');
    expect(shell).toContain('row.closingValue.toFixed(2)');
  });

  it('drills each row into the material document list on the same window', () => {
    expect(service).toContain('/inventory/material-document-list?materialFrom=');
    expect(service).toContain('postingDateFrom=${s.dateFrom}&postingDateTo=${s.dateTo}');
    expect(shell).toContain('href={row.drillDown}');
  });

  it('reads the immutable ledger and compares the stock master as a control only', () => {
    expect(service).toContain('from material_document_line l');
    expect(service).toContain('join material_document d');
    expect(service).toContain("d.status = 'POSTED'");
    expect(service).toContain('from stock_quantity');
    expect(service).toContain('The ledger figures stand as computed; nothing is adjusted.');
    expect(service).not.toMatch(/\binsert into\b/i);
    expect(service).not.toMatch(/\bupdate .* set\b/i);
    expect(service).not.toMatch(/\bdelete from\b/i);
  });

  it('reports truncation and every warning on screen', () => {
    expect(shell).toContain('result?.truncated');
    expect(shell).toContain('stockDate.truncated');
    expect(shell).toContain('result.warnings.map');
  });

  it('is registered in the catalogue with the MB5B alias', () => {
    expect(registry).toContain(`code: '${capability}'`);
    expect(registry).toContain(`ourCode: '${capability}', termType: 'TRANSACTION'`);
    expect(registry).toContain("aliases: ['MB5B']");
    expect(registry).toContain("route: '/inventory/stock-posting-date'");
    expect(messages).toContain("'stockDate.title'");
  });

  it('defers batch, valuation type and exporting by name in the catalogue entry', () => {
    expect(registry).toMatch(/Valuation type, Scope-of-List variants[^']*deferred by name/);
    expect(shell).toContain('name="batch"');
    expect(service).toContain('A named batch splits the rollforward');
  });
});
