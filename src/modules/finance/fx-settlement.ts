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

/** The local carrying amount attributable to a part of an open item, rounded once at 4 decimals. */
export function proportionalLocal(
  openLocal: bigint,
  openDocument: bigint,
  partDocument: bigint,
): bigint {
  if (openDocument === 0n || partDocument === 0n) return 0n;
  if (partDocument === openDocument) return openLocal;
  return divideRound(openLocal * partDocument, openDocument);
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
}

/**
 * An open item or an account/currency balance that an active (not reversed) period-end valuation
 * has already adjusted. Settling it now would count the same difference twice, so the caller refuses
 * until the valuation document is reversed.
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
): Promise<ActiveValuation | null> {
  const rows = (await tx.execute(sql`
    select r.run_id, r.valuation_key_date::text as valuation_key_date
      from fx_valuation_item i
      join fx_valuation_run r on r.client = i.client and r.run_id = i.run_id
      left join journal_entry e
        on e.client = i.client and e.document_number = i.posting_document and e.fiscal_year = r.fiscal_year
     where i.client = ${client}
       and r.company_code = ${companyCode}
       and i.status = 'POSTED'
       and r.status <> 'REVERSED'
       and (e.document_number is null or e.status = 'POSTED')
       and (
         (i.source_kind = 'OPEN_ITEM' and i.source_document = ${source.documentNumber ?? null} and i.source_line = ${source.lineNumber ?? null})
         or
         (i.source_kind = 'BALANCE' and i.account_number = ${source.accountNumber ?? null} and i.currency = ${source.currency ?? null})
       )
     limit 1
  `)) as unknown as Array<{ run_id: string; valuation_key_date: string }>;
  if (!rows[0]) return null;
  return { runId: rows[0].run_id, valuationKeyDate: rows[0].valuation_key_date };
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
  const currencies = [...new Set(rows.map((r) => String(r.currency).trim().toUpperCase()))];
  if (currencies.length > 1) return { kind: 'ambiguous', count: rows.length };
  return { kind: 'unique', currency: currencies[0]! };
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
