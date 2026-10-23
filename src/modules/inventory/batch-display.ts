/**
 * Display batch. MSC3N is a search alias only.
 *
 * This reads the batch row MSC1N created and MSC2N changes. It does not
 * write a second master, and it does not post. ZUSTD is the restricted-use
 * indicator, not 1 or 2. The date of manufacture is HSDAT, not HERDT.
 * Deletion, classification, and inspection lots are not stored.
 * This screen does not show stock. The pick-up list is MB5C.
 */
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { readBatch, BatchChangeError, type BatchChangeRow } from './batch-change';

export const ACTIVITY = 'INV.BATCH.DISPLAY';
export const ROUTE = '/inventory/batches/display';
export const ALIASES = ['MSC3N'] as const;

export class BatchDisplayError extends Error {
  readonly code: 'COMPANY_REFUSED';

  constructor(message: string, code: BatchDisplayError['code'], readonly remedy?: string) {
    super(message);
    this.name = 'BatchDisplayError';
    this.code = code;
  }
}

export interface BatchDisplayHistoryItem {
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface BatchDisplayHistory {
  changeType: string;
  transactionCode: string | null;
  reason: string | null;
  changedBy: string;
  changedAt: string;
  items: BatchDisplayHistoryItem[];
}

export interface BatchDisplay extends BatchChangeRow {
  createdBy: string | null;
  createdAt: string | null;
  changedBy: string | null;
  changedAt: string | null;
  statusLabel: string;
  deletionStored: false;
  classificationStored: false;
  history: BatchDisplayHistory[];
}

export function batchStatusLabel(row: Pick<BatchChangeRow, 'restrictedUse' | 'statusApplies'>): string {
  if (!row.statusApplies) return 'Status management is not effective. No indicator is stored. It is not 1 or 2.';
  if (row.restrictedUse === 'X') return 'X — restricted. Not the number 2.';
  if (row.restrictedUse === '') return 'Blank — unrestricted. Not the number 1.';
  return 'The restricted-use indicator is unset. It is not 1 or 2.';
}

function when(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export async function displayBatch(input: {
  client: string;
  materialNumber: string;
  plant?: string;
  batchNumber: string;
  companyCode?: string;
}): Promise<BatchDisplay | null> {
  if (input.companyCode?.trim()) {
    throw new BatchDisplayError(
      'A company code is not a batch key. Nothing was read by company code.',
      'COMPANY_REFUSED',
      'Open the batch by material, and by plant only when the batch level is plant.',
    );
  }
  const row = await readBatch(input);
  if (!row) return null;
  return withTenant(input.client, async (tx) => {
    const audit = await tx.execute(sql`
      select created_by, created_at, changed_by, changed_at
      from batch
      where client = ${input.client} and id = ${row.id}
      limit 1
    `) as unknown as Array<{
      created_by: string | null;
      created_at: Date | string | null;
      changed_by: string | null;
      changed_at: Date | string | null;
    }>;
    const documents = await changeHistory(tx, input.client, 'batch', row.id, 20);
    return {
      ...row,
      createdBy: audit[0]?.created_by ?? null,
      createdAt: when(audit[0]?.created_at),
      changedBy: audit[0]?.changed_by ?? null,
      changedAt: when(audit[0]?.changed_at),
      statusLabel: batchStatusLabel(row),
      deletionStored: false,
      classificationStored: false,
      history: documents.map((document) => ({
        changeType: document.changeType,
        transactionCode: document.transactionCode,
        reason: document.reason ?? null,
        changedBy: document.changedBy,
        changedAt: when(document.changedAt) ?? '',
        items: document.items.map((item) => ({
          fieldName: item.fieldName,
          oldValue: item.oldValue,
          newValue: item.newValue,
        })),
      })),
    };
  });
}

export { BatchChangeError };
