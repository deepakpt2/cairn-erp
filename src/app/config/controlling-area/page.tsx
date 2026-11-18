import Link from 'next/link';
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  controllingAreaF4Choices,
  getControllingAreaVersion,
  listControllingAreas,
} from '@/modules/foundation/controlling-area-maintenance';
import { ControllingAreaForm } from './ControllingAreaForm';
import { ControllingAreasList, type ControllingAreaListEntry } from './ControllingAreasList';
import type { ControllingAreaChoice } from './ControllingAreaValueHelp';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ACTIVITY = 'CFG.COST.CONTROLLINGAREA.DEFINE';
const ROUTE = '/config/controlling-area';

/** OKKP Controlling Area definition; Company Code assignment maintenance stays in OX19. */
export default async function ControllingAreaPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);
  const [areas, valueHelp] = await Promise.all([
    listControllingAreas(client),
    canMaintain
      ? controllingAreaF4Choices(client)
      : Promise.resolve({ currencies: [], fiscalYearVariants: [] }),
  ]);

  const currencies: ControllingAreaChoice[] = valueHelp.currencies.map((choice) => ({
    ...choice,
    isActive: true,
  }));
  const fiscalYearVariants: ControllingAreaChoice[] = valueHelp.fiscalYearVariants;
  const rows: ControllingAreaListEntry[] = await Promise.all(areas.map(async (area) => ({
    controllingArea: area.controllingArea,
    name: area.name,
    organizationName: area.organizationName,
    companyCodeScope: area.companyCodeScope,
    currency: area.currency,
    fiscalYearVariant: area.fiscalYearVariant,
    isActive: area.isActive,
    companyCodeCount: area.companyCodeCount,
    currencyLocked: area.currencyLocked,
    fiscalYearVariantLocked: area.fiscalYearVariantLocked,
    version: canMaintain ? await getControllingAreaVersion(client, area.controllingArea) : 0,
  })));

  return (
    <Page title={t('controllingArea.title')} code={<>{ACTIVITY} · OKKP</>} back={{ href: '/config', label: t('nav.workbench') }}>
      <section className="panel overflow-hidden">
        <nav aria-label={t('nav.workbench')} className="flex flex-wrap items-center gap-2 border-b border-line bg-sunken px-3 py-3 sm:px-4 sm:py-2">
          <Link href="/config/controlling-area/assign-company-code" className="inline-flex min-h-11 items-center border border-line-strong bg-white px-3 text-sm font-medium text-accent hover:bg-sunken sm:min-h-8 sm:py-1">
            {t('controllingArea.assignmentLink')}
          </Link>
          <Link href="/config/company-codes" className="inline-flex min-h-11 items-center border border-line-strong bg-white px-3 text-sm font-medium text-accent hover:bg-sunken sm:min-h-8 sm:py-1">
            {t('controllingArea.companyCodesLink')}
          </Link>
        </nav>
        <p className="border-b border-line px-3 py-3 text-sm text-ink-soft sm:px-4">{t('controllingArea.subtitle')}</p>
        <p className="border-b border-line bg-sunken px-3 py-2 text-xs text-ink-soft">{t('controllingArea.assignmentSeparate')}</p>
      </section>

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}
      {canMaintain && (
        <ControllingAreaForm currencies={currencies} fiscalYearVariants={fiscalYearVariants} />
      )}
      <ControllingAreasList
        areas={rows}
        canMaintain={canMaintain}
        currencies={currencies}
        fiscalYearVariants={fiscalYearVariants}
      />
    </Page>
  );
}
