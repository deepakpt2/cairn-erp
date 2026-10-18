import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { changeHistory } from '@/platform/change';
import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { getStorageLocationVersion } from '@/modules/foundation/storage-location-maintenance';
import { plant as plantTable, storageLocation as storageLocationTable } from '@/modules/foundation/schema';
import { StorageLocationForm, type StorageLocationDraft } from './StorageLocationForm';
import { DeactivateStorageLocationForm } from './DeactivateStorageLocationForm';

export const dynamic = 'force-dynamic';

const STORAGE_LOCATION_DEFINE = 'CFG.ORG.STORAGELOC.DEFINE';

function historyKey(plantCode: string, storageLocationCode: string): string {
  return `${plantCode.length}:${plantCode}${storageLocationCode.length}:${storageLocationCode}`;
}

function selectionHref(plantCode: string, storageLocationCode: string, detail: 'location' | 'edit' = 'location') {
  return `/config/storage-locations?plant=${encodeURIComponent(plantCode)}&${detail}=${encodeURIComponent(storageLocationCode)}`;
}

export default async function StorageLocationsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; plant?: string; edit?: string; location?: string; history?: string }>;
}) {
  const params = await searchParams;
  const session = await requireSession('/config/storage-locations');
  const client = session.user.client;
  const canMaintain = can(session, STORAGE_LOCATION_DEFINE);

  // The list is always tenant-scoped and keeps inactive definitions visible for review.
  const { plants, locations } = await withTenant(client, async (tx) => {
    const plantRows = await tx
      .select({ plant: plantTable.plant, name: plantTable.name, isActive: plantTable.isActive })
      .from(plantTable)
      .where(eq(plantTable.client, client))
      .orderBy(asc(plantTable.plant));
    const locationRows = await tx
      .select()
      .from(storageLocationTable)
      .where(eq(storageLocationTable.client, client))
      .orderBy(asc(storageLocationTable.plant), asc(storageLocationTable.storageLocation));
    return { plants: plantRows, locations: locationRows };
  });

  const plantNames = new Map(plants.map((item) => [item.plant, item.name]));
  const creating = params.new === '1' && canMaintain;
  const requestedPlant = params.plant?.trim() ?? '';
  const requestedCode = (params.edit ?? params.location)?.trim() ?? '';
  const selectionRequested = Boolean(params.edit || params.location);
  const selected = selectionRequested
    ? locations.find((item) => item.plant === requestedPlant && item.storageLocation === requestedCode)
    : undefined;
  const editing = Boolean(params.edit && selected && canMaintain);
  const activePlantChoices = creating ? plants.filter((item) => item.isActive) : [];

  const version = canMaintain && selected
    ? await getStorageLocationVersion(client, selected.plant, selected.storageLocation)
    : 0;
  const history = selected && params.history === '1'
    ? await withTenant(client, (tx) =>
        changeHistory(tx, client, 'storage_location', historyKey(selected.plant, selected.storageLocation)),
      )
    : [];

  const emptyDraft: StorageLocationDraft = {
    plant: activePlantChoices.some((item) => item.plant === requestedPlant) ? requestedPlant : '',
    storageLocation: '',
    name: '',
    allowNegativeStock: false,
  };
  const selectedDraft: StorageLocationDraft | undefined = selected
    ? {
        plant: selected.plant,
        storageLocation: selected.storageLocation,
        name: selected.name,
        allowNegativeStock: selected.allowNegativeStock,
      }
    : undefined;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{STORAGE_LOCATION_DEFINE}</span>
        <div className="mt-0.5 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('storageLocation.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default">{t('nav.workbench')}</Link>
            {canMaintain && (
              <Link href="/config/storage-locations?new=1" className="btn btn-primary">
                {t('storageLocation.create')}
              </Link>
            )}
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('storageLocation.subtitle')}</p>
        <p className="mt-2 text-xs text-ink-soft">{t('storageLocation.negativeStockNote')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: STORAGE_LOCATION_DEFINE })}
        </p>
      )}

      {creating && (
        <StorageLocationForm
          mode="CREATE"
          plants={activePlantChoices.map(({ plant: plantCode, name }) => ({ plant: plantCode, name }))}
          initial={emptyDraft}
          version={0}
        />
      )}
      {editing && selectedDraft && (
        <StorageLocationForm mode="CHANGE" plants={[]} initial={selectedDraft} version={version} />
      )}

      {selectionRequested && !selected && (
        <section className="panel p-4">
          <p role="status" className="text-sm text-signal-error">{t('storageLocation.notFound')}</p>
          <Link className="mt-2 inline-block text-sm text-accent underline" href="/config/storage-locations">
            {t('storageLocation.backToList')}
          </Link>
        </section>
      )}

      {selected && !editing && (
        <section className="panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="panel-title">
                {t('storageLocation.detail')} · <span className="code">{selected.storageLocation}</span>
              </h2>
              <p className="mt-1 text-sm text-ink-soft">
                {t('storageLocation.plant')}: <span className="code">{selected.plant}</span>
                {plantNames.has(selected.plant) ? ` · ${plantNames.get(selected.plant)}` : ''}
              </p>
            </div>
            <div className="flex flex-wrap gap-3 text-sm">
              <Link className="text-accent underline" href="/config/storage-locations">
                {t('storageLocation.backToList')}
              </Link>
              {canMaintain && (
                <Link className="text-accent underline" href={selectionHref(selected.plant, selected.storageLocation, 'edit')}>
                  {t('common.change')}
                </Link>
              )}
              <Link
                className="text-accent underline"
                href={selectionHref(selected.plant, selected.storageLocation) + '&history=1'}
              >
                {t('storageLocation.history')}
              </Link>
            </div>
          </div>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="field-label">{t('storageLocation.name')}</dt><dd>{selected.name}</dd></div>
            <div><dt className="field-label">{t('storageLocation.allowNegativeStock')}</dt><dd>{t(selected.allowNegativeStock ? 'storageLocation.allowed' : 'storageLocation.notAllowed')}</dd></div>
            <div><dt className="field-label">{t('storageLocation.status')}</dt><dd>{t(selected.isActive ? 'storageLocation.active' : 'storageLocation.inactive')}</dd></div>
            {canMaintain && <div><dt className="field-label">{t('storageLocation.version')}</dt><dd className="tabular">{version}</dd></div>}
          </dl>
          {!selected.isActive && <p className="mt-3 text-xs text-ink-soft">{t('storageLocation.inactiveRetained')}</p>}
        </section>
      )}

      {selected && !editing && canMaintain && (
        <DeactivateStorageLocationForm
          plant={selected.plant}
          storageLocation={selected.storageLocation}
          version={version}
          active={selected.isActive}
        />
      )}

      {selected && params.history === '1' && (
        <section className="panel overflow-x-auto">
          <div className="panel-header">
            <h2 className="panel-title">
              {t('storageLocation.history')} · <span className="code">{selected.plant}/{selected.storageLocation}</span>
            </h2>
          </div>
          {history.map((entry) => (
            <article key={entry.id} className="border-b border-line p-3 text-sm">
              <p className="font-medium">{entry.changedAt.toISOString()} · {entry.changedBy} · {entry.changeType}</p>
              {entry.reason && <p className="text-ink-soft">{entry.reason}</p>}
              <ul className="mt-1 text-2xs text-ink-soft">
                {entry.items.map((item) => (
                  <li key={item.id}>
                    {item.fieldLabel}: {item.oldValue ?? '—'} → {item.newValue ?? '—'}
                    {item.isSecurityRelevant === 'true' ? ` · ${t('nr.controlChange')}` : ''}
                  </li>
                ))}
              </ul>
            </article>
          ))}
          {!history.length && <p className="p-3 text-sm text-ink-soft">{t('storageLocation.noChanges')}</p>}
        </section>
      )}

      <section className="panel overflow-x-auto">
        <div className="panel-header">
          <h2 className="panel-title">{t('storageLocation.list')}</h2>
          <span className="text-2xs text-ink-faint tabular">{locations.length}</span>
        </div>
        {locations.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">{t('storageLocation.empty')}</p>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>{t('storageLocation.plant')}</th>
                <th>{t('storageLocation.code')}</th>
                <th>{t('storageLocation.name')}</th>
                <th>{t('storageLocation.allowNegativeStock')}</th>
                <th>{t('storageLocation.status')}</th>
                <th className="text-end">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {locations.map((location) => (
                <tr key={`${location.plant}/${location.storageLocation}`}>
                  <td>
                    <span className="code">{location.plant}</span>
                    {plantNames.has(location.plant) && <span className="ms-2 text-ink-soft">{plantNames.get(location.plant)}</span>}
                  </td>
                  <td className="code font-semibold">{location.storageLocation}</td>
                  <td>{location.name}</td>
                  <td>{t(location.allowNegativeStock ? 'storageLocation.allowed' : 'storageLocation.notAllowed')}</td>
                  <td>
                    <span className={`chip ${location.isActive ? 'chip-ok' : 'chip-neutral'}`}>
                      {t(location.isActive ? 'storageLocation.active' : 'storageLocation.inactive')}
                    </span>
                  </td>
                  <td className="text-end whitespace-nowrap">
                    <Link className="text-accent underline" href={selectionHref(location.plant, location.storageLocation)}>
                      {t('storageLocation.open')}
                    </Link>
                    {canMaintain && (
                      <Link
                        className="ms-3 text-accent underline"
                        href={selectionHref(location.plant, location.storageLocation, 'edit')}
                      >
                        {t('common.change')}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="border-t border-line px-4 py-3 text-xs text-ink-soft">{t('storageLocation.retentionNote')}</p>
      </section>

    </div>
  );
}
