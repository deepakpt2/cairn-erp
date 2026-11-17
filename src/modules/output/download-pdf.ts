/**
 * Download PDF (MAIL-03 §7.2) — the one deliberately synchronous PDF render in the product.
 *
 * The user clicked a button and is waiting for a file, so this renders on the request. It reads
 * nothing but the message's stored `rendered_document` (and the letterhead): it must refuse a message
 * that carries no rendering yet, rather than build a document from the masters that is not the one
 * recorded. Bounded by the length of the stored text.
 */
import { type Tx, withTenant } from '../../platform/db/client';
import { renderDocumentPdfIn, replacedCharactersWarning } from './render-pdf';

export interface PdfDownload {
  fileName: string;
  /** base64 of the PDF bytes; the browser turns it into a file. */
  base64: string;
  replacedCharacters: number;
  /** The warning line to show, or null when every character was representable. */
  warning: string | null;
  pageCount: number;
}

export class PdfDownloadError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'PdfDownloadError';
  }
}

export async function renderStoredPdf(input: {
  client: string;
  /** Reads the stored rendering of the message under the caller's own rules. */
  load: (tx: Tx) => Promise<{ renderedDocument: string | null; title: string; documentNumber: string; companyCode: string | null } | null>;
}): Promise<PdfDownload> {
  return withTenant(input.client, async (tx) => {
    const message = await input.load(tx);
    if (!message) {
      throw new PdfDownloadError('That output message does not exist.', 'Refresh the queue and try again.');
    }
    if (!message.renderedDocument) {
      throw new PdfDownloadError(
        'Nothing has been rendered for this message yet, so there is no document to put in a PDF.',
        'Wait for the OUTPUT.DISPATCH job to process it (or dispatch it); the PDF is built from what was rendered, never from the masters.',
      );
    }
    if (!message.companyCode) {
      throw new PdfDownloadError(
        'This document\'s organisation is not assigned to a company code, so there is no letterhead for it.',
        'Assign the sales organisation or plant to a company code.',
      );
    }
    const pdf = await renderDocumentPdfIn(tx, {
      client: input.client,
      companyCode: message.companyCode,
      title: message.title,
      documentNumber: message.documentNumber,
      bodyText: message.renderedDocument,
    });
    return {
      fileName: `${message.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'Document'}-${message.documentNumber.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`,
      base64: Buffer.from(pdf.bytes).toString('base64'),
      replacedCharacters: pdf.replacedCharacters,
      warning: replacedCharactersWarning(pdf.replacedCharacters),
      pageCount: pdf.pageCount,
    };
  });
}
