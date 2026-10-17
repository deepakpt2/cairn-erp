import { z } from 'zod';
import { and, asc, count, eq, inArray } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
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

/**
 * OBA7 — maintain the document types (SCR-038 stage 3).
 *
 * Three writes in the OBBO/OB08 shape: create-or-change, activate-or-
 * deactivate, and delete. The rules the owner settled shape them (R-87).
 *
 * The **key is exactly two characters** and immutable: the screen says which
 * of create or change it is doing, and renaming a type means defining the
 * new one and, where the old should not stand, deleting or deactivating it.
 *
 * The **number-range interval must exist** among the intervals defined for
 * its object: a type pointing at an interval nobody defined posts documents
 * nobody can number, and the readiness rules would only discover it at
 * posting time. The reverse document type, where one is named, must stand
 * in the same tenant (a type may name itself). The account types are the
 * letter set posting reads, normalized to the canonical order so two
 * screens cannot store the same permission two ways.
 *
 * Removal is **both halves the owner chose**: deactivation, which stops
 * the type being offered to posting while history keeps reading it, and
 * deletion, refused while journal entries in the tenant carry the type —
 * journal entries store the type, and a type they name stays readable.
 *
 * A **reason is mandatory on every write**, one change document per write
 * with the account types and the interval security-relevant: together they
 * decide what may be posted under a type and where its number comes from.
 */
export const OBJECT_CLASS = 'document_type';
const PREREQUISITES = ['CFG.PLT.NUMBERRANGE.DEFINE'] as const;

/** Posting's account-kind vocabulary in its canonical order. */
export const ACCOUNT_TYPE_LETTERS = ['A', 'D', 'K', 'M', 'S'] as const;

export const REVERSAL_MODES = ['REVERSE_AND_ALT_DATE', 'REVERSE_ONLY', 'NO_REVERSE'] as const;

export const documentTypeValuesSchema = z.object({
  mode: z.enum(['CREATE', 'CHANGE']),
  documentType: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{2}$/, 'The Document Type is exactly two letters or digits.')),
  name: z.string().trim().min(1, 'A description is required.').max(120, 'The description is at most 120 characters.'),
  numberRangeObject: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9_.-]{1,40}$/, 'The number range object is up to forty letters, digits, underscores or dots.')),
  numberRangeSubObject: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9_*.-]{1,24}$/, 'The number range interval is up to twenty-four letters, digits, underscores or dots.')),
  allowedAccountTypes: z
    .array(z.enum(ACCOUNT_TYPE_LETTERS))
    .min(1, 'At least one account type must be allowed.')
    .transform((letters) => ACCOUNT_TYPE_LETTERS.filter((letter) => letters.includes(letter)).join('')),
  reversalMode: z.enum(REVERSAL_MODES),
  /** An empty reverse type means the type reverses under itself. */
  reversalDocumentType: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value.toUpperCase()))
    .pipe(z.string().regex(/^[A-Z0-9]{2}$/, 'The Reverse Document Type is exactly two letters or digits.').nullable()),
  requiresReference: z.boolean(),
  requiresLineText: z.boolean(),
  reason: z.string().trim().min(1, 'A reason is required.').max(500, 'The reason is at most 500 characters.'),
});

const actorFields = {
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
};

export const documentTypeInputSchema = documentTypeValuesSchema.extend(actorFields).strict();
export type DocumentTypeInput = z.input<typeof documentTypeInputSchema>;

export const documentTypeDeleteInputSchema = z.object({
  ...actorFields,
  documentType: documentTypeValuesSchema.shape.documentType,
  reason: documentTypeValuesSchema.shape.reason,
}).strict();
export type DocumentTypeDeleteInput = z.input<typeof documentTypeDeleteInputSchema>;

export const documentTypeActiveInputSchema = documentTypeDeleteInputSchema.extend({
  active: z.boolean(),
}).strict();
export type DocumentTypeActiveInput = z.input<typeof documentTypeActiveInputSchema>;

export class DocumentTypeError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the document type and try again.',
  ) {
    super(message);
    this.name = 'DocumentTypeError';
  }
}

export interface DocumentTypeSaveResult {
  changed: boolean;
  documentType: string;
  /** Journal entries in the tenant posted under the type at the moment of the write. */
  usedByEntries: number;
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

async function assertPrerequisites(tx: Tx, client: string): Promise<void> {
  const rows = await tx
    .select({ activityCode: configActivityStatus.activityCode })
    .from(configActivityStatus)
    .where(and(
      eq(configActivityStatus.client, client),
      inArray(configActivityStatus.activityCode, [...PREREQUISITES]),
      eq(configActivityStatus.status, 'COMPLETED'),
    ));
  const completed = new Set(rows.map((row) => row.activityCode));
  const missing = PREREQUISITES.filter((code) => !completed.has(code));
  if (missing.length > 0) {
    throw new DocumentTypeError(
      `Document type prerequisites are incomplete: ${missing.join(', ')}.`,
      'Define number ranges in the configuration workbench first: a document type draws its numbers from an interval, and there is nothing to assign until intervals exist.',
    );
  }
}

async function countEntries(tx: Tx, client: string, code: string): Promise<number> {
  const [row] = await tx
    .select({ entries: count() })
    .from(journalEntry)
    .where(and(eq(journalEntry.client, client), eq(journalEntry.documentType, code)));
  return row?.entries ?? 0;
}

const FIELD_LABELS = {
  name: 'Description',
  numberRangeObject: 'Number range object',
  numberRangeSubObject: 'Number range interval',
  allowedAccountTypes: 'Account types allowed',
  reversalMode: 'Reversal mode',
  reversalDocumentType: 'Reverse document type',
  requiresReference: 'Reference required',
  requiresLineText: 'Line text required',
  isActive: 'Active',
  usedByEntries: 'Journal entries posted under the type at the change',
} as const;

const SECURITY_RELEVANT = ['allowedAccountTypes', 'numberRangeObject', 'numberRangeSubObject'] as const;

/**
 * Create a document type, or change everything but its key and its active
 * state. Idempotent on change: repeating the stored values reports
 * `changed: false` and writes nothing but the activity completion.
 */
export async function saveDocumentType(raw: DocumentTypeInput): Promise<DocumentTypeSaveResult> {
  const parsed = documentTypeInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DocumentTypeError(
      parsed.error.issues[0]?.message ?? 'The document type is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [interval] = await tx
      .select({ subObject: numberRange.subObject })
      .from(numberRange)
      .where(and(
        eq(numberRange.client, client),
        eq(numberRange.objectCode, values.numberRangeObject),
        eq(numberRange.subObject, values.numberRangeSubObject),
      ))
      .limit(1);
    if (!interval) {
      throw new DocumentTypeError(
        `Number range interval ${values.numberRangeSubObject} is not defined for object ${values.numberRangeObject}.`,
        'Choose an interval that is defined, or define it under Number Ranges first; a type pointing at an interval nobody defined would post documents nobody can number.',
      );
    }

    if (values.reversalDocumentType && values.reversalDocumentType !== values.documentType) {
      const [reverse] = await tx
        .select({ documentType: documentType.documentType })
        .from(documentType)
        .where(and(eq(documentType.client, client), eq(documentType.documentType, values.reversalDocumentType)))
        .limit(1);
      if (!reverse) {
        throw new DocumentTypeError(
          `Reverse Document Type ${values.reversalDocumentType} is not defined in this tenant.`,
          'Choose a document type that stands, or leave the field empty so the type reverses under itself.',
        );
      }
    }

    const [existing] = await tx
      .select()
      .from(documentType)
      .where(and(eq(documentType.client, client), eq(documentType.documentType, values.documentType)))
      .for('update');

    if (values.mode === 'CREATE' && existing) {
      throw new DocumentTypeError(
        `Document Type ${values.documentType} is already defined.`,
        'Change the document type that exists, or choose another type.',
      );
    }
    if (values.mode === 'CHANGE' && !existing) {
      throw new DocumentTypeError(
        `Document Type ${values.documentType} is not defined.`,
        'Create the document type first; a key cannot be changed into existence, because the key is the type.',
      );
    }

    const usedByEntries = await countEntries(tx, client, values.documentType);
    const result: DocumentTypeSaveResult = {
      changed: true,
      documentType: values.documentType,
      usedByEntries,
    };

    const stored = {
      name: values.name,
      numberRangeObject: values.numberRangeObject,
      numberRangeSubObject: values.numberRangeSubObject,
      allowedAccountTypes: values.allowedAccountTypes,
      reversalMode: values.reversalMode,
      reversalDocumentType: values.reversalDocumentType,
      requiresReference: values.requiresReference,
      requiresLineText: values.requiresLineText,
    };

    if (values.mode === 'CREATE') {
      await tx.insert(documentType).values({
        client,
        documentType: values.documentType,
        ...stored,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey: values.documentType,
        changeType: 'CREATE',
        changedBy,
        transactionCode: ACTIVITY,
        reason,
        after: { documentType: values.documentType, ...stored },
        fieldLabels: { documentType: 'Document type', ...FIELD_LABELS },
        securityRelevantFields: [...SECURITY_RELEVANT],
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return result;
    }

    if (
      existing.name === stored.name
      && existing.numberRangeObject === stored.numberRangeObject
      && existing.numberRangeSubObject === stored.numberRangeSubObject
      && existing.allowedAccountTypes === stored.allowedAccountTypes
      && existing.reversalMode === stored.reversalMode
      && existing.reversalDocumentType === stored.reversalDocumentType
      && existing.requiresReference === stored.requiresReference
      && existing.requiresLineText === stored.requiresLineText
    ) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { ...result, changed: false };
    }

    await tx
      .update(documentType)
      .set({ ...stored, changedBy, changedAt: new Date() })
      .where(and(eq(documentType.client, client), eq(documentType.documentType, values.documentType)));

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: values.documentType,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: {
        name: existing.name,
        numberRangeObject: existing.numberRangeObject,
        numberRangeSubObject: existing.numberRangeSubObject,
        allowedAccountTypes: existing.allowedAccountTypes,
        reversalMode: existing.reversalMode,
        reversalDocumentType: existing.reversalDocumentType,
        requiresReference: existing.requiresReference,
        requiresLineText: existing.requiresLineText,
      },
      // The usage count rides on the after side, deliberately (the OB37 rule):
      // repeated on both sides recordChange would drop it as unmoved, and the
      // trail would not say how much history stood under the type when its
      // rules changed.
      after: { ...stored, usedByEntries },
      fieldLabels: FIELD_LABELS,
      securityRelevantFields: [...SECURITY_RELEVANT],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return result;
  });
}

/**
 * Deactivate a document type — it stops being offered to posting while the
 * documents already posted under it keep reading it — or reactivate it.
 * Repeating the standing state answers `changed: false` and writes nothing
 * but the activity completion.
 */
export async function setDocumentTypeActive(raw: DocumentTypeActiveInput): Promise<DocumentTypeSaveResult> {
  const parsed = documentTypeActiveInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DocumentTypeError(
      parsed.error.issues[0]?.message ?? 'The document type state is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, documentType: code, active } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx
      .select()
      .from(documentType)
      .where(and(eq(documentType.client, client), eq(documentType.documentType, code)))
      .for('update');
    if (!existing) {
      throw new DocumentTypeError(
        `Document Type ${code} is not defined.`,
        'Reload the document types; the entry may have been deleted.',
      );
    }

    const usedByEntries = await countEntries(tx, client, code);
    const result: DocumentTypeSaveResult = { changed: true, documentType: code, usedByEntries };

    if (existing.isActive === active) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { ...result, changed: false };
    }

    await tx
      .update(documentType)
      .set({ isActive: active, changedBy, changedAt: new Date() })
      .where(and(eq(documentType.client, client), eq(documentType.documentType, code)));

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: code,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { isActive: existing.isActive },
      after: { isActive: active, usedByEntries },
      fieldLabels: FIELD_LABELS,
      securityRelevantFields: ['isActive'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return result;
  });
}

/**
 * Delete a document type, while no journal entry in the tenant carries it.
 * The deletion files what was removed, so the audit trail keeps the
 * definition after the registry stops holding it.
 */
export async function deleteDocumentType(raw: DocumentTypeDeleteInput): Promise<{ deleted: true }> {
  const parsed = documentTypeDeleteInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DocumentTypeError(
      parsed.error.issues[0]?.message ?? 'The document type deletion is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, documentType: code } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx
      .select()
      .from(documentType)
      .where(and(eq(documentType.client, client), eq(documentType.documentType, code)))
      .for('update');
    if (!existing) {
      throw new DocumentTypeError(
        `Document Type ${code} is not defined.`,
        'Reload the document types; the entry may already have been deleted.',
      );
    }

    const usedByEntries = await countEntries(tx, client, code);
    if (usedByEntries > 0) {
      throw new DocumentTypeError(
        `Document Type ${code} is carried by ${usedByEntries} journal entr(ies) and cannot be deleted.`,
        'A type that history names stays defined, so what those entries are remains readable; deactivate it if it should no longer be posted with.',
      );
    }

    await tx
      .delete(documentType)
      .where(and(eq(documentType.client, client), eq(documentType.documentType, code)));

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: code,
      changeType: 'DELETE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: {
        name: existing.name,
        numberRangeObject: existing.numberRangeObject,
        numberRangeSubObject: existing.numberRangeSubObject,
        allowedAccountTypes: existing.allowedAccountTypes,
        reversalMode: existing.reversalMode,
        reversalDocumentType: existing.reversalDocumentType,
        requiresReference: existing.requiresReference,
        requiresLineText: existing.requiresLineText,
        isActive: existing.isActive,
      },
      fieldLabels: FIELD_LABELS,
      securityRelevantFields: [...SECURITY_RELEVANT],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { deleted: true as const };
  });
}
