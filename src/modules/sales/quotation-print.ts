/**
 * Printable sales quotation — the offer the customer receives, with its validity date.
 *
 * Built on demand from the quotation as it stands, on the letterhead of its company code. A rejected
 * quotation is not an offer, so it is refused rather than printed; rejected lines are left off.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/pattern';
import { PdfDownloadError, type PdfDownload } from '../output/download-pdf';
import { RULE, THIN, addressBlock, buildDocumentPdf, money, pad, padStart, trimQuantity } from '../output/document-text';
import { material } from '../inventory/schema';
import { SALES_QUOTATION_CAPABILITY } from './quotation';
import { salesQuotation, salesQuotationLine } from './schema';

export async function salesQuotationPdf(input: { client: string; quotationNumber: string; capabilities: string[] }): Promise<PdfDownload> {
  if (!hasCapability(input.capabilities, SALES_QUOTATION_CAPABILITY)) {
    throw new PdfDownloadError(
      `Printing needs ${SALES_QUOTATION_CAPABILITY}, which this session does not hold.`,
      `Ask an administrator to grant ${SALES_QUOTATION_CAPABILITY}.`,
    );
  }
  const { client, quotationNumber } = input;
  return buildDocumentPdf(client, async (tx) => {
    const [q] = await tx.select().from(salesQuotation).where(and(
      eq(salesQuotation.client, client), eq(salesQuotation.quotationNumber, quotationNumber),
    )).limit(1);
    if (!q) return null;
    if (q.status !== 'OPEN') {
      throw new PdfDownloadError(`Quotation ${quotationNumber} is rejected, so it is not an offer and cannot be printed.`);
    }
    const lines = (await tx.select().from(salesQuotationLine).where(and(
      eq(salesQuotationLine.client, client), eq(salesQuotationLine.quotationNumber, quotationNumber),
    )).orderBy(asc(salesQuotationLine.lineNumber))).filter((l) => l.status === 'OPEN');
    const numbers = [...new Set(lines.map((l) => l.materialNumber))];
    const names = new Map<string, string>();
    if (numbers.length > 0) {
      for (const row of await tx.select({ n: material.materialNumber, d: material.description }).from(material).where(and(
        eq(material.client, client), inArray(material.materialNumber, numbers),
      ))) if (row.d) names.set(row.n, row.d);
    }

    const out: string[] = [RULE, padStart('QUOTATION', 44), RULE];
    out.push(`${pad('Quotation', 20)}${pad(quotationNumber, 22)}${pad('Date', 12)}${q.quotationDate}`);
    out.push(`${pad('Valid until', 20)}${pad(q.validTo, 22)}${pad('Currency', 12)}${q.currency}`);
    if (q.purchaseOrderReference) out.push(`${pad('Your reference', 20)}${q.purchaseOrderReference}`);
    if (q.headerText) out.push(`${pad('Text', 20)}${q.headerText}`);
    out.push(THIN);
    out.push(...await addressBlock(tx, client, q.customerNumber, 'Customer'));
    out.push(THIN);
    out.push(`${padStart('It', 2)} ${pad('Material', 26)}${padStart('Quantity', 10)} ${pad('', 6)}${padStart('Price', 12)}${padStart('Amount', 12)}`);
    for (const line of lines) {
      out.push([
        padStart(String(line.lineNumber), 2),
        pad(`${line.materialNumber} ${names.get(line.materialNumber) ?? ''}`.trim(), 26),
        padStart(trimQuantity(line.quotationQuantity), 10),
        pad(line.quantityUnit, 6),
        padStart(money(line.netPrice), 12),
        padStart(money(line.netAmount), 12),
      ].join(' '));
    }
    out.push(THIN);
    out.push(`${padStart('Net value', 58)}${padStart(money(q.netValue), 10)} ${q.currency}`);
    out.push(`${padStart('Tax', 58)}${padStart(money(q.taxValue), 10)} ${q.currency}`);
    out.push(`${padStart('Gross value', 58)}${padStart(money(q.grossValue), 10)} ${q.currency}`);
    out.push(THIN);
    out.push(`This offer is valid until ${q.validTo}.`);
    out.push(RULE);
    return { companyCode: q.companyCode, title: 'Quotation', documentNumber: quotationNumber, bodyText: out.join('\n') };
  });
}
