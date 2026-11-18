import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * ITEM-22 — the stock transport order lives on EXISTING screens. It adds sections and actions, never a route,
 * a launchpad entry or a competing registry alias; and the screens carry the field names the service reads.
 */
describe('ITEM-22 stock transport order UI contract', () => {
  const seed = read('scripts/seed.ts');

  it('adds no screen: no stock-transport route directory and no new registry code or alias', () => {
    const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const pages = walk('src/app').filter((f) => f.endsWith('page.tsx'));
    expect(pages.filter((f) => /stock-?transport|sto-|transit/i.test(f))).toEqual([]);
    expect(existsSync(join(root, 'src/app/inventory/stock-transport'))).toBe(false);
    expect(seed).not.toMatch(/ourCode: '[A-Z.]*\.(STO|STOCKTRANSPORT|TRANSPORT)(\.[A-Z.]+)?'/);
    // The registry aliases stay where they were: ME21N on the existing PO capabilities, ME23N on display.
    expect(seed).toContain("aliases: ['ME23N']");
    expect(seed.match(/'ME21N'/g)).toHaveLength(1);
    // ME23N was already registered twice (display and one other screen) before this item; it gains none.
    expect(seed.match(/'ME23N'/g)).toHaveLength(2);
  });

  it('the purchase order screen offers the type, labels the plants and the company flow, and keeps typed fallback fields', () => {
    const form = read('src/app/purchasing/orders/StockTransportForm.tsx');
    expect(form).toContain("documentType: 'STOCK_TRANSPORT'");
    expect(form).toContain('Supplying plant');
    expect(form).toContain('Receiving plant');
    expect(form).toContain('same company');
    expect(form).toContain('cross-company');
    expect(form).toContain('kind="plant"');
    expect(form).toContain('kind="material-order"');
    expect(form).not.toContain('supplierNumber');
    expect(form).not.toContain('netPrice');
    const orders = read('src/app/purchasing/orders/Orders.tsx');
    expect(orders).toContain('StockTransportForm');
    expect(orders).toContain('name="orderNumber"');
    const actions = read('src/app/purchasing/orders/actions.ts');
    // An STO payload passes whole so the service can refuse an unsupported field by name.
    expect(actions).toContain("input.documentType === 'STOCK_TRANSPORT'");
  });

  it('transfer posting posts the 351 against the order with the form fields the service reads', () => {
    const panel = read('src/app/inventory/transfer-posting/StoIssuePanel.tsx');
    for (const name of ['orderNumber', 'requestKey', 'postingDate', 'documentDate', 'qty-', 'sloc-', 'batch-']) {
      expect(panel).toContain(name);
    }
    expect(panel).not.toContain('name="issuingPlant"');
    expect(panel).not.toContain('name="materialNumber"');
    const actions = read('src/app/inventory/transfer-posting/actions.ts');
    expect(actions).toContain('postStoIssue(');
    expect(actions).not.toMatch(/postStoIssue\(\{[^}]*issuingPlant/s);
  });

  it('goods receipt routes an STO through the receipt-from-transit service, with the same field names', () => {
    const actions = read('src/app/inventory/goods-receipt/actions.ts');
    expect(actions).toContain('isStockTransportOrder(');
    expect(actions).toContain('postStoReceipt(');
    const panel = read('src/app/inventory/goods-receipt/StoReceiptPanel.tsx');
    for (const name of ['orderNumber', 'requestKey', 'postingDate', 'documentDate', 'qty-', 'sloc-', 'batch-']) {
      expect(panel).toContain(name);
    }
    expect(panel).toContain('data-transit');
    expect(panel).not.toContain('supplierNumber');
  });

  it('the stock overview shows transit apart from every on-hand figure, and the PO display never says transit was received', () => {
    const overview = read('src/app/inventory/stock-overview/StockOverviewShell.tsx');
    expect(overview).toContain('data-transit-node');
    expect(overview).toContain('stockOvw.transitNote');
    const display = read('src/app/purchasing/purchase-order-display/page.tsx');
    expect(display).toContain('data-po-sto');
    expect(display).toContain('not yet received');
    const reversal = read('src/app/inventory/reversal/actions.ts');
    expect(reversal).toContain('authorization:');
  });
});
