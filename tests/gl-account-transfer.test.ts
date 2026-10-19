import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  transferGlAccounts, type GlAccountTransferSelection,
} from '../src/modules/finance/gl-account-transfer';
import { getJournalItems } from '../src/modules/finance/journal-items';
import { postGlDocument } from '../src/modules/finance/gl-document';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'FS15-TEST';
const TARGET = '2000';
let client = '';
let company = '';

const selection = (overrides: Partial<GlAccountTransferSelection> = {}): GlAccountTransferSelection => ({
  sourceCompanyCode: company, targetCompanyCode: TARGET, chartOfAccounts: 'CA01',
  accountFrom: '100000', accountTo: '199999',
  testRun: true, withCompanyData: true, overwriteExisting: false, ...overrides,
});

async function segment(companyCode: string, account: string) {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select account_currency, sort_key, is_open_item_managed, is_blocked_posting
      from gl_account_company
      where client = ${client} and company_code = ${companyCode} and gl_account = ${account}
    `) as unknown as Array<Record<string, unknown>>;
    return rows[0];
  });
}

beforeAll(async () => {
  const fx = await createTenant('gltransfer');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into company_code (client, company_code, name, chart_of_accounts, currency, country)
      values (${client}, ${TARGET}, 'Target company', 'CA01', 'USD', 'US')
    `);
    // Source segments stand for two accounts in range (post-backfill state).
    await tx.execute(sql`
      insert into gl_account_company
        (client, company_code, chart_of_accounts, gl_account, account_currency,
         tax_category, is_open_item_managed, sort_key, is_blocked_posting, created_by)
      values
        (${client}, ${company}, 'CA01', '101000', 'USD', null, true, '001', false, ${ACTOR}),
        (${client}, ${company}, 'CA01', '110000', 'USD', null, false, '002', false, ${ACTOR})
      on conflict do nothing
    `);
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-110 FS15 G/L account master transfer (R-158)', () => {
  it('test run judges everything, copies nothing, and persists only the protocol', async () => {
    const result = await transferGlAccounts({ client, actor: ACTOR, selection: selection() });
    expect(result.testRun).toBe(true);
    expect(result.status).toBe('COMPLETED');
    expect(result.lines.find((l) => l.glAccount === '101000')?.action).toBe('CREATED');
    expect(await segment(TARGET, '101000')).toBeUndefined();
    const runs = await withTenant(client, async (tx) => tx.execute(sql`
      select status, test_run from gl_account_transfer_run where client = ${client} and run_id = ${result.runId}
    `)) as unknown as Array<{ status: string; test_run: boolean }>;
    expect(runs[0]).toMatchObject({ status: 'COMPLETED', test_run: true });
  });

  it('live run creates, repeat skips, overwrite updates', async () => {
    const live = await transferGlAccounts({ client, actor: ACTOR, selection: selection({ testRun: false }) });
    expect(live.lines.find((l) => l.glAccount === '101000')?.action).toBe('CREATED');
    expect(await segment(TARGET, '101000')).toMatchObject({ sort_key: '001', is_open_item_managed: true });

    const repeat = await transferGlAccounts({ client, actor: ACTOR, selection: selection({ testRun: false }) });
    expect(repeat.lines.find((l) => l.glAccount === '101000')?.action).toBe('SKIPPED');

    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update gl_account_company set sort_key = '007'
        where client = ${client} and company_code = ${company} and gl_account = '101000'
      `);
    });
    const overwrite = await transferGlAccounts({
      client, actor: ACTOR, selection: selection({ testRun: false, overwriteExisting: true }),
    });
    expect(overwrite.lines.find((l) => l.glAccount === '101000')?.action).toBe('UPDATED');
    expect(await segment(TARGET, '101000')).toMatchObject({ sort_key: '007' });
  });

  it('without company data every account skips at chart level, and bad selections are judged', async () => {
    const chartOnly = await transferGlAccounts({
      client, actor: ACTOR, selection: selection({ testRun: false, withCompanyData: false }),
    });
    expect(chartOnly.lines.every((l) => l.action === 'SKIPPED')).toBe(true);
    expect(chartOnly.lines[0]?.reason).toContain('shared chart');

    await expect(transferGlAccounts({
      client, actor: ACTOR, selection: selection({ targetCompanyCode: company }),
    })).rejects.toThrow('must differ');
    await expect(transferGlAccounts({
      client, actor: ACTOR, selection: selection({ chartOfAccounts: 'ZZZZ' }),
    })).rejects.toThrow('not ZZZZ');
  });

  it('the segment governs: posting block and open-item judgement read it first', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update gl_account_company set is_blocked_posting = true
        where client = ${client} and company_code = ${company} and gl_account = '101000'
      `);
    });
    await expect(postGlDocument({
      client, changedBy: ACTOR, requestKey: 'fs15-block-1', companyCode: company,
      documentDate: '2026-04-10', postingDate: '2026-04-10', documentType: 'SA', currency: 'USD',
      lines: [
        { glAccount: '101000', debitCredit: 'S', amount: '10' },
        { glAccount: '300000', debitCredit: 'H', amount: '10' },
      ],
    })).rejects.toThrow(`blocked for posting in company ${company}`);
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update gl_account_company set is_blocked_posting = false
        where client = ${client} and company_code = ${company} and gl_account = '101000'
      `);
    });

    // Chart flag off, segment on: the item still judges as managed.
    await postGlDocument({
      client, changedBy: ACTOR, requestKey: 'fs15-oi-1', companyCode: company,
      documentDate: '2026-04-10', postingDate: '2026-04-10', documentType: 'SA', currency: 'USD',
      lines: [
        { glAccount: '101000', debitCredit: 'S', amount: '25' },
        { glAccount: '300000', debitCredit: 'H', amount: '25' },
      ],
    });
    const open = await getJournalItems(client, {
      accountFrom: '101000', companyCodes: [company], fiscalYear: 2026, status: 'OPEN',
    });
    expect(open.rows.some((r) => r.itemStatus === 'OPEN')).toBe(true);
  });
});
