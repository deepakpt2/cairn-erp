import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-130 / MD04 UI contract: the screen is gated on PROD.MRP.STOCKREQ (the
 * frozen roadmap capability), takes its tenant scope from the session, requires
 * the material and the plant, carries every selection and column the package
 * names, shows the summary and the exceptions, and never writes.
 */
const capability = 'PROD.MRP.STOCKREQ';
const page = readFileSync('src/app/production/stock-requirements/page.tsx', 'utf8');
const shell = readFileSync('src/app/production/stock-requirements/StockRequirementsShell.tsx', 'utf8');
const service = readFileSync('src/modules/production/stock-requirements.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-130 stock/requirements list UI contract', () => {
  it('gates the screen on the roadmap capability and takes tenant scope from the session', () => {
    expect(service).toContain(`export const STOCK_REQUIREMENTS_CAPABILITY = '${capability}'`);
    expect(page).toContain('can(session, STOCK_REQUIREMENTS_CAPABILITY)');
    expect(page).toContain('session.user.client');
    expect(page).not.toContain('params.client');
    expect(shell).toContain('md04.capabilityMissing');
  });

  it('requires the material and the plant on screen and in the service', () => {
    expect(shell).toMatch(/name="material"[^>]*required/);
    expect(shell).toMatch(/name="plant"[^>]*required/);
    expect(service).toContain('A material is required.');
    expect(service).toContain('A plant is required.');
  });

  it('carries every selection the package names', () => {
    for (const name of [
      'material', 'plant', 'mrpArea', 'specialStockIndicator', 'pastDueOff',
      'periodSplit', 'simulationVersion', 'horizonEnd', 'maxHits',
    ]) {
      expect(shell, name).toContain(`name="${name}"`);
    }
    expect(shell).toContain('<option value="DAILY">');
    expect(shell).toContain('<option value="WEEKLY">');
    expect(service).toContain("export const PERIOD_SPLITS = ['DAILY', 'WEEKLY'] as const");
    // The past-due display defaults on, as the package states.
    expect(page).toContain("displayPastDue: get('pastDueOff') !== '1'");
  });

  it('shows the header summary the package names', () => {
    for (const key of [
      'md04.summary', 'md04.mrpType', 'md04.safetyStock', 'md04.reorderPoint', 'md04.opening', 'md04.closing',
    ]) {
      expect(shell, key).toContain(key);
      expect(messages, key).toContain(`'${key}'`);
    }
    expect(shell).toContain('result.materialDescription');
    expect(shell).toContain('result.baseUnit');
    expect(shell).toContain('result.safetyStock.toFixed(3)');
  });

  it('shows every column of the chronological list, with receipts and requirements apart', () => {
    for (const key of [
      'md04.date', 'md04.element', 'md04.document', 'md04.item', 'md04.receipt',
      'md04.requirement', 'md04.balance', 'md04.unit', 'md04.exceptions',
    ]) {
      expect(shell, key).toContain(key);
      expect(messages, key).toContain(`'${key}'`);
    }
    expect(shell).toContain("row.direction === 'RECEIPT' ? row.quantity.toFixed(3) : ''");
    expect(shell).toContain("row.direction === 'REQUIREMENT' ? row.quantity.toFixed(3) : ''");
    expect(shell).toContain('row.projectedBalance.toFixed(3)');
    expect(shell).toContain('data-balance={row.projectedBalance.toFixed(3)}');
  });

  it('marks the three exceptions on the row and counts them in the header', () => {
    expect(shell).toContain('data-exception-code={code}');
    expect(shell).toContain('data-exception="SHORTAGE"');
    expect(shell).toContain('data-exception="SAFETY_BREACH"');
    expect(shell).toContain('data-exception="PAST_DUE"');
    expect(service).toContain("export type ExceptionCode = 'SHORTAGE' | 'SAFETY_BREACH' | 'PAST_DUE'");
  });

  it('excludes blocked stock from MRP availability and says so', () => {
    expect(service).toContain("export const MRP_AVAILABLE_STOCK_TYPES = ['UNRESTRICTED', 'QUALITY'] as const");
    expect(service).toMatch(/excluded from MRP availability/);
  });

  it('computes the list live and never writes', () => {
    expect(service).toContain('from purchase_requisition_item');
    expect(service).toContain('from purchase_order_item');
    expect(service).toContain('from stock_quantity');
    expect(service).not.toMatch(/\binsert into\b/i);
    expect(service).not.toMatch(/\bupdate .* set\b/i);
    expect(service).not.toMatch(/\bdelete from\b/i);
    // The declined pegging table is not created anywhere.
    expect(service).not.toContain('mrp_stock_requirement_element');
  });

  it('refuses the MRP area, the special stock indicator and a simulation version by name', () => {
    expect(service).toMatch(/The MRP area .* does not stand/);
    expect(service).toMatch(/The special stock indicator .* does not stand/);
    expect(service).toMatch(/The simulation version .* does not stand/);
  });

  it('reports truncation and every warning on screen', () => {
    expect(shell).toContain('result?.truncated');
    expect(shell).toContain('md04.truncated');
    expect(shell).toContain('result.warnings.map');
  });

  it('is registered in the catalogue with the MD04 alias', () => {
    expect(registry).toContain(`code: '${capability}'`);
    expect(registry).toContain(`ourCode: '${capability}', termType: 'TRANSACTION'`);
    expect(registry).toContain("aliases: ['MD04']");
    expect(registry).toContain("route: '/production/stock-requirements'");
    expect(messages).toContain("'md04.title'");
  });
});
