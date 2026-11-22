/**
 * The printable payslip — a protected route handler, not a navigation screen.
 *
 * Linked from one payroll result on `/people/payroll-results`, it renders a self-contained HTML page
 * the browser can print or save as PDF. The tenant and the user come from the authenticated session,
 * never from the query string: `?result=` only names one result the caller must already reach.
 *
 * `getPayslip` re-judges the live session, the payroll-result capability and the result's Company Code
 * scope in its own transaction, and answers an unreachable result exactly like a missing one. A
 * refusal that names a real result (PROPOSED / CANCELLED) is only reached after authorisation passes.
 *
 * The response is never cached and carries no external resource: no script, no image, no font.
 */
import { getSession } from '@/platform/auth/current';
import { getPayslip, isPayslipError, renderPayslipHtml } from '@/modules/people/payroll-payslip';

export const dynamic = 'force-dynamic';

const HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as const;

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) {
    return new Response('Sign in to print a payslip.', {
      status: 401,
      headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const resultId = new URL(request.url).searchParams.get('result') ?? '';
  try {
    const slip = await getPayslip(session.user.client, resultId, {
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
    });
    return new Response(renderPayslipHtml(slip), {
      status: 200,
      headers: { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (error) {
    if (!isPayslipError(error)) throw error;
    const status = error.code === 'PAYSLIP_AUTHORITY' ? 403 : error.code === 'PAYSLIP_UNAVAILABLE' ? 404 : 400;
    // The message is the service's own; an unreachable result never says that it exists.
    return new Response(error.message, {
      status,
      headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
