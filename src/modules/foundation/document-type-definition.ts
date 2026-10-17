import { asc, count, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { numberRange } from '../../platform/tables/numbering';
import { journalEntry } from '../finance/schema';
import { documentType } from './schema';

/**
 * OBA7 Define Document Types — the read side (SCR-038 stage 1).
 *
 * This activity differs from the define-screens before it: the table has
 * existed since the first schema, and every tenant's standard package
 * delivers the working set (SA, KR, KZ, DR, DZ, AB and the rest) into it.
 * What has never existed is a way to maintain them — the types have been
 * package data, edited by nobody, while journals post against them daily.
 *
 * The contract the owner settled (R-87): the key is exactly two characters,
 * enforced by the service (the column's twelve are the journal entry's own
 * width, not a licence); the number-range assignment is the reference
 * concept in this product's shape — the interval of the document number object, chosen
 * from the intervals the tenant has defined and validated to exist, rather
 * than a two-character field a working engine would have to be rebuilt
 * around; the account types are the letter set the posting engine reads,
 * offered as the five checkboxes the package draws (Assets, Customers,
 * Vendors, Materials, G/L) with at least one required; removal is both
 * deactivation (the type stops being offered to posting) and deletion,
 * refused while journal entries carry the type; delivered types get no
 * special protection.
 *
 * The usage count reads journal entries in the tenant, the way FTXP reads
 * its lines: a type history names stays defined, because a posted document
 * carrying a type nobody can look up is a document that cannot be read.
 */
export const ACTIVITY = 'CFG.FIN.DOCTYPE.DEFINE';

export interface DocumentTypeRow {
  documentType: string;
  name: string;
  numberRangeObject: string;
  numberRangeSubObject: string;
  /** The letter set, e.g. 'S', 'SK', 'SDM' — posting's vocabulary, as stored. */
  allowedAccountTypes: string;
  reversalMode: string;
  reversalDocumentType: string | null;
  requiresReference: boolean;
  requiresLineText: boolean;
  isActive: boolean;
  /** Journal entries in this tenant posted under this type. */
  usedByEntries: number;
}

export interface IntervalChoice {
  objectCode: string;
  subObject: string;
}

/** Every document type the tenant holds, beside the entries already posted under each. */
export async function listDocumentTypes(client: string): Promise<DocumentTypeRow[]> {
  return withTenant(client, async (tx) => {
    const [types, usage] = await Promise.all([
      tx
        .select()
        .from(documentType)
        .where(eq(documentType.client, client))
        .orderBy(asc(documentType.documentType)),
      tx
        .select({ documentType: journalEntry.documentType, entries: count() })
        .from(journalEntry)
        .where(eq(journalEntry.client, client))
        .groupBy(journalEntry.documentType),
    ]);

    const usedBy = new Map(usage.map((row) => [row.documentType, Number(row.entries)]));

    return types.map((row) => ({
      documentType: row.documentType,
      name: row.name,
      numberRangeObject: row.numberRangeObject,
      numberRangeSubObject: row.numberRangeSubObject,
      allowedAccountTypes: row.allowedAccountTypes,
      reversalMode: row.reversalMode,
      reversalDocumentType: row.reversalDocumentType,
      requiresReference: row.requiresReference,
      requiresLineText: row.requiresLineText,
      isActive: row.isActive,
      usedByEntries: usedBy.get(row.documentType) ?? 0,
    }));
  });
}

/**
 * The number-range intervals the tenant has defined, object by sub-object —
 * the value help for the assignment, and the list a write is judged against.
 */
export async function listIntervalChoices(client: string): Promise<IntervalChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .selectDistinct({ objectCode: numberRange.objectCode, subObject: numberRange.subObject })
      .from(numberRange)
      .where(eq(numberRange.client, client))
      .orderBy(asc(numberRange.objectCode), asc(numberRange.subObject));
    return rows;
  });
}
