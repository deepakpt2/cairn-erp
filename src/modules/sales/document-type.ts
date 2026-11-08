/**
 * Sales document types — the configuration a document is created against.
 *
 * An order, a delivery and a billing document each carried their type as a constant in their own service
 * (`OR`, `LF`, `F2`), and each constant stood for three facts: the code the document stores, the number
 * range object and sub-object its number is drawn from, and the name a screen shows. Migration 9226 moves
 * those facts into `sales_document_type` and seeds them for every tenant, so a new commercial process is a
 * row rather than a deployment — which is how movement types, purchasing contract types and scheduling
 * agreement types have always worked here.
 *
 * What is left here is deliberately small: read the row, hand back the facts, and say nothing when it does
 * not stand. The resolver returns `undefined` rather than throwing, because the refusal belongs to the
 * service that is being asked to create a document — it knows what it was about to create, and its own
 * error class is what its screen already catches and displays. A shared error thrown from here would either
 * have to be added to three catch lists or surface as an unhandled failure.
 *
 * SAP keeps the same facts in three places — VOV8 for orders, the delivery type and the billing type — and
 * each entry carries more than this: the proposed follow-on types, the cancellation type and the billing
 * block. Those arrive with the increments that read them, each in its own migration; a column nothing reads
 * is a promise the system does not keep.
 */
import { and, eq } from 'drizzle-orm';
import { type Tx } from '../../platform/db/client';
import { salesDocumentType } from './schema';

/**
 * The three types every tenant is delivered with. A screen that offers a choice reads what is configured;
 * these are the codes the chain asks for while no screen offers one.
 */
export const STANDARD_ORDER_TYPE = 'OR';
export const STANDARD_DELIVERY_TYPE = 'LF';
export const STANDARD_BILLING_TYPE = 'F2';
/** What an invoice cancels into — VF11, as opposed to a credit memo, which stands on its own. */
export const STANDARD_BILLING_CANCELLATION_TYPE = 'S1';
/** SAP's LR: the delivery goods come back on, and the document that posts movement 651. */
export const STANDARD_RETURNS_DELIVERY_TYPE = 'LR';
/** SAP's RE: the order a return is raised on, created with reference to the invoice it comes from. */
export const STANDARD_RETURNS_ORDER_TYPE = 'RE';

/**
 * The three types every tenant is delivered with, in the shape the standard configuration package writes
 * them. One list, because the package and the migration that backfilled existing tenants must not drift
 * apart: a type added to one and not the other is a tenant that refuses to create a document nobody can
 * explain.
 */
export interface StandardSalesDocumentType {
  documentType: string;
  name: string;
  numberRangeObject: string;
  numberRangeSubObject: string;
  /** What a document of this type cancels into. Absent where the type has no cancellation counterpart. */
  cancellationDocumentType?: string;
}

/**
 * Ordered so that a type which names a cancellation counterpart comes after that counterpart: the column
 * carries a foreign key, and one insert per row means the counterpart has to stand first. The application
 * role holds INSERT and SELECT on this table and nothing else, so the seeding cannot fall back on an update
 * to hang the link on afterwards.
 */
export const STANDARD_SALES_DOCUMENT_TYPES: StandardSalesDocumentType[] = [
  { documentType: STANDARD_ORDER_TYPE, name: 'Standard order', numberRangeObject: 'SALESORD', numberRangeSubObject: 'OR' },
  { documentType: STANDARD_DELIVERY_TYPE, name: 'Outbound delivery', numberRangeObject: 'DELIVERY', numberRangeSubObject: 'LF' },
  {
    documentType: STANDARD_RETURNS_ORDER_TYPE, name: 'Returns',
    numberRangeObject: 'SALESORD', numberRangeSubObject: 'RE',
  },
  {
    documentType: STANDARD_RETURNS_DELIVERY_TYPE, name: 'Returns delivery',
    numberRangeObject: 'DELIVERY', numberRangeSubObject: 'LR',
  },
  {
    documentType: STANDARD_BILLING_CANCELLATION_TYPE, name: 'Cancellation of invoice',
    numberRangeObject: 'BILLING', numberRangeSubObject: 'S1',
  },
  {
    documentType: STANDARD_BILLING_TYPE, name: 'Invoice',
    numberRangeObject: 'BILLING', numberRangeSubObject: 'F2',
    cancellationDocumentType: STANDARD_BILLING_CANCELLATION_TYPE,
  },
];

export interface ResolvedSalesDocumentType {
  documentType: string;
  name: string;
  numberRangeObject: string;
  numberRangeSubObject: string;
  /** What a document of this type cancels into; null where the type has no cancellation counterpart. */
  cancellationDocumentType: string | null;
}

/**
 * The type as configured, inside the caller's own transaction. `undefined` when no such type stands for
 * this tenant, or when the one that stands has been deactivated — the two are the same refusal, and a
 * deactivated type is not offered to a document that is about to be created.
 */
export async function salesDocumentTypeFor(
  tx: Tx,
  client: string,
  documentType: string,
): Promise<ResolvedSalesDocumentType | undefined> {
  const [row] = await tx
    .select({
      documentType: salesDocumentType.documentType,
      name: salesDocumentType.name,
      numberRangeObject: salesDocumentType.numberRangeObject,
      numberRangeSubObject: salesDocumentType.numberRangeSubObject,
      cancellationDocumentType: salesDocumentType.cancellationDocumentType,
    })
    .from(salesDocumentType)
    .where(
      and(
        eq(salesDocumentType.client, client),
        eq(salesDocumentType.documentType, documentType),
        eq(salesDocumentType.isActive, true),
      ),
    )
    .limit(1);
  return row;
}

/**
 * The remedy every caller offers. It names the configuration rather than a screen, because the maintenance
 * screen is the increment that follows this one and the remedy must not point at something that does not
 * exist yet.
 */
export const DOCUMENT_TYPE_REMEDY =
  'Have the standard sales document types restored for this tenant in the sales document type configuration, then save again.';
