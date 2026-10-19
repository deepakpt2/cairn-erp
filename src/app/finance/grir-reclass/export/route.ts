import { can, requireSession } from '@/platform/auth/current';
import {
  GRIR_RECLASS_CAPABILITY, getGrIrRun, grIrCsv,
} from '@/modules/finance/grir-reclass';

const ROUTE = '/finance/grir-reclass';

/** CSV export of a persisted GR/IR protocol (SCR-099): read-only. */
export async function GET(request: Request) {
  const session = await requireSession(ROUTE);
  if (!can(session, GRIR_RECLASS_CAPABILITY)) {
    return new Response('You do not hold the GR/IR reclassification capability.', { status: 403 });
  }
  const runId = new URL(request.url).searchParams.get('run')?.trim() ?? '';
  const result = runId ? await getGrIrRun(session.user.client, runId) : null;
  if (!result) return new Response('GR/IR run not found.', { status: 404 });
  return new Response(grIrCsv(result), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="grir-analysis-${runId}.csv"`,
    },
  });
}
