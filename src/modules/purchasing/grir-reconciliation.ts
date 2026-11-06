/**
 * GR/IR reconciliation — the exceptions that need a person.
 *
 * A GR/IR balance is not an error. Goods arrive before the invoice often
 * enough that an open balance is the ordinary state of a healthy purchase
 * order, and clearing it by hand every month would be an industry of its
 * own. What needs a person is the balance that no longer explains itself:
 * the one that is still standing after procurement said it had finished.
 *
 * So this worklist reads the position the postings actually made — the
 * same residuals the clearing screen judges, from the same function — and
 * says which of them are ordinary and which are not. It writes nothing.
 * It clears nothing, adjusts nothing, reverses nothing and reclassifies
 * nothing: a balance that turns out to be wrong is put right through the
 * posting, authorization and reversal machinery that already exists, not
 * by a report that decided it knew better.
 *
 * Two indicators do the work of telling an expected balance from an
 * unexplained one, and neither of them is an accounting posting:
 *
 *   * delivery completed says no more goods are coming. A balance of
 *     received-not-yet-invoiced is then waiting for the invoice, which is
 *     expected; once the invoice is final too, the same balance has no
 *     business still standing there.
 *
 *   * the final invoice indicator says no more invoices are coming. A
 *     balance of invoiced-not-yet-received is then goods that have not
 *     arrived, and it stays visible until they do. It is never netted off
 *     to make a report look tidier.
 */
import { listGrIrResiduals, type GrIrResidual, type GrIrSelection } from './grir-clearing';

export const GRIR_RECONCILIATION_CAPABILITY = 'PROC.GRIR.RECONCILE';
export const GRIR_RECONCILIATION_ROUTE = '/purchasing/grir-reconciliation';
export const GRIR_RECONCILIATION_ALIASES = ['F.13', 'MR11analysis'] as const;

export type GrIrExceptionCategory =
  /** Neither delivery nor invoicing is finished, so the balance is still moving on its own. */
  | 'EXPECTED_OUTSTANDING'
  /** Procurement said it had finished, and the account still carries a balance. */
  | 'COMPLETED_WITH_RESIDUAL'
  /** More invoiced than received: the goods have still to come, and the balance waits for them. */
  | 'INVOICE_BEFORE_GR'
  /** Quantities agree but value stands — a price or timing difference, not a quantity one. */
  | 'VALUE_VARIANCE'
  /** The position cannot be stated from the postings, so nobody may act on a guess. */
  | 'UNRESOLVED';

export interface GrIrExceptionRow {
  companyCode: string;
  plant: string;
  supplier: string;
  orderNumber: string;
  itemNumber: number;
  materialNumber: string | null;
  shortText: string;
  unit: string;
  currency: string;
  orderedQuantity: number;
  receivedQuantity: number;
  invoicedQuantity: number;
  /** Goods still to come, against the quantity ordered. */
  outstandingGrQuantity: number;
  /** What may still be invoiced, judged by the item's own invoice basis. */
  outstandingInvoiceQuantity: number;
  deliveryCompleted: boolean;
  finalInvoiceIndicator: boolean;
  invoiceBasis: 'GOODS_RECEIPT' | 'ORDERED_QUANTITY';
  /** The balance the account actually carries, after any clearing already posted. */
  grIrBalance: number;
  /** What the postings would have left, before any clearing was applied. */
  postedBalance: number;
  /** Cleared so far by GR/IR maintenance, so the two figures above reconcile. */
  clearedToDate: number;
  category: GrIrExceptionCategory;
  /** Why the row is listed, and what it would take to make it go away. */
  reason: string;
  /** Where to look next. Empty where the documents cannot be named. */
  documents: {
    goodsReceipts: string[];
    invoices: string[];
    clearings: string[];
  };
  grIrAccount: string | null;
  /** Set where the position cannot be stated at all, so nobody acts on a guess. */
  refusal: string | null;
}

export interface GrIrReconciliationTotals {
  rows: number;
  /** Absolute value still standing on the account, in document currency. */
  balance: number;
  byCategory: Record<GrIrExceptionCategory, number>;
}

export interface GrIrReconciliationResult {
  rows: GrIrExceptionRow[];
  totals: GrIrReconciliationTotals;
}

const QTY = 1e-6;
const MONEY = 0.005;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Why a row stands on the worklist.
 *
 * The order matters: an invoice that arrived before its goods is reported as
 * that, whatever the indicators say, because the remedy is the goods and not
 * a clearing. Only then does "procurement has finished" turn an ordinary
 * balance into an exception.
 */
function classify(row: GrIrResidual): { category: GrIrExceptionCategory; reason: string } {
  if (row.refusal) {
    return {
      category: 'UNRESOLVED',
      reason: `The position cannot be stated: ${row.refusal}`,
    };
  }
  if (row.invoicedQuantity > row.receivedQuantity + QTY) {
    return {
      category: 'INVOICE_BEFORE_GR',
      reason: row.finalInvoiceIndicator
        ? 'Invoiced ahead of the goods, and no further invoice is expected. The balance stands '
          + 'until the goods arrive; it is not cleared away because procurement finished invoicing.'
        : 'Invoiced ahead of the goods. The balance stands until the goods arrive.',
    };
  }
  if (row.deliveryCompleted || row.finalInvoiceIndicator) {
    const which = row.deliveryCompleted && row.finalInvoiceIndicator
      ? 'Delivery is complete and the invoice is final'
      : row.deliveryCompleted
        ? 'Delivery is complete'
        : 'The invoice is final';
    return {
      category: 'COMPLETED_WITH_RESIDUAL',
      reason: `${which}, and the account still carries ${Math.abs(row.remaining).toFixed(2)} `
        + `${row.currency}. Nothing clears it on its own: ${row.surplus === 'DELIVERY'
          ? 'post the invoice that is still owed, or clear the balance through GR/IR maintenance'
            + ' where it is genuinely not recoverable'
          : 'receive the goods, or clear the balance through GR/IR maintenance where they will'
            + ' never arrive'}.`,
    };
  }
  if (Math.abs(row.openQuantity) <= QTY && Math.abs(row.remaining) > MONEY) {
    return {
      category: 'VALUE_VARIANCE',
      reason: `Goods and invoice agree on quantity but ${Math.abs(row.remaining).toFixed(2)} `
        + `${row.currency} still stands, which is a price or timing difference rather than a `
        + 'quantity one. It does not resolve itself by waiting for an invoice.',
    };
  }
  return {
    category: 'EXPECTED_OUTSTANDING',
    reason: `Goods and invoice stand ${Math.abs(row.openQuantity).toFixed(3)} ${row.unit} apart and `
      + 'neither delivery nor invoicing is finished, so the balance is expected to move on its own. '
      + 'It is listed because it holds money, not because anything is wrong.',
  };
}

export async function listGrIrExceptions(
  input: { client: string } & GrIrSelection & { categories?: GrIrExceptionCategory[] },
): Promise<GrIrReconciliationResult> {
  const residuals = await listGrIrResiduals({
    client: input.client,
    companyFrom: input.companyFrom,
    companyTo: input.companyTo,
    orderFrom: input.orderFrom,
    orderTo: input.orderTo,
    itemNumber: input.itemNumber,
    plantFrom: input.plantFrom,
    plantTo: input.plantTo,
    keyDate: input.keyDate,
    surplus: input.surplus,
  });

  const rows: GrIrExceptionRow[] = [];
  for (const residual of residuals) {
    const { category, reason } = classify(residual);
    if (input.categories && input.categories.length > 0 && !input.categories.includes(category)) continue;

    // What may still be invoiced follows the item's own basis, the same way the
    // invoice screen judges it: against what was received, or against what was
    // ordered where the order says the invoice need not wait for the goods.
    const basis = residual.invoiceBasis === 'GOODS_RECEIPT'
      ? residual.receivedQuantity - residual.invoicedQuantity
      : residual.orderedQuantity - residual.invoicedQuantity;

    rows.push({
      companyCode: residual.companyCode,
      plant: residual.plant,
      supplier: residual.supplier,
      orderNumber: residual.orderNumber,
      itemNumber: residual.itemNumber,
      materialNumber: residual.materialNumber,
      shortText: residual.shortText,
      unit: residual.unit,
      currency: residual.currency,
      orderedQuantity: residual.orderedQuantity,
      receivedQuantity: residual.receivedQuantity,
      invoicedQuantity: residual.invoicedQuantity,
      outstandingGrQuantity: round3(Math.max(residual.orderedQuantity - residual.receivedQuantity, 0)),
      outstandingInvoiceQuantity: round3(Math.max(basis, 0)),
      deliveryCompleted: residual.deliveryCompleted,
      finalInvoiceIndicator: residual.finalInvoiceIndicator,
      invoiceBasis: residual.invoiceBasis,
      grIrBalance: residual.remaining,
      postedBalance: residual.grIrValue,
      clearedToDate: round2(residual.grIrValue - residual.remaining),
      category,
      reason,
      documents: residual.documents,
      grIrAccount: residual.grIrAccount,
      refusal: residual.refusal,
    });
  }

  rows.sort((a, b) => (
    Math.abs(b.grIrBalance) - Math.abs(a.grIrBalance)
    || a.orderNumber.localeCompare(b.orderNumber)
    || a.itemNumber - b.itemNumber
  ));

  const byCategory: Record<GrIrExceptionCategory, number> = {
    COMPLETED_WITH_RESIDUAL: 0, INVOICE_BEFORE_GR: 0, VALUE_VARIANCE: 0,
    EXPECTED_OUTSTANDING: 0, UNRESOLVED: 0,
  };
  for (const row of rows) byCategory[row.category] += 1;

  return {
    rows,
    totals: {
      rows: rows.length,
      balance: round2(rows.reduce((sum, row) => sum + Math.abs(row.grIrBalance), 0)),
      byCategory,
    },
  };
}
