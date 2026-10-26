import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  SETTLEMENT_CONFIG_CAPABILITY,
  SETTLEMENT_CONFIG_ROUTE,
  getAllocationStructure,
  getSettlementProfile,
  listAllocationStructures,
  listOrderTypeSettlementProfiles,
  listSettlementProfileDocumentTypes,
  listSettlementProfiles,
} from '@/modules/foundation/settlement-configuration-masters';
import {
  SettlementMasters,
  type OrderTypeEntry,
  type ProfileEntry,
  type StructureEntry,
} from './SettlementMasters';

export const dynamic = 'force-dynamic';

/**
 * The settlement masters, kept where they belong: one allocation structure, one profile, and one
 * order type assignment per client and order type. The distribution rule of a single order stays at
 * `/controlling/settlement-rules`, and this screen writes none of it.
 */
export default async function SettlementConfigurationPage() {
  const session = await requireSession(SETTLEMENT_CONFIG_ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, SETTLEMENT_CONFIG_CAPABILITY);

  const [structureRows, profileRows, typeRows, documentTypeRows] = await Promise.all([
    listAllocationStructures(client),
    listSettlementProfiles(client),
    canMaintain ? listOrderTypeSettlementProfiles(client) : Promise.resolve([]),
    canMaintain ? listSettlementProfileDocumentTypes(client) : Promise.resolve([]),
  ]);

  // The per-row version is what an edit form submits as `expectedVersion`: a save carries the version
  // its reader saw, so a second user's stale form refuses instead of overwriting.
  const structures: StructureEntry[] = await Promise.all(structureRows.map(async (row) => {
    const detail = await getAllocationStructure(client, row.structureCode);
    return {
      structureCode: row.structureCode,
      description: row.description,
      profiles: row.profiles,
      orderTypes: row.orderTypes,
      version: detail?.version ?? 0,
      assignments: (detail?.assignments ?? []).map((assignment) => ({ ...assignment })),
      profilesUsedBy: detail?.profilesUsedBy ?? [],
    };
  }));

  const profiles: ProfileEntry[] = await Promise.all(profileRows.map(async (row) => ({
    ...row,
    version: (await getSettlementProfile(client, row.profileCode))?.version ?? 0,
  })));

  const orderTypes: OrderTypeEntry[] = typeRows.map((row) => ({ ...row }));
  const documentTypes = documentTypeRows.map((row) => ({ ...row }));

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:p-6">
      <section className="overflow-hidden border border-line bg-white shadow-sm">
        <header className="flex min-h-16 flex-wrap items-center gap-3 border-b border-line bg-sunken px-3 py-2 sm:px-4">
          <Link href="/config" className="inline-flex min-h-11 items-center border border-line bg-white px-3 text-sm">
            Configuration home
          </Link>
          <div className="min-w-0 flex-1">
            <span className="code block text-2xs text-ink-soft">{SETTLEMENT_CONFIG_CAPABILITY}</span>
            <h1 className="text-base font-semibold leading-tight sm:text-lg">Settlement Configuration</h1>
          </div>
          <Link
            href="/controlling/settlement-rules"
            className="inline-flex min-h-11 items-center border border-line bg-white px-3 text-sm"
          >
            Order settlement rules
          </Link>
        </header>
        <p className="border-b border-line px-3 py-3 text-sm text-ink-soft sm:px-4">
          These rows are shared. An allocation structure decides where a cost account settles to, a
          settlement profile names the document type and the distribution methods an order may use, and
          an order type says which profile its orders read. A change here is read by every order of that
          type, so a save that would leave an order unable to settle is refused here rather than found
          by a run.
        </p>
      </section>

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
          Read only: your user does not have the {SETTLEMENT_CONFIG_CAPABILITY} capability. Nothing on
          this screen can be saved, and the settlement rules of individual orders are unaffected.
        </p>
      )}

      <SettlementMasters
        structures={structures}
        profiles={profiles}
        orderTypes={orderTypes}
        documentTypes={documentTypes}
        canMaintain={canMaintain}
      />
    </div>
  );
}
