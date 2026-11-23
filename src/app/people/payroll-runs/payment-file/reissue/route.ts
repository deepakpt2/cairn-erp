/**
 * Controlled salary-file replacement — a protected endpoint, not a navigation screen.
 *
 * Linked from the payment-file panel. POST actions:
 * - `preview`  — read-only eligibility preview for all or selected employees.
 * - `request`  — create a frozen, encrypted DRAFT (requester capability).
 * - `approve`  — release a draft (a DIFFERENT, authorized approver).
 * - `cancel`   — cancel an unapproved draft with a reason.
 * GET actions:
 * - `download` — an approved replacement CSV.
 * - `historical` — a superseded source file, marked do-not-upload, for FILE_HISTORICAL holders.
 *
 * Every action re-judges the live session, tenant, capability and employee scope inside the service. A response
 * is never cached and never carries a bank identifier in a URL or body header.
 */
import { getSession } from '@/platform/auth/current';
import {
  REISSUE_WARNING,
  cancelReissue,
  approveReissue,
  downloadHistoricalFile,
  downloadReissue,
  isReissueError,
  previewReissue,
  requestReissue,
} from '@/modules/people/payroll-payment-reissue';

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
  if (code === 'REISSUE_AUTHORITY' || code === 'FOUR_EYES') return code === 'FOUR_EYES' ? 409 : 403;
  if (code === 'REISSUE_UNAVAILABLE' || code === 'FILE_UNAVAILABLE' || code === 'REISSUE_NOT_APPROVED') return 404;
  if (code === 'REISSUE_CONFLICT' || code === 'REISSUE_STATE') return 409;
  return 400;
}

async function session() {
  return getSession();
}

export async function POST(request: Request): Promise<Response> {
  const s = await session();
  if (!s) return refusal(401, 'Sign in to work with a replacement payment file.');
  const form = await request.formData().catch(() => null);
  const action = typeof form?.get('action') === 'string' ? String(form.get('action')) : '';
  const access = { authorization: { userId: s.user.userId, sessionId: s.sessionId ?? '' } };
  try {
    if (action === 'preview') {
      const preview = await previewReissue(
        s.user.client,
        {
          sourcePreparationId: String(form?.get('sourcePreparationId') ?? ''),
          selection: (String(form?.get('selection') ?? 'ALL') === 'SELECTED' ? 'SELECTED' : 'ALL'),
          personnelNumbers: String(form?.get('personnelNumbers') ?? '').split(',').map((n) => n.trim()).filter(Boolean),
          intendedPaymentDate: String(form?.get('intendedPaymentDate') ?? ''),
        },
        access,
      );
      return json(preview);
    }
    if (action === 'request') {
      let attestations: unknown[] = [];
      try {
        const parsed = JSON.parse(String(form?.get('attestations') ?? '[]'));
        if (Array.isArray(parsed)) attestations = parsed;
      } catch {
        return refusal(400, 'The attestations could not be read. Nothing was saved.', 'Reload the screen and enter each employee’s original outcome again.');
      }
      const view = await requestReissue({
        client: s.user.client,
        sourcePreparationId: String(form?.get('sourcePreparationId') ?? ''),
        selection: String(form?.get('selection') ?? 'ALL') === 'SELECTED' ? 'SELECTED' : 'ALL',
        personnelNumbers: String(form?.get('personnelNumbers') ?? '').split(',').map((n) => n.trim()).filter(Boolean),
        intendedPaymentDate: String(form?.get('intendedPaymentDate') ?? ''),
        reason: String(form?.get('reason') ?? ''),
        attestations: attestations as never,
        requestKey: String(form?.get('requestKey') ?? '') || undefined,
        changedBy: s.user.username,
      }, access);
      return json({ ...view, warning: REISSUE_WARNING }, 201);
    }
    if (action === 'approve') {
      const view = await approveReissue(s.user.client, String(form?.get('reissueId') ?? ''), s.user.username, access);
      return json(view);
    }
    if (action === 'cancel') {
      const view = await cancelReissue(
        s.user.client,
        String(form?.get('reissueId') ?? ''),
        { reason: String(form?.get('reason') ?? ''), changedBy: s.user.username },
        access,
      );
      return json(view);
    }
    return refusal(400, 'Unknown action.');
  } catch (error) {
    if (!isReissueError(error)) throw error;
    return refusal(statusOf(error.code), error.message, error.remedy);
  }
}

export async function GET(request: Request): Promise<Response> {
  const s = await session();
  if (!s) return refusal(401, 'Sign in to download a payment file.');
  const params = new URL(request.url).searchParams;
  const access = { authorization: { userId: s.user.userId, sessionId: s.sessionId ?? '' } };
  try {
    if (params.get('historical') === '1') {
      const file = await downloadHistoricalFile(s.user.client, params.get('file') ?? '', access);
      return new Response(new Uint8Array(file.body), {
        status: 200,
        headers: {
          ...HEADERS,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${file.filename}"`,
          'X-Payment-File-Historical': 'do-not-upload',
        },
      });
    }
    const file = await downloadReissue(s.user.client, params.get('reissue') ?? '', { requestedBy: s.user.username }, access);
    return new Response(new Uint8Array(file.body), {
      status: 200,
      headers: {
        ...HEADERS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'X-Payment-File-Reference': file.reissueReference,
        'X-Payment-File-Warning': encodeURIComponent(REISSUE_WARNING),
      },
    });
  } catch (error) {
    if (!isReissueError(error)) throw error;
    return refusal(statusOf(error.code), error.message, error.remedy);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, 'Content-Type': 'application/json' } });
}
