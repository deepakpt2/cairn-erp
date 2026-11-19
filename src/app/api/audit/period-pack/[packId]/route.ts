/**
 * Authorised download of a period-close evidence pack. A protected API route, not a screen.
 *
 * A live session, the three capabilities, the company reach and the ORIGINAL live audit grant are all judged by
 * `downloadPeriodPack` on every request; an id alone is never authority. The bytes are never placed in a
 * server-action payload, never cached, never redirected to a public or signed link.
 */
import { getSession } from '@/platform/auth/current';
import { AuditError } from '@/modules/audit/workspace';
import { downloadPeriodPack } from '@/modules/audit/period-evidence';

export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } as const;

function refusal(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: { ...HEADERS, 'Content-Type': 'application/json' } });
}

export async function GET(_request: Request, context: { params: Promise<{ packId: string }> }): Promise<Response> {
  const session = await getSession();
  if (!session) return refusal(401, 'Sign in to download an evidence pack.');
  const { packId } = await context.params;
  try {
    const pack = await downloadPeriodPack(
      { client: session.user.client, userId: session.user.userId, username: session.user.username }, packId,
    );
    return new Response(new Uint8Array(pack.bytes), {
      status: 200,
      headers: {
        ...HEADERS,
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${pack.filename}"`,
        'Content-Length': String(pack.bytes.length),
      },
    });
  } catch (error) {
    if (error instanceof AuditError) {
      const status = error.code === 'AUDIT_PACK_NOT_FOUND' ? 404 : error.code === 'AUDIT_PACK_UNAVAILABLE' ? 410 : 403;
      return refusal(status, error.message);
    }
    throw error;
  }
}
