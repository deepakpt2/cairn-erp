import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-127 / MB52 UI contract: the screen is gated on INV.STOCK.WAREHOUSE, takes
 * its tenant scope from the session, requires the scope of list, carries every
 * selection and grid field the package names, shows the four-way split with its
 * totals, and drills each row into both the movements and the rollforward.
 */
const capability = 'INV.STOCK.WAREHOUSE';
const page = readFileSync('src/app/inventory/warehouse-stocks/page.tsx', 'utf8');
const shell = readFileSync('src/app/inventory/warehouse-stocks/WarehouseStocksShell.tsx', 'utf8');
const service = readFileSync('src/modules/inventory/warehouse-stocks.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-127 warehouse stocks on hand UI contract', () => {
  it('gates the screen on the exact capability and takes tenant scope from the session', () => {
    expect(service).toContain(`export const WAREHOUSE_STOCK_CAPABILITY = '${capability}'`);
    expect(page).toContain('can(session, WAREHOUSE_STOCK_CAPABILITY)');
    expect(page).toContain('session.user.client');
    expect(page).not.toContain('params.client');
    expect(shell).toContain('whStock.capabilityMissing');
  });

  it('requires the scope of list on screen and in the service', () => {
    expect(shell).toMatch(/name="scopeOfList"[^>]*required/);
    expect(service).toContain('SCOPE_OF_LIST_OPTIONS');
    expect(service).toContain('The scope of list');
  });

  it('carries every selection the package names', () => {
    for (const name of [
      'scopeOfList', 'materialFrom', 'materialTo', 'plantFrom', 'plantTo',
      'storageLocationFrom', 'storageLocationTo', 'valuationType', 'batch',
      'specialStockIndicator', 'displayZero', 'valuationPriceOff', 'maxHits',
    ]) {
      expect(shell, name).toContain(`name="${name}"`);
    }
    // Defaults: zero lines suppressed, valuation display on.
    expect(shell).toContain('defaultChecked={selection.displayZero === true}');
    expect(page).toContain("valuationPriceDisplay: get('valuationPriceOff') !== '1'");
    expect(service).toContain('valuationPriceDisplay: raw.valuationPriceDisplay !== false');
  });

  it('shows every grid column the package names, including the four-way split', () => {
    for (const key of [
      'whStock.material', 'whStock.description', 'whStock.plant', 'whStock.storageLocation',
      'whStock.unit', 'whStock.unrestricted', 'whStock.quality', 'whStock.blocked',
      'whStock.special', 'whStock.total', 'whStock.price', 'whStock.currency', 'whStock.value',
    ]) {
      expect(shell, key).toContain(key);
      expect(messages, key).toContain(`'${key}'`);
    }
    expect(shell).toContain('row.unrestrictedQuantity.toFixed(3)');
    expect(shell).toContain('row.qualityInspectionQuantity.toFixed(3)');
    expect(shell).toContain('row.blockedQuantity.toFixed(3)');
    expect(shell).toContain('row.specialQuantity.toFixed(3)');
    expect(shell).toContain('row.price.toFixed(4)');
    expect(shell).toContain('row.value.toFixed(2)');
    // An unknown valuation is shown as unknown, never as zero.
    expect(shell).toContain("row.value === null ? t('whStock.unknownValue')");
  });

  it('carries the totals footer', () => {
    expect(shell).toContain('result!.totals.totalQuantity.toFixed(3)');
    expect(shell).toContain('result!.totals.value === null');
  });

  it('drills each row into both the movements and the rollforward', () => {
    expect(service).toContain("drill('/inventory/material-document-list')");
    expect(service).toContain("drill('/inventory/stock-on-posting-date')");
    expect(shell).toContain('href={row.movementsDrillDown}');
    expect(shell).toContain('href={row.rollforwardDrillDown}');
  });

  it('reads the stock master and its valuation, and never writes', () => {
    expect(service).toContain('from stock_quantity s');
    expect(service).toContain('join material_valuation v');
    expect(service).not.toMatch(/\binsert into\b/i);
    expect(service).not.toMatch(/\bupdate .* set\b/i);
    expect(service).not.toMatch(/\bdelete from\b/i);
  });

  it('refuses the special stock indicator and defers batch and valuation type by name', () => {
    expect(service).toContain('The special stock indicator');
    expect(service).toMatch(/Valuation type .* is not maintained/);
    expect(service).toContain('A named batch splits the row and filters this list');
    expect(service).toContain('named stock type');
  });

  it('reports truncation and every warning on screen', () => {
    expect(shell).toContain('result?.truncated');
    expect(shell).toContain('whStock.truncated');
    expect(shell).toContain('result.warnings.map');
  });

  it('is registered in the catalogue with the MB52 alias', () => {
    expect(registry).toContain(`code: '${capability}'`);
    expect(registry).toContain(`ourCode: '${capability}', termType: 'TRANSACTION'`);
    expect(registry).toContain("aliases: ['MB52']");
    expect(registry).toContain("route: '/inventory/warehouse-stocks'");
    expect(messages).toContain("'whStock.title'");
  });
});
