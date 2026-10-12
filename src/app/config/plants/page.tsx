import Link from 'next/link';
import { and, asc, eq } from 'drizzle-orm';
import { t } from '@/platform/i18n';
import { listPlants } from '@/modules/foundation/services';
import { getPlantDefinitionVersion } from '@/modules/foundation/plant-maintenance';
import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { country as countryReference } from '@/platform/tables/reference';
import { companyCode as companyCodeTable } from '@/modules/foundation/schema';
import { PlantCompanyCodeAssignmentForm, type PlantCompanyCodeChoice } from './PlantCompanyCodeAssignmentForm';
import { PlantDefinitionForm, type PlantDefinitionDraft } from './PlantDefinitionForm';

export const dynamic = 'force-dynamic';

const PLANT_DEFINE = 'CFG.ORG.PLANT.DEFINE';
const PLANT_ASSIGNMENT = 'CFG.ORG.PLANT.ASSIGN_COMPANY';

const EMPTY_DRAFT: PlantDefinitionDraft = {
  plant: '',
  name: '',
  country: '',
  street: null,
  houseNumber: null,
  postalCode: null,
  city: null,
  region: null,
  factoryCalendar: null,
  language: 'EN',
  isProductionSite: true,
  isStorageSite: true,
};

/** Plants and their storage locations stay readable; only the exact define capability exposes the form. */
export default async function PlantsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; edit?: string }>;
}) {
  const params = await searchParams;
  // The tenant comes from the verified session, never from the query string.
  const session = await requireSession('/config/plants');
  const client = session.user.client;
  const canDefine = can(session, PLANT_DEFINE);
  const canAssign = can(session, PLANT_ASSIGNMENT);
  const plants = await listPlants(client);
  const hasUnassignedPlants = plants.some((item) => !item.companyCode);

  // Do not expose tenant Company Code choices without the separate assignment authority.
  const companyCodeChoices: PlantCompanyCodeChoice[] = canAssign && hasUnassignedPlants
    ? await withTenant(client, async (tx) => {
        const rows = await tx
          .select({ code: companyCodeTable.companyCode, name: companyCodeTable.name })
          .from(companyCodeTable)
          .where(and(eq(companyCodeTable.client, client), eq(companyCodeTable.isActive, true)))
          .orderBy(asc(companyCodeTable.companyCode));
        return rows.map((item) => ({ ...item, code: item.code.trim() }));
      })
    : [];

  const editCode = params.edit?.trim() ?? '';
  const creating = !editCode && params.new === '1';
  const selected = editCode ? plants.find((item) => item.plant === editCode) : undefined;
  const editing = Boolean(editCode);
  const showForm = canDefine && (creating || Boolean(selected));

  // Do not disclose global reference choices to read-only users or unrelated page views.
  const countries = showForm
    ? await withTenant(client, async (tx) => {
        const rows = await tx
          .select({ code: countryReference.code, name: countryReference.name })
          .from(countryReference)
          .orderBy(asc(countryReference.code));
        return rows.map((item) => ({ ...item, code: item.code.trim() }));
      })
    : [];

  // Plant's optimistic token is the tenant-scoped count of its existing change documents.
  const version = canDefine && selected
    ? await getPlantDefinitionVersion(client, selected.plant)
    : 0;

  const initial: PlantDefinitionDraft = selected
    ? {
        plant: selected.plant,
        name: selected.name,
        country: selected.country.trim(),
        street: selected.street,
        houseNumber: selected.houseNumber,
        postalCode: selected.postalCode,
        city: selected.city,
        region: selected.region,
        factoryCalendar: selected.factoryCalendar,
        language: selected.language.trim() || 'EN',
        isProductionSite: selected.isProductionSite,
        isStorageSite: selected.isStorageSite,
      }
    : EMPTY_DRAFT;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="code text-ink-faint">{PLANT_DEFINE}</span>
          {canDefine && (
            <Link className="btn btn-primary" href="/config/plants?new=1">{t('plant.create')}</Link>
          )}
        </div>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight">{t('plant.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('plant.subtitle')}</p>
      </header>

      {showForm && (
        <PlantDefinitionForm
          key={`${creating ? 'CREATE' : 'CHANGE'}:${initial.plant}`}
          mode={creating ? 'CREATE' : 'CHANGE'}
          countries={countries}
          initial={initial}
          version={version}
        />
      )}
      {canDefine && editing && !selected && (
        <section role="status" className="panel p-4 text-sm text-signal-warn">
          <p>{t('plant.notFound')}</p>
          <Link className="mt-2 inline-block text-accent underline" href="/config/plants">{t('plant.backToList')}</Link>
        </section>
      )}
      {!canDefine && (
        <p className="text-sm text-ink-soft">{t('auth.readOnly', { authority: PLANT_DEFINE })}</p>
      )}

      <p className="text-xs text-ink-soft">{t('plant.roleFlagsNote')}</p>
      {plants.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-soft">{t('plant.empty')}</div>
      ) : (
        <div className="space-y-4">
          {plants.map((plant) => (
            <section key={plant.plant} className="panel overflow-hidden">
              <div className="panel-header">
                <div className="flex items-baseline gap-3">
                  <h2 className="panel-title">{plant.name}</h2>
                  <span className="code text-ink-faint">{plant.plant}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <span className={`chip ${plant.companyCode ? 'chip-neutral' : 'chip-warn'}`} aria-label={t('plant.company')}>
                    {plant.companyCode ?? t('cc.unassigned')}
                  </span>
                  {plant.isProductionSite && <span className="chip chip-info">{t('plant.production')}</span>}
                  {plant.isStorageSite && <span className="chip chip-neutral">{t('plant.storage')}</span>}
                  {canDefine && (
                    <Link
                      className="btn btn-default ml-2"
                      href={`/config/plants?edit=${encodeURIComponent(plant.plant)}`}
                    >
                      {t('plant.change')}
                    </Link>
                  )}
                </div>
              </div>
              {!plant.companyCode && (
                <div className="border-t border-line px-4 py-3">
                  {canAssign ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="code text-ink-faint">{PLANT_ASSIGNMENT}</span>
                        <p className="text-xs text-ink-soft">{t('plant.assignmentInitialOnly')}</p>
                      </div>
                      {companyCodeChoices.length > 0 ? (
                        <PlantCompanyCodeAssignmentForm plant={plant.plant} companyCodes={companyCodeChoices} />
                      ) : (
                        <p role="status" className="text-sm text-ink-soft">{t('plant.noActiveCompanyCodes')}</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-ink-soft">
                      {t('auth.readOnly', { authority: PLANT_ASSIGNMENT })}
                    </p>
                  )}
                </div>
              )}
              <table className="grid-table">
                <thead>
                  <tr>
                    <th className="w-28">{t('plant.locations')}</th>
                    <th>{t('plant.name')}</th>
                    <th className="w-40">{t('plant.negativeStock')}</th>
                  </tr>
                </thead>
                <tbody>
                  {plant.storageLocations.map((location) => (
                    <tr key={location.storageLocation}>
                      <td className="code font-semibold">{location.storageLocation}</td>
                      <td>{location.name}</td>
                      <td className="text-ink-soft">
                        {location.allowNegativeStock ? t('plant.permitted') : t('plant.refused')}
                      </td>
                    </tr>
                  ))}
                  {plant.storageLocations.length === 0 && (
                    <tr>
                      <td colSpan={3} className="text-ink-faint">{t('plant.noStorageLocations')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
