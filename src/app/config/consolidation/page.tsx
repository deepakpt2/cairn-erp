import { can, requireSession } from '@/platform/auth/current';
import {
  CONSOLIDATION_CAPABILITY, CONSOLIDATION_FOLDERS,
  getConsolidationWorkbench, listConsolidationAreas,
  type ConsolidationFolder,
} from '@/modules/finance/consolidation-workbench';
import ConsolidationWorkbenchShell from './ConsolidationWorkbenchShell';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/consolidation';

export default async function ConsolidationWorkbenchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();
  const folderRaw = get('folder', 'DATA_BASIS').toUpperCase();
  const folder = (CONSOLIDATION_FOLDERS as readonly string[]).includes(folderRaw)
    ? (folderRaw as ConsolidationFolder)
    : 'DATA_BASIS';

  const areas = await listConsolidationAreas(session.user.client, { userId: session.user.userId, sessionId: session.sessionId ?? '' });
  const areaKey = get('area').toUpperCase() || areas[0]?.area || '';
  const view = areaKey ? await getConsolidationWorkbench(session.user.client, areaKey, { userId: session.user.userId, sessionId: session.sessionId ?? '' }) : null;

  return (
    <Page
      title="Consolidation Workbench" code="FIN.RPT.CONSOLIDATE · UCWB" back={null}
      description="Configure consolidation areas, data basis, units, mappings, methods and task hierarchies. Configuration only — execution stands apart."
    >
      <ConsolidationWorkbenchShell
        canUse={can(session, `${CONSOLIDATION_CAPABILITY}.read`) || can(session, CONSOLIDATION_CAPABILITY)}
        canConfigure={can(session, CONSOLIDATION_CAPABILITY)}
        areas={areas}
        area={areaKey}
        folder={folder}
        view={view}
      />
    </Page>
  );
}
