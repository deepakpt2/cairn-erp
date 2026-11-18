import Link from 'next/link';
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { getSalesAreaVersion, listSalesAreas, salesAreaF4Choices } from '@/modules/foundation/sales-area-maintenance';
import { SalesAreaForm } from './SalesAreaForm';
import { SalesAreasList, type SalesAreaListEntry } from './SalesAreasList';

export const dynamic = 'force-dynamic';

const ACTIVITY = 'CFG.ORG.SALESAREA.DEFINE';
const ROUTE = '/config/sales-areas';

/** OVXG Sales Area maintenance, guarded by the exact configuration capability. */
export default async function SalesAreasPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const languageKey = session.user.logonLanguage ?? 'E';
  const canMaintain = can(session, ACTIVITY);
  const [areas, valueHelp] = await Promise.all([
    listSalesAreas(client, languageKey),
    canMaintain
      ? salesAreaF4Choices(client, undefined, languageKey)
      : Promise.resolve({ salesOrganizations: [], distributionChannels: [], divisions: [] }),
  ]);

  const rows = await Promise.all(areas.map(async (area) => ({
    ...area,
    version: await getSalesAreaVersion(client, {
      salesOrg: area.salesOrg,
      distributionChannel: area.distributionChannel,
      division: area.division,
    }),
  }))) as SalesAreaListEntry[];

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:p-6">
      <section className="overflow-hidden border border-line-strong bg-white shadow-sm">
        <header className="flex min-h-16 items-center gap-2 border-b border-line-strong bg-sunken px-3 py-2 text-ink sm:gap-3 sm:px-4">
          <Link href="/config" aria-label={t('nav.workbench')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-line text-xl hover:bg-line-strong sm:h-9 sm:w-9">‹</Link>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent font-bold tracking-tight text-white shadow-sm sm:h-8 sm:w-8" aria-label={t('app.name')}>C</span>
          <div className="min-w-0 flex-1 text-center">
            <span className="code text-2xs text-ink-soft">{ACTIVITY} · OVXG</span>
            <h1 className="text-sm font-semibold leading-tight sm:text-base">{t('salesArea.title')}</h1>
          </div>
          <Link href="/config" className="hidden shrink-0 text-xs text-ink underline sm:inline">{t('nav.workbench')}</Link>
        </header>
        <nav aria-label={t('salesArea.navigation')} className="flex flex-wrap items-center gap-2 border-b border-line bg-sunken px-3 py-3 sm:px-4 sm:py-2">
          <Link href="/config/sales-orgs" className="inline-flex min-h-11 items-center border border-line-strong bg-white px-3 text-sm font-medium text-accent hover:bg-sunken sm:min-h-8">{t('salesArea.salesOrgDefinitions')}</Link>
          <Link href="/config/distribution-channels" className="inline-flex min-h-11 items-center border border-line-strong bg-white px-3 text-sm font-medium text-accent hover:bg-sunken sm:min-h-8">{t('salesArea.distributionChannelDefinitions')}</Link>
          <Link href="/config/divisions" className="inline-flex min-h-11 items-center border border-line-strong bg-white px-3 text-sm font-medium text-accent hover:bg-sunken sm:min-h-8">{t('salesArea.divisionDefinitions')}</Link>
          <Link href="/config/sales-orgs/assign-distribution-channel" className="inline-flex min-h-11 items-center border border-line-strong bg-white px-3 text-sm font-medium text-accent hover:bg-sunken sm:min-h-8">{t('salesArea.ovxkLink')}</Link>
          <Link href="/config/sales-orgs/assign-division" className="inline-flex min-h-11 items-center border border-line-strong bg-white px-3 text-sm font-medium text-accent hover:bg-sunken sm:min-h-8">{t('salesArea.ovxaLink')}</Link>
        </nav>
        <p className="border-b border-line px-3 py-3 text-sm text-ink-soft sm:px-4">{t('salesArea.subtitle')}</p>
        <p className="border-b border-line bg-sunken px-3 py-2 text-xs text-ink-soft">{t('salesArea.selectionRule')}</p>
      </section>

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}
      {canMaintain && (
        <SalesAreaForm salesOrganizations={valueHelp.salesOrganizations} />
      )}
      <SalesAreasList areas={rows} canMaintain={canMaintain} />
    </div>
  );
}
