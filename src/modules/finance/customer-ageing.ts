/**
 * Customer ageing analysis — SCR-070 / R-118, derivation repaired
 * SCR-120 / R-169 (S_ALR_87012178 as a search alias only).
 *
 * Read-only mirror of vendor ageing over the shared derivation:
 * only lines standing on the company's CUSTOMERS reconciliation
 * accounts age, special G/L items join when selected, and due
 * dates come from the origin invoice's baseline plus its payment
 * terms through the canonical payment-term service. Amounts
 * aggregate in company-code currency. Nothing posts here.
 */
import { withTenant } from '../../platform/db/client';
import {
  AgeingDerivationError, aggregateAgeingPartners, deriveAgeingItems,
  validateAgeingSelection, type AgeingSort,
} from './ageing-derivation';

export const CUSTOMER_AGEING_CAPABILITY = 'FIN.AR.AGEING';

export class CustomerAgeingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CustomerAgeingError';
    this.remedy = remedy;
  }
}

export interface AgeingItem {
  customer: string;
  customerName: string;
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  documentType: string;
  postingDate: string;
  documentDate: string;
  baselineDate: string | null;
  dueDate: string;
  daysOverdue: number;
  bucket: number; // 0 = not yet due, 1..4 = overdue buckets
  currency: string;
  amount: string;
  documentAmount: string;
  signed: number;
  specialGlIndicator: string | null;
  paymentTerms: string | null;
  clearingDocument: string | null;
  clearingDate: string | null;
}

export interface AgeingCustomerRow {
  customer: string;
  customerName: string;
  itemCount: number;
  buckets: [number, number, number, number, number];
  total: number;
}

export interface CustomerAgeingView {
  companyCode: string;
  keyDate: string;
  currency: string;
  thresholds: [number, number, number];
  customers: AgeingCustomerRow[];
  totals: [number, number, number, number, number];
  grandTotal: number;
  items: AgeingItem[];
}

export type { AgeingSort };

export async function getCustomerAgeing(client: string, input: {
  companyCode: string; keyDate: string;
  customerFrom?: string; customerTo?: string;
  thresholds?: [number, number, number];
  includeSpecialGl?: boolean;
  sort?: AgeingSort;
}): Promise<CustomerAgeingView> {
  const thresholds = input.thresholds ?? [30, 60, 90];
  if (input.customerFrom && input.customerTo && input.customerFrom > input.customerTo) {
    throw new CustomerAgeingError(
      `Customer range ${input.customerFrom} to ${input.customerTo} runs backwards.`,
      'Give the lower customer number first.',
    );
  }
  try {
    validateAgeingSelection({ keyDate: input.keyDate, thresholds });
    return await withTenant(client, async (tx) => {
      const { currency, items } = await deriveAgeingItems(tx, client, {
        side: 'AR',
        companyCode: input.companyCode,
        keyDate: input.keyDate,
        partnerFrom: input.customerFrom,
        partnerTo: input.customerTo,
        thresholds,
        includeSpecialGl: input.includeSpecialGl,
        sort: input.sort,
      });
      const { partners, totals, grandTotal } = aggregateAgeingPartners(items);
      return {
        companyCode: input.companyCode, keyDate: input.keyDate, currency, thresholds,
        customers: partners.map((row) => ({
          customer: row.partner, customerName: row.partnerName, itemCount: row.itemCount,
          buckets: row.buckets, total: row.total,
        })),
        totals, grandTotal,
        items: items.map((item) => ({
          customer: item.partner, customerName: item.partnerName,
          documentNumber: item.documentNumber, fiscalYear: item.fiscalYear,
          lineNumber: item.lineNumber, documentType: item.documentType,
          postingDate: item.postingDate, documentDate: item.documentDate,
          baselineDate: item.baselineDate, dueDate: item.dueDate,
          daysOverdue: item.daysOverdue, bucket: item.bucket,
          currency: item.currency, amount: item.amount,
          documentAmount: item.documentAmount, signed: item.signed,
          specialGlIndicator: item.specialGlIndicator,
          paymentTerms: item.paymentTerms,
          clearingDocument: item.clearingDocument, clearingDate: item.clearingDate,
        })),
      };
    });
  } catch (error) {
    if (error instanceof AgeingDerivationError) {
      throw new CustomerAgeingError(error.message, error.remedy);
    }
    throw error;
  }
}
