import { sql, type SQL } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { toScaled } from '../../platform/posting/decimal';
import { journalEntryLine } from './schema';

/**
 * Settlement applications and the balances they produce.
 *
 * The source identity is the immutable journal document number (`company/year/number`),
 * which is what a payment or down-payment clearing writes into `Settles <document>` /
 * `Applied from <document>`. It encodes company and fiscal year, so it is unambiguous.
 *
 * Four distinct balances are derived here; they are not interchangeable:
 *
 *  1. Open invoice liability = invoice amount − valid applications/settlements.
 *  2. Available advance credit = advance amount − valid applications/settlements.
 *  3. Payable/collectible = open invoice liability − unapplied payment credits.
 *  4. Ageing balance = the open invoice liability as of a key date.
 *
 * A *valid* application is one whose clearing was not reset and whose journal is posted and
 * not a reversal mirror. Resetting a clearing (FBRA) lifts the stamps and undoes the
 * application: it no longer reduces the liability or the advance, and its counter-line is an
 * unapplied credit. Reversing a journal is a separate event and is excluded by its status.
 *
 * An unapplied **payment** credit is cash that left the bank but no longer settles the item:
 * a reset payment's counter-line, still open. It offsets the payable so the item is not paid
 * twice. An unapplied **advance** does not: a special G/L advance is applied only by an
 * explicit clearing, so an unapplied advance stays available and does not reduce the payable.
 */
export class SettlementNettingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'SettlementNettingError';
    this.remedy = remedy;
  }
}

interface LineRef {
  documentNumber: string;
  companyCode: string;
  businessPartner: string | null;
  glAccount: string;
  currency: string;
  debitCredit: string;
}

/** Document classes that post cash settlement counter-lines. */
const PAYMENT_ORIGIN_CLASSES = sql`side_header.origin_class in ('incoming_payment', 'outgoing_payment', 'payment_run')`;

const refOfSide = {
  client: sql`side.client`,
  company: sql`side.company_code`,
  document: sql`side.document_number`,
  fiscalYear: sql`side.fiscal_year`,
};

function resetEffectiveBy(asOf: string | undefined): SQL {
  return asOf
    ? sql`coalesce(
          (select min(rev.posting_date)
             from journal_entry orig
             join journal_entry rev
               on rev.client = orig.client
              and rev.document_number = orig.reversed_by
              and rev.reversal_of = orig.document_number
              and rev.status = 'POSTED'
            where orig.client = cr.client
              and orig.document_number = cr.clearing_document
              and orig.fiscal_year = cr.fiscal_year),
          cr.created_at::date
        ) <= ${asOf}`
    : sql`true`;
}

/** `not exists (clearing_reset for this line's document)`, date-aware when `asOf` is given. */
function notResetSql(asOf: string | undefined, ref: {
  client: SQL; company: SQL; document: SQL; fiscalYear: SQL;
}): SQL {
  return sql`not exists (
    select 1 from clearing_reset cr
     where cr.client = ${ref.client}
       and cr.company_code = ${ref.company}
       and cr.clearing_document = ${ref.document}
       and cr.fiscal_year = ${ref.fiscalYear}
       and ${resetEffectiveBy(asOf)}
  )`;
}

/** `exists (clearing_reset for this line's document)`, date-aware when `asOf` is given. */
function resetExistsSql(asOf: string | undefined, ref: {
  client: SQL; company: SQL; document: SQL; fiscalYear: SQL;
}): SQL {
  return sql`exists (
    select 1 from clearing_reset cr
     where cr.client = ${ref.client}
       and cr.company_code = ${ref.company}
       and cr.clearing_document = ${ref.document}
       and cr.fiscal_year = ${ref.fiscalYear}
       and ${resetEffectiveBy(asOf)}
  )`;
}

/**
 * Sum of the **valid** applications naming the outer line (document or local currency).
 * Used for the open invoice liability and the available advance.
 */
export function validApplicationSql(value: 'document' | 'local', asOf?: string): SQL {
  const amount = value === 'document' ? sql`side.amount_document` : sql`side.amount_local`;
  const postedBy = asOf ? sql`and side_header.posting_date <= ${asOf}` : sql``;
  return sql`(
    select coalesce(sum(${amount}), 0)::text
      from journal_entry_line side
      join journal_entry side_header
        on side_header.client = side.client
       and side_header.document_number = side.document_number
       and side_header.fiscal_year = side.fiscal_year
     where side.client = ${journalEntryLine.client}
       and side.company_code = ${journalEntryLine.companyCode}
       and side.business_partner = ${journalEntryLine.businessPartner}
       and side.gl_account = ${journalEntryLine.glAccount}
       and side.currency = ${journalEntryLine.currency}
       and side.debit_credit <> ${journalEntryLine.debitCredit}
       and side_header.status = 'POSTED'
       and side_header.reversal_of is null
       ${postedBy}
       and side.line_text in (
         concat('Settles ', ${journalEntryLine.documentNumber}),
         concat('Applied from ', ${journalEntryLine.documentNumber})
       )
       and ${notResetSql(asOf, refOfSide)}
  )`;
}

/**
 * Sum of the **unapplied payment credits** naming the outer line: counter-lines of a reset
 * payment (cash still out) that remain open. These offset the payable; an unapplied advance
 * is not included because a special G/L advance is applied only by an explicit clearing.
 */
export function unappliedPaymentCreditSql(value: 'document' | 'local', asOf?: string): SQL {
  const amount = value === 'document' ? sql`side.amount_document` : sql`side.amount_local`;
  const postedBy = asOf ? sql`and side_header.posting_date <= ${asOf}` : sql``;
  return sql`(
    select coalesce(sum(${amount}), 0)::text
      from journal_entry_line side
      join journal_entry side_header
        on side_header.client = side.client
       and side_header.document_number = side.document_number
       and side_header.fiscal_year = side.fiscal_year
     where side.client = ${journalEntryLine.client}
       and side.company_code = ${journalEntryLine.companyCode}
       and side.business_partner = ${journalEntryLine.businessPartner}
       and side.gl_account = ${journalEntryLine.glAccount}
       and side.currency = ${journalEntryLine.currency}
       and side.debit_credit <> ${journalEntryLine.debitCredit}
       and side_header.status = 'POSTED'
       and side_header.reversal_of is null
       and side.clearing_document is null
       ${postedBy}
       and side.line_text in (
         concat('Settles ', ${journalEntryLine.documentNumber}),
         concat('Applied from ', ${journalEntryLine.documentNumber})
       )
       and ${PAYMENT_ORIGIN_CLASSES}
       and ${resetExistsSql(asOf, refOfSide)}
  )`;
}

export interface ApplicationLineExclusionOptions {
  /**
   * Ageing's rule (the default): a reset application's counter-line stays visible, because a
   * reset **payment** is cash that left the bank and remains an unapplied credit. Consumers that
   * already net that credit into the source line through `unappliedPaymentCreditSql`, or that
   * treat a reset clearing as fully undone, pass `false` so the counter-line is not counted twice.
   */
  keepResetOffsets?: boolean;
}

/**
 * Excludes a settlement-application line: its text names a source line and the source exists
 * with the same partner/account/currency and the opposite direction.
 *
 * By default (ageing's rule) a **reset** counter-line is kept visible as an unapplied credit.
 * With `keepResetOffsets: false` it is excluded as well, which is what an open-item consumer
 * needs when it has already netted the reset into the source (a reset payment credit), or when a
 * reset down-payment clearing simply leaves no cash behind.
 */
export function notValidApplicationLineSql(
  asOf?: string,
  options: ApplicationLineExclusionOptions = {},
): SQL {
  const resetGuard = options.keepResetOffsets === false ? sql`` : sql`and ${notResetSql(asOf, {
    client: sql`${journalEntryLine.client}`, company: sql`${journalEntryLine.companyCode}`,
    document: sql`${journalEntryLine.documentNumber}`, fiscalYear: sql`${journalEntryLine.fiscalYear}`,
  })}`;
  return sql`not (
    (${journalEntryLine.lineText} like 'Settles %' or ${journalEntryLine.lineText} like 'Applied from %')
    and exists (
      select 1 from journal_entry_line src
      join journal_entry src_header
        on src_header.client = src.client
       and src_header.document_number = src.document_number
       and src_header.fiscal_year = src.fiscal_year
      where src.client = ${journalEntryLine.client}
        and src.company_code = ${journalEntryLine.companyCode}
        and src.business_partner = ${journalEntryLine.businessPartner}
        and src.gl_account = ${journalEntryLine.glAccount}
        and src.currency = ${journalEntryLine.currency}
        and src.debit_credit <> ${journalEntryLine.debitCredit}
        and src_header.status = 'POSTED'
        and src_header.reversal_of is null
        and src.document_number = case
          when ${journalEntryLine.lineText} like 'Settles %'
            then substring(${journalEntryLine.lineText} from 9)
          else substring(${journalEntryLine.lineText} from 14)
        end
    )
    ${resetGuard}
  )`;
}

/**
 * Excludes an invalid (reset) counter-line from a status calculation. Unlike
 * `notValidApplicationLineSql` this does not require the source line to still exist: the
 * down-payment clearing views use it to stop a reset application from reducing the advance.
 */
export function notResetOffsetLineSql(): SQL {
  return notResetSql(undefined, {
    client: sql`${journalEntryLine.client}`, company: sql`${journalEntryLine.companyCode}`,
    document: sql`${journalEntryLine.documentNumber}`, fiscalYear: sql`${journalEntryLine.fiscalYear}`,
  });
}

/**
 * Transaction-scoped form of the same rule for posting paths that must recompute the eligible
 * amount inside their own transaction. Returns scaled amounts at MONEY_SCALE:
 *  - `liability` is the open invoice liability,
 *  - `paymentCredit` is the unapplied payment credit that offsets the payable.
 */
export async function openItemBalances(
  tx: Tx, client: string, line: LineRef,
): Promise<{
  liability: { document: bigint; local: bigint };
  paymentCredit: { document: bigint; local: bigint };
}> {
  const rows = (await tx.execute(sql`
    select
      coalesce(sum(case when ${notResetSql(undefined, refOfSide)}
        then side.amount_document else 0 end), 0)::text as liability_document,
      coalesce(sum(case when ${notResetSql(undefined, refOfSide)}
        then side.amount_local else 0 end), 0)::text as liability_local,
      coalesce(sum(case when ${resetExistsSql(undefined, refOfSide)}
        and side.clearing_document is null and ${PAYMENT_ORIGIN_CLASSES}
        then side.amount_document else 0 end), 0)::text as payment_credit_document,
      coalesce(sum(case when ${resetExistsSql(undefined, refOfSide)}
        and side.clearing_document is null and ${PAYMENT_ORIGIN_CLASSES}
        then side.amount_local else 0 end), 0)::text as payment_credit_local
      from journal_entry_line side
      join journal_entry side_header
        on side_header.client = side.client
       and side_header.document_number = side.document_number
       and side_header.fiscal_year = side.fiscal_year
     where side.client = ${client}
       and side.company_code = ${line.companyCode}
       and side.business_partner = ${line.businessPartner}
       and side.gl_account = ${line.glAccount}
       and side.currency = ${line.currency}
       and side.debit_credit <> ${line.debitCredit}
       and side_header.status = 'POSTED'
       and side_header.reversal_of is null
        and side.line_text in (
         concat('Settles ', cast(${line.documentNumber} as text)),
         concat('Applied from ', cast(${line.documentNumber} as text))
       )
  `)) as unknown as Array<{
    liability_document: string; liability_local: string;
    payment_credit_document: string; payment_credit_local: string;
  }>;
  const row = rows[0];
  return {
    liability: {
      document: toScaled(row?.liability_document ?? '0'),
      local: toScaled(row?.liability_local ?? '0'),
    },
    paymentCredit: {
      document: toScaled(row?.payment_credit_document ?? '0'),
      local: toScaled(row?.payment_credit_local ?? '0'),
    },
  };
}
