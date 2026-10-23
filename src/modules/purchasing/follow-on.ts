/**
 * The purchasing chain SAP keeps between a requisition, a request, a quotation
 * and an order.
 *
 * A request copies a requisition and does not consume it. A quotation prices
 * that request and does not create an order. An order is saved from the
 * quotation, must not exceed the quantity still open, and writes the info
 * record only when the quotation carried the indicator. The requisition is
 * consumed by the order, and only up to what remains. A vendor in the standing
 * quota has the order quantity added to that vendor's base. A vendor who is
 * not in it is warned. A typed price stands. An info-record price in another
 * unit or currency is converted, and a missing conversion or rate refuses the
 * order when that price is the one being used.
 */
import { and, eq, sql } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';
import { exchangeRate } from '../foundation/schema';
import { companyCode, plant, purchasingOrgPlant } from '../foundation/schema';
import { supplierPurchasing } from '../foundation/supplier-purchasing-schema';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import {
  InfoRecordError,
  writePurchasingInfoRecord,
  writePurchasingInfoRecordChange,
} from './info-record';
import {
  documentRelease,
  purchaseOrderItem,
  purchaseRequisitionAssignment,
  purchaseRequisitionItem,
  purchasingInfoRecord,
  purchasingInfoRecordOrg,
  purchasingQuotaArrangement,
  purchasingQuotaArrangementItem,
  purchasingQuotation,
  purchasingQuotationItem,
  purchasingRfq,
  purchasingRfqEvent,
  purchasingRfqItem,
} from './schema';

export class FollowOnError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'FollowOnError';
    this.remedy = remedy;
  }
}

export interface RequisitionCopy {
  requisitionNumber: string;
  requisitionItem: number;
  materialNumber: string | null;
  shortText: string;
  quantity: string;
  unit: string;
  plant: string;
  storageLocation: string | null;
  deliveryDate: string;
  warning: string | null;
}

function blank(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return text === '' ? null : text;
}

function asNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Latest average rate. A missing pair is tried in reverse. */
export async function convertMoney(
  tx: Tx,
  client: string,
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  onDate: string,
): Promise<number> {
  const from = fromCurrency.trim().toUpperCase();
  const to = toCurrency.trim().toUpperCase();
  if (from === to) return amount;
  const direct = await rate(tx, client, from, to, onDate);
  if (direct != null) return amount * direct;
  const inverse = await rate(tx, client, to, from, onDate);
  if (inverse != null && inverse !== 0) return amount / inverse;
  throw new FollowOnError(
    `No exchange rate from ${from} to ${to} stands on ${onDate}.`,
    'Maintain an average exchange rate for that pair, then save again.',
  );
}

async function rate(
  tx: Tx, client: string, from: string, to: string, onDate: string,
): Promise<number | null> {
  const [row] = await tx.select().from(exchangeRate).where(and(
    eq(exchangeRate.client, client),
    eq(exchangeRate.rateType, 'AVERAGE'),
    eq(exchangeRate.fromCurrency, from),
    eq(exchangeRate.toCurrency, to),
  )).orderBy(sql`${exchangeRate.validFrom} desc`);
  if (!row || row.validFrom > onDate) return null;
  const quoted = Number(row.rate) * row.ratioTo / row.ratioFrom;
  return row.isIndirectQuote && quoted !== 0 ? 1 / quoted : quoted;
}

async function baseQuantity(
  tx: Tx, client: string, materialNumber: string, quantity: number, unit: string,
): Promise<number> {
  try {
    const converted = await toBaseQuantity(tx, client, { materialNumber, quantity, entryUnit: unit });
    return converted.baseQuantity;
  } catch (error) {
    if (error instanceof UnitConversionError) {
      throw new FollowOnError(error.message, error.remedy);
    }
    throw error;
  }
}

/**
 * A request line may name a requisition item. The quantity is copied, not
 * consumed. Asking for more than the requisition is a warning, not a refusal,
 * because the order is what consumes it.
 */
export async function copyRequisition(
  tx: Tx,
  client: string,
  input: {
    requisitionNumber?: string | null;
    requisitionItem?: number | string | null;
    materialNumber?: string | null;
    plant?: string | null;
    quantity?: number | string | null;
    unit?: string | null;
  },
): Promise<RequisitionCopy | null> {
  const number = blank(input.requisitionNumber);
  const itemText = input.requisitionItem == null ? '' : String(input.requisitionItem).trim();
  if (!number && !itemText) return null;
  if (!number || !itemText) {
    throw new FollowOnError(
      'A requisition reference needs both the number and the item.',
      'Name the requisition and the item, or leave both empty.',
    );
  }
  const itemNumber = Number(itemText);
  if (!Number.isSafeInteger(itemNumber) || itemNumber <= 0) {
    throw new FollowOnError('A requisition item is a positive whole number.');
  }
  const [row] = await tx.select().from(purchaseRequisitionItem).where(and(
    eq(purchaseRequisitionItem.client, client),
    eq(purchaseRequisitionItem.requisitionNumber, number),
    eq(purchaseRequisitionItem.itemNumber, itemNumber),
  ));
  if (!row) throw new FollowOnError(`Requisition item ${number} / ${itemNumber} does not exist.`);
  if (row.markedForDeletion) {
    throw new FollowOnError(
      `Requisition item ${number} / ${itemNumber} is marked for deletion.`,
      'Use a standing requisition item, or ask without a requisition reference.',
    );
  }
  const materialNumber = blank(input.materialNumber);
  if (materialNumber && row.materialNumber && materialNumber !== row.materialNumber) {
    throw new FollowOnError(
      `The request asks for ${materialNumber}; requisition ${number} / ${itemNumber} asks for ${row.materialNumber}.`,
    );
  }
  const plantCode = blank(input.plant);
  if (plantCode && plantCode !== row.plant) {
    throw new FollowOnError(
      `The request names plant ${plantCode}; requisition ${number} / ${itemNumber} names plant ${row.plant}.`,
    );
  }
  const unit = blank(input.unit)?.toUpperCase();
  if (unit && unit !== row.unit && row.materialNumber) {
    await baseQuantity(tx, client, row.materialNumber, 1, unit);
    await baseQuantity(tx, client, row.materialNumber, 1, row.unit);
  }
  const asked = input.quantity == null || String(input.quantity).trim() === ''
    ? asNumber(row.quantity)
    : asNumber(input.quantity);
  let warning: string | null = null;
  if (asked > asNumber(row.quantity) + 0.0005) {
    warning = `The request asks for ${asked}, and requisition ${number} / ${itemNumber} asks for ${row.quantity}. The requisition is not consumed by the request.`;
  }
  return {
    requisitionNumber: number,
    requisitionItem: itemNumber,
    materialNumber: row.materialNumber,
    shortText: row.shortText,
    quantity: row.quantity,
    unit: row.unit,
    plant: row.plant,
    storageLocation: row.storageLocation,
    deliveryDate: row.deliveryDate,
    warning,
  };
}

export interface QuotationAdoption {
  quotationNumber: string;
  quotationItem: number;
  infoUpdate: boolean;
  requisitionNumber: string | null;
  requisitionItem: number | null;
  netPrice: number;
  priceUnit: number;
  currency: string;
  unit: string;
  materialNumber: string | null;
  shortText: string;
  plant: string;
  storageLocation: string | null;
  deliveryDate: string;
  openQuantity: number;
}

async function orderedAgainstQuotation(
  tx: Tx, client: string, quotationNumber: string, quotationItem: number, excludeOrder: string | null,
): Promise<number> {
  const rows = await tx.execute(sql`
    select coalesce(sum(quantity), 0) as ordered
      from purchase_order_item
     where client = ${client}
       and quotation_number = ${quotationNumber}
       and quotation_item = ${quotationItem}
       and not marked_for_deletion
       and (${excludeOrder}::varchar is null or order_number <> ${excludeOrder})
  `);
  return asNumber((rows as unknown as Array<{ ordered: string }>)[0]?.ordered);
}

/**
 * An order may be saved from a quotation. It does not exceed the quantity
 * still open. The requisition named through the request is returned so the
 * order can consume it, and only what remains.
 */
export async function adoptQuotation(
  tx: Tx,
  client: string,
  header: { supplierNumber: string; currency: string },
  item: {
    quotationNumber?: string | null;
    quotationItem?: number | null;
    materialNumber?: string | null;
    plant?: string | null;
    quantity: number;
    unit: string;
    markedForDeletion?: boolean;
    requisitionNumber?: string | null;
    requisitionItem?: number | null;
  },
  documentDate: string,
  excludeOrder: string | null,
): Promise<QuotationAdoption | null> {
  const number = blank(item.quotationNumber);
  if (!number && item.quotationItem == null) return null;
  if (!number || item.quotationItem == null) {
    throw new FollowOnError(
      'A quotation reference needs both the number and the item.',
      'Name the quotation and the item, or leave both empty.',
    );
  }
  const [offer] = await tx.select().from(purchasingQuotationItem).where(and(
    eq(purchasingQuotationItem.client, client),
    eq(purchasingQuotationItem.quotationNumber, number),
    eq(purchasingQuotationItem.itemNumber, item.quotationItem),
  ));
  if (!offer) throw new FollowOnError(`Quotation item ${number} / ${item.quotationItem} does not exist.`);
  const [quotation] = await tx.select().from(purchasingQuotation).where(and(
    eq(purchasingQuotation.client, client),
    eq(purchasingQuotation.quotationNumber, number),
  ));
  if (!quotation) throw new FollowOnError(`Quotation ${number} does not exist.`);
  const [request] = await tx.select().from(purchasingRfq).where(and(
    eq(purchasingRfq.client, client),
    eq(purchasingRfq.rfqNumber, quotation.rfqNumber),
  ));
  if (!request) throw new FollowOnError(`The request behind quotation ${number} does not stand.`);
  if (request.partnerNumber !== header.supplierNumber) {
    throw new FollowOnError(
      `Quotation ${number} was given by ${request.partnerNumber}, not ${header.supplierNumber}.`,
      'Save the order for the supplier who gave the quotation.',
    );
  }
  const [asked] = await tx.select().from(purchasingRfqItem).where(and(
    eq(purchasingRfqItem.client, client),
    eq(purchasingRfqItem.rfqNumber, quotation.rfqNumber),
    eq(purchasingRfqItem.itemNumber, item.quotationItem),
  ));
  if (!asked) throw new FollowOnError(`Quotation item ${number} / ${item.quotationItem} has no request line.`);
  const materialNumber = blank(item.materialNumber);
  if (materialNumber && asked.materialNumber && materialNumber !== asked.materialNumber) {
    throw new FollowOnError(
      `The order buys ${materialNumber}; quotation ${number} / ${item.quotationItem} prices ${asked.materialNumber}.`,
    );
  }
  const plantCode = blank(item.plant);
  if (plantCode && plantCode !== asked.plant) {
    throw new FollowOnError(
      `The order names plant ${plantCode}; quotation ${number} / ${item.quotationItem} names plant ${asked.plant}.`,
    );
  }
  const [event] = await tx.select().from(purchasingRfqEvent).where(and(
    eq(purchasingRfqEvent.client, client),
    eq(purchasingRfqEvent.eventNumber, request.eventNumber),
  ));
  if (!event) throw new FollowOnError(`The request event behind quotation ${number} does not stand.`);
  if (!item.markedForDeletion) {
    const already = await orderedAgainstQuotation(tx, client, number, item.quotationItem, excludeOrder);
    const offered = asNumber(offer.quantity);
    const sameUnit = item.unit.toUpperCase() === offer.unit.toUpperCase();
    const within = sameUnit
      ? already + item.quantity <= offered + 0.0005
      : await baseQuantity(tx, client, asked.materialNumber ?? materialNumber ?? '', already + item.quantity, item.unit)
        <= await baseQuantity(tx, client, asked.materialNumber ?? materialNumber ?? '', offered, offer.unit) + 0.0000001;
    if (!within) {
      throw new FollowOnError(
        `Ordering ${item.quantity} more against quotation ${number} / ${item.quotationItem} exceeds it: ${already} of ${offer.quantity} already ordered.`,
        'Reduce the order quantity to what the quotation still has open.',
      );
    }
  }
  if (item.requisitionNumber && asked.requisitionNumber && item.requisitionNumber !== asked.requisitionNumber) {
    throw new FollowOnError(
      `The order names requisition ${item.requisitionNumber}; quotation ${number} came from requisition ${asked.requisitionNumber}.`,
    );
  }
  if (
    item.requisitionItem != null && asked.requisitionItem != null
    && item.requisitionItem !== asked.requisitionItem
  ) {
    throw new FollowOnError(
      `The order names requisition item ${item.requisitionItem}; quotation ${number} came from item ${asked.requisitionItem}.`,
    );
  }
  let netPrice = asNumber(offer.netPrice);
  const priceUnit = asNumber(offer.priceUnit) || 1;
  if (offer.unit.toUpperCase() !== item.unit.toUpperCase() && asked.materialNumber) {
    const oneOrder = await baseQuantity(tx, client, asked.materialNumber, 1, item.unit);
    const oneOffer = await baseQuantity(tx, client, asked.materialNumber, 1, offer.unit);
    if (oneOffer === 0) {
      throw new FollowOnError(`Material ${asked.materialNumber} has no base quantity for ${offer.unit}.`);
    }
    netPrice = netPrice * (oneOrder / oneOffer);
  }
  return {
    quotationNumber: number,
    quotationItem: item.quotationItem,
    infoUpdate: offer.infoUpdate,
    requisitionNumber: asked.requisitionNumber,
    requisitionItem: asked.requisitionItem,
    netPrice,
    priceUnit: offer.unit.toUpperCase() === item.unit.toUpperCase() ? priceUnit : 1,
    currency: event.currency.trim(),
    unit: offer.unit,
    materialNumber: asked.materialNumber,
    shortText: asked.shortText,
    plant: asked.plant,
    storageLocation: asked.storageLocation,
    deliveryDate: offer.deliveryDate,
    openQuantity: asNumber(offer.quantity) - await orderedAgainstQuotation(tx, client, number, item.quotationItem, excludeOrder),
  };
}

export interface QuotaSettlement {
  quotaNumber: string | null;
  quotaItem: string | null;
  warning: string | null;
}

/**
 * Add the order quantity to the vendor's quota base when that vendor stands
 * in the quota. Otherwise warn. A change first removes what the standing item
 * had added.
 */
export async function settleQuota(
  tx: Tx,
  client: string,
  input: {
    materialNumber: string | null;
    plant: string;
    supplierNumber: string;
    purchasingOrg: string;
    documentDate: string;
    quantity: number;
    unit: string;
    markedForDeletion: boolean;
    orderNumber: string | null;
    itemNumber: number | null;
  },
): Promise<QuotaSettlement> {
  if (input.orderNumber && input.itemNumber != null) {
    const [standing] = await tx.select().from(purchaseOrderItem).where(and(
      eq(purchaseOrderItem.client, client),
      eq(purchaseOrderItem.orderNumber, input.orderNumber),
      eq(purchaseOrderItem.itemNumber, input.itemNumber),
    ));
    if (standing?.quotaNumber && standing.quotaItem && !standing.markedForDeletion && standing.materialNumber) {
      const previous = await baseQuantity(
        tx, client, standing.materialNumber, asNumber(standing.quantity), standing.unit,
      );
      await addBase(tx, client, standing.quotaNumber, standing.quotaItem, -previous);
    }
  }
  if (!input.materialNumber || input.markedForDeletion || input.quantity <= 0) {
    return { quotaNumber: null, quotaItem: null, warning: null };
  }
  const arrangements = await tx.select().from(purchasingQuotaArrangement).where(and(
    eq(purchasingQuotaArrangement.client, client),
    eq(purchasingQuotaArrangement.materialNumber, input.materialNumber),
    eq(purchasingQuotaArrangement.plant, input.plant),
    eq(purchasingQuotaArrangement.markedForDeletion, false),
  ));
  const standing = arrangements.filter((row) => row.validFrom <= input.documentDate && row.validTo >= input.documentDate);
  if (standing.length === 0) return { quotaNumber: null, quotaItem: null, warning: null };
  if (standing.length > 1) {
    throw new FollowOnError(
      `More than one quota arrangement stands for ${input.materialNumber} at plant ${input.plant} on ${input.documentDate}.`,
      'Retire the overlap, then save the order.',
    );
  }
  const arrangement = standing[0];
  const items = await tx.select().from(purchasingQuotaArrangementItem).where(and(
    eq(purchasingQuotaArrangementItem.client, client),
    eq(purchasingQuotaArrangementItem.quotaNumber, arrangement.quotaNumber),
    eq(purchasingQuotaArrangementItem.markedForDeletion, false),
  ));
  const vendor = items.find((row) =>
    row.partnerNumber === input.supplierNumber && row.purchasingOrg === input.purchasingOrg);
  if (!vendor) {
    return {
      quotaNumber: null,
      quotaItem: null,
      warning: `Supplier ${input.supplierNumber} is not in quota ${arrangement.quotaNumber} for ${input.materialNumber} at plant ${input.plant}. The order is saved, and the quota base is not changed.`,
    };
  }
  const added = await baseQuantity(tx, client, input.materialNumber, input.quantity, input.unit);
  await addBase(tx, client, arrangement.quotaNumber, vendor.itemNumber, added);
  return { quotaNumber: arrangement.quotaNumber, quotaItem: vendor.itemNumber, warning: null };
}

async function addBase(
  tx: Tx, client: string, quotaNumber: string, itemNumber: string, delta: number,
): Promise<void> {
  const rows = await tx.execute(sql`
    select quota_base_quantity
      from purchasing_quota_arrangement_item
     where client = ${client} and quota_number = ${quotaNumber} and item_number = ${itemNumber}
     for update
  `);
  const current = asNumber((rows as unknown as Array<{ quota_base_quantity: string }>)[0]?.quota_base_quantity);
  const next = Math.max(0, Math.round((current + delta) * 1000) / 1000);
  await tx.update(purchasingQuotaArrangementItem).set({
    quotaBaseQuantity: next.toFixed(3),
  }).where(and(
    eq(purchasingQuotaArrangementItem.client, client),
    eq(purchasingQuotaArrangementItem.quotaNumber, quotaNumber),
    eq(purchasingQuotaArrangementItem.itemNumber, itemNumber),
  ));
}

/**
 * Write the order price into the info record. Called only when the quotation
 * carried the indicator, and only after the order itself has been judged.
 */
export async function updateInfoRecordFromOrder(
  tx: Tx,
  input: {
    client: string;
    changedBy: string;
    supplierNumber: string;
    materialNumber: string;
    purchasingOrg: string;
    plant: string;
    amount: number;
    currency: string;
    priceUnit: number;
    unit: string;
    documentDate: string;
  },
): Promise<string | null> {
  const [supplierOrg] = await tx.select().from(supplierPurchasing).where(and(
    eq(supplierPurchasing.client, input.client),
    eq(supplierPurchasing.partnerNumber, input.supplierNumber),
    eq(supplierPurchasing.purchasingOrg, input.purchasingOrg),
  ));
  const targetCurrency = (supplierOrg?.orderCurrency ?? input.currency).trim().toUpperCase();
  const amount = await convertMoney(
    tx, input.client, input.amount, input.currency, targetCurrency, input.documentDate,
  );
  const [general] = await tx.select().from(purchasingInfoRecord).where(and(
    eq(purchasingInfoRecord.client, input.client),
    eq(purchasingInfoRecord.partnerNumber, input.supplierNumber),
    eq(purchasingInfoRecord.materialNumber, input.materialNumber),
    eq(purchasingInfoRecord.category, 'STANDARD'),
  ));
  const price = {
    amount: Number(amount.toFixed(2)),
    currency: targetCurrency,
    priceUnit: input.priceUnit,
    priceUnitOfMeasure: input.unit,
    validFrom: input.documentDate,
    validTo: '9999-12-31',
  };
  try {
    if (!general) {
      await writePurchasingInfoRecord(tx, {
        client: input.client,
        changedBy: input.changedBy,
        partnerNumber: input.supplierNumber,
        materialNumber: input.materialNumber,
        purchasingOrg: input.purchasingOrg,
        plant: input.plant,
        orderUnit: input.unit,
        price,
      });
      return null;
    }
    const segments = await tx.select().from(purchasingInfoRecordOrg).where(and(
      eq(purchasingInfoRecordOrg.client, input.client),
      eq(purchasingInfoRecordOrg.infoRecordNumber, general.infoRecordNumber),
      eq(purchasingInfoRecordOrg.purchasingOrg, input.purchasingOrg),
    ));
    const segment = segments.find((row) => row.plant === input.plant)
      ?? segments.find((row) => row.plant == null);
    if (!segment) {
      await writePurchasingInfoRecord(tx, {
        client: input.client,
        changedBy: input.changedBy,
        partnerNumber: input.supplierNumber,
        materialNumber: input.materialNumber,
        purchasingOrg: input.purchasingOrg,
        plant: input.plant,
        infoRecordNumber: general.infoRecordNumber,
        expectedVersion: general.version,
        orderUnit: input.unit,
        price,
      });
      return null;
    }
    await writePurchasingInfoRecordChange(tx, {
      client: input.client,
      changedBy: input.changedBy,
      reason: `Order price ${input.amount} ${price.currency} from ${input.documentDate}`,
      infoRecordNumber: general.infoRecordNumber,
      expectedVersion: general.version,
      segmentNumber: segment.segmentNumber,
      expectedSegmentVersion: segment.version,
      newPrice: price,
    });
    return null;
  } catch (error) {
    if (error instanceof InfoRecordError && /Nothing on the info record/.test(error.message)) return null;
    if (error instanceof InfoRecordError && /marked for deletion|is blocked|already starts|overlaps/.test(error.message)) {
      return `${error.message} The info record was not updated. The order is not refused.`;
    }
    if (error instanceof InfoRecordError) throw new FollowOnError(error.message, error.remedy);
    throw error;
  }
}

export interface OrderDraft {
  supplierNumber: string;
  purchasingOrg: string;
  purchasingGroup: string;
  companyCode: string;
  currency: string;
  quotationNumber: string;
  items: Array<{
    materialNumber: string;
    shortText: string;
    quantity: number;
    unit: string;
    netPrice: number | null;
    priceUnit: number;
    plant: string;
    storageLocation: string;
    requisitionNumber: string;
    requisitionItem: number | null;
    quotationNumber: string;
    quotationItem: number | null;
    deliveryDate: string;
    accountAssignmentCategory: 'COST_CENTER' | null;
    assignments: Array<{ glAccount: string; costCenter: string; percentage: string }>;
  }>;
  warning: string | null;
}

/** What the order screen shows when it is opened from a quotation. Nothing is written. */
export async function orderDraftFromQuotation(client: string, quotationNumber: string): Promise<OrderDraft | null> {
  const { withTenant } = await import('../../platform/db/client');
  return withTenant(client, async (tx) => {
    const [quotation] = await tx.select().from(purchasingQuotation).where(and(
      eq(purchasingQuotation.client, client),
      eq(purchasingQuotation.quotationNumber, quotationNumber),
    ));
    if (!quotation) return null;
    const [request] = await tx.select().from(purchasingRfq).where(and(
      eq(purchasingRfq.client, client),
      eq(purchasingRfq.rfqNumber, quotation.rfqNumber),
    ));
    if (!request) return null;
    const [event] = await tx.select().from(purchasingRfqEvent).where(and(
      eq(purchasingRfqEvent.client, client),
      eq(purchasingRfqEvent.eventNumber, request.eventNumber),
    ));
    if (!event) return null;
    const offers = await tx.select().from(purchasingQuotationItem).where(and(
      eq(purchasingQuotationItem.client, client),
      eq(purchasingQuotationItem.quotationNumber, quotationNumber),
    ));
    const asked = await tx.select().from(purchasingRfqItem).where(and(
      eq(purchasingRfqItem.client, client),
      eq(purchasingRfqItem.rfqNumber, quotation.rfqNumber),
    ));
    const askedByItem = new Map(asked.map((row) => [row.itemNumber, row]));
    const items = [];
    let company = '';
    let warning: string | null = null;
    for (const offer of offers) {
      const line = askedByItem.get(offer.itemNumber);
      if (!line) continue;
      const already = await orderedAgainstQuotation(tx, client, quotationNumber, offer.itemNumber, null);
      const open = Math.max(0, asNumber(offer.quantity) - already);
      if (open <= 0) {
        warning = `Quotation ${quotationNumber} item ${offer.itemNumber} has no quantity still open.`;
        continue;
      }
      const [plantRow] = await tx.select().from(plant).where(and(
        eq(plant.client, client),
        eq(plant.plant, line.plant),
      ));
      company = plantRow?.companyCode ?? company;
      items.push({
        materialNumber: line.materialNumber ?? '',
        shortText: line.shortText,
        quantity: open,
        unit: offer.unit,
        netPrice: asNumber(offer.netPrice),
        priceUnit: asNumber(offer.priceUnit) || 1,
        plant: line.plant,
        storageLocation: line.storageLocation ?? '',
        requisitionNumber: line.requisitionNumber ?? '',
        requisitionItem: line.requisitionItem,
        quotationNumber,
        quotationItem: offer.itemNumber,
        deliveryDate: offer.deliveryDate,
        accountAssignmentCategory: null,
        assignments: [],
      });
    }
    if (!company || items.length === 0) return null;
    return {
      supplierNumber: request.partnerNumber,
      purchasingOrg: event.purchasingOrg,
      purchasingGroup: event.purchasingGroup,
      companyCode: company,
      currency: event.currency.trim(),
      quotationNumber,
      items,
      warning,
    };
  });
}

async function orderedAgainstRequisition(
  tx: Tx, client: string, requisitionNumber: string, requisitionItem: number,
): Promise<number> {
  const rows = await tx.execute(sql`
    select coalesce(sum(quantity), 0) as ordered
      from purchase_order_item
     where client = ${client}
       and requisition_number = ${requisitionNumber}
       and requisition_item = ${requisitionItem}
       and not marked_for_deletion
  `);
  return asNumber((rows as unknown as Array<{ ordered: string }>)[0]?.ordered);
}

/**
 * What the order screen shows when it is opened from a requisition.
 * A request and a quotation are not required. Nothing is written.
 */
export async function orderDraftFromRequisition(client: string, requisitionNumber: string): Promise<OrderDraft | null> {
  const number = requisitionNumber.trim();
  if (!number) return null;
  const { withTenant } = await import('../../platform/db/client');
  return withTenant(client, async (tx) => {
    const empty = (warning: string): OrderDraft => ({
      supplierNumber: '',
      purchasingOrg: '',
      purchasingGroup: '',
      companyCode: '',
      currency: '',
      quotationNumber: '',
      items: [],
      warning,
    });
    const lines = await tx.select().from(purchaseRequisitionItem).where(and(
      eq(purchaseRequisitionItem.client, client),
      eq(purchaseRequisitionItem.requisitionNumber, number),
    ));
    if (lines.length === 0) return empty(`Requisition ${number} does not exist.`);
    const [release] = await tx.select().from(documentRelease).where(and(
      eq(documentRelease.client, client),
      eq(documentRelease.documentCategory, 'PURCHASE_REQUISITION'),
      eq(documentRelease.documentNumber, number),
    ));
    if (release && release.status !== 'RELEASED') {
      return empty(`Requisition ${number} is not released. Release it, then create the order.`);
    }
    const assignments = await tx.select().from(purchaseRequisitionAssignment).where(and(
      eq(purchaseRequisitionAssignment.client, client),
      eq(purchaseRequisitionAssignment.requisitionNumber, number),
    ));
    const warnings: string[] = [];
    const items: OrderDraft['items'] = [];
    let company = '';
    let currency = '';
    let group = '';
    let purchasingOrg = '';
    for (const line of lines) {
      if (line.markedForDeletion) continue;
      const already = await orderedAgainstRequisition(tx, client, number, line.itemNumber);
      const open = Math.round((asNumber(line.quantity) - already) * 1000) / 1000;
      if (open <= 0) {
        warnings.push(`Requisition ${number} item ${line.itemNumber} has no quantity still open.`);
        continue;
      }
      const [plantRow] = await tx.select().from(plant).where(and(
        eq(plant.client, client),
        eq(plant.plant, line.plant),
      ));
      if (!plantRow?.companyCode) {
        warnings.push(`Plant ${line.plant} belongs to no company, so item ${line.itemNumber} was not copied.`);
        continue;
      }
      if (company && plantRow.companyCode !== company) {
        warnings.push(`Item ${line.itemNumber} belongs to company ${plantRow.companyCode}, not ${company}. It was not copied.`);
        continue;
      }
      company = plantRow.companyCode;
      const [companyRow] = await tx.select().from(companyCode).where(and(
        eq(companyCode.client, client),
        eq(companyCode.companyCode, company),
      ));
      const orgs = await tx.select().from(purchasingOrgPlant).where(and(
        eq(purchasingOrgPlant.client, client),
        eq(purchasingOrgPlant.plant, line.plant),
      ));
      const org = orgs.length === 1 ? orgs[0].purchasingOrg : '';
      if (orgs.length !== 1) {
        warnings.push(`Plant ${line.plant} does not name one purchasing organisation. Choose it on the order.`);
      } else if (purchasingOrg && org !== purchasingOrg) {
        warnings.push(`Item ${line.itemNumber} belongs to purchasing organisation ${org}. Choose one organisation on the order.`);
        purchasingOrg = '';
      } else {
        purchasingOrg = org;
      }
      if (!group) group = line.purchasingGroup;
      else if (group !== line.purchasingGroup) {
        warnings.push(`The requisition items do not share one purchasing group. The first group, ${group}, is proposed.`);
      }
      const priceCurrency = line.currency?.trim() ?? '';
      const local = companyRow?.currency?.trim() ?? '';
      if (!currency) currency = priceCurrency || local;
      const priced = line.estimatedPrice != null && (!priceCurrency || !currency || priceCurrency === currency);
      if (line.estimatedPrice != null && priceCurrency && currency && priceCurrency !== currency) {
        warnings.push(`Item ${line.itemNumber} is estimated in ${priceCurrency}. The order price was left blank.`);
      }
      items.push({
        materialNumber: line.materialNumber ?? '',
        shortText: line.shortText,
        quantity: open,
        unit: line.unit,
        netPrice: priced ? asNumber(line.estimatedPrice) : null,
        priceUnit: asNumber(line.priceUnit) || 1,
        plant: line.plant,
        storageLocation: line.storageLocation ?? '',
        requisitionNumber: number,
        requisitionItem: line.itemNumber,
        quotationNumber: '',
        quotationItem: null,
        deliveryDate: line.deliveryDate,
        accountAssignmentCategory: line.accountAssignmentCategory === 'COST_CENTER' ? 'COST_CENTER' : null,
        assignments: assignments.filter((row) => row.itemNumber === line.itemNumber).map((row) => ({
          glAccount: row.glAccount,
          costCenter: row.costCenter,
          percentage: row.distributionPercentage,
        })),
      });
    }
    if (items.length === 0) {
      return empty(warnings[0] ?? `Requisition ${number} has no quantity still open.`);
    }
    warnings.unshift('Name the supplier. A requisition does not choose one, and a request is not required.');
    return {
      supplierNumber: '',
      purchasingOrg,
      purchasingGroup: group,
      companyCode: company,
      currency,
      quotationNumber: '',
      items,
      warning: warnings.join(' '),
    };
  });
}
