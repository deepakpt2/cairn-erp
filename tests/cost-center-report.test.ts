/**
 * SCR-112 / R-160 stage 5 — cost centre actual/plan report service.
 *
 * Actuals are posted journal lines carrying a cost centre; plan
 * stands in cost_center_plan by version. Missing plan is null,
 * never zero; variance and status follow the signed figures;
 * range totals stand beside periods 1..cutoff; centres without
 * validity in the year are excluded and named; the report is
 * read-only.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { postGlDocument } from '../src/modules/finance/gl-document';
import { saveCostCenter } from '../src/modules/foundation/cost-center-definition';
import {
  calculateCostCenterReport, type CostCenterReportSelection,
} from '../src/modules/foundation/cost-center-report';
import { closeDb, createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';
import { configActivityStatus } from '@/platform/tables/registry';
import { controllingAreaCompany } from '@/modules/foundation/schema';

const ACTOR = 'SCR112-TEST';
const REASON = 'SCR-112 automated backend test';
let tenant: TestTenant | undefined;
let client = '';
let currency = 'USD';

function selection(overrides: Partial<CostCenterReportSelection> = {}): CostCenterReportSelection {
  return {
    controllingArea: 'A000', costCenterGroup: '', costCenterFrom: '', costCenterTo: '',
    costElementFrom: '', costElementTo: '', fiscalYear: 2026,
    periodFrom: 4, periodTo: 4, planVersion: '000', ...overrides,
  };
}

async function post(amount: string, lines: Array<{ glAccount: string; debitCredit: 'S' | 'H'; costCenter?: string }>, key: string, date: string) {
  await postGlDocument({
    client, changedBy: ACTOR, requestKey: key, companyCode: '1000',
    documentDate: date, postingDate: date, documentType: 'SA', currency,
    lines: lines.map((l) => ({ amount, ...l })),
  });
}

async function journalCount(): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
    return rows[0]!.n;
  });
}

beforeAll(async () => {
  tenant = await createTenant('scr112-report');
  client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    for (const activityCode of ['CFG.COST.CONTROLLINGAREA.DEFINE', 'CFG.COST.COSTCENTER.DEFINE']) {
      await tx.insert(configActivityStatus)
        .values({ client, activityCode, status: 'COMPLETED', createdBy: ACTOR })
        .onConflictDoUpdate({
          target: [configActivityStatus.client, configActivityStatus.activityCode],
          set: { status: 'COMPLETED', changedBy: ACTOR, changedAt: new Date() },
        });
    }
    await tx.insert(controllingAreaCompany)
      .values({ client, controllingArea: 'A000', companyCode: '1000', createdBy: ACTOR })
      .onConflictDoNothing();
  });
  await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select currency from controlling_area where client = ${client} and controlling_area = 'A000'
    `) as unknown as Array<{ currency: string }>;
    currency = rows[0]?.currency ?? 'USD';
  });

  for (const [center, from, to, name] of [
    ['CC1000', '2026-01-01', '2026-12-31', 'Production centre'],
    ['CC2000', '2026-01-01', '2026-12-31', 'Service centre'],
    ['CC3000', '2025-01-01', '2025-12-31', 'Lapsed centre'],
  ] as const) {
    await saveCostCenter({
      client, changedBy: ACTOR, mode: 'CREATE', controllingArea: 'A000',
      costCenter: center, validFrom: from, validTo: to, name,
      personResponsible: '', category: 'PRODUCTION', companyCode: '1000', reason: REASON,
    });
  }

  // April expense over plan; February expense inside YTD; April revenue.
  await post('5000', [{ glAccount: '400000', debitCredit: 'S', costCenter: 'CC1000' }, { glAccount: '101000', debitCredit: 'H' }], 'cc-2026-1', '2026-04-10');
  await post('2000', [{ glAccount: '400000', debitCredit: 'S', costCenter: 'CC1000' }, { glAccount: '101000', debitCredit: 'H' }], 'cc-2026-2', '2026-02-10');
  await post('9000', [{ glAccount: '101000', debitCredit: 'S' }, { glAccount: '300000', debitCredit: 'H', costCenter: 'CC1000' }], 'cc-2026-3', '2026-04-11');
  await post('1000', [{ glAccount: '400000', debitCredit: 'S', costCenter: 'CC2000' }, { glAccount: '101000', debitCredit: 'H' }], 'cc-2026-4', '2026-04-12');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into cost_center_plan (client, controlling_area, plan_version, fiscal_year, period, cost_center, cost_element, planned_amount, created_by)
      values
        (${client}, 'A000', '000', 2026, 4, 'CC1000', '400000', 4500, ${ACTOR}),
        (${client}, 'A000', '000', 2026, 2, 'CC1000', '400000', 1800, ${ACTOR}),
        (${client}, 'A000', '000', 2026, 4, 'CC1000', '300000', 8000, ${ACTOR})
    `);
    await tx.execute(sql`
      insert into activity_rate (client, controlling_area, plan_version, fiscal_year, period, cost_center, activity_type, planned_quantity, fixed_price, variable_price, price_unit, created_by)
      values (${client}, 'A000', '000', 2026, 4, 'CC1000', 'LAB01', 120.000, 50.00, 10.00, 1, ${ACTOR})
    `);
    await tx.execute(sql`
      insert into cost_center_hierarchy (client, controlling_area, title, created_by)
      values (${client}, 'A000', 'Standard hierarchy', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into cost_center_node (client, controlling_area, node, parent_node, title, display_order, created_by)
      values
        (${client}, 'A000', 'ROOT', null, 'All centres', 10, ${ACTOR}),
        (${client}, 'A000', 'PLANT', 'ROOT', 'Plant', 10, ${ACTOR})
    `);
    await tx.execute(sql`
      insert into cost_center_node_assignment (client, controlling_area, node, cost_center, valid_from, created_by)
      values (${client}, 'A000', 'PLANT', 'CC1000', '2026-01-01', ${ACTOR})
    `);
  });
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
}, 180_000);

describe('SCR-112 cost centre actual/plan report (R-160)', () => {
  it('compares journal actuals with signed plan, range beside YTD, hierarchy above centres', async () => {
    const before = await journalCount();
    const result = await calculateCostCenterReport({ client, selection: selection() });
    expect(await journalCount()).toBe(before); // read-only

    const expense = result.rows.find((r) => r.kind === 'ELEMENT' && r.costCenter === 'CC1000' && r.costElement === '400000');
    expect(expense?.actual).toBe(5000);
    expect(expense?.actualYtd).toBe(7000);
    expect(expense?.plan).toBe(4500);
    expect(expense?.planYtd).toBe(6300);
    expect(expense?.variance).toBe(500);
    expect(expense?.variancePercent).toBeCloseTo(11.11, 1);
    expect(expense?.status).toBe('UNFAVORABLE');

    const revenue = result.rows.find((r) => r.kind === 'ELEMENT' && r.costElement === '300000');
    expect(revenue?.actual).toBe(-9000);
    expect(revenue?.plan).toBe(-8000); // revenue plan signed negative
    expect(revenue?.variance).toBe(-1000);
    expect(revenue?.status).toBe('FAVORABLE');

    const center = result.rows.find((r) => r.kind === 'CENTER' && r.costCenter === 'CC1000');
    expect(center?.actual).toBe(-4000);
    expect(center?.plan).toBe(-3500);

    const plant = result.rows.find((r) => r.kind === 'GROUP' && r.key === 'PLANT');
    expect(plant?.actual).toBe(-4000);
    const root = result.rows.find((r) => r.kind === 'GROUP' && r.key === 'ROOT');
    expect(root?.actual).toBe(-4000); // hierarchy subtree only; the unplaced centre rolls up separately
  });

  it('keeps missing plan null, names excluded centres and stands the activity plan', async () => {
    const result = await calculateCostCenterReport({ client, selection: selection() });
    const unplanned = result.rows.find((r) => r.kind === 'CENTER' && r.costCenter === 'CC2000');
    expect(unplanned?.actual).toBe(1000);
    expect(unplanned?.plan).toBeNull();
    expect(unplanned?.variance).toBeNull();
    expect(unplanned?.variancePercent).toBeNull();
    expect(unplanned?.status).toBeNull();
    expect(result.excludedCenters).toContain('CC3000');
    expect(result.warnings.some((w) => w.includes('CC3000'))).toBe(true);
    const outside = result.rows.find((r) => r.kind === 'GROUP' && r.key === 'UNPLACED');
    expect(outside?.actual).toBe(1000);

    expect(result.activities).toEqual([
      expect.objectContaining({ costCenter: 'CC1000', activityType: 'LAB01', plannedQuantity: 120, fixedPrice: 50, variablePrice: 10 }),
    ]);
  });

  it('warns and nulls plan under an unknown version without failing', async () => {
    const result = await calculateCostCenterReport({ client, selection: selection({ planVersion: 'XYZ' }) });
    expect(result.warnings.some((w) => w.includes('No plan data stands for version XYZ'))).toBe(true);
    const expense = result.rows.find((r) => r.kind === 'ELEMENT' && r.costElement === '400000');
    expect(expense?.actual).toBe(5000);
    expect(expense?.plan).toBeNull();
  });

  it('resolves group leaves in display order: E excludes, a later I re-includes (SCR-112 repair)', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into cost_center_group (client, controlling_area, group_name, title, created_by)
        values (${client}, 'A000', 'OPS', 'Operations centres', ${ACTOR}),
               (${client}, 'A000', 'OPS2', 'Re-included centre', ${ACTOR}),
               (${client}, 'A000', 'OPS3', 'Nothing stands', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into cost_center_group_leaf
          (client, controlling_area, group_name, val_sign, val_option, val_from, val_to, display_order, created_by)
        values
          (${client}, 'A000', 'OPS', 'I', 'BT', 'CC1000', 'CC2999', 10, ${ACTOR}),
          (${client}, 'A000', 'OPS', 'E', 'EQ', 'CC2000', '', 20, ${ACTOR}),
          (${client}, 'A000', 'OPS2', 'E', 'EQ', 'CC1000', '', 10, ${ACTOR}),
          (${client}, 'A000', 'OPS2', 'I', 'BT', 'CC1000', 'CC1999', 20, ${ACTOR}),
          (${client}, 'A000', 'OPS3', 'I', 'BT', 'CC1000', 'CC2999', 10, ${ACTOR}),
          (${client}, 'A000', 'OPS3', 'E', 'BT', 'CC1000', 'CC9999', 20, ${ACTOR})
      `);
    });

    const centresOf = (rows: { kind: string; costCenter?: string }[]) =>
      rows.filter((r) => r.kind === 'CENTER').map((r) => r.costCenter).sort();

    const excluded = await calculateCostCenterReport({ client, selection: selection({ costCenterGroup: 'OPS' }) });
    expect(centresOf(excluded.rows)).toEqual(['CC1000']);
    expect(excluded.rows.find((r) => r.kind === 'CENTER' && r.costCenter === 'CC1000')?.actual).toBe(-4000);
    expect(excluded.rows.find((r) => r.kind === 'ELEMENT' && r.costCenter === 'CC1000' && r.costElement === '400000')?.actual).toBe(5000);

    const reincluded = await calculateCostCenterReport({ client, selection: selection({ costCenterGroup: 'OPS2' }) });
    expect(centresOf(reincluded.rows)).toEqual(['CC1000']);

    await expect(calculateCostCenterReport({ client, selection: selection({ costCenterGroup: 'OPS3' }) }))
      .rejects.toThrow(/No cost centers match the selection/);
  });
});
