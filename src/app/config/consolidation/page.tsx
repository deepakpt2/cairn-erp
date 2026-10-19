import { can, requireSession } from '@/platform/auth/current';
import {
  CONSOLIDATION_CAPABILITY, CONSOLIDATION_FOLDERS,
  type ConsolidationFolder,
} from '@/modules/finance/consolidation-workbench';
import ConsolidationWorkbenchShell from './ConsolidationWorkbenchShell';

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

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.RPT.CONSOLIDATE · UCWB</span>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Consolidation Workbench</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Configure consolidation areas, data basis, units, mappings, methods and task hierarchies. Configuration only — execution stands apart.
        </p>
      </header>
      <ConsolidationWorkbenchShell
        canUse={can(session, `${CONSOLIDATION_CAPABILITY}.read`) || can(session, CONSOLIDATION_CAPABILITY)}
        areas={[]}
        area={get('area').toUpperCase()}
        folder={folder}
        view={null}
      />
    </div>
  );
}
