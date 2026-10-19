/**
 * Transfer G/L account master data between company codes —
 * SCR-110 / FS15 as a search alias only, SAP parity scope.
 *
 * Parity first builds the company-code segment of the G/L
 * master (gl_account_company): account currency, tax category,
 * open-item management, sort key and posting block per company.
 * Where a segment row stands it governs; the chart-level flag
 * remains the fallback, so standing behavior is preserved.
 * The transfer copies segment rows source -> target company
 * under test-run / with-company-data / overwrite policy, and
 * every run (test runs included, as execution metadata) leaves
 * a run header plus per-account protocol. Chart-level records
 * are never overwritten for a company difference.
 *
 * Stage 1 carries the vocabulary only; schema lands in stage 2
 * and the transfer service in stage 3.
 */
export const GL_ACCOUNT_TRANSFER_CAPABILITY = 'CFG.FIN.GLACCOUNT.TRANSFER';

export interface GlAccountCompanySegment {
  companyCode: string;
  glAccount: string;
  accountCurrency: string;
  taxCategory: string | null;
  isOpenItemManaged: boolean;
  sortKey: string;
  isBlockedPosting: boolean;
}

export interface GlAccountTransferSelection {
  sourceCompanyCode: string;
  targetCompanyCode: string;
  chartOfAccounts: string;
  accountFrom?: string;
  accountTo?: string;
  testRun: boolean;
  withCompanyData: boolean;
  overwriteExisting: boolean;
}

export type TransferAction = 'CREATED' | 'UPDATED' | 'SKIPPED' | 'ERROR';

export interface GlAccountTransferLine {
  glAccount: string;
  action: TransferAction;
  reason: string;
}

export interface GlAccountTransferResult {
  runId: string;
  testRun: boolean;
  status: 'COMPLETED' | 'PARTIALLY_FAILED' | 'FAILED';
  lines: GlAccountTransferLine[];
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  executedAt: string;
  executedBy: string;
}

import { sql } from 'drizzle-orm';
import { withTenant } from '@/platform/db/client';
import { getCompanyCode } from '@/platform/periods';

export class GlAccountTransferError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'GlAccountTransferError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new GlAccountTransferError(message, remedy);
}

interface SegmentRow {
  gl_account: string;
  account_currency: string;
  tax_category: string | null;
  is_open_item_managed: boolean;
  sort_key: string;
  is_blocked_posting: boolean;
}

/** Read-only segment list for the account display (stage 3). */
export async function listAccountSegments(client: string, input: {
  chartOfAccounts: string; glAccount: string;
}): Promise<GlAccountCompanySegment[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select company_code, gl_account, account_currency, tax_category,
             is_open_item_managed, sort_key, is_blocked_posting
      from gl_account_company
      where client = ${client} and chart_of_accounts = ${input.chartOfAccounts}
        and gl_account = ${input.glAccount}
      order by company_code
    `) as unknown as Array<{
      company_code: string; gl_account: string; account_currency: string;
      tax_category: string | null; is_open_item_managed: boolean;
      sort_key: string; is_blocked_posting: boolean;
    }>;
    return rows.map((r) => ({
      companyCode: r.company_code, glAccount: r.gl_account,
      accountCurrency: r.account_currency, taxCategory: r.tax_category,
      isOpenItemManaged: r.is_open_item_managed, sortKey: r.sort_key,
      isBlockedPosting: r.is_blocked_posting,
    }));
  });
}

/**
 * Execute the FS15 transfer. Every account in range is judged
 * before any write; live writes and the run protocol persist in
 * one transaction. Test runs persist only the run protocol
 * (execution metadata) and never master data. Chart-level
 * records are never overwritten for a company difference.
 */
export async function transferGlAccounts(input: {
  client: string; actor: string; selection: GlAccountTransferSelection;
}): Promise<GlAccountTransferResult> {
  const { client, actor } = input;
  const s = input.selection;
  if (!s.sourceCompanyCode || !s.targetCompanyCode) fail('Source and target company codes are required.');
  if (s.sourceCompanyCode === s.targetCompanyCode) {
    fail('Source and target company codes must differ.', 'Choose a different target company code.');
  }
  const accountFrom = (s.accountFrom ?? '').trim();
  const accountTo = (s.accountTo ?? '').trim() || accountFrom;
  if (accountFrom && accountFrom > accountTo) fail('The account range is inverted.', 'Account from must not exceed account to.');
  const executedAt = new Date().toISOString();
  const runId = `TR${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 36 ** 4).toString(36).toUpperCase().padStart(4, '0')}`;

  return withTenant(client, async (tx) => {
    const source = await getCompanyCode(tx, client, s.sourceCompanyCode);
    if (!source) fail(`Source company code ${s.sourceCompanyCode} does not stand.`);
    const target = await getCompanyCode(tx, client, s.targetCompanyCode);
    if (!target) fail(`Target company code ${s.targetCompanyCode} does not stand.`);
    for (const [label, company] of [['Source', source], ['Target', target]] as const) {
      if ((company.chartOfAccounts ?? '') !== s.chartOfAccounts) {
        fail(`${label} company ${company.companyCode} stands on chart ${company.chartOfAccounts ?? '(none)'}, not ${s.chartOfAccounts}.`,
          'Select the chart both company codes are assigned to.');
      }
    }

    const accountRows = await tx.execute(sql`
      select account_number from gl_account
      where client = ${client} and chart_of_accounts = ${s.chartOfAccounts}
        ${accountFrom ? sql`and account_number between ${accountFrom} and ${accountTo}` : sql``}
      order by account_number
    `) as unknown as Array<{ account_number: string }>;
    if (accountRows.length === 0) {
      fail(`No G/L accounts stand in the selected range on chart ${s.chartOfAccounts}.`, 'Widen the account range.');
    }

    const segmentRows = await tx.execute(sql`
      select company_code, gl_account, account_currency, tax_category,
             is_open_item_managed, sort_key, is_blocked_posting
      from gl_account_company
      where client = ${client} and chart_of_accounts = ${s.chartOfAccounts}
        and company_code in (${s.sourceCompanyCode}, ${s.targetCompanyCode})
    `) as unknown as Array<SegmentRow & { company_code: string }>;
    const sourceSegments = new Map(segmentRows.filter((r) => r.company_code === s.sourceCompanyCode).map((r) => [r.gl_account, r]));
    const targetSegments = new Map(segmentRows.filter((r) => r.company_code === s.targetCompanyCode).map((r) => [r.gl_account, r]));

    const lines: GlAccountTransferLine[] = [];
    for (const { account_number: account } of accountRows) {
      if (!s.withCompanyData) {
        lines.push({ glAccount: account, action: 'SKIPPED', reason: 'Chart-level record already stands on the shared chart; company code data not requested.' });
        continue;
      }
      const sourceSegment = sourceSegments.get(account);
      if (!sourceSegment) {
        lines.push({ glAccount: account, action: 'SKIPPED', reason: `No company segment stands for the source company ${s.sourceCompanyCode} to copy.` });
        continue;
      }
      if (!/^[A-Z]{3}$/.test(sourceSegment.account_currency)) {
        lines.push({ glAccount: account, action: 'ERROR', reason: `Source segment currency ${sourceSegment.account_currency} is not a valid currency code; nothing substituted.` });
        continue;
      }
      const targetSegment = targetSegments.get(account);
      if (targetSegment && !s.overwriteExisting) {
        lines.push({ glAccount: account, action: 'SKIPPED', reason: 'Target segment already exists; overwrite is off.' });
        continue;
      }
      if (s.testRun) {
        lines.push({
          glAccount: account,
          action: targetSegment ? 'UPDATED' : 'CREATED',
          reason: targetSegment ? 'Test run: target segment would be updated from the source segment.' : 'Test run: target segment would be created from the source segment.',
        });
        continue;
      }
      if (targetSegment) {
        await tx.execute(sql`
          update gl_account_company
          set account_currency = ${sourceSegment.account_currency},
              tax_category = ${sourceSegment.tax_category},
              is_open_item_managed = ${sourceSegment.is_open_item_managed},
              sort_key = ${sourceSegment.sort_key},
              is_blocked_posting = ${sourceSegment.is_blocked_posting},
              updated_by = ${actor}, updated_at = now()
          where client = ${client} and company_code = ${s.targetCompanyCode} and gl_account = ${account}
        `);
        lines.push({ glAccount: account, action: 'UPDATED', reason: 'Target segment updated from the source segment.' });
      } else {
        await tx.execute(sql`
          insert into gl_account_company
            (client, company_code, chart_of_accounts, gl_account, account_currency,
             tax_category, is_open_item_managed, sort_key, is_blocked_posting, created_by)
          values (${client}, ${s.targetCompanyCode}, ${s.chartOfAccounts}, ${account},
                  ${sourceSegment.account_currency}, ${sourceSegment.tax_category},
                  ${sourceSegment.is_open_item_managed}, ${sourceSegment.sort_key},
                  ${sourceSegment.is_blocked_posting}, ${actor})
        `);
        lines.push({ glAccount: account, action: 'CREATED', reason: 'Target segment created from the source segment.' });
      }
    }

    const errors = lines.filter((l) => l.action === 'ERROR').length;
    const status = errors === 0 ? 'COMPLETED' : lines.some((l) => l.action !== 'ERROR') ? 'PARTIALLY_FAILED' : 'FAILED';
    await tx.execute(sql`
      insert into gl_account_transfer_run
        (client, run_id, source_company_code, target_company_code, chart_of_accounts,
         account_from, account_to, test_run, with_company_data, overwrite_existing,
         status, executed_by)
      values (${client}, ${runId}, ${s.sourceCompanyCode}, ${s.targetCompanyCode}, ${s.chartOfAccounts},
              ${accountFrom || null}, ${accountTo || null}, ${s.testRun}, ${s.withCompanyData},
              ${s.overwriteExisting}, ${status}, ${actor})
    `);
    for (const line of lines) {
      await tx.execute(sql`
        insert into gl_account_transfer_result (client, run_id, gl_account, action, reason)
        values (${client}, ${runId}, ${line.glAccount}, ${line.action}, ${line.reason})
      `);
    }

    return {
      runId, testRun: s.testRun, status: status as GlAccountTransferResult['status'], lines,
      created: lines.filter((l) => l.action === 'CREATED').length,
      updated: lines.filter((l) => l.action === 'UPDATED').length,
      skipped: lines.filter((l) => l.action === 'SKIPPED').length,
      errors, executedAt, executedBy: actor,
    };
  });
}
