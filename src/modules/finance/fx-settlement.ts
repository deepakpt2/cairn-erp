/**
 * Helpers shared by the settlement paths (incoming/outgoing payment, payment run, clearing).
 *
 * The accounting rule these encode: the bank moves at the payment date's rate, the receivable or
 * payable is relieved at the carrying amount it was posted with, and the difference is a realized
 * exchange gain or loss. A cash discount reduces the carrying amount at the invoice's own rate, so
 * the exchange difference is computed only on the cash actually applied.
 */
import { and, eq, sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { MONEY_SCALE, divideRound } from '../../platform/posting/decimal';
import type { ResolvedExchangeRate } from './exchange-rate-lookup';
import { translateAmount } from './exchange-rate-lookup';
import { accountDetermination, bankAccount } from '../foundation/schema';

/**
 * The local carrying amount attributable to a part of an open item, rounded to the local currency's
 * minor unit (stored at 4 decimals). The caller derives the remainder as `openLocal - released`, so
 * the parts conserve the carrying amount exactly and never acquire an unsupported fourth decimal.
 */
export function proportionalLocal(
  openLocal: bigint,
  openDocument: bigint,
  partDocument: bigint,
  localScale: number,
): bigint {
  if (openDocument === 0n || partDocument === 0n) return 0n;
  if (partDocument === openDocument) return openLocal;
  const minor = 10n ** BigInt(MONEY_SCALE - localScale);
  return divideRound(openLocal * partDocument, openDocument * minor) * minor;
}

/** Translate document units (at `documentScale`) into stored local units (always 4 decimals). */
export function localUnitsOf(
  documentUnits: bigint,
  documentScale: number,
  localScale: number,
  rate: ResolvedExchangeRate,
): bigint {
  return translateAmount(documentUnits, documentScale, localScale, rate) * 10n ** BigInt(MONEY_SCALE - localScale);
}

/** The FX difference account for an event (FXGAIN or FXLOSS), unmodified. */
export async function fxDifferenceAccount(
  tx: Tx,
  client: string,
  chart: string,
  event: 'FXGAIN' | 'FXLOSS',
): Promise<string | null> {
  const rows = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, chart),
    eq(accountDetermination.event, event),
  ));
  const row = rows.find((r) => r.valuationClass === '' && r.generalModifier === '')
    ?? rows.find((r) => r.valuationClass === '')
    ?? rows[0];
  return row?.glAccount ?? null;
}

export interface ActiveValuation {
  runId: string;
  valuationKeyDate: string;
  reversalDate: string | null;
}

/**
 * Serialize a company's FX valuation with every settlement/clearing path. A single transaction-scoped
 * advisory lock is enough: the guard and the posting can no longer interleave with a valuation run.
 * Tenant and company scope are part of the key.
 */
export async function lockValuationSettlement(
  tx: Tx,
  client: string,
  companyCode: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/fxvaluation/${companyCode}`}, 0))`);
}

/**
 * An open item or an account/currency balance that a period-end valuation had already adjusted **as
 * of the settlement date**. A valuation posted later does not affect an earlier settlement; a
 * valuation whose reversal is dated after the settlement date still does, because it was active when
 * the settlement was made. Counting it now would double-count the same difference, so the caller
 * refuses until the reversal is effective as of that date.
 */
export async function activeValuationConflict(
  tx: Tx,
  client: string,
  companyCode: string,
  source: {
    documentNumber?: string;
    lineNumber?: number;
    accountNumber?: string;
    currency?: string;
  },
  asOfDate: string,
): Promise<ActiveValuation | null> {
  const rows = (await tx.execute(sql`
    select r.run_id, r.valuation_key_date::text as valuation_key_date,
           (select rev.posting_date::text
              from journal_entry rev
             where rev.client = v.client and rev.document_number = v.reversed_by
               and rev.reversal_of = v.document_number
             order by rev.posting_date
             limit 1) as reversal_date
      from fx_valuation_item i
      join fx_valuation_run r on r.client = i.client and r.run_id = i.run_id
      join journal_entry v
        on v.client = i.client and v.document_number = r.posting_document_number
       and v.company_code = r.company_code
     where i.client = ${client}
       and r.company_code = ${companyCode}
       and i.status = 'POSTED'
       and r.posting_document_number is not null
       and v.posting_date <= ${asOfDate}
       and (
         v.status = 'POSTED'
         or (
           v.status = 'REVERSED'
           and not exists (
             select 1 from journal_entry rev
              where rev.client = v.client and rev.document_number = v.reversed_by
                and rev.reversal_of = v.document_number
                and rev.status = 'POSTED' and rev.posting_date <= ${asOfDate}
           )
         )
       )
       and (
         (i.source_kind = 'OPEN_ITEM' and i.source_document = ${source.documentNumber ?? null} and i.source_line = ${source.lineNumber ?? null})
         or
         (i.source_kind = 'BALANCE' and i.account_number = ${source.accountNumber ?? null} and i.currency = ${source.currency ?? null})
       )
     order by v.posting_date
     limit 1
  `)) as unknown as Array<{ run_id: string; valuation_key_date: string; reversal_date: string | null }>;
  if (!rows[0]) return null;
  return {
    runId: rows[0].run_id,
    valuationKeyDate: rows[0].valuation_key_date,
    reversalDate: rows[0].reversal_date,
  };
}

export type BankCurrencyVerdict =
  | { kind: 'none' }
  | { kind: 'unique'; currency: string }
  | { kind: 'ambiguous'; count: number };

/** Which bank account (if any) owns a G/L, and the currency it is held in. */
export async function bankCurrencyForGl(
  tx: Tx,
  client: string,
  companyCode: string,
  glAccount: string,
): Promise<BankCurrencyVerdict> {
  const rows = await tx.select({ currency: bankAccount.currency }).from(bankAccount).where(and(
    eq(bankAccount.client, client),
    eq(bankAccount.companyCode, companyCode),
    eq(bankAccount.glAccount, glAccount),
  ));
  if (rows.length === 0) return { kind: 'none' };
  // More than one bank account on the G/L is ambiguous even when both happen to share a currency:
  // the identity, not just the currency, is what the actual bank amount must be validated against.
  if (rows.length > 1) return { kind: 'ambiguous', count: rows.length };
  return { kind: 'unique', currency: String(rows[0]!.currency).trim().toUpperCase() };
}

/**
 * The supported bank-currency cases: the account is held in the payment (document) currency, or in
 * the company local currency. A third currency would need a per-line account-currency amount the
 * posting model does not carry, so it is refused rather than silently converted.
 */
export function bankCurrencyRefusal(
  localCurrency: string,
  documentCurrency: string,
  bankCurrency: string | null,
): string | null {
  if (!bankCurrency) return null;
  const bank = bankCurrency.trim().toUpperCase();
  if (bank === documentCurrency.trim().toUpperCase()) return null;
  if (bank === localCurrency.trim().toUpperCase()) return null;
  return `The bank account is held in ${bank}, which is neither the payment currency (${documentCurrency}) nor the company local currency (${localCurrency}).`;
}
