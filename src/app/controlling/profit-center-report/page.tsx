import { can, requireSession } from '@/platform/auth/current';
import { listControllingAreas } from '@/modules/foundation/controlling-area-maintenance';
import {
  DEFAULT_MAX_HITS, LEADING_LEDGER, PROFIT_CENTER_REPORT_CAPABILITY,
  type ProfitCenterReportSelection,
} from '@/modules/foundation/profit-center-report';
import ProfitCenterReportShell from './ProfitCenterReportShell';

export const dynamic = 'force-dynamic';

export default async function ProfitCenterReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();
  const controllingAreas = await listControllingAreas(session.user.client);
  const initialSelection: ProfitCenterReportSelection = {
    controllingArea: (get('controllingArea') || controllingAreas[0]?.controllingArea || '').toUpperCase(),
    profitCenterGroup: get('profitCenterGroup').toUpperCase(),
    profitCenterFrom: get('profitCenterFrom').toUpperCase(),
    profitCenterTo: get('profitCenterTo').toUpperCase(),
    glAccountFrom: get('glAccountFrom'),
    glAccountTo: get('glAccountTo'),
    documentFrom: get('documentFrom'),
    documentTo: get('documentTo'),
    fiscalYear: Number(get('fiscalYear', String(new Date().getFullYear()))) || new Date().getFullYear(),
    periodFrom: Number(get('periodFrom', '1')) || 1,
    periodTo: Number(get('periodTo', '12')) || 12,
    ledger: (get('ledger', LEADING_LEDGER) || LEADING_LEDGER).toUpperCase(),
    maxHits: Number(get('maxHits', String(DEFAULT_MAX_HITS))) || DEFAULT_MAX_HITS,
  };

  return (
    <ProfitCenterReportShell
      canUse={can(session, `${PROFIT_CENTER_REPORT_CAPABILITY}.read`)}
      areas={controllingAreas}
      selection={initialSelection}
      result={null}
    />
  );
}
