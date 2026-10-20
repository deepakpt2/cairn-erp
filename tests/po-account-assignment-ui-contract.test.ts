import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-129 / ME2K UI contract: the screen is gated on PROC.PO.ACCOUNTASSIGN,
 * takes its tenant scope from the session, requires both the scope of list and
 * the scope of selection, carries every selection and grid field the package
 * names, groups by assigned object and drills to the order and the cost centre.
 */
const capability = 'PROC.PO.ACCOUNTASSIGN';
const page = readFileSync('src/app/purchasing/orders-by-account-assignment/page.tsx', 'utf8');
const shell = readFileSync('src/app/purchasing/orders-by-account-assignment/PoAccountAssignmentShell.tsx', 'utf8');
const service = readFileSync('src/modules/purchasing/po-account-assignment.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-129 purchase orders by account assignment UI contract', () => {
  it('gates the screen on the exact capability and takes tenant scope from the session', () => {
    expect(service).toContain(`export const PO_ACCOUNT_ASSIGN_CAPABILITY = '${capability}'`);
    expect(page).toContain('can(session, PO_ACCOUNT_ASSIGN_CAPABILITY)');
    expect(page).toContain('session.user.client');
    expect(page).not.toContain('params.client');
    expect(shell).toContain('poAa.capabilityMissing');
  });

  it('requires the scope of list and the scope of selection on screen and in the service', () => {
    expect(shell).toMatch(/name="scopeOfList"[^>]*required/);
    expect(shell).toMatch(/name="scope"[^>]*required/);
    expect(service).toContain('The scope of list');
    expect(service).toContain('The scope of selection');
    expect(service).toContain("export const SCOPES = [");
  });

  it('carries every selection the package names', () => {
    for (const name of [
      'scopeOfList', 'scope', 'accountAssignmentCategory', 'costCenterFrom', 'costCenterTo',
      'purchasingOrgFrom', 'purchasingOrgTo', 'purchasingGroupFrom', 'purchasingGroupTo',
      'plantFrom', 'plantTo', 'supplierFrom', 'supplierTo', 'documentDateFrom', 'documentDateTo', 'maxHits',
    ]) {
      expect(shell, name).toContain(`name="${name}"`);
    }
  });

  it('shows every grid column the package names', () => {
    for (const key of [
      'poAa.order', 'poAa.item', 'poAa.line', 'poAa.costCenter', 'poAa.glAccount', 'poAa.material',
      'poAa.description', 'poAa.plant', 'poAa.quantity', 'poAa.unit', 'poAa.netValue', 'poAa.percent',
      'poAa.assignedValue', 'poAa.deliveryDate', 'poAa.release', 'poAa.supplier',
    ]) {
      expect(shell, key).toContain(key);
      expect(messages, key).toContain(`'${key}'`);
    }
    expect(shell).toContain('row.assignedValue.toFixed(2)');
    expect(shell).toContain('row.distributionPercentage.toFixed(2)');
    expect(shell).toContain('row.deliveryDate');
  });

  it('groups by the assigned object and totals the commitment', () => {
    expect(shell).toContain('result.groups.map');
    expect(shell).toContain('data-group={group.costCenter}');
    expect(shell).toContain('result.totalAssignedValue.toFixed(2)');
    expect(service).toContain('const groupMap = new Map');
  });

  it('drills each row into the order and the cost centre', () => {
    expect(service).toContain('/purchasing/orders?order=');
    expect(service).toContain('/controlling/cost-center-report?costCenter=');
    expect(shell).toContain('href={row.orderDrillDown}');
    expect(shell).toContain('href={row.costCenterDrillDown}');
  });

  it('refuses the categories this canon cannot carry, by name and with a remedy', () => {
    expect(service).toContain('(${name}) is not carried');
    expect(service).toContain("const name = category === 'A' ? 'asset'");
    expect(service).toContain("'P' ? 'WBS element' : 'internal order'");
    expect(service).toContain('cost centres only');
    expect(service).toContain("export const COST_CENTER_CATEGORIES = ['COST_CENTER', 'K'] as const");
  });

  it('reads the order book and never writes', () => {
    expect(service).toContain('join purchase_order_assignment a');
    expect(service).toContain('join purchase_order_item i');
    expect(service).toContain('from purchase_order po');
    expect(service).not.toMatch(/\binsert into\b/i);
    expect(service).not.toMatch(/\bupdate .* set\b/i);
    expect(service).not.toMatch(/\bdelete from\b/i);
  });

  it('reports truncation and every warning on screen', () => {
    expect(shell).toContain('result?.truncated');
    expect(shell).toContain('poAa.truncated');
    expect(shell).toContain('result.warnings.map');
  });

  it('is registered in the catalogue with the ME2K alias', () => {
    expect(registry).toContain(`code: '${capability}'`);
    expect(registry).toContain(`ourCode: '${capability}', termType: 'TRANSACTION'`);
    expect(registry).toContain("aliases: ['ME2K']");
    expect(registry).toContain("route: '/purchasing/orders-by-account-assignment'");
    expect(messages).toContain("'poAa.title'");
  });
});
