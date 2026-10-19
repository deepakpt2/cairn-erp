/**
 * GR/IR clearing account analysis — SCR-099 / R-147 (F.19 as a
 * search alias only).
 *
 * Stage 1 vocabulary. The analysis service lands in stage 3.
 */
export const GRIR_RECLASS_CAPABILITY = 'FIN.GRIR.RECLASS';

export class GrIrReclassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrIrReclassError';
  }
}

export interface GrIrSelection {
  companyCode: string;
  keyDate: string;
  purchaseOrderFrom?: string;
  purchaseOrderTo?: string;
  postingDateFrom?: string;
  postingDateTo?: string;
  displayVariant?: string;
  testRun: boolean;
  createAccruals: boolean;
  postingDate?: string;
  reversalDate?: string;
  accrualDocumentType?: string;
  accrualAccount?: string;
  requestKey: string;
}

export type GrIrClassification =
  | 'RECONCILED' | 'GOODS_RECEIVED_NOT_INVOICED' | 'INVOICED_NOT_RECEIVED'
  | 'QUANTITY_DIFFERENCE' | 'VALUE_DIFFERENCE';

export type GrIrItemStatus = 'ANALYZED' | 'ACCRUED' | 'SKIPPED' | 'ERROR';

export interface GrIrItem {
  itemNumber: number;
  purchaseOrder: string;
  purchaseOrderItem: number;
  vendor: string;
  material: string | null;
  plant: string;
  currency: string;
  orderedQuantity: number;
  receivedQuantity: number;
  invoicedQuantity: number;
  openQuantity: number;
  receivedValue: number;
  invoicedValue: number;
  openValue: number;
  classification: GrIrClassification;
  accrualAmount: number;
  status: GrIrItemStatus;
  error: string | null;
  accrualDocument: string | null;
}

export interface GrIrResult {
  runId: string;
  status: 'TEST' | 'COMPLETED' | 'REVERSED';
  companyCode: string;
  keyDate: string;
  fiscalYear: number;
  items: GrIrItem[];
  totalOpenValue: number;
  totalAccrualAmount: number;
  accrualDocument: string | null;
  reversalDocument: string | null;
  warnings: string[];
}
