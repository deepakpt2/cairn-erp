import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PRODUCTION_ORDER_COST_REPORT_CAPABILITY, holdsProductionOrderCostReportAuthority } from '../src/modules/production/order-cost-report';

const root = process.cwd();
const migration = readFileSync(path.join(root, 'drizzle/history/9215_production_order_cost_report.sql'), 'utf8');
const service = readFileSync(path.join(root, 'src/modules/production/order-cost-report.ts'), 'utf8');
const page = readFileSync(path.join(root, 'src/app/production/order-cost-report/page.tsx'), 'utf8');
const catalog = readFileSync(path.join(root, 'src/ui/shell/screen-catalog.ts'), 'utf8');
const displayPage = readFileSync(path.join(root, 'src/app/production/production-order-display/page.tsx'), 'utf8');
const browserCheck = readFileSync(path.join(root, 'scripts/browser-smoke/production-order-cost-report.ts'), 'utf8');


describe('production-order cost report contracts', () => {
  it('uses a tenant-RLS-preserving invoker view and grants only runtime SELECT', () => {
    expect(migration).toMatch(/CREATE VIEW public\.production_order_actual_posting_v\s+WITH \(security_invoker = true\)/i);
    expect(migration).toMatch(/JOIN public\.journal_entry j[\s\S]*?j\.client = l\.client[\s\S]*?j\.status IN \('POSTED', 'REVERSED'\)/i);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.production_order_actual_posting_v FROM PUBLIC/i);
    expect(migration).toMatch(/GRANT SELECT ON TABLE public\.production_order_actual_posting_v TO cairn_app/i);
    expect(migration).not.toMatch(/GRANT\s+(?!SELECT\b)[^;]*production_order_actual_posting_v/i);
  });

  it('reads the order and selected journal period through the tenant-scoped view without writes or rate valuation', () => {
    expect(service).toContain('withTenant(input.client');
    expect(service).toContain('from production_order_actual_posting_v');
    expect(service).toContain('where client = ${input.client}');
    expect(service).toContain('order_number = ${orderNumber}');
    expect(service).toContain('fiscal_year = ${fiscalYear}');
    expect(service).toContain('posting_period >= ${periodFrom}');
    expect(service).toContain('posting_period <= ${periodTo}');
    expect(service).toContain('toScaled(line.amountDocument)');
    expect(service).toContain('toScaled(line.amountLocal)');
    expect(service).not.toMatch(/\b(insert into|update\s+\w+|delete from|activity_rate|work_center_costing)\b/i);
  });

  it('gives the report a dedicated exact-grant-only capability', () => {
    expect(PRODUCTION_ORDER_COST_REPORT_CAPABILITY).toBe('PROD.ORDER.COST.DISPLAY');
    expect(holdsProductionOrderCostReportAuthority(['PROD.ORDER.COST.DISPLAY'])).toBe(true);
    expect(holdsProductionOrderCostReportAuthority(['PROD.*'])).toBe(false);
    expect(holdsProductionOrderCostReportAuthority(['*'])).toBe(false);
    expect(page).toContain('PRODUCTION_ORDER_COST_REPORT_CAPABILITY');
    expect(catalog).toContain('code: "PROD.ORDER.COST.DISPLAY"');
  });

  it('links production-order display to the actual-posting report and covers browser period/no-write behavior', () => {
    expect(displayPage).toContain('/production/order-cost-report');
    expect(browserCheck).toContain('period one displays its two order-assigned journal lines');
    expect(browserCheck).toContain('all-period debit total includes period two');
    expect(browserCheck).toContain('reading the report creates, changes, or reverses no journal or production-order rows');
  });

  it('does not mislabel plan-rate activity valuation, WIP, or variance as posted actuals', () => {
    expect(page).toMatch(/plan rates are not actuals/i);
    expect(page).toMatch(/does not settle, post, or calculate WIP or variance/i);
    expect(service).toMatch(/Plan activity rates are not treated as actual costs/);
  });
});
