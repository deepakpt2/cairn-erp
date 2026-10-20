import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-124 / ME2L suite UI contract: the list screen is a read-only report gated
 * on PROC.PO.LIST, takes its tenant scope from the session, carries the four
 * perspectives and the scope of selection, offers every range the package
 * names, and drills each row down to the order display.
 */
const capability = 'PROC.PO.LIST';
const page = readFileSync('src/app/purchasing/purchase-order-list/page.tsx', 'utf8');
const shell = readFileSync('src/app/purchasing/purchase-order-list/PurchaseOrderListShell.tsx', 'utf8');
const service = readFileSync('src/modules/purchasing/purchase-order-list.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-124 purchase order list UI contract', () => {
  it('gates the screen on the exact capability and takes tenant scope from the session', () => {
    expect(service).toContain(`export const PO_LIST_CAPABILITY = '${capability}'`);
    expect(page).toContain('can(session, PO_LIST_CAPABILITY)');
    expect(page).toContain('session.user.client');
    expect(page).not.toContain('params.client');
    expect(shell).toContain('poList.capabilityMissing');
  });

  it('offers the four perspectives and the four scopes the package names', () => {
    for (const alias of ['ME2L', 'ME2M', 'ME2N', 'ME2C']) {
      expect(service, alias).toContain(`alias: '${alias}'`);
    }
    for (const scope of ['ALL', 'STILL_TO_BE_DELIVERED', 'STILL_TO_BE_INVOICED', 'COMPLETED']) {
      expect(service, scope).toContain(`code: '${scope}'`);
    }
    expect(shell).toContain('name="perspective"');
    expect(shell).toContain('name="scope"');
  });

  it('carries every selection range the package names', () => {
    for (const name of [
      'vendorFrom', 'vendorTo', 'purchasingOrgFrom', 'purchasingOrgTo',
      'purchasingGroupFrom', 'purchasingGroupTo', 'plantFrom', 'plantTo',
      'materialFrom', 'materialTo', 'materialGroupFrom', 'materialGroupTo',
      'orderFrom', 'orderTo', 'documentDateFrom', 'documentDateTo', 'maxHits',
    ]) {
      expect(shell, name).toContain(`name="${name}"`);
    }
  });

  it('shows every row field the contract names and drills down to the order display', () => {
    for (const key of [
      'poList.order', 'poList.vendor', 'poList.purchasingOrg', 'poList.purchasingGroup',
      'poList.companyCode', 'poList.documentDate', 'poList.material', 'poList.shortText',
      'poList.materialGroup', 'poList.plant', 'poList.quantity', 'poList.unit',
      'poList.netPrice', 'poList.netValue', 'poList.currency', 'poList.deliveryDate',
      'poList.release', 'poList.requisition', 'poList.delivered', 'poList.invoiced',
      'poList.openDelivery', 'poList.openInvoice', 'poList.accountAssignment',
      'poList.status', 'poList.display',
    ]) {
      expect(shell, key).toContain(key);
    }
    expect(shell).toContain('href={row.drillDown}');
    expect(service).toContain('`/purchasing/orders?order=${encodeURIComponent');
  });

  it('derives delivered and invoiced from posted history rather than a status column', () => {
    expect(service).toContain("d.status = 'POSTED'");
    expect(service).toContain("s2.status = 'POSTED'");
    expect(service).toContain("m.direction = 'REVERSAL'");
    expect(service).toContain('and not marked_for_deletion');
  });

  it('indicates truncation and never invents a delivery date', () => {
    expect(shell).toContain('result?.truncated');
    expect(shell).toContain('poList.truncated');
    expect(service).toContain("coalesce(sc.delivery_date, '') as delivery_date");
  });

  it('is registered in the catalogue with all four aliases', () => {
    expect(registry).toContain(`code: '${capability}'`);
    expect(registry).toContain(`ourCode: '${capability}', termType: 'TRANSACTION'`);
    expect(registry).toContain("aliases: ['ME2L', 'ME2M', 'ME2N', 'ME2C']");
    expect(registry).toContain("route: '/purchasing/purchase-order-list'");
    expect(messages).toContain("'poList.title'");
  });

  it('adds no state: the service only reads the standing tables', () => {
    expect(service).not.toMatch(/\binsert into\b/i);
    expect(service).not.toMatch(/\bupdate .* set\b/i);
    expect(service).not.toMatch(/\bdelete from\b/i);
    expect(service).toContain('from purchase_order_item i');
    expect(service).toContain('from material_document_line l');
    expect(service).toContain('from supplier_invoice_item si');
  });
});
