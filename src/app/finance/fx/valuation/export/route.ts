import { can, requireSession } from '@/platform/auth/current';
import {
  FX_VALUATION_CAPABILITY, fxValuationCsv, getFxValuationRun,
} from '@/modules/finance/fx-valuation';

const ROUTE = '/finance/fx/valuation';

/** CSV export of a persisted valuation protocol (SCR-098): read-only. */
export async function GET(request: Request) {
  const session = await requireSession(ROUTE);
  if (!can(session, FX_VALUATION_CAPABILITY)) {
    return new Response('You do not hold the FX valuation capability.', { status: 403 });
  }
  const runId = new URL(request.url).searchParams.get('run')?.trim() ?? '';
  let result: Awaited<ReturnType<typeof getFxValuationRun>> = null;
  try {
    result = runId ? await getFxValuationRun(session.user.client, runId, { userId: session.user.userId, sessionId: session.sessionId ?? '' }) : null;
  } catch {
    return new Response('Your capability or Company Code scope does not allow this export.', { status: 403 });
  }
  if (!result) return new Response('Valuation run not found.', { status: 404 });
  return new Response(fxValuationCsv(result), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="fx-valuation-${runId}.csv"`,
    },
  });
}
