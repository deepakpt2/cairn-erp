import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * Sales demand in MD04 and MRP: the contract between the shared projection and the screens/services that read it.
 * Source-level assertions, because the behaviour itself is proved against the database in sales-demand-planning.
 */
describe('sales demand contract', () => {
  it('MD04 and MRP read the one projection', () => {
    expect(read('src/modules/production/stock-requirements.ts')).toContain("from '../sales/sales-demand'");
    expect(read('src/modules/production/mrp-run.ts')).toContain("from '../sales/sales-demand'");
    expect(read('src/modules/production/mrp-run.ts')).toContain('salesDemandElements(tx, client, candidate.materialNumber, candidate.plant)');
  });

  it('the MD04 screen labels the element and masks the document for a viewer without sales authority', () => {
    expect(read('src/app/production/stock-requirements/StockRequirementsShell.tsx')).toContain("'SALES_ORDER'");
    expect(read('src/app/production/stock-requirements/page.tsx')).toContain("canDisplaySalesOrders: can(session, 'SALES.ORDER.CREATE')");
  });

  it('the order, delivery and reversal services mark the existing planning file in their own transaction', () => {
    expect(read('src/modules/sales/sales-order.ts')).toContain('markSalesPlanning(tx, parsed.client');
    expect(read('src/modules/sales/delivery.ts')).toContain('markSalesPlanning(tx, parsed.client');
    expect(read('src/modules/sales/goods-issue-reversal.ts')).toContain('markSalesPlanning(tx, client');
    const demand = read('src/modules/sales/sales-demand.ts');
    expect(demand).toContain('insert into planning_file');
    expect(demand).not.toMatch(/create table|planning_change/i);
  });

  it('the scoped availability checks know the element', () => {
    expect(read('src/modules/production/order-availability.ts')).toContain("case 'SALES_ORDER'");
  });
});
