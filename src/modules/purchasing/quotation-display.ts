/**
 * Display a quotation — SCR-158.
 *
 * A read of the quotation that already stands. The supplier and the currency
 * are read from the request. They are not stored again. The price per one unit
 * is calculated for the screen and is not a column. There is no status, no
 * revision, and no condition. This module writes nothing.
 */
import { and, asc, desc, eq } from 'drizzle-orm';

import { changeDocument, changeDocumentItem } from '../../platform/tables/audit-trail';
import { withTenant } from '../../platform/db/client';
import { businessPartner } from '../foundation/business-partner-schema';
import { plant } from '../foundation/schema';
import { pricePerUnit } from './quotation';
import {
  purchasingQuotation, purchasingQuotationItem, purchasingRfq, purchasingRfqEvent, purchasingRfqItem,
} from './schema';

export const QUOTATION_DISPLAY_CAPABILITY = 'PROC.RFQ.QUOTATION.DISPLAY';
export const QUOTATION_DISPLAY_ROUTE = '/purchasing/quotation-display';
const QUOTATION_CLASS = 'purchasing_quotation';

export interface DisplayedOffer {
  itemNumber: number;
  shortText: string;
  materialNumber: string | null;
  plant: string;
  companyCode: string | null;
  askedQuantity: string;
  askedUnit: string;
  askedDelivery: string;
  offer: {
    quantity: string;
    unit: string;
    netPrice: string;
    priceUnit: string;
    /** Calculated for display. Not stored. */
    pricePerUnit: string;
    deliveryDate: string;
    remark: string | null;
  } | null;
}

export interface DisplayedChange {
  changeType: string;
  changedBy: string;
  changedAt: string;
  reason: string | null;
  fieldName: string | null;
  oldValue: string | null;
  newValue: string | null;
}

export interface DisplayedQuotation {
  quotationNumber: string;
  rfqNumber: string;
  eventNumber: string;
  partnerNumber: string;
  partnerName: string;
  purchasingOrg: string;
  purchasingGroup: string;
  rfqDate: string;
  quotationDeadline: string;
  currency: string;
  collectiveNumber: string | null;
  companyCodes: string[];
  savedBy: string;
  savedAt: string;
  lines: DisplayedOffer[];
  changes: DisplayedChange[];
}

export type QuotationDisplayResult =
  | { found: true; quotation: DisplayedQuotation }
  | { found: false; reason: 'quotation' | 'request' | 'no-offer'; number: string };

function keyOf(value: string | null | undefined): string {
  return value?.trim().toUpperCase() ?? '';
}

function when(value: Date | string | null | undefined): string {
  if (value == null || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

async function readQuotation(client: string, quotationNumber: string): Promise<DisplayedQuotation | null> {
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(purchasingQuotation).where(and(
      eq(purchasingQuotation.client, client),
      eq(purchasingQuotation.quotationNumber, quotationNumber),
    ));
    if (!header) return null;
    const [request] = await tx.select().from(purchasingRfq).where(and(
      eq(purchasingRfq.client, client),
      eq(purchasingRfq.rfqNumber, header.rfqNumber),
    ));
    if (!request) return null;
    const [event] = await tx.select().from(purchasingRfqEvent).where(and(
      eq(purchasingRfqEvent.client, client),
      eq(purchasingRfqEvent.eventNumber, request.eventNumber),
    ));
    if (!event) return null;
    const [partner] = await tx.select({ name: businessPartner.name }).from(businessPartner).where(and(
      eq(businessPartner.client, client),
      eq(businessPartner.partnerNumber, request.partnerNumber),
    ));
    const asked = await tx.select().from(purchasingRfqItem).where(and(
      eq(purchasingRfqItem.client, client),
      eq(purchasingRfqItem.rfqNumber, header.rfqNumber),
    )).orderBy(asc(purchasingRfqItem.itemNumber));
    const offered = await tx.select().from(purchasingQuotationItem).where(and(
      eq(purchasingQuotationItem.client, client),
      eq(purchasingQuotationItem.quotationNumber, quotationNumber),
    )).orderBy(asc(purchasingQuotationItem.itemNumber));
    const companies = await tx.select({
      plantCode: purchasingRfqItem.plant,
      companyCode: plant.companyCode,
    }).from(purchasingRfqItem)
      .innerJoin(plant, and(
        eq(plant.client, purchasingRfqItem.client),
        eq(plant.plant, purchasingRfqItem.plant),
      ))
      .where(and(
        eq(purchasingRfqItem.client, client),
        eq(purchasingRfqItem.rfqNumber, header.rfqNumber),
      ));
    const companyByPlant = new Map(companies.map((row) => [row.plantCode, row.companyCode]));
    const history = await tx.select({
      changeType: changeDocument.changeType,
      changedBy: changeDocument.changedBy,
      changedAt: changeDocument.changedAt,
      reason: changeDocument.reason,
      fieldName: changeDocumentItem.fieldName,
      oldValue: changeDocumentItem.oldValue,
      newValue: changeDocumentItem.newValue,
    }).from(changeDocument)
      .leftJoin(changeDocumentItem, and(
        eq(changeDocumentItem.client, changeDocument.client),
        eq(changeDocumentItem.changeDocumentId, changeDocument.id),
      ))
      .where(and(
        eq(changeDocument.client, client),
        eq(changeDocument.objectClass, QUOTATION_CLASS),
        eq(changeDocument.objectKey, quotationNumber),
      ))
      .orderBy(asc(changeDocument.changedAt), asc(changeDocumentItem.fieldName));
    const byItem = new Map(offered.map((row) => [row.itemNumber, row]));
    return {
      quotationNumber: header.quotationNumber,
      rfqNumber: request.rfqNumber,
      eventNumber: request.eventNumber,
      partnerNumber: request.partnerNumber,
      partnerName: partner?.name ?? '',
      purchasingOrg: event.purchasingOrg,
      purchasingGroup: event.purchasingGroup,
      rfqDate: event.rfqDate,
      quotationDeadline: event.quotationDeadline,
      currency: event.currency.trim(),
      collectiveNumber: event.collectiveNumber,
      companyCodes: [...new Set([...companyByPlant.values()].filter((code): code is string => Boolean(code)))].sort(),
      savedBy: header.createdBy,
      savedAt: when(header.createdAt),
      lines: asked.map((row) => {
        const offer = byItem.get(row.itemNumber) ?? null;
        return {
          itemNumber: row.itemNumber,
          shortText: row.shortText,
          materialNumber: row.materialNumber,
          plant: row.plant,
          companyCode: companyByPlant.get(row.plant) ?? null,
          askedQuantity: row.quantity,
          askedUnit: row.unit,
          askedDelivery: row.deliveryDate,
          offer: offer ? {
            quantity: offer.quantity,
            unit: offer.unit,
            netPrice: offer.netPrice,
            priceUnit: offer.priceUnit,
            pricePerUnit: pricePerUnit(offer.netPrice, offer.priceUnit),
            deliveryDate: offer.deliveryDate,
            remark: offer.remark,
          } : null,
        };
      }),
      changes: history.map((row) => ({
        changeType: row.changeType,
        changedBy: row.changedBy,
        changedAt: when(row.changedAt),
        reason: row.reason,
        fieldName: row.fieldName,
        oldValue: row.oldValue,
        newValue: row.newValue,
      })),
    };
  });
}

/** The quotation number is the key. A request number is not accepted here. */
export async function displayQuotation(client: string, quotationNumber: string): Promise<QuotationDisplayResult> {
  const number = keyOf(quotationNumber);
  if (!number) return { found: false, reason: 'quotation', number: '' };
  const quotation = await readQuotation(client, number);
  return quotation ? { found: true, quotation } : { found: false, reason: 'quotation', number };
}

/** The request number resolves the one quotation that stands for it. It is not the quotation number. */
export async function displayQuotationForRequest(client: string, rfqNumber: string): Promise<QuotationDisplayResult> {
  const number = keyOf(rfqNumber);
  if (!number) return { found: false, reason: 'request', number: '' };
  const quotationNumber = await withTenant(client, async (tx) => {
    const [request] = await tx.select({ rfqNumber: purchasingRfq.rfqNumber }).from(purchasingRfq).where(and(
      eq(purchasingRfq.client, client),
      eq(purchasingRfq.rfqNumber, number),
    ));
    if (!request) return null;
    const [header] = await tx.select({ quotationNumber: purchasingQuotation.quotationNumber }).from(purchasingQuotation).where(and(
      eq(purchasingQuotation.client, client),
      eq(purchasingQuotation.rfqNumber, number),
    ));
    return header?.quotationNumber ?? '';
  });
  if (quotationNumber == null) return { found: false, reason: 'request', number };
  if (quotationNumber === '') return { found: false, reason: 'no-offer', number };
  const quotation = await readQuotation(client, quotationNumber);
  return quotation ? { found: true, quotation } : { found: false, reason: 'no-offer', number };
}

export async function listRecentDisplayedQuotations(client: string): Promise<Array<{
  quotationNumber: string;
  rfqNumber: string;
  partnerNumber: string;
  quotationDeadline: string;
}>> {
  return withTenant(client, (tx) => tx.select({
    quotationNumber: purchasingQuotation.quotationNumber,
    rfqNumber: purchasingQuotation.rfqNumber,
    partnerNumber: purchasingRfq.partnerNumber,
    quotationDeadline: purchasingRfqEvent.quotationDeadline,
  }).from(purchasingQuotation)
    .innerJoin(purchasingRfq, and(
      eq(purchasingRfq.client, purchasingQuotation.client),
      eq(purchasingRfq.rfqNumber, purchasingQuotation.rfqNumber),
    ))
    .innerJoin(purchasingRfqEvent, and(
      eq(purchasingRfqEvent.client, purchasingRfq.client),
      eq(purchasingRfqEvent.eventNumber, purchasingRfq.eventNumber),
    ))
    .where(eq(purchasingQuotation.client, client))
    .orderBy(desc(purchasingQuotation.quotationNumber))
    .limit(20));
}
