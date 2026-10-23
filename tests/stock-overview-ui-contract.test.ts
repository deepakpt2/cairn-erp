import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-128 / MMBE UI contract: the screen is gated on INV.STOCK.VIEW (the frozen
 * roadmap capability), takes its tenant scope from the session, requires the
 * single material, offers the expansion level, renders the three levels, and
 * drills each node into MB51, MB5B and MB52.
 */
const capability = 'INV.STOCK.VIEW';
const page = readFileSync('src/app/inventory/stock-overview/page.tsx', 'utf8');
const shell = readFileSync('src/app/inventory/stock-overview/StockOverviewShell.tsx', 'utf8');
const service = readFileSync('src/modules/inventory/stock-overview.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-128 stock overview UI contract', () => {
  it('gates the screen on the roadmap capability and takes tenant scope from the session', () => {
    expect(service).toContain(`export const STOCK_OVERVIEW_CAPABILITY = '${capability}'`);
    expect(page).toContain('can(session, STOCK_OVERVIEW_CAPABILITY)');
    expect(page).toContain('session.user.client');
    expect(page).not.toContain('params.client');
    expect(shell).toContain('stockOvw.capabilityMissing');
  });

  it('requires the single material on screen and in the service', () => {
    expect(shell).toMatch(/name="material"[^>]*required/);
    expect(service).toContain('A material is required.');
    // One material, not a range: there is no materialTo anywhere.
    expect(shell).not.toContain('name="materialTo"');
    // No material range in the selection — the only materialTo is the single
    // material repeated in a drill-down URL.
    expect(service).not.toContain('materialTo?:');
  });

  it('carries every selection the package names, including the expansion dropdown', () => {
    for (const name of [
      'material', 'plantFrom', 'plantTo', 'storageLocationFrom', 'storageLocationTo',
      'batch', 'specialStockIndicator', 'displayZero', 'expansionLevel', 'maxHits',
    ]) {
      expect(shell, name).toContain(`name="${name}"`);
    }
    expect(shell).toContain('<option value="PLANT">');
    expect(shell).toContain('<option value="STORAGE_LOCATION">');
    expect(service).toContain("export const EXPANSION_LEVELS = ['PLANT', 'STORAGE_LOCATION'] as const");
  });

  it('renders the three levels as a collapsible tree', () => {
    expect(shell).toContain('<details key={plant.plant}');
    expect(shell).toContain('data-plant={plant.plant}');
    expect(shell).toContain('data-location={`${plant.plant}|${location.storageLocation}`}');
    expect(shell).toContain('data-stock-type={type.stockType}');
    expect(shell).toContain('plant.storageLocations.map');
    expect(shell).toContain('location.stockTypes.flatMap');
    // The expansion level decides whether plants open on arrival.
    expect(shell).toContain("const openPlants = result?.expansionLevel === 'STORAGE_LOCATION'");
    expect(shell).toContain('open={openPlants}');
  });

  it('shows the roll-up figures at the plant node', () => {
    for (const key of [
      'stockOvw.plant', 'stockOvw.storageLocation', 'stockOvw.stockType', 'stockOvw.quantity',
      'stockOvw.total', 'stockOvw.unrestricted', 'stockOvw.quality', 'stockOvw.blocked', 'stockOvw.special',
    ]) {
      expect(shell, key).toContain(key);
      expect(messages, key).toContain(`'${key}'`);
    }
    expect(shell).toContain('plant.quantity.toFixed(3)');
    expect(shell).toContain('location.quantity.toFixed(3)');
    expect(shell).toContain('type.quantity.toFixed(3)');
  });

  it('drills every node into MB51, MB5B and MB52', () => {
    expect(shell).toContain('href={plant.movementsDrillDown}');
    expect(shell).toContain('href={plant.rollforwardDrillDown}');
    expect(shell).toContain('href={plant.warehouseDrillDown}');
    expect(shell).toContain('href={location.movementsDrillDown}');
    expect(shell).toContain('batchReadback(location.movementsDrillDown, batch.batch)');
    expect(shell).toContain('&batch=');
    expect(service).toContain("drill('/inventory/material-document-list'");
    expect(service).toContain("drill('/inventory/stock-on-posting-date'");
    expect(service).toContain("drill('/inventory/warehouse-stocks'");
  });

  it('folds the roll-ups from one read rather than a second query', () => {
    expect(service).toContain('from stock_quantity');
    expect(service).toContain('plantMap');
    expect(service).not.toMatch(/\binsert into\b/i);
    expect(service).not.toMatch(/\bupdate .* set\b/i);
    expect(service).not.toMatch(/\bdelete from\b/i);
  });

  it('refuses the special stock indicator and defers batch and in-transit by name', () => {
    expect(service).toContain('The special stock indicator');
    expect(service).toContain('A named batch filters this tree');
    expect(service).toContain('named stock type');
    expect(service).toContain('produces transit stock'); // in-transit deferred in the module header
    expect(service).not.toContain('IN_TRANSIT');
  });

  it('reports truncation and every warning on screen', () => {
    expect(shell).toContain('result?.truncated');
    expect(shell).toContain('stockOvw.truncated');
    expect(shell).toContain('result.warnings.map');
  });

  it('is registered in the catalogue under the roadmap code with the MMBE alias', () => {
    expect(registry).toContain(`code: '${capability}'`);
    expect(registry).toContain(`ourCode: '${capability}', termType: 'TRANSACTION'`);
    expect(registry).toContain("aliases: ['MMBE']");
    expect(registry).toContain("route: '/inventory/stock-overview'");
    expect(messages).toContain("'stockOvw.title'");
  });
});
