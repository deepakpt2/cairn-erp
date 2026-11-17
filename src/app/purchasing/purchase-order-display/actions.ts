'use server';

import { requireSession } from '@/platform/auth/current';
import { PdfDownloadError } from '@/modules/output/download-pdf';
import { purchaseOrderPdf } from '@/modules/purchasing/document-print';
import { PO_DISPLAY_ROUTE } from '@/modules/purchasing/purchase-order-display';
import type { PdfDownloadState } from '@/ui/output/DocumentPrint';

/** Download the purchase order as a PDF on the company code's letterhead. */
export async function downloadPurchaseOrderPdfAction(form: FormData): Promise<PdfDownloadState> {
  const session = await requireSession(PO_DISPLAY_ROUTE);
  const orderNumber = String(form.get('orderNumber') ?? '').trim();
  try {
    const pdf = await purchaseOrderPdf({ client: session.user.client, orderNumber, capabilities: session.user.capabilities });
    return { ok: true, fileName: pdf.fileName, base64: pdf.base64, warning: pdf.warning };
  } catch (error) {
    if (error instanceof PdfDownloadError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
