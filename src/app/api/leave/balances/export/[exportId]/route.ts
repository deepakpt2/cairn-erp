/**
 * Download of a queued leave-balance export. A protected API route, not a screen. The live session, VIEW, EXPORT,
 * Company Code scope and ownership are judged by `downloadLeaveExport` on every request; an id alone is no authority.
 */
import { getSession } from '@/platform/auth/current';
import { downloadLeaveExport } from '@/modules/people/leave-export';
import { isLeaveError } from '@/modules/people/leave-access';

export const dynamic = 'force-dynamic';
const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } as const;
const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { ...HEADERS, 'Content-Type': 'application/json' } });

export async function GET(_request: Request, context: { params: Promise<{ exportId: string }> }): Promise<Response> {
  const session = await getSession();
  if (!session) return json(401, 'Sign in to download a leave export.');
  const { exportId } = await context.params;
  try {
    const file = await downloadLeaveExport(session.user.client, exportId, {
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
    });
    return new Response(new Uint8Array(file.body), {
      status: 200,
      headers: {
        ...HEADERS, 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
        'Content-Length': String(file.body.length),
      },
    });
  } catch (error) {
    if (isLeaveError(error)) {
      return json(error.code === 'LEAVE_AUTHORITY' ? 403 : error.code === 'EXPORT_NOT_FOUND' ? 404 : error.code === 'EXPORT_UNAVAILABLE' ? 410 : 400, error.message);
    }
    throw error;
  }
}
