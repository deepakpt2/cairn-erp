/**
 * Plain-text layout helpers and the on-demand PDF for documents that are printed straight from their
 * masters (purchase order, request for quotation, sales quotation).
 *
 * Unlike sales output there is no stored rendering: the PDF is built from the document as it stands
 * now, on the letterhead of its company code. The 78-column text is the same format the output queue
 * stores, so the one renderer (`render-pdf.ts`) serves both.
 */
import { and, eq } from 'drizzle-orm';

import { type Tx, withTenant } from '../../platform/db/client';
import { businessPartner } from '../foundation/business-partner-schema';
import { PdfDownloadError, type PdfDownload } from './download-pdf';
import { renderDocumentPdfIn, replacedCharactersWarning } from './render-pdf';

export const RULE = '='.repeat(78);
export const THIN = '-'.repeat(78);

export function pad(value: string, width: number): string {
  return value.length > width ? value.slice(0, width) : value.padEnd(width, ' ');
}

export function padStart(value: string, width: number): string {
  return value.length > width ? value.slice(0, width) : value.padStart(width, ' ');
}

export function money(value: number | string): string {
  const asNumber = typeof value === 'number' ? value : Number(value);
  return (Math.round((asNumber + Number.EPSILON) * 100) / 100).toFixed(2);
}

export function trimQuantity(value: string): string {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) return value;
  return String(Math.round(asNumber * 1000) / 1000);
}

/** `Label     P-100       Name` plus the address on the next line. */
export async function addressBlock(tx: Tx, client: string, partnerNumber: string, label: string): Promise<string[]> {
  const [row] = await tx.select({
    name: businessPartner.name, street: businessPartner.street, city: businessPartner.city,
    region: businessPartner.region, postalCode: businessPartner.postalCode, country: businessPartner.country,
  }).from(businessPartner).where(and(
    eq(businessPartner.client, client), eq(businessPartner.partnerNumber, partnerNumber),
  )).limit(1);
  const lines = [`${pad(label, 10)}${pad(partnerNumber, 12)}${row?.name ?? ''}`];
  const place = [row?.street, row?.city, row?.region, row?.postalCode, row?.country]
    .filter((part) => part && String(part).trim().length > 0).join(', ');
  if (place) lines.push(`${pad('', 10)}${place}`);
  return lines;
}

export interface PrintableDocument {
  companyCode: string;
  title: string;
  documentNumber: string;
  bodyText: string;
}

/** Render a printable document to a PDF download, inside its own tenant read. */
export async function buildDocumentPdf(client: string, load: (tx: Tx) => Promise<PrintableDocument | null>): Promise<PdfDownload> {
  return withTenant(client, async (tx) => {
    const doc = await load(tx);
    if (!doc) throw new PdfDownloadError('That document does not exist.', 'Check the number and try again.');
    const pdf = await renderDocumentPdfIn(tx, {
      client, companyCode: doc.companyCode, title: doc.title, documentNumber: doc.documentNumber, bodyText: doc.bodyText,
    });
    return {
      fileName: `${doc.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'Document'}-${doc.documentNumber.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`,
      base64: Buffer.from(pdf.bytes).toString('base64'),
      replacedCharacters: pdf.replacedCharacters,
      warning: replacedCharactersWarning(pdf.replacedCharacters),
      pageCount: pdf.pageCount,
    };
  });
}
