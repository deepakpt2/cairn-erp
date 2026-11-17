/**
 * Printable purchase order and request for quotation — the PDF that goes to the supplier.
 *
 * Built on demand from the document as it stands, on the letterhead of its company code (see
 * `output/document-text.ts`). A purchase order must be released before it is printed: an unreleased
 * order is not yet a commitment, and a PDF of it would read like one. Items marked for deletion are
 * left off. Prices are the order's own figures, never re-derived.
 */
import { and, asc, eq } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/pattern';
import type { PdfDownload } from '../output/download-pdf';
import { PdfDownloadError } from '../output/download-pdf';
import { RULE, THIN, addressBlock, buildDocumentPdf, money, pad, padStart, trimQuantity } from '../output/document-text';
import { purchasingOrg } from '../foundation/schema';
import { RFQ_CAPABILITY } from './rfq';
import { PO_DISPLAY_CAPABILITY } from './purchase-order-display';
import {
  purchaseOrder, purchaseOrderItem, purchasingRfq, purchasingRfqEvent, purchasingRfqItem,
} from './schema';

function forbidden(capability: string): never {
  throw new PdfDownloadError(`Printing needs ${capability}, which this session does not hold.`, `Ask an administrator to grant ${capability}.`);
}

export async function purchaseOrderPdf(input: { client: string; orderNumber: string; capabilities: string[] }): Promise<PdfDownload> {
  if (!hasCapability(input.capabilities, PO_DISPLAY_CAPABILITY)) forbidden(PO_DISPLAY_CAPABILITY);
  const { client, orderNumber } = input;
  return buildDocumentPdf(client, async (tx) => {
    const [po] = await tx.select().from(purchaseOrder).where(and(
      eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, orderNumber),
    )).limit(1);
    if (!po) return null;
    if (po.releaseStatus !== 'RELEASED') {
      throw new PdfDownloadError(
        `Purchase order ${orderNumber} is not released, so it cannot be printed.`,
        'Release the order first; an unreleased order is not yet a commitment to the supplier.',
      );
    }
    const items = (await tx.select().from(purchaseOrderItem).where(and(
      eq(purchaseOrderItem.client, client), eq(purchaseOrderItem.orderNumber, orderNumber),
    )).orderBy(asc(purchaseOrderItem.itemNumber))).filter((i) => !i.markedForDeletion);

    const out: string[] = [RULE, padStart('PURCHASE ORDER', 48), RULE];
    out.push(`${pad('Order', 20)}${pad(orderNumber, 22)}${pad('Date', 12)}${po.documentDate}`);
    out.push(`${pad('Purchasing org', 20)}${pad(`${po.purchasingOrg}/${po.purchasingGroup}`, 22)}${pad('Currency', 12)}${po.currency}`);
    if (po.paymentTermsCode) out.push(`${pad('Payment terms', 20)}${po.paymentTermsCode}`);
    if (po.incotermsCode) out.push(`${pad('Incoterms', 20)}${po.incotermsCode}${po.incotermsLocation ? ` ${po.incotermsLocation}` : ''}`);
    out.push(THIN);
    out.push(...await addressBlock(tx, client, po.supplierNumber, 'Supplier'));
    out.push(THIN);
    out.push(`${padStart('It', 4)} ${pad('Material / description', 28)}${padStart('Quantity', 10)} ${pad('Unit', 5)}${padStart('Price', 10)}${padStart('Amount', 11)}`);
    let total = 0;
    for (const item of items) {
      total += Number(item.netValue);
      out.push([
        padStart(String(item.itemNumber), 4),
        pad(`${item.materialNumber ? `${item.materialNumber} ` : ''}${item.shortText}`.trim(), 28),
        padStart(trimQuantity(item.quantity), 10),
        pad(item.unit, 5),
        padStart(money(item.netPrice), 10),
        padStart(money(item.netValue), 11),
      ].join(' '));
      out.push(`${pad('', 5)}Plant ${item.plant}${item.storageLocation ? `/${item.storageLocation}` : ''}`);
    }
    out.push(THIN);
    out.push(`${padStart('Net value', 56)}${padStart(money(total), 12)} ${po.currency}`);
    out.push(RULE);
    return { companyCode: po.companyCode, title: 'Purchase order', documentNumber: orderNumber, bodyText: out.join('\n') };
  });
}

/** One request to one supplier: the RFQ number is per supplier, the event number is shared. */
export async function rfqPdf(input: { client: string; rfqNumber: string; capabilities: string[] }): Promise<PdfDownload> {
  if (!hasCapability(input.capabilities, RFQ_CAPABILITY)) forbidden(RFQ_CAPABILITY);
  const { client, rfqNumber } = input;
  return buildDocumentPdf(client, async (tx) => {
    const [rfq] = await tx.select().from(purchasingRfq).where(and(
      eq(purchasingRfq.client, client), eq(purchasingRfq.rfqNumber, rfqNumber),
    )).limit(1);
    if (!rfq) return null;
    const [event] = await tx.select().from(purchasingRfqEvent).where(and(
      eq(purchasingRfqEvent.client, client), eq(purchasingRfqEvent.eventNumber, rfq.eventNumber),
    )).limit(1);
    if (!event) return null;
    const [org] = await tx.select({ companyCode: purchasingOrg.companyCode }).from(purchasingOrg).where(and(
      eq(purchasingOrg.client, client), eq(purchasingOrg.purchasingOrg, event.purchasingOrg),
    )).limit(1);
    if (!org?.companyCode) {
      throw new PdfDownloadError(
        `Purchasing organisation ${event.purchasingOrg} is not assigned to a company code, so there is no letterhead for this request.`,
        'Assign the purchasing organisation to a company code.',
      );
    }
    const items = await tx.select().from(purchasingRfqItem).where(and(
      eq(purchasingRfqItem.client, client), eq(purchasingRfqItem.rfqNumber, rfqNumber),
    )).orderBy(asc(purchasingRfqItem.itemNumber));

    const out: string[] = [RULE, padStart('REQUEST FOR QUOTATION', 50), RULE];
    out.push(`${pad('Request', 20)}${pad(rfqNumber, 22)}${pad('Date', 12)}${event.rfqDate}`);
    out.push(`${pad('Purchasing org', 20)}${pad(`${event.purchasingOrg}/${event.purchasingGroup}`, 22)}${pad('Reply by', 12)}${event.quotationDeadline}`);
    out.push(THIN);
    out.push(...await addressBlock(tx, client, rfq.partnerNumber, 'Supplier'));
    out.push(THIN);
    out.push('Please quote your price and delivery for the items below.');
    out.push(`${padStart('It', 4)} ${pad('Material / description', 30)}${padStart('Quantity', 10)} ${pad('Unit', 5)}${pad('Deliver by', 12)}`);
    for (const item of items) {
      out.push([
        padStart(String(item.itemNumber), 4),
        pad(`${item.materialNumber ? `${item.materialNumber} ` : ''}${item.shortText}`.trim(), 30),
        padStart(trimQuantity(item.quantity), 10),
        pad(item.unit, 5),
        pad(item.deliveryDate, 12),
      ].join(' '));
    }
    out.push(RULE);
    return { companyCode: org.companyCode, title: 'Request for quotation', documentNumber: rfqNumber, bodyText: out.join('\n') };
  });
}
