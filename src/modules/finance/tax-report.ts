/**
 * Advance return for tax on sales/purchases — SCR-097 / R-145
 * (S_ALR_87012357 as a search alias only).
 *
 * Stage 1 vocabulary. The extraction service lands in stage 3.
 */
export const TAX_REPORT_CAPABILITY = 'FIN.TAX.REPORT';

export class TaxReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxReportError';
  }
}

export interface TaxReportSelection {
  companyCode: string;
  taxGroup?: string;
  postingDateFrom: string;
  postingDateTo: string;
  taxReturnCountry: string;
  testRun: boolean;
  doNotUpdateDocuments: boolean;
  electronicReturn: boolean;
  correctedReturn: boolean;
  clearingAccount?: string;
}

export interface TaxReportLine {
  taxCode: string;
  accountKey: string | null;
  ratePercent: number;
  /** Derived from the standing rate where above zero; null when not derivable. */
  taxBase: number | null;
  inputTax: number;
  outputTax: number;
  currency: string;
  documentCount: number;
  alreadyReported: number;
}

export interface TaxReportResult {
  companies: string[];
  postingDateFrom: string;
  postingDateTo: string;
  taxReturnCountry: string;
  lines: TaxReportLine[];
  totalBase: number;
  totalInputTax: number;
  totalOutputTax: number;
  /** Output over input: positive is payable, negative receivable. */
  netTax: number;
  currency: string;
  warnings: string[];
  runId: string | null;
  transferDocumentNumber: string | null;
}

import { and, eq, sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { getCompanyCode, derivePosition } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { accountDetermination, companyCode as companyCodeTable, documentType, taxCode as taxCodeTable } from '../foundation/schema';
import { journalEntry, journalEntryLine, taxReturnRun } from './schema';

const round2 = (n: number) => Math.round(n * 100) / 100;

interface TaxLineRow {
  document_number: string;
  fiscal_year: number;
  line_number: number;
  tax_code: string;
  debit_credit: string;
  amount: string;
  currency: string;
  tax_return_run_id: string | null;
}

/**
 * Execute the advance tax return for a judged selection.
 *
 * Test runs write only their execution-log row (the audit trail)
 * and change no source document; update runs stamp the reported
 * lines so they are not reported twice, and may post the clearing
 * transfer through the canonical engine. A corrected return
 * re-includes stamped lines.
 */
export async function executeTaxReport(input: {
  client: string; changedBy: string; selection: TaxReportSelection;
}): Promise<TaxReportResult> {
  const { selection } = input;
  const from = selection.postingDateFrom;
  const to = selection.postingDateTo;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new TaxReportError(`The posting-date window ${from} to ${to} is not a valid range.`);
  }
  const country = selection.taxReturnCountry.toUpperCase();
  if (!country) throw new TaxReportError('A tax return country is required.');

  return withTenant(input.client, async (tx) => {
    const company = await getCompanyCode(tx, input.client, selection.companyCode);
    if (!company?.isActive) {
      throw new TaxReportError(`Company code ${selection.companyCode} is not active or does not exist.`);
    }
    if (company.country !== country) {
      throw new TaxReportError(
        `Tax return country ${country} does not match company ${selection.companyCode}'s country ${company.country}; its tax codes would not govern.`,
      );
    }

    let companies = [selection.companyCode];
    if (selection.taxGroup) {
      const rows = await tx.select().from(companyCodeTable).where(and(
        eq(companyCodeTable.client, input.client), eq(companyCodeTable.country, country),
        eq(companyCodeTable.isActive, true),
      ));
      companies = rows.map((r) => r.companyCode);
      const currencies = new Set(rows.map((r) => r.currency));
      if (currencies.size > 1) {
        throw new TaxReportError('The grouped company codes do not share one currency; run the return per currency.');
      }
    }
    const currency = company.currency;

    const codeRows = await tx.select().from(taxCodeTable).where(and(
      eq(taxCodeTable.client, input.client), eq(taxCodeTable.country, country),
    ));
    const codes = new Map(codeRows.map((r) => [r.taxCode, r]));

    const raw = await tx.execute(sql`
      select l.document_number, l.fiscal_year, l.line_number, l.tax_code,
             l.debit_credit, l.amount_document as amount, l.currency, l.tax_return_run_id
      from journal_entry_line l
      join journal_entry h
        on h.client = l.client and h.document_number = l.document_number and h.fiscal_year = l.fiscal_year
      where l.client = ${input.client}
        and h.company_code in (${sql.join(companies.map((c) => sql`${c}`), sql`, `)})
        and h.posting_date >= ${from} and h.posting_date <= ${to}
        and l.tax_code is not null
      order by l.tax_code, l.document_number, l.line_number
    `);
    const all = raw as unknown as TaxLineRow[];
    const isUpdate = !selection.testRun && !selection.doNotUpdateDocuments;
    const reportable = all.filter((r) => selection.correctedReturn || !r.tax_return_run_id);
    const alreadyReportedCount = all.length - all.filter((r) => !r.tax_return_run_id).length;

    const byKey = new Map<string, TaxReportLine & { stamped: number }>();
    for (const row of reportable) {
      const key = `${row.tax_code}|${row.currency}`;
      const entry = byKey.get(key) ?? {
        taxCode: row.tax_code,
        accountKey: codes.get(row.tax_code)?.accountKey ?? null,
        ratePercent: Number(codes.get(row.tax_code)?.ratePercent ?? 0),
        taxBase: null, inputTax: 0, outputTax: 0, currency: row.currency,
        documentCount: 0, alreadyReported: 0, stamped: 0,
      };
      const amount = Number(row.amount);
      if (row.debit_credit === 'S') entry.inputTax = round2(entry.inputTax + amount);
      else entry.outputTax = round2(entry.outputTax + amount);
      if (row.tax_return_run_id) entry.stamped += 1;
      byKey.set(key, entry);
    }
    const docCounts = new Map<string, Set<string>>();
    for (const row of reportable) {
      const key = `${row.tax_code}|${row.currency}`;
      const set = docCounts.get(key) ?? new Set<string>();
      set.add(row.document_number);
      docCounts.set(key, set);
    }
    const lines: TaxReportLine[] = [...byKey.values()].map(({ stamped, ...entry }) => ({
      ...entry,
      documentCount: docCounts.get(`${entry.taxCode}|${entry.currency}`)?.size ?? 0,
      alreadyReported: stamped,
      taxBase: entry.ratePercent > 0
        ? round2(((entry.inputTax + entry.outputTax) / entry.ratePercent) * 100)
        : null,
    })).sort((a, b) => a.taxCode.localeCompare(b.taxCode));

    const warnings: string[] = [];
    for (const line of lines) {
      if (!codes.has(line.taxCode)) {
        warnings.push(`Tax code ${line.taxCode} is not configured for country ${country}; its account key and rate do not stand.`);
      } else if (line.ratePercent === 0) {
        warnings.push(`Tax code ${line.taxCode} carries a zero rate; its tax base is not derivable.`);
      }
    }
    if (alreadyReportedCount > 0 && !selection.correctedReturn) {
      warnings.push(`${alreadyReportedCount} tax line(s) in this window already stand reported and are excluded; a corrected return re-includes them.`);
    }
    if (selection.taxGroup) {
      warnings.push(`Group ${selection.taxGroup}: the run spans company codes ${companies.join(', ')} in country ${country}.`);
    }
    if (selection.electronicReturn) {
      warnings.push('Electronic advance return is recorded on the run; no statutory file format is configured in the product, so no file was produced.');
    }

    const totalInput = round2(lines.reduce((s, l) => s + l.inputTax, 0));
    const totalOutput = round2(lines.reduce((s, l) => s + l.outputTax, 0));
    const totalBase = round2(lines.reduce((s, l) => s + (l.taxBase ?? 0), 0));
    const netTax = round2(totalOutput - totalInput);
    const runId = `TX${Date.now().toString(36).toUpperCase()}`.slice(0, 24);

    let transferDocumentNumber: string | null = null;
    if (isUpdate && selection.clearingAccount && netTax !== 0) {
      if (selection.taxGroup) {
        warnings.push('The clearing transfer is not posted for a group run; run the transfer per company code.');
      } else {
        const [determination] = await tx.select().from(accountDetermination).where(and(
          eq(accountDetermination.client, input.client),
          eq(accountDetermination.chartOfAccounts, company.chartOfAccounts ?? ''),
          eq(accountDetermination.event, 'TAX'),
        ));
        if (!determination) {
          throw new TaxReportError(`Account determination for TAX does not stand in chart ${company.chartOfAccounts}.`);
        }
        const [type] = await tx.select().from(documentType).where(and(
          eq(documentType.client, input.client), eq(documentType.isActive, true),
        ));
        if (!type) throw new TaxReportError('No active document type stands for the clearing transfer.');
        const position = await derivePosition(tx, input.client, company.fiscalYearVariant!, to);
        const amount = Math.abs(netTax).toFixed(2);
        const taxLine = netTax > 0
          ? { glAccount: determination.glAccount, debitCredit: 'S' as const, amount }
          : { glAccount: determination.glAccount, debitCredit: 'H' as const, amount };
        const clearingLine = netTax > 0
          ? { glAccount: selection.clearingAccount, debitCredit: 'H' as const, amount }
          : { glAccount: selection.clearingAccount, debitCredit: 'S' as const, amount };
        const posted = await postJournalEntry(tx, {
          client: input.client, companyCode: selection.companyCode,
          documentType: type.documentType, documentDate: to, postingDate: to,
          fiscalYear: position.fiscalYear, postingPeriod: position.period,
          currency, localCurrency: currency,
          headerText: `Tax clearing ${from} to ${to}`,
          lines: [taxLine, clearingLine],
          postedBy: input.changedBy, transactionCode: TAX_REPORT_CAPABILITY,
        }).catch((error: unknown) => {
          if (error instanceof PostingError) throw new TaxReportError(`${error.message} ${error.remedy}`);
          throw error;
        });
        transferDocumentNumber = posted.documentNumber;
      }
    }

    if (isUpdate) {
      for (const row of reportable) {
        await tx.update(journalEntryLine).set({ taxReturnRunId: runId }).where(and(
          eq(journalEntryLine.client, input.client),
          eq(journalEntryLine.documentNumber, row.document_number),
          eq(journalEntryLine.fiscalYear, row.fiscal_year),
          eq(journalEntryLine.lineNumber, row.line_number),
        ));
      }
    }

    await tx.insert(taxReturnRun).values({
      client: input.client, runId, companyCode: selection.companyCode,
      taxGroup: selection.taxGroup ?? null,
      postingDateFrom: from, postingDateTo: to, taxReturnCountry: country,
      isTestRun: selection.testRun, doNotUpdateDocuments: selection.doNotUpdateDocuments,
      isCorrectedReturn: selection.correctedReturn, electronicReturn: selection.electronicReturn,
      clearingAccount: selection.clearingAccount ?? null,
      totalTaxBase: String(totalBase), totalInputTax: String(totalInput),
      totalOutputTax: String(totalOutput), netTax: String(netTax), currency,
      transferDocumentNumber, linesReported: isUpdate ? reportable.length : 0,
      createdBy: input.changedBy,
    });

    return {
      companies, postingDateFrom: from, postingDateTo: to, taxReturnCountry: country,
      lines, totalBase, totalInputTax: totalInput, totalOutputTax: totalOutput,
      netTax, currency, warnings,
      runId, transferDocumentNumber,
    };
  });
}

export async function listTaxReturnRuns(client: string) {
  return withTenant(client, async (tx) => tx.select().from(taxReturnRun)
    .where(eq(taxReturnRun.client, client))
    .orderBy(taxReturnRun.createdAt));
}
