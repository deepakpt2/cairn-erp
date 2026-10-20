/**
 * SCR-113 / R-161 stage 5 — profit centre actual line items.
 *
 * Lines are the posted journal lines carrying a profit centre,
 * exactly as recorded; totals reconcile to those lines by
 * profit centre, account and currency; the hit limit windows
 * the lines and says so; the report is read-only.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { postGlDocument } from '../src/modules/finance/gl-document';
import {
  listProfitCenterLines, profitCenterLinesCsv, ProfitCenterReportError,
  type ProfitCenterReportSelection,
} from '../src/modules/foundation/profit-center-report';
import { closeDb, createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'SCR113-TEST';
let tenant: TestTenant | undefined;
let client = '';
let currency = 'USD';

function selection(overrides: Partial<ProfitCenterReportSelection> = {}): ProfitCenterReportSelection {
  return {
    controllingArea: 'A000', fiscalYear: 2026, periodFrom: 4, periodTo: 4,
    ledger: '0L', maxHits: 5000, ...overrides,
  };
}

async function post(amount: string, lines: Array<{ glAccount: string; debitCredit: 'S' | 'H'; profitCenter?: string; assignment?: string; lineText?: string }>, key: string, date: string) {
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
  tenant = await createTenant('scr113-report');
  client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select currency from controlling_area where client = ${client} and controlling_area = 'A000'
    `) as unknown as Array<{ currency: string }>;
    currency = rows[0]?.currency ?? 'USD';
    await tx.execute(sql`
      insert into profit_center (client, controlling_area, profit_center, valid_from, valid_to, name, created_by)
      values
        (${client}, 'A000', 'PC1000', '2026-01-01', '2026-12-31', 'Plant centre', ${ACTOR}),
        (${client}, 'A000', 'PC2000', '2026-01-01', '2026-12-31', 'Sales centre', ${ACTOR}),
        (${client}, 'A000', 'PC3000', '2025-01-01', '2025-12-31', 'Lapsed centre', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into profit_center_group (client, controlling_area, group_name, title, created_by)
      values (${client}, 'A000', 'GRP1', 'Plant only', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into profit_center_group_leaf (client, controlling_area, group_name, val_sign, val_option, val_from, val_to, created_by)
      values
        (${client}, 'A000', 'GRP1', 'I', 'BT', 'PC1000', 'PC9999', ${ACTOR}),
        (${client}, 'A000', 'GRP1', 'E', 'EQ', 'PC2000', '', ${ACTOR})
    `);
  });

  await post('7000', [{ glAccount: '101000', debitCredit: 'S' }, { glAccount: '300000', debitCredit: 'H', profitCenter: 'PC1000', assignment: 'APR-SALES', lineText: 'April revenue' }], 'pc-2026-1', '2026-04-10');
  await post('1200', [{ glAccount: '400000', debitCredit: 'S', profitCenter: 'PC1000' }, { glAccount: '101000', debitCredit: 'H' }], 'pc-2026-2', '2026-04-11');
  await post('800', [{ glAccount: '400000', debitCredit: 'S', profitCenter: 'PC2000' }, { glAccount: '101000', debitCredit: 'H' }], 'pc-2026-3', '2026-02-10');
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
}, 180_000);

describe('SCR-113 profit centre actual line items (R-161)', () => {
  it('lists posted lines as recorded, signed, with reconciling totals', async () => {
    const before = await journalCount();
    const result = await listProfitCenterLines({ client, selection: selection() });
    expect(await journalCount()).toBe(before); // read-only
    expect(result.truncated).toBe(false);
    expect(result.lines).toHaveLength(2);

    const revenue = result.lines.find((l) => l.glAccount === '300000');
    expect(revenue?.profitCenter).toBe('PC1000');
    expect(revenue?.profitCenterName).toBe('Plant centre');
    expect(revenue?.amountDocument).toBe(-7000);
    expect(revenue?.amountLocal).toBe(-7000);
    expect(revenue?.assignment).toBe('APR-SALES');
    expect(revenue?.lineText).toBe('April revenue');
    expect(revenue?.ledger).toBe('0L');

    const expenseTotal = result.totals.find((t) => t.profitCenter === 'PC1000' && t.glAccount === '400000');
    expect(expenseTotal?.amountLocal).toBe(1200);
    expect(result.excludedCenters).toContain('PC3000');
    expect(result.warnings.some((w) => w.includes('PC3000'))).toBe(true);
  });

  it('windows lines at the hit limit, flags truncation, keeps totals complete', async () => {
    const result = await listProfitCenterLines({ client, selection: selection({ periodFrom: 1, maxHits: 1 }) });
    expect(result.truncated).toBe(true);
    expect(result.lines).toHaveLength(1);
    const feb = result.totals.find((t) => t.profitCenter === 'PC2000');
    expect(feb?.amountLocal).toBe(800); // totals cover the complete selection
  });

  it('resolves groups with exclusion leaves in display order', async () => {
    const result = await listProfitCenterLines({ client, selection: selection({ periodFrom: 1, profitCenterGroup: 'GRP1' }) });
    expect(new Set(result.lines.map((l) => l.profitCenter))).toEqual(new Set(['PC1000']));
  });

  it('exports exactly the shown window to CSV, marked when truncated (SCR-113 export)', async () => {
    const full = await listProfitCenterLines({ client, selection: selection() });
    const csv = profitCenterLinesCsv(full);
    const rows = csv.trimEnd().split('\n');
    expect(rows[0]).toContain('Company Code,Document Number');
    expect(rows).toHaveLength(1 + full.lines.length);
    const revenueRow = rows.find((r) => r.includes('300000'));
    expect(revenueRow).toContain('PC1000');
    expect(revenueRow).toContain('-7000.0000');
    expect(revenueRow).toContain('April revenue');

    const trimmed = await listProfitCenterLines({ client, selection: selection({ periodFrom: 1, maxHits: 1 }) });
    const trimmedCsv = profitCenterLinesCsv(trimmed);
    expect(trimmedCsv.startsWith('# TRUNCATED at 1 hits')).toBe(true);
    expect(trimmedCsv.trimEnd().split('\n')).toHaveLength(3); // marker, header, one line
  });

  it('refuses non-leading ledgers and unknown profit centres by name', async () => {
    await expect(listProfitCenterLines({ client, selection: selection({ ledger: '2L' }) }))
      .rejects.toBeInstanceOf(ProfitCenterReportError);
    await expect(listProfitCenterLines({ client, selection: selection({ profitCenterFrom: 'PC9999' }) }))
      .rejects.toThrow(/PC9999 does not stand/);
  });
});
