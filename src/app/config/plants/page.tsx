import { t } from '@/platform/i18n';
import { listPlants } from '@/modules/foundation/services';
import { requireSession } from '@/platform/auth/current';

export const dynamic = 'force-dynamic';

/**
 * Plants and storage locations — CFG.ORG.PLANT.DEFINE, CFG.ORG.STORAGELOC.DEFINE
 *
 * Shown together because a storage location has no meaning outside its plant, and
 * separating them into two screens would make users navigate to answer one
 * question: where can stock actually sit?
 */
export default async function PlantsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const params = await searchParams;
  // The tenant comes from the session, never from the query string. A `?client=`
  // override here would let a signed-in user of one tenant read another's books.
  const session = await requireSession();
  const client = session.user.client;

  const plants = await listPlants(client);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-4 border-b border-line pb-4">
        <span className="code text-ink-faint">CFG.ORG.PLANT.DEFINE</span>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight">{t('plant.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('plant.subtitle')}</p>
      </header>

      <div className="space-y-4">
        {plants.map((plant) => (
          <section key={plant.plant} className="panel overflow-hidden">
            <div className="panel-header">
              <div className="flex items-baseline gap-3">
                <h2 className="panel-title">{plant.name}</h2>
                <span className="code text-ink-faint">{plant.plant}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="chip chip-neutral">{plant.companyCode}</span>
                {plant.isProductionSite && <span className="chip chip-info">Production</span>}
                {plant.isStorageSite && <span className="chip chip-neutral">Storage</span>}
              </div>
            </div>
            <table className="grid-table">
              <thead>
                <tr>
                  <th className="w-28">{t('plant.locations')}</th>
                  <th>{t('plant.name')}</th>
                  <th className="w-40">Negative stock</th>
                </tr>
              </thead>
              <tbody>
                {plant.storageLocations.map((location) => (
                  <tr key={location.storageLocation}>
                    <td className="code font-semibold">{location.storageLocation}</td>
                    <td>{location.name}</td>
                    <td className="text-ink-soft">
                      {location.allowNegativeStock ? 'Permitted' : 'Refused'}
                    </td>
                  </tr>
                ))}
                {plant.storageLocations.length === 0 && (
                  <tr>
                    <td colSpan={3} className="text-ink-faint">
                      No storage locations defined.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}
