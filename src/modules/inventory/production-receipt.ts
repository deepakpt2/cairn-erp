/**
 * Receive the finished good from a production order — SCR-140 / PROD.ORDER.GR (MIGO 101 + R08).
 *
 * The other half of the production loop: the order consumed its components (§26.904) and now
 * the goods it made arrive in stock. The document is a **material document** like every other
 * movement — receipt line, stock up, valuation up, one journal — with the order named on the
 * line, never a second ledger.
 *
 * **The value is what the good is worth here, not what it cost to make.** SAP receipts an order
 * at its planned cost; canon carries no costing sheet, no standard cost estimate and no routing,
 * so the honest valuation is the rule the issue already uses: the standard price under `S`, the
 * moving average under `V`. A cost estimate is deferred by name, and no report claims otherwise.
 *
 * **Two flows, two accounts.** The issue debits `PRODUCTION_CONSUMPTION`; the receipt credits
 * `PRODUCTION_OUTPUT`. One account for both would net consumption against output silently and
 * leave a reader unable to say what the balance meant.
 */
import { and, eq, sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { allocateNumber } from '../../platform/numbering';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { accountDetermination, plant as plantTable } from '../foundation/schema';
import { materialPeriodAllows } from './material-period-control';
import { postingValuationRefusal } from './valuation-class-definition';
import { assertInventoryCountOpen, lockStockScope, PhysicalInventoryError } from './physical-inventory';
import {
  applyValuationDelta, lockRequestKey, mismatchedRequest, postingFingerprint, quantityToken,
  REQUEST_MISMATCH_REMEDY,
} from './balance-update';
import { getMaterialPeriodControlInTx } from './goods-issue';
import { recordOutputsForPostedDocument } from './material-document-output';
import { resolveStorageLocation, storageLocationRequired, StorageLocationError } from './storage-location';
import { BatchPostingError, resolvePostingBatch } from './batch-posting';
import { toBaseQuantity, UnitConversionError } from './unit-conversion';
const MATERIAL_DOCUMENT_CLASS = 'material_document';
/** WE — the document type a goods receipt posts under (as MB01 does). */
const JOURNAL_DOCUMENT_TYPE = 'WE';
import {
  material, materialDocument, materialDocumentLine, materialPlant, materialValuation,
  movementType, productionOrder, stockQuantity,
} from './schema';

export const PRODUCTION_RECEIPT_CAPABILITY = 'PROD.ORDER.GR';
export const PRODUCTION_RECEIPT_SCENARIO = {
  code: '101',
  movementType: 'PROD_RECEIPT_ORDER',
  reversalMovementType: 'PROD_RECEIPT_ORD_REV',
  description: 'Goods receipt from a production order',
  accountAssignment: 'ORDER',
} as const;

export class ProductionReceiptError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ProductionReceiptError';
    this.remedy = remedy;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number) => Math.round(n * 100) / 100;

function requireDate(value: string, what: string) {
  if (!ISO_DATE.test(value)) {
    throw new ProductionReceiptError(`${what} ${value || '(empty)'} is not a date.`, 'Enter the date as YYYY-MM-DD.');
  }
}

export interface ProductionReceiptLineInput {
  /** The receiving storage location; the plant is the order's own. */
  storageLocation?: string;
  quantity: number;
  entryUnit?: string;
  /** Required when the material is batch-managed. The batch must already stand. */
  batch?: string;
}

export interface PostProductionReceiptInput {
  client: string;
  changedBy: string;
  orderNumber: string;
  postingDate: string;
  documentDate: string;
  headerText?: string;
  lines: ProductionReceiptLineInput[];
  requestKey: string;
}

export interface ProductionReceiptLineView {
  lineNumber: number;
  movementType: string;
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  batch: string;
  quantity: string;
  unit: string;
  value: string;
  /** What the order still expects to receive after this posting. */
  orderOpenAfter: string;
}

export interface ProductionReceiptView {
  materialDocumentNumber: string;
  documentYear: number;
  postingDate: string;
  documentDate: string;
  orderNumber: string;
  companyCode: string;
  movementCode: string;
  movementType: string;
  journalDocumentNumber: string | null;
  totalValue: string;
  /** Received against the order before this posting, and after it. */
  orderQuantity: string;
  receivedAfter: string;
  lines: ProductionReceiptLineView[];
}

async function ensureMovements(tx: Tx, client: string, changedBy: string) {
  const rows = [
    {
      movementType: PRODUCTION_RECEIPT_SCENARIO.movementType,
      description: `${PRODUCTION_RECEIPT_SCENARIO.description} (${PRODUCTION_RECEIPT_SCENARIO.code})`,
      direction: 'RECEIPT',
      referenceCategory: 'PRODUCTION_ORDER',
      accountAssignment: 'ORDER',
      reversalMovementType: PRODUCTION_RECEIPT_SCENARIO.reversalMovementType,
    },
    {
      movementType: PRODUCTION_RECEIPT_SCENARIO.reversalMovementType,
      description: `Reversal of ${PRODUCTION_RECEIPT_SCENARIO.description} (102)`,
      direction: 'REVERSAL',
      referenceCategory: 'PRODUCTION_ORDER',
      accountAssignment: 'ORDER',
      reversalMovementType: null,
    },
  ];
  for (const row of rows) {
    await tx.insert(movementType).values({ client, ...row, createdBy: changedBy }).onConflictDoNothing();
  }
}

async function resolveAccount(tx: Tx, client: string, chart: string, event: string, valuationClass: string) {
  const [row] = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, chart),
    eq(accountDetermination.event, event),
    eq(accountDetermination.valuationClass, valuationClass),
    eq(accountDetermination.generalModifier, ''),
  ));
  if (!row) {
    throw new ProductionReceiptError(
      `Account determination for ${event} and valuation class ${valuationClass} does not stand in chart ${chart}.`,
      'Maintain the account determination for this event, then post again.',
    );
  }
  return row.glAccount;
}

/** What the order has already received, read from the documents — never a stored counter. */
async function receivedFor(tx: Tx, client: string, orderNumber: string) {
  const rows = await tx.execute(sql`
    select coalesce(sum(entry_quantity), 0)::text as received
    from material_document_line
    where client = ${client}
      and production_order_number = ${orderNumber}
      and movement_type = ${PRODUCTION_RECEIPT_SCENARIO.movementType}
  `) as unknown as Array<{ received: string }>;
  return Number(rows[0]?.received ?? 0);
}

async function toView(
  tx: Tx, client: string, number: string,
  prepared: Array<{ quantity: number; value: number; location: string | null; unit: string; materialNumber: string; plant: string }>,
  orderQuantity: number, receivedAfter: number,
): Promise<ProductionReceiptView> {
  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client), eq(materialDocument.materialDocumentNumber, number),
  ));
  if (!header) throw new ProductionReceiptError(`Material document ${number} does not exist after posting.`);
  const [plantRow] = await tx.select({ companyCode: plantTable.companyCode }).from(plantTable).where(and(
    eq(plantTable.client, client), eq(plantTable.plant, prepared[0]?.plant ?? ''),
  ));
  const lines = await tx.select().from(materialDocumentLine).where(and(
    eq(materialDocumentLine.client, client),
    eq(materialDocumentLine.materialDocumentNumber, number),
  )).orderBy(materialDocumentLine.lineNumber);

  return {
    materialDocumentNumber: number,
    documentYear: header.documentYear,
    postingDate: header.postingDate,
    documentDate: header.documentDate,
    orderNumber: lines[0]?.productionOrderNumber ?? '',
    companyCode: plantRow?.companyCode ?? '',
    movementCode: PRODUCTION_RECEIPT_SCENARIO.code,
    movementType: PRODUCTION_RECEIPT_SCENARIO.movementType,
    journalDocumentNumber: header.journalDocumentNumber,
    // A replay passes no prepared lines; the stored lines carry the same value.
    totalValue: (prepared.length
      ? prepared.reduce((sum, p) => sum + p.value, 0)
      : lines.reduce((sum, l) => sum + Number(l.value), 0)).toFixed(2),
    orderQuantity: orderQuantity.toFixed(3),
    receivedAfter: receivedAfter.toFixed(3),
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber,
      movementType: l.movementType,
      materialNumber: l.materialNumber,
      plant: l.plant,
      storageLocation: l.storageLocation,
      batch: l.batchNumber,
      quantity: l.baseQuantity,
      unit: l.baseUnit,
      value: l.value,
      orderOpenAfter: Math.max(0, orderQuantity - receivedAfter).toFixed(3),
    })),
  };
}

/**
 * Post the receipt. One transaction: the journal, the material document, the stock and the
 * valuation commit together or not at all. The order itself is never written — its received
 * quantity is derived from exactly these documents.
 */
export async function postProductionReceipt(input: PostProductionReceiptInput): Promise<ProductionReceiptView> {
  const orderNumber = input.orderNumber.trim();
  if (!orderNumber) {
    throw new ProductionReceiptError('A production order is required.', 'Enter the order whose output is received.');
  }
  requireDate(input.postingDate, 'The posting date');
  requireDate(input.documentDate, 'The document date');
  if ((input.headerText ?? '').length > 25) {
    throw new ProductionReceiptError('The header text is longer than 25 characters.', 'Shorten the header text.');
  }
  if (input.lines.length === 0 || input.lines.every((l) => !(l.quantity > 0))) {
    throw new ProductionReceiptError(
      'No receipt quantity was entered.',
      'Enter the quantity of finished goods this document receives.',
    );
  }
  let quantity = input.lines.reduce((sum, l) => sum + (l.quantity > 0 ? l.quantity : 0), 0);
  const fingerprint = postingFingerprint([
    'PROD-GR', orderNumber, input.postingDate, input.documentDate, input.headerText ?? '',
    ...input.lines.map((line) => {
      const token = `${quantityToken(line.quantity)}:${line.entryUnit ?? ''}:${line.storageLocation ?? ''}`;
      const batch = (line.batch ?? '').trim().toUpperCase();
      return batch ? `${token}:${batch}` : token;
    }),
  ]);

  return withTenant(input.client, async (tx) => {
    await lockRequestKey(tx, input.client, input.requestKey);
    const [replay] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.requestKey, input.requestKey),
    ));
    if (replay) {
      const mismatch = await mismatchedRequest(tx, input.client, input.requestKey, fingerprint);
      if (mismatch) throw new ProductionReceiptError(mismatch, REQUEST_MISMATCH_REMEDY);
      const [order] = await tx.select().from(productionOrder).where(and(
        eq(productionOrder.client, input.client), eq(productionOrder.orderNumber, orderNumber),
      ));
      return toView(tx, input.client, replay.materialDocumentNumber, [], Number(order?.orderQuantity ?? 0),
        await receivedFor(tx, input.client, orderNumber));
    }

    await ensureMovements(tx, input.client, input.changedBy);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/prod-receipt/${orderNumber}`}, 0))`);

    const [order] = await tx.select().from(productionOrder).where(and(
      eq(productionOrder.client, input.client), eq(productionOrder.orderNumber, orderNumber),
    ));
    if (!order) {
      throw new ProductionReceiptError(
        `Production order ${orderNumber} does not exist.`,
        'Create the order first (CO01), then receive its output.',
      );
    }
    if (order.status !== 'RELEASED') {
      throw new ProductionReceiptError(
        `Production order ${orderNumber} stands ${order.status.toLowerCase()}, and only a released order receives output.`,
        'Release the order, then receive the finished good.',
      );
    }

    const materialNumber = order.materialNumber;
    const plant = order.plant;

    // SCR-144: the order states its unit; a receipt entered in another unit converts to it
    // before the order's expectation is measured. A unit with no conversion is refused by name.
    const entryUnit = input.lines[0]?.entryUnit ?? order.unitOfMeasure;
    if (entryUnit !== order.unitOfMeasure) {
      try {
        const conversion = await toBaseQuantity(tx, input.client, {
          materialNumber, quantity, entryUnit,
        });
        quantity = conversion.baseQuantity;
      } catch (caught) {
        if (caught instanceof UnitConversionError) {
          throw new ProductionReceiptError(caught.message, caught.remedy);
        }
        throw caught;
      }
    }
    const [mat] = await tx.select().from(material).where(and(
      eq(material.client, input.client), eq(material.materialNumber, materialNumber),
    ));
    if (!mat) throw new ProductionReceiptError(`Material ${materialNumber} does not exist.`);
    if (mat.markedForDeletion) {
      throw new ProductionReceiptError(
        `Material ${materialNumber} is flagged for deletion.`,
        'Cancel the deletion flag, then receive the output.',
      );
    }
    const [ext] = await tx.select().from(materialPlant).where(and(
      eq(materialPlant.client, input.client),
      eq(materialPlant.materialNumber, materialNumber),
      eq(materialPlant.plant, plant),
    ));
    if (!ext) {
      throw new ProductionReceiptError(`Material ${materialNumber} is not extended to plant ${plant}.`);
    }
    const [plantRow] = await tx.select().from(plantTable).where(and(
      eq(plantTable.client, input.client), eq(plantTable.plant, plant),
    ));
    if (!plantRow?.companyCode) {
      throw new ProductionReceiptError(
        `Plant ${plant} carries no company code.`,
        'Assign the plant to a company code, then receive the output.',
      );
    }
    const companyCode = plantRow.companyCode;

    // The order states how much it will make; a receipt beyond that is a receipt with no plan.
    const orderQuantity = Number(order.orderQuantity);
    const received = await receivedFor(tx, input.client, orderNumber);
    const stillExpected = Math.max(0, orderQuantity - received);
    if (quantity > stillExpected + 1e-9) {
      throw new ProductionReceiptError(
        `Order ${orderNumber} still expects ${stillExpected.toFixed(3)} ${order.unitOfMeasure} of ${materialNumber}, and ${quantity.toFixed(3)} was entered.`,
        'Receive only what the order still expects; canon carries no over-receipt tolerance.',
      );
    }

    // One receiving location per document. A blank line takes the plant default when the material is stocked.
    const required = await storageLocationRequired(tx, input.client, materialNumber, plant);
    let receivedAt;
    try {
      receivedAt = await resolveStorageLocation(tx, {
        client: input.client,
        plant,
        typed: input.lines[0]?.storageLocation,
        applyPlantDefault: true,
        required,
        verb: 'Receive into',
      });
    } catch (caught) {
      if (caught instanceof StorageLocationError) throw new ProductionReceiptError(caught.message, caught.remedy);
      throw caught;
    }
    const location = receivedAt.storageLocation;
    await lockStockScope(tx, input.client, [materialNumber], 'EXCLUSIVE');
    try {
      await assertInventoryCountOpen(tx, input.client, {
        materialNumber, plant, storageLocation: location || null,
        batch: input.lines.map((line) => (line.batch ?? '').trim()).find(Boolean) || order.batchNumber,
      });
    } catch (caught) {
      if (caught instanceof PhysicalInventoryError) {
        throw new ProductionReceiptError(caught.message, caught.remedy);
      }
      throw caught;
    }

    const [valuation] = await tx.select().from(materialValuation).where(and(
      eq(materialValuation.client, input.client),
      eq(materialValuation.materialNumber, materialNumber),
      eq(materialValuation.valuationArea, plant),
    ));
    if (!valuation || !valuation.valuationClass) {
      throw new ProductionReceiptError(
        `Material ${materialNumber} carries no valuation class in plant ${plant}.`,
        'Complete the material valuation data, then receive the output.',
      );
    }
    const classRefusal = await postingValuationRefusal(tx, input.client, materialNumber, valuation.valuationClass);
    if (classRefusal) {
      throw new ProductionReceiptError(classRefusal, 'Maintain a valuation class this material type permits, then receive the output.');
    }

    const company = await getCompanyCode(tx, input.client, companyCode);
    if (!company?.fiscalYearVariant) throw new ProductionReceiptError(`Company code ${companyCode} is not configured.`);
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);
    const mmRecord = await getMaterialPeriodControlInTx(tx, input.client, companyCode);
    if (!materialPeriodAllows(mmRecord, position.fiscalYear, position.period)) {
      throw new ProductionReceiptError(
        `The material posting period ${position.fiscalYear}/${position.period} is closed for company ${companyCode}.`,
        'Post into the open material period, or shift the material period first.',
      );
    }

    // The value the ledger can defend: the material's own price in its own plant.
    const price = valuation.priceControl === 'STANDARD'
      ? Number(valuation.standardPrice) / Number(valuation.priceUnit)
      : Number(valuation.movingAveragePrice) / Number(valuation.priceUnit);
    const value = round2(quantity * price);
    const unitPrice = valuation.priceControl === 'STANDARD' ? valuation.standardPrice : valuation.movingAveragePrice;

    const chart = company.chartOfAccounts as string;
    const inventoryAccount = await resolveAccount(tx, input.client, chart, 'INVENTORY', valuation.valuationClass);
    const outputAccount = await resolveAccount(tx, input.client, chart, 'PRODUCTION_OUTPUT', valuation.valuationClass);
    if (outputAccount === inventoryAccount) {
      throw new ProductionReceiptError(
        `Production output and inventory resolve to the same account ${inventoryAccount}, and the receipt would net to nothing.`,
        'Give PRODUCTION_OUTPUT its own account in the account determination.',
      );
    }

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'MATDOC', allocatedBy: input.changedBy,
    });
    const number = allocated.display;

    const journal = await postJournalEntry(tx, {
      client: input.client,
      companyCode,
      documentType: JOURNAL_DOCUMENT_TYPE,
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      fiscalYear: position.fiscalYear,
      postingPeriod: position.period,
      currency: company.currency,
      localCurrency: company.currency,
      reference: PRODUCTION_RECEIPT_SCENARIO.code,
      headerText: input.headerText,
      lines: [
        {
          glAccount: inventoryAccount, debitCredit: 'S', amount: value.toFixed(2),
          productionOrder: orderNumber, material: materialNumber, plant,
        },
        {
          glAccount: outputAccount, debitCredit: 'H', amount: value.toFixed(2),
          productionOrder: orderNumber, material: materialNumber, plant,
        },
      ],
      origin: { documentClass: MATERIAL_DOCUMENT_CLASS, documentKey: number },
      postedBy: input.changedBy,
      transactionCode: PRODUCTION_RECEIPT_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new ProductionReceiptError(error.message, error.remedy);
      throw error;
    });

    await tx.insert(materialDocument).values({
      client: input.client, materialDocumentNumber: number, documentYear: position.fiscalYear,
      documentDate: input.documentDate, postingDate: input.postingDate,
      headerText: input.headerText ?? null, status: 'POSTED',
      journalDocumentNumber: journal.documentNumber, requestKey: input.requestKey,
      requestFingerprint: fingerprint,
      createdBy: input.changedBy,
    });

    const typedBatches = [...new Set(
      input.lines.filter((line) => line.quantity > 0)
        .map((line) => (line.batch ?? '').trim().toUpperCase())
        .filter((batch) => batch !== ''),
    )];
    if (typedBatches.length > 1) {
      throw new ProductionReceiptError('The receipt lines name more than one batch.', 'Receive one batch on this document.');
    }
    let postingBatch = '';
    try {
      postingBatch = await resolvePostingBatch(tx, {
        client: input.client, materialNumber, plant,
        batch: typedBatches[0] || order.batchNumber, postingDate: input.postingDate,
      });
    } catch (caught) {
      if (caught instanceof BatchPostingError) throw new ProductionReceiptError(caught.message, caught.remedy);
      throw caught;
    }

    await tx.insert(materialDocumentLine).values({
      client: input.client, materialDocumentNumber: number, lineNumber: 1,
      movementType: PRODUCTION_RECEIPT_SCENARIO.movementType,
      materialNumber, plant,
      storageLocation: location || null, stockType: 'UNRESTRICTED', batchNumber: postingBatch,
      lineDirection: 'RECEIPT',
      entryQuantity: String(input.lines[0]?.entryQuantity ?? quantity),
      entryUnit,
      baseQuantity: String(quantity), baseUnit: order.unitOfMeasure,
      unitPrice, priceUnit: valuation.priceUnit, currency: company.currency,
      value: String(value),
      productionOrderNumber: orderNumber,
      createdBy: input.changedBy,
    });

    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, batch_number, quantity, created_by)
      values (${input.client}, ${materialNumber}, ${plant}, ${location}, 'UNRESTRICTED', ${postingBatch}, ${String(quantity)}, ${input.changedBy})
      on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
      do update set quantity = stock_quantity.quantity + ${quantity},
                    changed_by = ${input.changedBy}, changed_at = now()
    `);

    await applyValuationDelta(
      tx, input.client, input.changedBy, materialNumber, plant, quantity, value,
    );

    await recordChange(tx, {
      client: input.client,
      objectClass: MATERIAL_DOCUMENT_CLASS,
      objectKey: number,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: PRODUCTION_RECEIPT_CAPABILITY,
      after: {
        movement: PRODUCTION_RECEIPT_SCENARIO.movementType,
        receipt: PRODUCTION_RECEIPT_SCENARIO.code,
        order: orderNumber, quantity: String(quantity), value: String(value),
        journal: journal.documentNumber, status: 'POSTED', company: companyCode,
      },
    });

    await recordOutputsForPostedDocument(tx, input.client, number, input.changedBy);

    return toView(
      tx, input.client, number,
      [{ quantity, value, location: location || null, unit: order.unitOfMeasure, materialNumber, plant }],
      orderQuantity, received + quantity,
    );
  });
}

/** How much of the order has been received — for the order screen and the tests. */
export async function receivedQuantityFor(client: string, orderNumber: string): Promise<number> {
  return withTenant(client, (tx) => receivedFor(tx, client, orderNumber));
}
