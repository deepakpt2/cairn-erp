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
  HISTORICAL_WARNING,
  downloadHistoricalReissue,
  cancelReissue,
  approveReissue,
  downloadHistoricalFile,
  downloadReissue,
  isReissueError,
  abandonReissueIntent,
  executeReissueIntent,
  listReissueIntents,
  previewReissue,
  reconcileReissueRequest,
  registerReissueIntent,
  requestReissue,
  reissueStatus,
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
  if (code === 'REISSUE_AUTHORITY' || code === 'REISSUE_BANK_AUTHORITY' || code === 'FOUR_EYES') return code === 'FOUR_EYES' ? 409 : 403;
  if (code === 'REISSUE_UNAVAILABLE' || code === 'FILE_UNAVAILABLE' || code === 'REISSUE_NOT_APPROVED') return 404;
  if (code === 'REISSUE_SUPERSEDED' || code === 'REISSUE_BANK_CHANGED') return 409;
  if (code === 'REISSUE_CONFLICT' || code === 'REISSUE_STATE' || code === 'REISSUE_KEY_REUSED'
    || code === 'REISSUE_ABANDONED' || code === 'REISSUE_REFUSED'
    || code === 'REISSUE_PREDECESSOR_CHANGED' || code === 'REISSUE_OVERLAP'
    || code === 'PREDECESSOR_BINDING_REQUIRED' || code === 'PREDECESSOR_BINDING_INVALID') return 409;
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
      let predecessors: unknown[] = [];
      try {
        const parsed = JSON.parse(String(form?.get('attestations') ?? '[]'));
        if (Array.isArray(parsed)) attestations = parsed;
        const parsedPred = JSON.parse(String(form?.get('predecessors') ?? '[]'));
        if (Array.isArray(parsedPred)) predecessors = parsedPred;
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
        predecessors: predecessors as never,
        requestKey: String(form?.get('requestKey') ?? '') || undefined,
        changedBy: s.user.username,
      }, access);
      return json({ ...view, warning: REISSUE_WARNING }, 201);
    }
    if (action === 'register' || action === 'execute') {
      let attestations: unknown[] = [];
      let predecessors: unknown[] = [];
      if (action === 'register') {
        try {
          const parsed = JSON.parse(String(form?.get('attestations') ?? '[]'));
          if (Array.isArray(parsed)) attestations = parsed;
          const parsedPred = JSON.parse(String(form?.get('predecessors') ?? '[]'));
          if (Array.isArray(parsedPred)) predecessors = parsedPred;
        } catch {
          return refusal(400, 'The attestations could not be read. Nothing was saved.', 'Reload the screen and enter each employee’s original outcome again.');
        }
      }
      if (action === 'register') {
        const intent = await registerReissueIntent({
          client: s.user.client,
          sourcePreparationId: String(form?.get('sourcePreparationId') ?? ''),
          selection: String(form?.get('selection') ?? 'ALL') === 'SELECTED' ? 'SELECTED' : 'ALL',
          personnelNumbers: String(form?.get('personnelNumbers') ?? '').split(',').map((n) => n.trim()).filter(Boolean),
          intendedPaymentDate: String(form?.get('intendedPaymentDate') ?? ''),
          reason: String(form?.get('reason') ?? ''),
          attestations: attestations as never,
          predecessors: predecessors as never,
          requestKey: String(form?.get('requestKey') ?? '') || undefined,
          changedBy: s.user.username,
        }, access);
        return json(intent, 201);
      }
      const view = await executeReissueIntent(s.user.client, String(form?.get('intentId') ?? ''), access, s.user.username);
      return json({ ...view, warning: REISSUE_WARNING }, 201);
    }
    if (action === 'intents') {
      const list = await listReissueIntents(
        s.user.client,
        String(form?.get('sourcePreparationId') ?? ''),
        access,
        s.user.username,
      );
      return json(list);
    }
    if (action === 'reissueStatus') {
      return json(await reissueStatus(s.user.client, String(form?.get('reissueId') ?? ''), access));
    }
    if (action === 'abandon') {
      const intent = await abandonReissueIntent(s.user.client, String(form?.get('intentId') ?? ''), access, s.user.username);
      return json(intent);
    }
    if (action === 'reconcile') {
      const result = await reconcileReissueRequest(
        s.user.client,
        {
          requestKey: String(form?.get('requestKey') ?? ''),
          sourcePreparationId: String(form?.get('sourcePreparationId') ?? ''),
          requestedBy: s.user.username,
        },
        access,
      );
      return json(result);
    }
    if (action === 'approve') {
      // The approver asserts the review explicitly AND supplies the reviewed digest; both are required.
      if (String(form?.get('confirmReviewed') ?? '') !== 'yes') {
        return refusal(400, 'Confirm that you reviewed the frozen instruction before approving.', 'Open Review on the draft and tick the acknowledgment.');
      }
      const confirmDigest = String(form?.get('confirmDigest') ?? '');
      const view = await approveReissue(s.user.client, String(form?.get('reissueId') ?? ''), s.user.username, access, { confirmDigest, reviewedAssertion: true });
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
      // An original file (file=) or a replacement (reissue=). Both are protected historical evidence.
      const historical = params.get('reissue')
        ? await downloadHistoricalReissue(s.user.client, params.get('reissue') ?? '', access)
        : await downloadHistoricalFile(s.user.client, params.get('file') ?? '', access);
      return new Response(new Uint8Array(historical.body), {
        status: 200,
        headers: {
          ...HEADERS,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${historical.filename}"`,
          'X-Payment-File-Historical': 'do-not-upload',
          'X-Payment-File-Warning': encodeURIComponent(HISTORICAL_WARNING),
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
