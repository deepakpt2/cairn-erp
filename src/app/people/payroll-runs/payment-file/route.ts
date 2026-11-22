/**
 * The generic salary payment CSV — a protected download route, not a navigation screen.
 *
 * Linked from a POSTED run on `/people/payroll-runs`. Two verbs:
 * - `POST` prepares the one frozen file for the run (idempotent: a retry returns the same snapshot).
 * - `GET` downloads the prepared file.
 *
 * A re-download needs confirm=yes, because a second upload to a bank can pay employees twice and the ERP
 * cannot see the external bank. Both verbs re-judge the live session, the export capability, the run's
 * company and every included employee's reach in the service's own transaction; an unreachable run answers
 * like a missing one. The response is never cached and is never an attachment linked from a public URL.
 */
import { getSession } from '@/platform/auth/current';
import {
  PAYMENT_FILE_WARNING,
  downloadPaymentFile,
  getPaymentFile,
  isPaymentFileError,
  preparePaymentFile,
} from '@/modules/people/payroll-payment-file';

export const dynamic = 'force-dynamic';

const HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

function refusal(status: number, message: string, remedy?: string): Response {
  return new Response(remedy ? `${message} ${remedy}` : message, {
    status,
    headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function statusOf(code: string): number {
  if (code === 'FILE_AUTHORITY') return 403;
  if (code === 'FILE_UNAVAILABLE') return 404;
  if (code === 'FILE_REUSE') return 409;
  return 400;
}

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return refusal(401, 'Sign in to prepare a payment file.');
  const form = await request.formData().catch(() => null);
  const runId = typeof form?.get('runId') === 'string' ? String(form.get('runId')) : '';
  const intendedPaymentDate = typeof form?.get('intendedPaymentDate') === 'string' ? String(form.get('intendedPaymentDate')) : undefined;
  try {
    const view = await preparePaymentFile(
      { client: session.user.client, runId, intendedPaymentDate, changedBy: session.user.username },
      { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } },
    );
    return new Response(
      JSON.stringify({
        preparationId: view.preparationId,
        fileReference: view.fileReference,
        filename: view.filename,
        rowCount: view.rowCount,
        totalAmount: view.totalAmount,
        currency: view.currency,
        intendedPaymentDate: view.intendedPaymentDate,
        downloadPath: view.downloadPath,
        warning: PAYMENT_FILE_WARNING,
      }),
      { status: view.downloadCount > 0 ? 200 : 201, headers: { ...HEADERS, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    if (!isPaymentFileError(error)) throw error;
    return refusal(statusOf(error.code), error.message, error.remedy);
  }
}

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return refusal(401, 'Sign in to download a payment file.');
  const params = new URL(request.url).searchParams;
  const runId = params.get('run') ?? '';
  const confirmReuse = params.get('confirm') === 'yes';
  try {
    const file = await downloadPaymentFile(
      session.user.client,
      runId,
      { confirmReuse, requestedBy: session.user.username },
      { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } },
    );
    return new Response(new Uint8Array(file.body), {
      status: 200,
      headers: {
        ...HEADERS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'X-Payment-File-Reference': file.fileReference,
        'X-Payment-File-Warning': encodeURIComponent(PAYMENT_FILE_WARNING),
      },
    });
  } catch (error) {
    if (!isPaymentFileError(error)) throw error;
    return refusal(statusOf(error.code), error.message, error.remedy);
  }
}

// The screen shows the prepared state through the same service; exported so it can be imported from one place.
export { getPaymentFile };
