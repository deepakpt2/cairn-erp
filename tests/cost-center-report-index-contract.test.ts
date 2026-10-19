/**
 * SCR-112 / R-160 stage 2 — plan schema and index contract.
 *
 * The actual/plan report derives actuals from the journal
 * (cost-centre index path) and reads plan values from the one
 * table this round adds. These assertions pin the plan table's
 * key across migration SQL and the Drizzle mirror, and the
 * journal paths the aggregation relies on — tenant first,
 * no report-specific posting tables anywhere.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('drizzle/0117_cost_center_plan.sql', 'utf8');
const foundationSchema = readFileSync('src/modules/foundation/schema.ts', 'utf8');
const financeSchema = readFileSync('src/modules/finance/schema.ts', 'utf8');
const vocabulary = readFileSync('src/modules/foundation/cost-center-report.ts', 'utf8');

describe('SCR-112 stage 2: plan table and journal paths stand aligned', () => {
  it('cost_center_plan keys by tenant, area, version, year, period, centre, element', () => {
    expect(migration).toContain('create table public.cost_center_plan');
    expect(migration).toContain('primary key (client, controlling_area, plan_version, fiscal_year, period, cost_center, cost_element)');
    expect(foundationSchema).toContain("export const costCenterPlan = pgTable('cost_center_plan'");
    expect(foundationSchema).toContain('primaryKey({ columns: [t.client, t.controllingArea, t.planVersion, t.fiscalYear, t.period, t.costCenter, t.costElement] })');
  });

  it('actuals ride the journal cost-centre and header paths', () => {
    expect(financeSchema).toContain("index('jel_costcenter_idx').on(t.client, t.costCenter)");
    expect(financeSchema).toContain("index('journal_entry_company_year_period_idx').on(t.client, t.companyCode, t.fiscalYear, t.postingPeriod)");
  });

  it('the report vocabulary persists nothing and plans stay nullable in spirit', () => {
    expect(vocabulary).toContain('cost_center_plan');
    expect(vocabulary).not.toMatch(/insert into|create table/i);
    expect(vocabulary).toContain('plan: number | null');
  });
});
