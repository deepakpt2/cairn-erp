/**
 * Emailing a rendered document (MAIL-03): the PDF is built from the stored rendering and handed to
 * the mail queue as the one attachment. Runs inside the dispatch job's per-message transaction.
 *
 * Mail not configured is an ERROR for the message, never a quiet success: the caller records the
 * returned text on the message.
 */
import type { Tx } from '../../platform/db/client';
import { MailError, enqueueMail } from '../../platform/mail/service';
import { resolveLetterhead } from './document-layout';
import { renderPdfWithLetterhead } from './render-pdf';

/** Names the screen that fixes it. */
export const MAIL_NOT_CONFIGURED_TEXT = 'Mail is not configured for this tenant. Configure and enable the mail node at /platform/mail.';

export type EmailOutcome =
  | { ok: true; replacedCharacters: number; mailId: string }
  | { ok: false; errorText: string };

function attachmentName(title: string, documentNumber: string): string {
  const stem = title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'Document';
  return `${stem}-${documentNumber.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`;
}

export async function emailRenderedDocument(tx: Tx, input: {
  client: string;
  companyCode: string;
  title: string;
  documentNumber: string;
  objectClass: string;
  objectKey: string;
  recipient: string;
  renderedDocument: string;
  changedBy: string;
}): Promise<EmailOutcome> {
  const letterhead = await resolveLetterhead(tx, input.client, input.companyCode);
  const pdf = await renderPdfWithLetterhead(letterhead, {
    title: input.title, documentNumber: input.documentNumber, bodyText: input.renderedDocument,
  });
  try {
    const mailId = await enqueueMail(tx, {
      client: input.client,
      toAddress: input.recipient,
      subject: `${input.title} ${input.documentNumber}`,
      bodyText: `Please find attached ${input.title} ${input.documentNumber} from ${letterhead.name}.`,
      objectClass: input.objectClass,
      objectKey: input.objectKey.slice(0, 80),
      attachment: {
        name: attachmentName(input.title, input.documentNumber),
        mime: 'application/pdf',
        base64: Buffer.from(pdf.bytes).toString('base64'),
      },
      changedBy: input.changedBy,
    });
    return { ok: true, replacedCharacters: pdf.replacedCharacters, mailId };
  } catch (error) {
    if (error instanceof MailError) {
      return {
        ok: false,
        errorText: error.code === 'MAIL_NOT_CONFIGURED' ? MAIL_NOT_CONFIGURED_TEXT : error.message.slice(0, 200),
      };
    }
    throw error;
  }
}
