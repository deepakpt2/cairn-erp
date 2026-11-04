/**
 * Read-only production-order actual posting report.
 * Monetary amounts come only from posted journal lines assigned to the order.
 * Confirmation activity quantities are deliberately not valued with plan rates.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { hasCapability } from '../../platform/auth/session';
import { PRODUCTION_ORDER_COST_DISPLAY_CAPABILITY } from '../../platform/auth/capability-policy';

export const PRODUCTION_ORDER_COST_REPORT_CAPABILITY = PRODUCTION_ORDER_COST_DISPLAY_CAPABILITY;
export const PRODUCTION_ORDER_COST_REPORT_ROUTE = '/production/order-cost-report';

export class ProductionOrderCostReportError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'ProductionOrderCostReportError';
  }
}

export interface ProductionOrderCostReportInput {
  client: string;
  orderNumber: string;
  fiscalYear?: number | string;
  periodFrom?: number | string;
  periodTo?: number | string;
}

export interface ProductionOrderCostLine {
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

export interface ProductionOrderCostCurrencyTotal {
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

export interface ProductionOrderCostReport {
  order: {
    orderNumber: string;
    materialNumber: string;
    plant: string;
    orderType: string | null;
    status: string;
    companyCode: string | null;
    controllingArea: string | null;
    currency: string | null;
  };
  filter: { fiscalYear: number | null; periodFrom: number | null; periodTo: number | null };
  lines: ProductionOrderCostLine[];
  totals: ProductionOrderCostCurrencyTotal[];
  gaps: string[];
}

export function holdsProductionOrderCostReportAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], PRODUCTION_ORDER_COST_REPORT_CAPABILITY);
}

function clean(value: string | number | undefined): string {
  return value == null ? '' : String(value).trim();
}

function integer(value: string | number | undefined, label: string, min: number, max: number): number | null {
  const raw = clean(value);
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) throw new ProductionOrderCostReportError(`${label} must be a whole number.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ProductionOrderCostReportError(`${label} must be between ${min} and ${max}.`);
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

function makeTotals(lines: ProductionOrderCostLine[]): ProductionOrderCostCurrencyTotal[] {
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

export async function getProductionOrderCostReport(
  input: ProductionOrderCostReportInput,
): Promise<ProductionOrderCostReport> {
  const orderNumber = clean(input.orderNumber);
  if (!input.client?.trim()) throw new ProductionOrderCostReportError('A tenant is required.');
  if (!orderNumber) throw new ProductionOrderCostReportError('Enter a production order number.');
  if (orderNumber.length > 12) throw new ProductionOrderCostReportError('The production order number is too long.');

  const fiscalYear = integer(input.fiscalYear, 'Fiscal year', 1000, 9999);
  const periodFrom = integer(input.periodFrom, 'Period from', 1, 16);
  const periodTo = integer(input.periodTo, 'Period to', 1, 16);
  if ((periodFrom !== null || periodTo !== null) && fiscalYear === null) {
    throw new ProductionOrderCostReportError('Choose a fiscal year before filtering by period.');
  }
  if (periodFrom !== null && periodTo !== null && periodFrom > periodTo) {
    throw new ProductionOrderCostReportError('Period from must not be after period to.');
  }

  return withTenant(input.client, async (tx) => {
    const [order] = await tx.execute(sql`
      select order_number, material_number, plant, order_type, status,
             company_code, controlling_area, currency
        from production_order
       where client = ${input.client} and order_number = ${orderNumber}
       limit 1
    `) as unknown as Array<{
      order_number: string;
      material_number: string;
      plant: string;
      order_type: string | null;
      status: string;
      company_code: string | null;
      controlling_area: string | null;
      currency: string | null;
    }>;
    if (!order) {
      throw new ProductionOrderCostReportError(
        `Production order ${orderNumber} does not stand in this tenant.`,
        'Choose an order from this tenant; no other tenant was searched.',
      );
    }

    const rows = await tx.execute(sql`
      select company_code, document_number, display_number, fiscal_year::int as fiscal_year,
             document_type, document_date::text as document_date, posting_date::text as posting_date,
             posting_period::int as posting_period, document_currency, local_currency,
             document_status, reversal_of, reversed_by, origin_class, origin_key,
             line_number::int as line_number, gl_account, debit_credit,
             amount_document::text as amount_document, amount_local::text as amount_local,
             line_currency, material, plant, line_text
        from production_order_actual_posting_v
       where client = ${input.client}
         and order_number = ${orderNumber}
         and (${fiscalYear}::int is null or fiscal_year = ${fiscalYear})
         and (${periodFrom}::int is null or posting_period >= ${periodFrom})
         and (${periodTo}::int is null or posting_period <= ${periodTo})
       order by fiscal_year, posting_period, posting_date, document_number, line_number
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

    const lines: ProductionOrderCostLine[] = rows.map((row) => {
      if (row.debit_credit !== 'S' && row.debit_credit !== 'H') {
        throw new ProductionOrderCostReportError(`Journal line ${row.document_number}/${row.line_number} has an unsupported debit/credit marker.`);
      }
      if (row.document_status !== 'POSTED' && row.document_status !== 'REVERSED') {
        throw new ProductionOrderCostReportError(`Journal document ${row.document_number} has unsupported status ${row.document_status}.`);
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

    const gaps: string[] = [
      'Amounts are posted journal actuals only. Confirmation activity quantities are not monetarily valued.',
      'Plan activity rates are not treated as actual costs. WIP and variance categorization are not calculated.',
      'Material-document values are drilldown evidence and are not added again to journal amounts.',
    ];
    if (!order.company_code?.trim() || !order.currency?.trim()) {
      gaps.push('The order has no stored company code or currency. No company or currency was inferred.');
    }
    if (lines.some((line) => line.lineCurrency !== line.documentCurrency)) {
      gaps.push('A journal line currency differs from its document currency. Both stored values are shown without conversion.');
    }
    if (order.company_code && lines.some((line) => line.companyCode !== order.company_code)) {
      gaps.push('A journal line company code differs from the order snapshot. No line was silently excluded.');
    }
    if (lines.length === 0) gaps.push('No posted or reversed journal lines cite this order for the selected period.');

    return {
      order: {
        orderNumber: order.order_number,
        materialNumber: order.material_number.trim(),
        plant: order.plant.trim(),
        orderType: order.order_type?.trim() || null,
        status: order.status,
        companyCode: order.company_code?.trim() || null,
        controllingArea: order.controlling_area?.trim() || null,
        currency: order.currency?.trim() || null,
      },
      filter: { fiscalYear, periodFrom, periodTo },
      lines,
      totals: makeTotals(lines),
      gaps,
    };
  });
}
