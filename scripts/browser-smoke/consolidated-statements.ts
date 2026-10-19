import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import {
  activateArea, assignUnit, saveArea, saveDataBasis, saveGroup,
  saveGroupAccount, saveMapping, saveMethod, saveTask, saveUnit, saveVersion,
} from '../../src/modules/finance/consolidation-workbench';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/finance/consolidated-statements';
const ACTOR = { changedBy: 'browser.admin', reason: 'Browser acceptance run' };

/**
 * SCR-118 browser acceptance: consolidated statements.
 *
 * The journey: UCWB configuration and posted journals stand,
 * the balance sheet aggregates the mapped asset item per unit
 * with its previous-year comparison, the income statement
 * shows revenue and expense, and the report persists nothing.
 */
export async function consolidatedStatements(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-118: display consolidated statements over UCWB configuration');

  const fixture = await withTenant(client, async (tx) => {
    const variantRows = await tx.execute(sql`
      select fiscal_year_variant from company_code where client = ${client} and company_code = '1000'
    `) as unknown as Array<{ fiscal_year_variant: string }>;
    const rows = await tx.execute(sql`
      select distinct on (account_type) account_type, account_number
      from gl_account where client = ${client} and chart_of_accounts = 'CA01'
        and account_type in ('ASSET', 'REVENUE', 'EXPENSE')
      order by account_type, account_number
    `) as unknown as Array<{ account_type: string; account_number: string }>;
    const picked: Record<string, string> = {};
    for (const row of rows) picked[row.account_type] = row.account_number;
    return { variant: variantRows[0]?.fiscal_year_variant ?? 'K4', picked };
  });
  const { variant, picked } = fixture;

  await saveDataBasis({ client, ...ACTOR, basis: 'BASIS1', title: 'Journal basis', dimensions: [{ dimension: 'COMPANY_CODE' }] });
  await saveArea({ client, ...ACTOR, area: 'C100', title: 'Group consolidation', dataBasis: 'BASIS1', consChart: 'GC01', fiscalYearVariant: variant });
  await saveUnit({ client, ...ACTOR, area: 'C100', unit: 'U1000', title: 'Acceptance unit', companyCode: '1000' });
  await saveGroup({ client, ...ACTOR, area: 'C100', group: 'GRP1', title: 'Group' });
  await assignUnit({ client, ...ACTOR, area: 'C100', group: 'GRP1', unit: 'U1000', validFrom: '2025-01-01', validTo: '2026-12-31' });
  await saveGroupAccount({ client, ...ACTOR, consChart: 'GC01', account: 'FS1000', title: 'Asset item' });
  await saveGroupAccount({ client, ...ACTOR, consChart: 'GC01', account: 'FS4000', title: 'Revenue item' });
  await saveGroupAccount({ client, ...ACTOR, consChart: 'GC01', account: 'FS5000', title: 'Expense item' });
  await saveMapping({ client, ...ACTOR, consChart: 'GC01', sourceChart: 'CA01', sourceFrom: picked.ASSET!, sourceTo: picked.ASSET!, groupAccount: 'FS1000' });
  await saveMapping({ client, ...ACTOR, consChart: 'GC01', sourceChart: 'CA01', sourceFrom: picked.REVENUE!, sourceTo: picked.REVENUE!, groupAccount: 'FS4000' });
  await saveMapping({ client, ...ACTOR, consChart: 'GC01', sourceChart: 'CA01', sourceFrom: picked.EXPENSE!, sourceTo: picked.EXPENSE!, groupAccount: 'FS5000' });
  await saveMethod({ client, ...ACTOR, area: 'C100', method: 'MVAL', kind: 'OTHER', title: 'Collect' });
  await saveVersion({ client, ...ACTOR, area: 'C100', version: '100', title: 'Actual' });
  await saveTask({ client, ...ACTOR, area: 'C100', version: '100', task: 'T100', sequence: 10, taskType: 'DATA_COLLECTION', method: 'MVAL', unit: 'U1000', group: 'GRP1', validFrom: '2025-01-01', validTo: '2026-12-31' });
  await activateArea({ client, ...ACTOR, area: 'C100' });

  await withTenant(client, async (tx) => {
    const journals: Array<[string, number, number, Array<[string, 'S' | 'H', number]>]> = [
      ['STMT-2026-06', 2026, 6, [[picked.ASSET!, 'S', 1000], [picked.REVENUE!, 'H', 1000]]],
      ['STMT-2026-12', 2026, 12, [[picked.EXPENSE!, 'S', 250], [picked.ASSET!, 'H', 250]]],
      ['STMT-2025-12', 2025, 12, [[picked.ASSET!, 'S', 500], [picked.REVENUE!, 'H', 500]]],
    ];
    for (const [doc, fy, period, lines] of journals) {
      await tx.execute(sql`
        insert into journal_entry
          (client, document_number, fiscal_year, document_type, company_code, document_date,
           posting_date, posting_period, document_currency, local_currency, status, created_by)
        values (${client}, ${doc}, ${fy}, 'SA', '1000', ${`${fy}-06-15`}, ${`${fy}-06-15`}, ${period}, 'USD', 'USD', 'POSTED', ${ACTOR.changedBy})
      `);
      for (const [index, [account, dc, amount]] of lines.entries()) {
        await tx.execute(sql`
          insert into journal_entry_line
            (client, document_number, fiscal_year, line_number, gl_account, company_code,
             debit_credit, amount_local, amount_document, currency)
          values (${client}, ${doc}, ${fy}, ${index + 1}, ${account}, '1000', ${dc}, ${amount}, ${amount}, 'USD')
        `);
      }
    }
  });

  await page.goto(`${base}${ROUTE}?area=C100&group=GRP1&version=100&fiscalYear=2026&period=12&view=BALANCE_SHEET&comparative=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: 'Consolidated Statements' }).waitFor();
  const assetRow = page.locator('tr', { hasText: 'FS1000' }).first();
  await assetRow.getByText('750.00').first().waitFor();
  await assetRow.getByText('500.00').first().waitFor();
  await page.getByText(/pre-elimination/).first().waitFor();
  console.log('  ✓ the balance sheet aggregates the asset item per unit with its comparison');

  await page.goto(`${base}${ROUTE}?area=C100&group=GRP1&version=100&fiscalYear=2026&period=12&view=INCOME_STATEMENT`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('tr', { hasText: 'FS4000' }).first().getByText('-1,000.00').first().waitFor();
  await page.locator('tr', { hasText: 'FS5000' }).first().getByText('250.00').first().waitFor();
  console.log('  ✓ the income statement shows revenue and expense items');

  const journals = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  });
  assert.equal(journals, 3);
  console.log('  ✓ the statements persisted nothing');
}
