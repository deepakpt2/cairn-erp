/**
 * Which documents the returns chain uses, and which movement the receipt posts.
 *
 * The returns chain works, and it arrived carrying its own identity in code: `RE` for the returns order,
 * `LR` for the returns delivery, `CR` for the complaint a credit is requested on, `G2` for the credit memo
 * itself, and `RETURNS_RECEIPT` for the 651 that receives the goods back. Constants, the way the order type
 * was a constant before 9226, and wrong in the same way — 9226 made the *types* configuration, and left
 * which of them the returns chain uses in the services.
 *
 * So this module holds one row per tenant, and every service in the chain reads it before it creates
 * anything. Two consequences are deliberate:
 *
 * The row is not optional. A tenant with no row is a tenant whose returns chain has never been configured,
 * and the services say so with a remedy that names the screen. A silent fallback to the delivered standard
 * would be a configuration pretending to be a default — every tenant would look configured, and none would
 * know whether it had chosen anything.
 *
 * And the configuration is validated against what the posting will re-read. A receipt movement that carries
 * value, or that does not land in returns stock, is refused here rather than discovered when the goods are
 * already at the door: the receipt is not valuated, the transfer out of returns stock is, and a
 * configuration that says otherwise is a contradiction the posting would only repeat.
 *
 * The four types must differ from one another. The returns order, the returns delivery, the complaint and
 * the credit memo are four documents with four fates, and a chain in which two of them carry one type is a
 * chain whose history cannot say which happened.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { movementType } from '../inventory/schema';
import { RETURNS } from '../inventory/warehouse-stocks';
import { salesDocumentType, salesReturnsConfiguration, salesOrder } from './schema';

export const RETURNS_CONFIGURATION_ROUTE = '/config/sales-returns';

/**
 * The capability the screen is gated by. A configuration code, like the document type's: naming which
 * documents a process uses is not the same act as creating one of them.
 */
export const RETURNS_DEFINE_CAPABILITY = 'CFG.SALES.RETURNS.DEFINE';

const OBJECT_CLASS = 'sales_returns_configuration';

export class ReturnsConfigurationError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ReturnsConfigurationError';
    this.remedy = remedy;
  }
}

export interface ReturnsChain {
  returnsOrderType: string;
  returnsDeliveryType: string;
  complaintType: string;
  creditMemoType: string;
  receiptMovementType: string;
}

/**
 * What the services read. One row, or a refusal that names the screen: the chain has no business deciding
 * for itself which document a return is.
 */
export async function returnsChain(tx: Tx, client: string): Promise<ReturnsChain> {
  const [row] = await tx.select().from(salesReturnsConfiguration)
    .where(eq(salesReturnsConfiguration.client, client)).limit(1);
  if (!row) {
    throw new ReturnsConfigurationError(
      'The returns chain is not configured for this tenant, so no returns document can be created and no goods can be received back.',
      `Name the document types and the receipt movement at ${RETURNS_CONFIGURATION_ROUTE}, then try again.`,
    );
  }
  return {
    returnsOrderType: row.returnsOrderType,
    returnsDeliveryType: row.returnsDeliveryType,
    complaintType: row.complaintType,
    creditMemoType: row.creditMemoType,
    receiptMovementType: row.receiptMovementType,
  };
}

export interface ReturnsConfigurationPart {
  code: string;
  name: string;
  /** Whether the type or movement named still stands, and may still be used. */
  stands: boolean;
  /** How many documents of this type already stand — what a change here does not rewrite. */
  documentsStanding: number;
}

export interface ReturnsConfigurationView {
  configured: boolean;
  returnsOrderType: ReturnsConfigurationPart;
  returnsDeliveryType: ReturnsConfigurationPart;
  complaintType: ReturnsConfigurationPart;
  creditMemoType: ReturnsConfigurationPart;
  receiptMovementType: ReturnsConfigurationPart;
  /** What the screen may offer: the document types that stand, and the movements that can receive a return. */
  choices: {
    documentTypes: Array<{ documentType: string; name: string }>;
    movements: Array<{ movementType: string; description: string }>;
  };
}

interface PartRow {
  code: string; name: string; stands: boolean; documents_standing: string | number;
}

function part(row: PartRow | undefined, code: string, kind: string): ReturnsConfigurationPart {
  return {
    code,
    name: row?.name ?? `${kind} ${code} does not stand`,
    stands: Boolean(row?.stands),
    documentsStanding: Number(row?.documents_standing ?? 0),
  };
}

/** What the screen reads: the chain as configured, and what may be chosen for each part of it. */
export async function getReturnsConfiguration(client: string): Promise<ReturnsConfigurationView> {
  return withTenant(client, async (tx) => {
    const [row] = await tx.select().from(salesReturnsConfiguration)
      .where(eq(salesReturnsConfiguration.client, client)).limit(1);

    const read = async (code: string | undefined, kind: string): Promise<ReturnsConfigurationPart> => {
      if (!code) return part(undefined, '', kind);
      const rows = await tx.execute(sql`
        select t.document_type as code, t.name, t.is_active as stands,
               (select count(*) from sales_order o
                 where o.client = t.client and o.document_type = t.document_type) as documents_standing
          from sales_document_type t
         where t.client = ${client} and t.document_type = ${code}
      `) as unknown as PartRow[];
      return part(rows[0], code, kind);
    };

    const readMovement = async (code: string | undefined): Promise<ReturnsConfigurationPart> => {
      if (!code) return part(undefined, '', 'Movement');
      const rows = await tx.execute(sql`
        select m.movement_type as code, m.description as name,
               (m.direction = 'RECEIPT' and m.reference_category = 'SALES_DELIVERY'
                and m.destination_stock_type = ${RETURNS} and not m.valuation_relevant) as stands,
               0 as documents_standing
          from movement_type m
         where m.client = ${client} and m.movement_type = ${code}
      `) as unknown as PartRow[];
      return part(rows[0], code, 'Movement');
    };

    const [documentTypes, movements] = await Promise.all([
      tx.select({ documentType: salesDocumentType.documentType, name: salesDocumentType.name })
        .from(salesDocumentType)
        .where(and(eq(salesDocumentType.client, client), eq(salesDocumentType.isActive, true)))
        .orderBy(salesDocumentType.documentType),
      // Only what could receive a return is offered: the posting re-reads those four facts, so a movement
      // that contradicts them is not a choice, it is a refusal waiting to happen.
      tx.select({ movementType: movementType.movementType, description: movementType.description })
        .from(movementType)
        .where(and(
          eq(movementType.client, client),
          eq(movementType.direction, 'RECEIPT'),
          eq(movementType.referenceCategory, 'SALES_DELIVERY'),
          eq(movementType.destinationStockType, RETURNS),
          eq(movementType.valuationRelevant, false),
        ))
        .orderBy(movementType.movementType),
    ]);

    return {
      configured: Boolean(row),
      returnsOrderType: await read(row?.returnsOrderType, 'Document type'),
      returnsDeliveryType: await read(row?.returnsDeliveryType, 'Document type'),
      complaintType: await read(row?.complaintType, 'Document type'),
      creditMemoType: await read(row?.creditMemoType, 'Document type'),
      receiptMovementType: await readMovement(row?.receiptMovementType),
      choices: { documentTypes, movements },
    };
  });
}

export interface SaveReturnsConfigurationInput {
  client: string;
  changedBy: string;
  returnsOrderType: string;
  returnsDeliveryType: string;
  complaintType: string;
  creditMemoType: string;
  receiptMovementType: string;
}

/**
 * Write the chain. Every part is checked against what stands, and the receipt movement against what the
 * posting will re-read, so a configuration that contradicts itself is refused here rather than at the
 * goods-in door.
 */
export async function saveReturnsConfiguration(
  input: SaveReturnsConfigurationInput,
): Promise<{ client: string; created: boolean }> {
  const chain: ReturnsChain = {
    returnsOrderType: input.returnsOrderType.trim().toUpperCase(),
    returnsDeliveryType: input.returnsDeliveryType.trim().toUpperCase(),
    complaintType: input.complaintType.trim().toUpperCase(),
    creditMemoType: input.creditMemoType.trim().toUpperCase(),
    receiptMovementType: input.receiptMovementType.trim().toUpperCase(),
  };
  for (const [field, code] of Object.entries(chain)) {
    if (!code) {
      throw new ReturnsConfigurationError(
        `The returns chain names a type for every part of it, and ${field} is empty.`,
        `Name the ${field.replace(/([A-Z])/g, ' $1').toLowerCase()} the chain uses.`,
      );
    }
  }
  const codes = Object.values(chain).filter((code) => code !== chain.receiptMovementType);
  if (new Set(codes).size !== codes.length) {
    throw new ReturnsConfigurationError(
      'The returns order, the returns delivery, the complaint and the credit memo are four documents with four fates, and two of them have been given one type.',
      'Name a different document type for each part of the chain.',
    );
  }

  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(salesReturnsConfiguration)
      .where(eq(salesReturnsConfiguration.client, input.client)).limit(1);

    for (const code of codes) {
      const [type] = await tx.select().from(salesDocumentType).where(and(
        eq(salesDocumentType.client, input.client), eq(salesDocumentType.documentType, code),
      )).limit(1);
      if (!type) {
        throw new ReturnsConfigurationError(
          `Sales document type ${code} does not stand for this tenant, so the returns chain cannot use it.`,
          'Define the type on the sales document types screen first, then name it here.',
        );
      }
      if (!type.isActive) {
        throw new ReturnsConfigurationError(
          `Sales document type ${code} has been withdrawn, so no document of that type can be created.`,
          'Offer the type again on the sales document types screen, or name one that stands.',
        );
      }
    }

    const [movement] = await tx.select().from(movementType).where(and(
      eq(movementType.client, input.client),
      eq(movementType.movementType, chain.receiptMovementType),
    )).limit(1);
    if (!movement) {
      throw new ReturnsConfigurationError(
        `Movement type ${chain.receiptMovementType} does not stand for this tenant, so no returns receipt can be posted.`,
        'Maintain the movement in the movement catalogue, then name it here.',
      );
    }
    // The four facts the posting re-reads. Refused here, where the configuration is being written, rather
    // than at the door, where the same facts would be refused on every delivery that arrived.
    if (movement.direction !== 'RECEIPT') {
      throw new ReturnsConfigurationError(
        `Movement ${movement.movementType} is configured with direction ${movement.direction}, and a return takes goods back in.`,
        'Name a receipt movement; a return that removes stock is an issue.',
      );
    }
    if (movement.referenceCategory !== 'SALES_DELIVERY') {
      throw new ReturnsConfigurationError(
        `Movement ${movement.movementType} is configured to reference ${movement.referenceCategory}, and a customer return references the delivery the goods left on.`,
        'Name a movement that references a sales delivery.',
      );
    }
    if (movement.destinationStockType !== RETURNS) {
      throw new ReturnsConfigurationError(
        `Movement ${movement.movementType} is configured to receive into ${movement.destinationStockType ?? 'no stock type'}, and a customer return is received into returns stock.`,
        `Name a movement that receives into ${RETURNS}; goods received straight into valuated stock are a purchase, not a return.`,
      );
    }
    if (movement.valuationRelevant) {
      throw new ReturnsConfigurationError(
        `Movement ${movement.movementType} is configured to carry value, and a return into returns stock carries none.`,
        'Name a movement that carries no value; the value comes back with the transfer out of returns stock.',
      );
    }

    const values = {
      client: input.client,
      returnsOrderType: chain.returnsOrderType,
      returnsDeliveryType: chain.returnsDeliveryType,
      complaintType: chain.complaintType,
      creditMemoType: chain.creditMemoType,
      receiptMovementType: chain.receiptMovementType,
      changedBy: input.changedBy,
      changedAt: new Date(),
    };
    if (standing) {
      await tx.update(salesReturnsConfiguration).set(values)
        .where(eq(salesReturnsConfiguration.client, input.client));
    } else {
      await tx.insert(salesReturnsConfiguration).values({ ...values, createdBy: input.changedBy });
    }
    await recordChange(tx, {
      client: input.client, objectClass: OBJECT_CLASS, objectKey: input.client,
      changeType: standing ? 'CHANGE' : 'CREATE', changedBy: input.changedBy,
      before: standing ? {
        returnsOrderType: standing.returnsOrderType,
        returnsDeliveryType: standing.returnsDeliveryType,
        complaintType: standing.complaintType,
        creditMemoType: standing.creditMemoType,
        receiptMovementType: standing.receiptMovementType,
      } : {},
      after: { ...chain },
      fieldLabels: {
        returnsOrderType: 'Returns order type',
        returnsDeliveryType: 'Returns delivery type',
        complaintType: 'Complaint type',
        creditMemoType: 'Credit memo type',
        receiptMovementType: 'Receipt movement',
      },
    });
    return { client: input.client, created: !standing };
  });
}
