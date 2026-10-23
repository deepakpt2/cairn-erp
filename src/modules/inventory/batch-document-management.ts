/**
 * Activate document management for batches. ODOC is a search alias only.
 *
 * Verified from SAP release 4.6C onward, program SAPMOMBE screen 0500,
 * table TCUCD. The business field is KZDCD, data element KZDCD, domain
 * CHAR1, length 1, no value table and no search help. The same program
 * stores its other CHAR1 activation as X or blank, so X is active and
 * blank is not active. A missing row is not active.
 *
 * Activation shows a documents tab on the batch master. Deactivation
 * hides that tab. Batches, documents, and links are not deleted.
 * This screen does not create a document info record. CV01N is not here.
 * MB56, MB57, and MB5C are not here.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { batchDocumentManagement } from './schema';

export const ACTIVITY = 'CFG.INV.BATCHDOCMGMT.DEFINE';
export const ROUTE = '/config/batch-document-management';
export const ALIAS = 'ODOC';
export const LOCK_OBJECT = 'BATCH_DOCUMENT_MANAGEMENT';
const OBJECT_CLASS = 'batch_document_management';

export const NOT_EXECUTED = [
  {
    field: 'CV01N',
    title: 'Document info record',
    reason: 'No document info record is created. DRAW is not this screen.',
  },
  {
    field: 'DRAD',
    title: 'Object link',
    reason: 'No batch-document link is stored. Removing a link is not available.',
  },
  {
    field: 'MB56',
    title: 'Batch where-used',
    reason: 'Genealogy is not this screen. MB57 and MB5C are not this screen.',
  },
  {
    field: 'UPLOAD',
    title: 'File content',
    reason: 'No file is uploaded. No storage path is stored.',
  },
] as const;

export class BatchDocumentError extends Error {
  readonly code: string;
  readonly remedy: string;

  constructor(message: string, code: string, remedy: string) {
    super(message);
    this.name = 'BatchDocumentError';
    this.code = code;
    this.remedy = remedy;
  }
}

export type DocumentManagementCode = 'X' | null;

export interface DocumentManagementRow {
  code: DocumentManagementCode;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
}

export interface SaveDocumentManagementInput {
  client: string;
  changedBy: string;
  documentManagement: string;
  version: number;
  reason: string;
  requestKey?: string;
  transportRequest?: string;
  postingPeriod?: string;
  companyCode?: string;
  plant?: string;
  documentType?: string;
  fileName?: string;
  whereUsed?: boolean;
}

function codeOf(raw: string): DocumentManagementCode {
  const text = raw.trim().toUpperCase();
  if (text === '' || text === 'BLANK') return null;
  if (text === 'X') return 'X';
  throw new BatchDocumentError(
    `Document management ${text} is refused. Active is X. Not active is blank.`,
    'CODE_UNKNOWN',
    'Do not store 1. The domain has no fixed-value list. This screen uses X or blank.',
  );
}

function stored(code: DocumentManagementCode): 'X' | ' ' {
  return code === 'X' ? 'X' : ' ';
}

function reasonOf(value: string): string {
  const text = value?.trim() ?? '';
  if (text.length < 3 || text.length > 500) {
    throw new BatchDocumentError('A reason is required.', 'REASON_REQUIRED', 'Say why the indicator is being saved.');
  }
  return text;
}

function refuseExtras(input: SaveDocumentManagementInput): void {
  if (input.transportRequest?.trim()) {
    throw new BatchDocumentError('A transport is refused. ODOC does not write a transport request.', 'TRANSPORT_REFUSED', 'Save this client only.');
  }
  if (input.postingPeriod?.trim()) {
    throw new BatchDocumentError('A posting period is refused. A closed period does not block this screen.', 'PERIOD_REFUSED', 'Leave the period empty.');
  }
  if (input.companyCode?.trim()) {
    throw new BatchDocumentError('A company code is refused. The indicator is for this client.', 'COMPANY_REFUSED', 'Do not send a company code.');
  }
  if (input.plant?.trim()) {
    throw new BatchDocumentError('A plant is refused. The indicator is not a plant setting.', 'PLANT_REFUSED', 'Leave the plant empty.');
  }
  if (input.documentType?.trim() || input.fileName?.trim()) {
    throw new BatchDocumentError(
      'A document type or a file is refused. ODOC does not create a document.',
      'DOCUMENT_REFUSED',
      'Save the indicator only. CV01N is not this screen.',
    );
  }
  if (input.whereUsed) {
    throw new BatchDocumentError(
      'Batch where-used is refused. MB56 is not this screen.',
      'GENEALOGY_REFUSED',
      'Do not open genealogy from ODOC.',
    );
  }
}

function present(row: {
  documentManagement: string;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
} | null): DocumentManagementRow {
  return {
    code: row?.documentManagement === 'X' ? 'X' : null,
    version: row?.version ?? 0,
    changedBy: row?.changedBy ?? null,
    changedAt: row?.changedAt ?? null,
  };
}

async function lockRow(tx: Tx, client: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${client}), hashtext('BATCH_DOCUMENT_MANAGEMENT'))`);
}

async function readRow(tx: Tx, client: string) {
  const rows = await tx.select().from(batchDocumentManagement)
    .where(eq(batchDocumentManagement.client, client))
    .limit(1);
  return rows[0] ?? null;
}

export async function documentManagementActive(client: string): Promise<boolean> {
  const current = await getBatchDocumentManagement(client);
  return current.code === 'X';
}

export async function getBatchDocumentManagement(client: string): Promise<DocumentManagementRow> {
  const key = client?.trim() ?? '';
  if (!key) throw new BatchDocumentError('The tenant is missing.', 'CLIENT_REQUIRED', 'Sign in again.');
  return withTenant(key, async (tx) => present(await readRow(tx, key)));
}

export async function saveBatchDocumentManagement(input: SaveDocumentManagementInput): Promise<DocumentManagementRow> {
  refuseExtras(input);
  const client = input.client?.trim() ?? '';
  const changedBy = input.changedBy?.trim() ?? '';
  if (!client || !changedBy) {
    throw new BatchDocumentError('The tenant or the acting user is missing.', 'CLIENT_REQUIRED', 'Sign in again.');
  }
  const next = codeOf(input.documentManagement);
  const requestKey = input.requestKey?.trim() || null;
  const reason = reasonOf(input.reason);
  return withTenant(client, async (tx) => {
    await lockRow(tx, client);
    const current = await readRow(tx, client);
    const currentCode: DocumentManagementCode = current?.documentManagement === 'X' ? 'X' : null;
    if (current && requestKey && current.lastRequestKey === requestKey) {
      if (currentCode !== next) {
        throw new BatchDocumentError(
          'This request key already saved a different indicator. The indicator was not changed.',
          'REQUEST_REPLAY',
          'Start a new save.',
        );
      }
      return present(current);
    }
    if (!current) {
      if (input.version !== 0) {
        throw new BatchDocumentError(
          'The indicator was not opened at this version. Nothing was saved.',
          'VERSION_STALE',
          'Open the screen again. The first save sends version 0.',
        );
      }
    } else if (current.version !== input.version) {
      throw new BatchDocumentError(
        'The indicator changed before this save. Nothing was saved.',
        'VERSION_STALE',
        'Open the screen again. A batch was not changed.',
      );
    }
    if (current && currentCode === next) return present(current);
    const now = new Date();
    const after = stored(next);
    if (!current) {
      await tx.insert(batchDocumentManagement).values({
        client,
        documentManagement: after,
        version: 1,
        lastRequestKey: requestKey,
        createdBy: changedBy,
        changedBy,
        createdAt: now,
        changedAt: now,
      });
    } else {
      const saved = await tx.update(batchDocumentManagement).set({
        documentManagement: after,
        version: current.version + 1,
        lastRequestKey: requestKey,
        changedBy,
        changedAt: now,
      }).where(and(
        eq(batchDocumentManagement.client, client),
        eq(batchDocumentManagement.version, current.version),
      )).returning();
      if (saved.length !== 1) {
        throw new BatchDocumentError(
          'The indicator changed before this save. Nothing was saved.',
          'VERSION_STALE',
          'Open the screen again.',
        );
      }
    }
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: client,
      changeType: current ? 'CHANGE' : 'CREATE',
      changedBy,
      transactionCode: ALIAS,
      reason,
      correlationId: requestKey ?? undefined,
      before: current ? { documentManagement: currentCode ?? ' ', version: current.version } : undefined,
      after: { documentManagement: next ?? ' ', version: current ? current.version + 1 : 1, documentsDeleted: false },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return present(await readRow(tx, client));
  });
}

export function linkBatchDocument(): never {
  throw new BatchDocumentError(
    'A document link was not saved. ODOC does not maintain document info records.',
    'LINK_NOT_AVAILABLE',
    'The documents tab is a view of the indicator. CV01N is not this screen. No file was stored.',
  );
}
