/**
 * G/L to subledger tie-out (SCR-115 / FIN.RPT.SUBLEDGER.TIE;
 * F.03 and FAGLB03 search aliases, FS10N staying with the
 * G/L balance report and FBL1N/FBL5N with the partner reports).
 *
 * Per owner research the tie-out matches the G/L balance of
 * each reconciliation account against the subledger total:
 * per company, fiscal year and cumulative periods
 * 1..period-to, every account whose reconciliation type
 * stands CUSTOMERS or VENDORS shows its total over all POSTED
 * journal lines beside the total over lines carrying a
 * business partner. The difference is named TIED or
 * EXCEPTION, never netted away; partnerless lines — direct
 * postings to a reconciliation account, which should only
 * ever move through its subledger — stand as the exception
 * detail, and partners posting to an account other than the
 * one their company segment assigns are named.
 *
 * Read-only; closed periods report normally; balances stand
 * in company local currency. Deferred by name: ASSETS and
 * MATERIAL reconciliation types, non-cumulative movement
 * comparison, and multi-ledger (ledger `0L` only, refused
 * by name as elsewhere).
 *
 * Stage 1 carries the vocabulary only; the index check
 * lands in stage 2 and the tie-out service in stage 3.
 */
export const SUBLEDGER_TIE_CAPABILITY = 'FIN.RPT.SUBLEDGER.TIE';
export const TIE_LEDGER = '0L';

export interface SubledgerTieSelection {
  companyCode: string;
  fiscalYear: number;
  periodTo: number;
  ledger: string;
  accountFrom?: string;
  accountTo?: string;
}

export type TieStatus = 'TIED' | 'EXCEPTION';

export interface SubledgerTieRow {
  kind: 'ACCOUNT' | 'PARTNER';
  key: string;
  companyCode: string;
  accountNumber: string;
  reconciliationType: string;
  businessPartner?: string;
  /** Account total over all posted lines (ACCOUNT rows). */
  glTotal: number;
  /** Total over partner-carrying lines (ACCOUNT: subledger total; PARTNER: that partner). */
  subledgerTotal: number;
  difference: number | null;
  status: TieStatus | null;
  lineCount: number;
}

export interface SubledgerTieResult {
  companyCode: string;
  currency: string;
  fiscalYear: number;
  periodTo: number;
  ledger: string;
  rows: SubledgerTieRow[];
  /** Partnerless lines standing on reconciliation accounts, the exception detail. */
  partnerlessLines: number;
  partnerlessAmount: number;
  warnings: string[];
  calculatedAt: string;
}

import { sql } from 'drizzle-orm';
import { withTenant } from '@/platform/db/client';
import { fromScaled, toScaled } from '@/platform/posting/decimal';
import { ledgerJournalStatus } from './ledger-journal';

export class SubledgerTieError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'SubledgerTieError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new SubledgerTieError(message, remedy);
}

const signed = (debitCredit: string, amount: string) =>
  Number(fromScaled(toScaled(amount))) * (debitCredit === 'S' ? 1 : -1);

export async function calculateSubledgerTie(input: {
  client: string; selection: SubledgerTieSelection;
}): Promise<SubledgerTieResult> {
  const { client } = input;
  const s = { ...input.selection, ledger: (input.selection.ledger || TIE_LEDGER).toUpperCase() };
  if (s.ledger !== TIE_LEDGER) {
    fail(`Ledger ${s.ledger} is not configured.`, `Only the leading ledger ${TIE_LEDGER} stands in this canon; other ledgers are not carried.`);
  }
  if (!Number.isInteger(s.fiscalYear) || s.fiscalYear < 1900 || s.fiscalYear > 2199) fail('A valid fiscal year is required.');
  if (s.periodTo < 1 || s.periodTo > 16) fail('Period to must stand between 1 and 16.');
  if (s.accountFrom && s.accountTo && s.accountFrom > s.accountTo) fail('The account range is inverted.');
  const calculatedAt = new Date().toISOString();

  return withTenant(client, async (tx) => {
    const companyRows = await tx.execute(sql`
      select company_code, currency, chart_of_accounts from company_code
      where client = ${client} and company_code = ${s.companyCode}
    `) as unknown as Array<{ company_code: string; currency: string; chart_of_accounts: string }>;
    const company = companyRows[0];
    if (!company) fail(`Company code ${s.companyCode} does not stand.`);

    const accountRows = await tx.execute(sql`
      select account_number, reconciliation_type from gl_account
      where client = ${client} and chart_of_accounts = ${company.chart_of_accounts}
        and reconciliation_type in ('CUSTOMERS', 'VENDORS')
        ${s.accountFrom ? sql`and account_number between ${s.accountFrom} and ${s.accountTo || s.accountFrom}` : sql``}
      order by account_number
    `) as unknown as Array<{ account_number: string; reconciliation_type: string }>;
    if (accountRows.length === 0) {
      fail('No reconciliation accounts stand in the company chart for customers or vendors.', 'Configure reconciliation accounts (FS00), then execute the tie-out.');
    }
    const accounts = accountRows.map((a) => a.account_number);
    const accountList = sql.join(accounts.map((a) => sql`${a}`), sql`, `);

    const totalRows = await tx.execute(sql`
      select l.gl_account,
        coalesce(sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end), 0)::text as gl_total,
        coalesce(sum(case when l.business_partner is not null
                          then case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end end), 0)::text as sub_total,
        coalesce(sum(case when l.business_partner is null
                          then case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end end), 0)::text as partnerless_amount,
        count(*)::int as lines,
        count(case when l.business_partner is null then 1 end)::int as partnerless_lines
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
      where l.client = ${client} and l.company_code = ${s.companyCode}
        and l.fiscal_year = ${s.fiscalYear} and e.posting_period <= ${s.periodTo}
        and ${ledgerJournalStatus('e')} and l.gl_account in (${accountList})
      group by l.gl_account
    `) as unknown as Array<{
      gl_account: string; gl_total: string; sub_total: string;
      partnerless_amount: string; lines: number; partnerless_lines: number;
    }>;
    const totalsOf = new Map(totalRows.map((r) => [r.gl_account, r]));

    const partnerRows = await tx.execute(sql`
      select l.gl_account, l.business_partner,
        sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end)::text as total,
        count(*)::int as lines
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
      where l.client = ${client} and l.company_code = ${s.companyCode}
        and l.fiscal_year = ${s.fiscalYear} and e.posting_period <= ${s.periodTo}
        and ${ledgerJournalStatus('e')} and l.gl_account in (${accountList})
        and l.business_partner is not null
      group by l.gl_account, l.business_partner
      order by l.gl_account, l.business_partner
    `) as unknown as Array<{ gl_account: string; business_partner: string; total: string; lines: number }>;

    // Partners posting away from their assigned reconciliation account.
    const segmentRows = await tx.execute(sql`
      select partner_number, reconciliation_account from customer_company_code
      where client = ${client} and company_code = ${s.companyCode} and reconciliation_account is not null
      union
      select partner_number, reconciliation_account from supplier_company_code
      where client = ${client} and company_code = ${s.companyCode} and reconciliation_account is not null
    `) as unknown as Array<{ partner_number: string; reconciliation_account: string }>;
    const assignedOf = new Map(segmentRows.map((r) => [r.partner_number, r.reconciliation_account]));
    const warnings: string[] = [];
    const misassigned = new Set<string>();
    for (const p of partnerRows) {
      const assigned = assignedOf.get(p.business_partner);
      if (assigned && assigned !== p.gl_account) {
        misassigned.add(`${p.business_partner} posts on ${p.gl_account} but its company segment assigns ${assigned}`);
      }
    }
    for (const m of [...misassigned].sort()) warnings.push(`Partner ${m}.`);

    const rows: SubledgerTieRow[] = [];
    let partnerlessLines = 0;
    let partnerlessAmount = 0;
    for (const account of accountRows) {
      const t = totalsOf.get(account.account_number);
      const glTotal = t ? Number(fromScaled(toScaled(t.gl_total))) : 0;
      const subledgerTotal = t ? Number(fromScaled(toScaled(t.sub_total))) : 0;
      const difference = glTotal - subledgerTotal;
      partnerlessLines += t?.partnerless_lines ?? 0;
      partnerlessAmount += t ? Number(fromScaled(toScaled(t.partnerless_amount))) : 0;
      rows.push({
        kind: 'ACCOUNT', key: account.account_number,
        companyCode: s.companyCode, accountNumber: account.account_number,
        reconciliationType: account.reconciliation_type,
        glTotal, subledgerTotal, difference,
        status: difference === 0 ? 'TIED' : 'EXCEPTION',
        lineCount: t?.lines ?? 0,
      });
      for (const p of partnerRows.filter((r) => r.gl_account === account.account_number)) {
        rows.push({
          kind: 'PARTNER', key: `${account.account_number}|${p.business_partner}`,
          companyCode: s.companyCode, accountNumber: account.account_number,
          reconciliationType: account.reconciliation_type,
          businessPartner: p.business_partner,
          glTotal: 0, subledgerTotal: Number(fromScaled(toScaled(p.total))),
          difference: null, status: null, lineCount: p.lines,
        });
      }
    }
    if (partnerlessLines > 0) {
      warnings.push(`${partnerlessLines} partnerless line(s) totalling ${partnerlessAmount.toFixed(2)} ${company.currency} stand on reconciliation accounts; a reconciliation account should only move through its subledger.`);
    }

    return {
      companyCode: s.companyCode, currency: company.currency,
      fiscalYear: s.fiscalYear, periodTo: s.periodTo, ledger: TIE_LEDGER,
      rows, partnerlessLines, partnerlessAmount, warnings, calculatedAt,
    };
  });
}
