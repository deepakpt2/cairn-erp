/**
 * Vendor ageing analysis — SCR-066 / R-114, derivation repaired
 * SCR-120 / R-169 (S_ALR_87012085 as a search alias only).
 *
 * Read-only. Standing reconstructs as of the key date over the
 * shared ageing derivation: only lines standing on the company's
 * VENDORS reconciliation accounts age (customer receivable lines
 * and stray partner lines never did belong here), special G/L
 * items join when selected, and due dates come from the origin
 * invoice's baseline plus its payment terms through the canonical
 * payment-term service. Amounts aggregate in company-code
 * currency. Nothing posts here.
 */
import { withTenant } from '../../platform/db/client';
import {
  AgeingDerivationError, aggregateAgeingPartners, deriveAgeingItems,
  validateAgeingSelection, type AgeingSort,
} from './ageing-derivation';

export const VENDOR_AGEING_CAPABILITY = 'FIN.AP.AGEING';

export class VendorAgeingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'VendorAgeingError';
    this.remedy = remedy;
  }
}

export interface AgeingItem {
  supplier: string;
  supplierName: string;
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

export interface AgeingSupplierRow {
  supplier: string;
  supplierName: string;
  itemCount: number;
  buckets: [number, number, number, number, number];
  total: number;
}

export interface VendorAgeingView {
  companyCode: string;
  keyDate: string;
  currency: string;
  thresholds: [number, number, number];
  suppliers: AgeingSupplierRow[];
  totals: [number, number, number, number, number];
  grandTotal: number;
  items: AgeingItem[];
}

export type { AgeingSort };

export async function getVendorAgeing(client: string, input: {
  companyCode: string; keyDate: string;
  supplierFrom?: string; supplierTo?: string;
  thresholds?: [number, number, number];
  includeSpecialGl?: boolean;
  sort?: AgeingSort;
}): Promise<VendorAgeingView> {
  const thresholds = input.thresholds ?? [30, 60, 90];
  if (input.supplierFrom && input.supplierTo && input.supplierFrom > input.supplierTo) {
    throw new VendorAgeingError(
      `Supplier range ${input.supplierFrom} to ${input.supplierTo} runs backwards.`,
      'Give the lower supplier number first.',
    );
  }
  try {
    validateAgeingSelection({ keyDate: input.keyDate, thresholds });
    return await withTenant(client, async (tx) => {
      const { currency, items } = await deriveAgeingItems(tx, client, {
        side: 'AP',
        companyCode: input.companyCode,
        keyDate: input.keyDate,
        partnerFrom: input.supplierFrom,
        partnerTo: input.supplierTo,
        thresholds,
        includeSpecialGl: input.includeSpecialGl,
        sort: input.sort,
      });
      const { partners, totals, grandTotal } = aggregateAgeingPartners(items);
      return {
        companyCode: input.companyCode, keyDate: input.keyDate, currency, thresholds,
        suppliers: partners.map((row) => ({
          supplier: row.partner, supplierName: row.partnerName, itemCount: row.itemCount,
          buckets: row.buckets, total: row.total,
        })),
        totals, grandTotal,
        items: items.map((item) => ({
          supplier: item.partner, supplierName: item.partnerName,
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
      throw new VendorAgeingError(error.message, error.remedy);
    }
    throw error;
  }
}
