/**
 * Internal order line items (KOB1): read-only actual postings to one internal order.
 *
 * A sibling of `src/modules/production/order-cost-report.ts`, mirroring its shapes and judgements:
 * only POSTED and REVERSED documents (a parked document is not yet a fact), reversal links carried
 * on every line, totals per (company, document currency, local currency), and a `gaps` list of what
 * the report cannot show. Deliberate differences from the template:
 *   - The capability is checked here, before anything is read, not only on the page.
 *   - The read joins `journal_entry_line` to `journal_entry` directly (same join and status filter
 *     as `production_order_actual_posting_v`): a view would be a schema change.
 *   - A net in the order's own currency is stated only when every line's local currency is the
 *     order's currency; otherwise it is null and the gap names the currencies.
 * Writes nothing.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { hasCapability } from '../../platform/auth/session';
import { INTERNAL_ORDER_COST_DISPLAY_CAPABILITY } from '../../platform/auth/capability-policy';

export const INTERNAL_ORDER_COST_REPORT_CAPABILITY = INTERNAL_ORDER_COST_DISPLAY_CAPABILITY;
export const INTERNAL_ORDER_COST_REPORT_ROUTE = '/controlling/internal-order-line-items';
export const INTERNAL_ORDER_MAINTAIN_ROUTE = '/controlling/internal-orders';

export class InternalOrderCostReportError extends Error {
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'InternalOrderCostReportError';
    this.remedy = remedy;
  }
}

export interface InternalOrderCostReportInput {
  client: string;
  /** What the caller holds. Checked before anything is read. */
  heldCapabilities: readonly string[];
  orderNumber: string;
  fiscalYear?: number | string;
  periodFrom?: number | string;
  periodTo?: number | string;
  /** Optional: restrict to one cost element (G/L account), as KOB1 does. */
  glAccount?: string;
}

export interface InternalOrderCostLine {
  companyCode: string;
  documentNumber: string;
  displayNumber: string;
  fiscalYear: number;
  documentType: string;
  documentDate: string;
  postingDate: string;
  postingPeriod: number;
  documentCurrency: string;
  localCurrency: string;
  status: 'POSTED' | 'REVERSED';
  reversalOf: string | null;
  reversedBy: string | null;
  originClass: string | null;
  originKey: string | null;
  lineNumber: number;
  glAccount: string;
  debitCredit: 'S' | 'H';
  amountDocument: string;
  amountLocal: string;
  lineCurrency: string;
  material: string | null;
  plant: string | null;
  lineText: string | null;
}

export interface InternalOrderCostCurrencyTotal {
  companyCode: string;
  documentCurrency: string;
  localCurrency: string;
  debitDocument: string;
  creditDocument: string;
  netDocument: string;
  debitLocal: string;
  creditLocal: string;
  netLocal: string;
}

export interface InternalOrderCostReport {
  order: {
    orderNumber: string;
    orderType: string;
    description: string;
    companyCode: string;
    controllingArea: string;
    currency: string;
    startDate: string;
    endDate: string;
    costCenter: string | null;
    profitCenter: string | null;
    statistical: boolean;
    markedForDeletion: boolean;
    isPostingLocked: boolean;
  };
  filter: {
    fiscalYear: number | null;
    periodFrom: number | null;
    periodTo: number | null;
    glAccount: string | null;
  };
  lines: InternalOrderCostLine[];
  totals: InternalOrderCostCurrencyTotal[];
  /** Net in the order's own currency, or null when it cannot be stated. */
  netInOrderCurrency: string | null;
  gaps: string[];
}

export function holdsInternalOrderCostReportAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], INTERNAL_ORDER_COST_REPORT_CAPABILITY);
}

function clean(value: string | number | undefined): string {
  return value == null ? '' : String(value).trim();
}

function integer(value: string | number | undefined, label: string, min: number, max: number): number | null {
  const raw = clean(value);
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) throw new InternalOrderCostReportError(`${label} "${raw}" must be a whole number.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new InternalOrderCostReportError(`${label} ${raw} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function signed(amount: string, side: 'S' | 'H'): bigint {
  const parsed = toScaled(amount);
  return side === 'S' ? parsed : -parsed;
}

type TotalAccumulator = {
  companyCode: string;
  documentCurrency: string;
  localCurrency: string;
  debitDocument: bigint;
  creditDocument: bigint;
  netDocument: bigint;
  debitLocal: bigint;
  creditLocal: bigint;
  netLocal: bigint;
};

function makeTotals(lines: InternalOrderCostLine[]): InternalOrderCostCurrencyTotal[] {
  const totals = new Map<string, TotalAccumulator>();
  for (const line of lines) {
    const key = `${line.companyCode}|${line.documentCurrency}|${line.localCurrency}`;
    let total = totals.get(key);
    if (!total) {
      total = {
        companyCode: line.companyCode,
        documentCurrency: line.documentCurrency,
        localCurrency: line.localCurrency,
        debitDocument: 0n,
        creditDocument: 0n,
        netDocument: 0n,
        debitLocal: 0n,
        creditLocal: 0n,
        netLocal: 0n,
      };
      totals.set(key, total);
    }
    const document = toScaled(line.amountDocument);
    const local = toScaled(line.amountLocal);
    if (line.debitCredit === 'S') {
      total.debitDocument += document;
      total.debitLocal += local;
    } else {
      total.creditDocument += document;
      total.creditLocal += local;
    }
    total.netDocument += signed(line.amountDocument, line.debitCredit);
    total.netLocal += signed(line.amountLocal, line.debitCredit);
  }
  return [...totals.values()].map((total) => ({
    companyCode: total.companyCode,
    documentCurrency: total.documentCurrency,
    localCurrency: total.localCurrency,
    debitDocument: fromScaled(total.debitDocument),
    creditDocument: fromScaled(total.creditDocument),
    netDocument: fromScaled(total.netDocument),
    debitLocal: fromScaled(total.debitLocal),
    creditLocal: fromScaled(total.creditLocal),
    netLocal: fromScaled(total.netLocal),
  }));
}

export async function getInternalOrderCostReport(
  input: InternalOrderCostReportInput,
): Promise<InternalOrderCostReport> {
  // Authority first: an unauthorised caller learns nothing, not even whether the order exists.
  if (!holdsInternalOrderCostReportAuthority(input.heldCapabilities ?? [])) {
    throw new InternalOrderCostReportError(
      `You do not hold ${INTERNAL_ORDER_COST_REPORT_CAPABILITY}.`,
      `Ask an administrator to grant ${INTERNAL_ORDER_COST_REPORT_CAPABILITY} by name; a broad role pattern does not grant it.`,
    );
  }

  const orderNumber = clean(input.orderNumber);
  if (!input.client?.trim()) throw new InternalOrderCostReportError('A tenant is required.');
  if (!orderNumber) throw new InternalOrderCostReportError('Enter an internal order number.');
  if (orderNumber.length > 20) {
    throw new InternalOrderCostReportError(`Internal order number ${orderNumber} is longer than 20 characters.`);
  }

  const fiscalYear = integer(input.fiscalYear, 'Fiscal year', 1000, 9999);
  const periodFrom = integer(input.periodFrom, 'Period from', 1, 16);
  const periodTo = integer(input.periodTo, 'Period to', 1, 16);
  if ((periodFrom !== null || periodTo !== null) && fiscalYear === null) {
    throw new InternalOrderCostReportError('Choose a fiscal year before filtering by period.');
  }
  if (periodFrom !== null && periodTo !== null && periodFrom > periodTo) {
    throw new InternalOrderCostReportError(`Period from (${periodFrom}) is later than period to (${periodTo}).`);
  }
  const glAccount = clean(input.glAccount) || null;
  if (glAccount !== null && glAccount.length > 10) {
    throw new InternalOrderCostReportError(`G/L account ${glAccount} is longer than 10 characters.`);
  }

  return withTenant(input.client, async (tx) => {
    const [order] = await tx.execute(sql`
      select order_number, order_type, description, company_code, controlling_area, currency,
             start_date::text as start_date, end_date::text as end_date, cost_center, profit_center,
             statistical, marked_for_deletion, is_posting_locked
        from internal_order
       where client = ${input.client} and order_number = ${orderNumber}
       limit 1
    `) as unknown as Array<{
      order_number: string;
      order_type: string;
      description: string;
      company_code: string;
      controlling_area: string;
      currency: string;
      start_date: string;
      end_date: string;
      cost_center: string | null;
      profit_center: string | null;
      statistical: boolean;
      marked_for_deletion: boolean;
      is_posting_locked: boolean;
    }>;
    if (!order) {
      throw new InternalOrderCostReportError(
        `Internal order ${orderNumber} does not stand in this tenant.`,
        `Check the number at ${INTERNAL_ORDER_MAINTAIN_ROUTE}; no other tenant was searched.`,
      );
    }

    const rows = await tx.execute(sql`
      select j.company_code, j.document_number, j.display_number, j.fiscal_year::int as fiscal_year,
             j.document_type, j.document_date::text as document_date, j.posting_date::text as posting_date,
             j.posting_period::int as posting_period, j.document_currency, j.local_currency,
             j.status as document_status, j.reversal_of, j.reversed_by, j.origin_class, j.origin_key,
             l.line_number::int as line_number, l.gl_account, l.debit_credit,
             l.amount_document::text as amount_document, l.amount_local::text as amount_local,
             l.currency as line_currency, l.material, l.plant, l.line_text
        from journal_entry_line l
        join journal_entry j
          on j.client = l.client and j.document_number = l.document_number and j.fiscal_year = l.fiscal_year
       where l.client = ${input.client}
         and l.internal_order = ${orderNumber}
         and j.status in ('POSTED', 'REVERSED')
         and (${fiscalYear}::int is null or j.fiscal_year = ${fiscalYear})
         and (${periodFrom}::int is null or j.posting_period >= ${periodFrom})
         and (${periodTo}::int is null or j.posting_period <= ${periodTo})
         and (${glAccount}::text is null or l.gl_account = ${glAccount})
       order by j.posting_date, j.document_number, l.line_number
    `) as unknown as Array<{
      company_code: string;
      document_number: string;
      display_number: string;
      fiscal_year: number;
      document_type: string;
      document_date: string;
      posting_date: string;
      posting_period: number;
      document_currency: string;
      local_currency: string;
      document_status: string;
      reversal_of: string | null;
      reversed_by: string | null;
      origin_class: string | null;
      origin_key: string | null;
      line_number: number;
      gl_account: string;
      debit_credit: string;
      amount_document: string;
      amount_local: string;
      line_currency: string;
      material: string | null;
      plant: string | null;
      line_text: string | null;
    }>;

    const lines: InternalOrderCostLine[] = rows.map((row) => {
      if (row.debit_credit !== 'S' && row.debit_credit !== 'H') {
        throw new InternalOrderCostReportError(`Journal line ${row.document_number}/${row.line_number} has an unsupported debit/credit marker.`);
      }
      if (row.document_status !== 'POSTED' && row.document_status !== 'REVERSED') {
        throw new InternalOrderCostReportError(`Journal document ${row.document_number} has unsupported status ${row.document_status}.`);
      }
      return {
        companyCode: row.company_code.trim(),
        documentNumber: row.document_number,
        displayNumber: row.display_number.trim() || row.document_number,
        fiscalYear: Number(row.fiscal_year),
        documentType: row.document_type.trim(),
        documentDate: row.document_date,
        postingDate: row.posting_date,
        postingPeriod: Number(row.posting_period),
        documentCurrency: row.document_currency.trim(),
        localCurrency: row.local_currency.trim(),
        status: row.document_status,
        reversalOf: row.reversal_of,
        reversedBy: row.reversed_by,
        originClass: row.origin_class,
        originKey: row.origin_key,
        lineNumber: Number(row.line_number),
        glAccount: row.gl_account.trim(),
        debitCredit: row.debit_credit,
        amountDocument: row.amount_document,
        amountLocal: row.amount_local,
        lineCurrency: row.line_currency.trim(),
        material: row.material?.trim() || null,
        plant: row.plant?.trim() || null,
        lineText: row.line_text,
      };
    });

    const orderCurrency = order.currency.trim();
    const orderCompany = order.company_code.trim();
    const gaps: string[] = [
      'Actual postings only: documents with status POSTED or REVERSED. Parked documents, commitments (KOB2), plan and budget are not shown.',
      'One internal order at a time. Selecting several orders at once, as KOB1 allows, is not offered.',
    ];

    // Net in the order's currency: only when every line's local currency is the order's currency.
    const foreign = [...new Set(lines.map((line) => line.localCurrency).filter((c) => c !== orderCurrency))].sort();
    let netInOrderCurrency: string | null = null;
    if (foreign.length === 0) {
      netInOrderCurrency = fromScaled(lines.reduce((sum, line) => sum + signed(line.amountLocal, line.debitCredit), 0n));
    } else {
      gaps.push(
        `No net in order currency ${orderCurrency} is stated: lines carry local currency ${foreign.join(', ')}`
        + ` as well as or instead of ${orderCurrency}, and no conversion is made. See the totals per currency.`,
      );
    }

    if (lines.some((line) => line.lineCurrency !== line.documentCurrency)) {
      gaps.push('A journal line currency differs from its document currency. Both stored values are shown without conversion.');
    }
    if (lines.some((line) => line.companyCode !== orderCompany)) {
      gaps.push(`A journal line belongs to a company other than the order's company ${orderCompany}. No line was silently excluded.`);
    }
    // A reversal may fall in another fiscal year, so the pair is matched on document number alone.
    const listed = new Set(lines.map((line) => line.documentNumber));
    const reversedOutside = [...new Set(lines
      .filter((line) => line.reversedBy && !listed.has(line.reversedBy))
      .map((line) => `${line.documentNumber} (reversed by ${line.reversedBy})`))];
    const reversalOutside = [...new Set(lines
      .filter((line) => line.reversalOf && !listed.has(line.reversalOf))
      .map((line) => `${line.documentNumber} (reversal of ${line.reversalOf})`))];
    if (reversedOutside.length || reversalOutside.length) {
      gaps.push(
        `The other half of a reversal pair is outside this selection: ${[...reversedOutside, ...reversalOutside].join('; ')}.`
        + ' The totals count only the documents listed.',
      );
    }
    if (lines.length === 0) {
      gaps.push('No posted or reversed journal lines cite this order for the selected filter.');
    }

    return {
      order: {
        orderNumber: order.order_number,
        orderType: order.order_type.trim(),
        description: order.description,
        companyCode: orderCompany,
        controllingArea: order.controlling_area.trim(),
        currency: orderCurrency,
        startDate: order.start_date,
        endDate: order.end_date,
        costCenter: order.cost_center?.trim() || null,
        profitCenter: order.profit_center?.trim() || null,
        statistical: Boolean(order.statistical),
        markedForDeletion: Boolean(order.marked_for_deletion),
        isPostingLocked: Boolean(order.is_posting_locked),
      },
      filter: { fiscalYear, periodFrom, periodTo, glAccount },
      lines,
      totals: makeTotals(lines),
      netInOrderCurrency,
      gaps,
    };
  });
}
