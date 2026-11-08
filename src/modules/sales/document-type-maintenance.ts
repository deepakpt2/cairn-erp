/**
 * Maintaining what a sales document *is*.
 *
 * Since 9226 the document type is a row, and every fact on it is read: the code a document carries, the
 * name a screen shows, the number range its number is drawn from, what the type cancels into, and whether
 * documents of that type may still be created. Not one of those facts could be written except by a
 * migration, so a new commercial process still cost a deployment — the thing 9226 set out to end.
 *
 * What is maintained here is deliberately the whole row and no more. There is no delete: a type with
 * documents standing under it is deactivated, because the history keeps reading the type a document was
 * created with, and the application role is granted no DELETE to break that with. There is no editing of
 * the number range object itself — a number range is the numbering service's own configuration, and two
 * screens editing one row is how a configuration comes to contradict itself.
 *
 * Two refusals carry the substance of the screen:
 *
 * A type whose number range does not stand is refused. A document type that cannot draw a number is a
 * type that will refuse every document created against it, and the refusal would present as a missing
 * number rather than as the configuration error it is — a silence in the wrong place, which is the same
 * fault 9226 was written to remove.
 *
 * And a type cannot cancel into itself. The column carries a foreign key to the same table, and a
 * cancellation that points at the document it cancels is a loop no reader can follow.
 */
import { and, eq, ne, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { billingDocument, delivery, salesDocumentType, salesOrder } from './schema';
import { DOCUMENT_TYPE_DEFINE_CAPABILITY } from './document-type';

/** Re-exported so the screen and the contract test import the code from the module that owns it. */
export { DOCUMENT_TYPE_DEFINE_CAPABILITY };
export const DOCUMENT_TYPE_OBJECT_CLASS = 'sales_document_type';

const DOCUMENT_TYPE_CODE = /^[A-Z0-9]{2,4}$/;

export class SalesDocumentTypeError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'SalesDocumentTypeError';
    this.remedy = remedy;
  }
}

export interface SalesDocumentTypeRow {
  documentType: string;
  name: string;
  numberRangeObject: string;
  numberRangeSubObject: string;
  cancellationDocumentType: string | null;
  isActive: boolean;
  /** How many documents of this type stand, over orders, deliveries and billing documents. */
  documentsStanding: number;
  /** Whether the number range this type draws from has an interval for this tenant. */
  rangeStands: boolean;
}

/**
 * What the screen reads: every type as configured, with the two facts that tell a consultant whether a
 * change is safe — how much history stands under the type, and whether its numbers can be drawn at all.
 */
export async function listSalesDocumentTypes(client: string): Promise<SalesDocumentTypeRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select t.document_type, t.name, t.number_range_object, t.number_range_sub_object,
             t.cancellation_document_type, t.is_active,
             (select count(*) from sales_order o
               where o.client = t.client and o.document_type = t.document_type)
             + (select count(*) from delivery d
                 where d.client = t.client and d.document_type = t.document_type)
             + (select count(*) from billing_document b
                 where b.client = t.client and b.document_type = t.document_type) as documents_standing,
             exists (
               select 1 from number_range r
                where r.client = t.client and r.object_code = t.number_range_object
                  and r.sub_object = t.number_range_sub_object and r.status = 'ACTIVE' and not r.is_external
             ) as range_stands
        from sales_document_type t
       where t.client = ${client}
       order by t.document_type
    `) as unknown as Array<{
      document_type: string; name: string; number_range_object: string; number_range_sub_object: string;
      cancellation_document_type: string | null; is_active: boolean;
      documents_standing: string | number; range_stands: boolean;
    }>;
    return rows.map((row) => ({
      documentType: row.document_type,
      name: row.name,
      numberRangeObject: row.number_range_object,
      numberRangeSubObject: row.number_range_sub_object,
      cancellationDocumentType: row.cancellation_document_type,
      isActive: Boolean(row.is_active),
      documentsStanding: Number(row.documents_standing ?? 0),
      rangeStands: Boolean(row.range_stands),
    }));
  });
}

/**
 * Whether the interval this type would draw its numbers from stands for this tenant.
 *
 * The check mirrors what the numbering service will look for, so the configuration refuses a type whose
 * documents could never be numbered rather than letting the refusal surface later as a missing number.
 */
async function rangeStands(
  tx: Tx, client: string, objectCode: string, subObject: string,
): Promise<boolean> {
  const [row] = await tx.execute(sql`
    select 1 as stands from number_range r
     where r.client = ${client} and r.object_code = ${objectCode} and r.sub_object = ${subObject}
       and r.status = 'ACTIVE' and not r.is_external
     limit 1
  `) as unknown as Array<{ stands: number }>;
  return Boolean(row);
}

export interface DefineSalesDocumentTypeInput {
  client: string;
  changedBy: string;
  documentType: string;
  name: string;
  numberRangeObject: string;
  numberRangeSubObject: string;
  cancellationDocumentType?: string;
}

/** Define a type that does not stand yet. */
export async function defineSalesDocumentType(
  input: DefineSalesDocumentTypeInput,
): Promise<{ documentType: string }> {
  const code = input.documentType.trim().toUpperCase();
  const name = input.name.trim();
  const object = input.numberRangeObject.trim().toUpperCase();
  const subObject = input.numberRangeSubObject.trim().toUpperCase();
  const cancels = input.cancellationDocumentType?.trim().toUpperCase() || null;

  if (!DOCUMENT_TYPE_CODE.test(code)) {
    throw new SalesDocumentTypeError(
      `A document type is two to four characters of capital letters or digits, and ${code} is not.`,
      'Name the type the way the documents will carry it, for example ZOR.',
    );
  }
  if (!name) {
    throw new SalesDocumentTypeError('A document type carries the name a screen shows for it.');
  }
  if (!object || !subObject) {
    throw new SalesDocumentTypeError(
      'A document type names the number range its documents draw their numbers from.',
      'Name the range object and its sub-object, for example SALESORD and OR.',
    );
  }
  if (cancels === code) {
    throw new SalesDocumentTypeError(
      `Document type ${code} cannot cancel into itself: a cancellation that points at the document it cancels is a loop.`,
      'Name the type a document of this one cancels into, or leave the cancellation type empty.',
    );
  }

  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select({ documentType: salesDocumentType.documentType }).from(salesDocumentType)
      .where(and(eq(salesDocumentType.client, input.client), eq(salesDocumentType.documentType, code))).limit(1);
    if (standing) {
      throw new SalesDocumentTypeError(
        `Document type ${code} stands for this tenant already.`,
        'Redefine the type that stands rather than defining it again: the documents created under it keep reading it.',
      );
    }
    if (cancels) {
      const [counterpart] = await tx.select({ documentType: salesDocumentType.documentType }).from(salesDocumentType)
        .where(and(
          eq(salesDocumentType.client, input.client), eq(salesDocumentType.documentType, cancels),
        )).limit(1);
      if (!counterpart) {
        throw new SalesDocumentTypeError(
          `Document type ${cancels} does not stand, so ${code} cannot cancel into it.`,
          `Define ${cancels} first, then name it as the cancellation type of ${code}.`,
        );
      }
    }
    if (!(await rangeStands(tx, input.client, object, subObject))) {
      throw new SalesDocumentTypeError(
        `No active number range interval stands for ${object} / ${subObject} in this tenant, so no document of type ${code} could be numbered.`,
        `Define the number range interval for ${object} / ${subObject} first, then define the type.`,
      );
    }

    await tx.insert(salesDocumentType).values({
      client: input.client, documentType: code, name: name.slice(0, 40),
      numberRangeObject: object, numberRangeSubObject: subObject,
      cancellationDocumentType: cancels, isActive: true, createdBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client, objectClass: DOCUMENT_TYPE_OBJECT_CLASS, objectKey: code,
      changeType: 'CREATE', changedBy: input.changedBy,
      before: {}, after: {
        documentType: code, name: name.slice(0, 40), numberRangeObject: object,
        numberRangeSubObject: subObject, cancellationDocumentType: cancels ?? '', isActive: true,
      },
    });
    return { documentType: code };
  });
}

export interface ChangeSalesDocumentTypeInput {
  client: string;
  changedBy: string;
  documentType: string;
  name: string;
  cancellationDocumentType?: string | null;
}

/** Redefine a type that stands: the name a screen shows, and what it cancels into. */
export async function changeSalesDocumentType(
  input: ChangeSalesDocumentTypeInput,
): Promise<{ documentType: string; version: number }> {
  const code = input.documentType.trim().toUpperCase();
  const name = input.name.trim();
  const cancels = input.cancellationDocumentType?.trim().toUpperCase() || null;
  if (!name) {
    throw new SalesDocumentTypeError('A document type carries the name a screen shows for it.');
  }
  if (cancels === code) {
    throw new SalesDocumentTypeError(
      `Document type ${code} cannot cancel into itself: a cancellation that points at the document it cancels is a loop.`,
      'Name the type a document of this one cancels into, or clear the cancellation type.',
    );
  }

  return withTenant(input.client, async (tx) => {
    const [row] = await tx.select().from(salesDocumentType).where(and(
      eq(salesDocumentType.client, input.client), eq(salesDocumentType.documentType, code),
    )).limit(1);
    if (!row) {
      throw new SalesDocumentTypeError(
        `Document type ${code} does not stand for this tenant.`,
        `Define ${code} before redefining it.`,
      );
    }
    if (cancels) {
      const [counterpart] = await tx.select({ documentType: salesDocumentType.documentType }).from(salesDocumentType)
        .where(and(
          eq(salesDocumentType.client, input.client), eq(salesDocumentType.documentType, cancels),
        )).limit(1);
      if (!counterpart) {
        throw new SalesDocumentTypeError(
          `Document type ${cancels} does not stand, so ${code} cannot cancel into it.`,
          `Define ${cancels} first, then name it as the cancellation type of ${code}.`,
        );
      }
    }
    await tx.update(salesDocumentType).set({
      name: name.slice(0, 40), cancellationDocumentType: cancels,
      changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(salesDocumentType.client, input.client), eq(salesDocumentType.documentType, code),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: DOCUMENT_TYPE_OBJECT_CLASS, objectKey: code,
      changeType: 'CHANGE', changedBy: input.changedBy,
      before: { name: row.name, cancellationDocumentType: row.cancellationDocumentType ?? '' },
      after: { name: name.slice(0, 40), cancellationDocumentType: cancels ?? '' },
      fieldLabels: { name: 'Name', cancellationDocumentType: 'Cancels into' },
    });
    // The table carries no version: a type is configuration, and two consultants saving the same type
    // is not the contention a document is. What is returned is the history's own count of the change.
    return { documentType: code, version: 0 };
  });
}

export interface SetSalesDocumentTypeActiveInput {
  client: string;
  changedBy: string;
  documentType: string;
  isActive: boolean;
}

/**
 * Activate or deactivate a type.
 *
 * Deactivating does not undo history: documents already created keep the type they were created with,
 * and a deactivated type is simply no longer offered to a document about to be created. Reactivating
 * puts it back, which is why there is no delete — the one thing a deactivation cannot do is forget.
 */
export async function setSalesDocumentTypeActive(
  input: SetSalesDocumentTypeActiveInput,
): Promise<{ documentType: string; isActive: boolean; documentsStanding: number }> {
  const code = input.documentType.trim().toUpperCase();
  return withTenant(input.client, async (tx) => {
    const [row] = await tx.select().from(salesDocumentType).where(and(
      eq(salesDocumentType.client, input.client), eq(salesDocumentType.documentType, code),
    )).limit(1);
    if (!row) {
      throw new SalesDocumentTypeError(
        `Document type ${code} does not stand for this tenant.`,
        `Define ${code} before changing whether it may be used.`,
      );
    }
    const [counted] = await tx.execute(sql`
      select (select count(*) from sales_order o
               where o.client = ${input.client} and o.document_type = ${code})
             + (select count(*) from delivery d
                 where d.client = ${input.client} and d.document_type = ${code})
             + (select count(*) from billing_document b
                 where b.client = ${input.client} and b.document_type = ${code}) as n
    `) as unknown as Array<{ n: string | number }>;
    const documentsStanding = Number(counted?.n ?? 0);

    await tx.update(salesDocumentType).set({
      isActive: input.isActive, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(salesDocumentType.client, input.client), eq(salesDocumentType.documentType, code),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: DOCUMENT_TYPE_OBJECT_CLASS, objectKey: code,
      changeType: 'CHANGE', changedBy: input.changedBy,
      before: { isActive: row.isActive }, after: { isActive: input.isActive, documentsStanding },
      fieldLabels: { isActive: 'May still be used', documentsStanding: 'Documents standing' },
    });
    return { documentType: code, isActive: input.isActive, documentsStanding };
  });
}

/** The types a document of another type may be created from, for the screen's own lists. */
export async function activeSalesDocumentTypes(client: string): Promise<Array<{
  documentType: string; name: string;
}>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      documentType: salesDocumentType.documentType, name: salesDocumentType.name,
    }).from(salesDocumentType).where(and(
      eq(salesDocumentType.client, client), eq(salesDocumentType.isActive, true),
    )).orderBy(salesDocumentType.documentType);
    return rows;
  });
}
