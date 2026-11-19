/**
 * Authorised CSV of the leave balance report. A protected API route, not a screen.
 *
 * A live session is required, and `leaveBalanceCsv` judges PEOPLE.LEAVE.VIEW, PEOPLE.LEAVE.EXPORT and the
 * company reach of every selected employee on every request. Personnel numbers in the query only select
 * among what the caller already reaches; they never grant anything. The file is never cached or linked.
 */
import { getSession } from '@/platform/auth/current';
import { isLeaveError } from '@/modules/people/leave-access';
import { leaveBalanceCsv } from '@/modules/people/leave-report';

export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } as const;

function refusal(status: number, message: string, remedy?: string): Response {
  return new Response(JSON.stringify({ error: message, remedy }), { status, headers: { ...HEADERS, 'Content-Type': 'application/json' } });
}

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return refusal(401, 'Sign in to export leave balances.');
  const q = new URL(request.url).searchParams;
  const numbers = (q.get('employees') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const yearText = q.get('year');
  const year = yearText ? Number(yearText) : undefined;
  if (yearText && !Number.isInteger(year)) return refusal(400, 'The year must be a whole number.');
  try {
    const csv = await leaveBalanceCsv(
      {
        client: session.user.client,
        personnelNumbers: numbers,
        groupCode: q.get('group')?.trim() || undefined,
        year,
        asOf: q.get('asOf')?.trim() || undefined,
      },
      { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } },
    );
    return new Response(csv.body, {
      status: 200,
      headers: {
        ...HEADERS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csv.filename}"`,
      },
    });
  } catch (error) {
    if (isLeaveError(error)) {
      const status = error.code === 'LEAVE_AUTHORITY' ? 403 : 400;
      return refusal(status, error.message, error.remedy);
    }
    throw error;
  }
}
