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
    <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:p-6">
      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm">
        <header className="flex min-h-16 items-center gap-2 border-b border-[#9eb6c8] bg-[#c9dce9] px-3 py-2 text-[#28445b] sm:gap-3 sm:px-4">
          <Link href="/config" aria-label={t('nav.workbench')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#b5cddd] text-xl hover:bg-[#a9c3d5] sm:h-9 sm:w-9">‹</Link>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#2d708b] font-bold tracking-tight text-white shadow-sm sm:h-8 sm:w-8" aria-label={t('app.name')}>C</span>
          <div className="min-w-0 flex-1 text-center">
            <span className="code text-2xs text-[#3e6078]">{ACTIVITY} · OKKP</span>
            <h1 className="text-sm font-semibold leading-tight sm:text-base">{t('controllingArea.title')}</h1>
          </div>
        </header>
        <nav aria-label={t('nav.workbench')} className="flex flex-wrap items-center gap-2 border-b border-[#cbd5de] bg-[#eef3f7] px-3 py-3 sm:px-4 sm:py-2">
          <Link href="/config/controlling-area/assign-company-code" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">
            {t('controllingArea.assignmentLink')}
          </Link>
          <Link href="/config/company-codes" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">
            {t('controllingArea.companyCodesLink')}
          </Link>
        </nav>
        <p className="border-b border-[#cbd5de] px-3 py-3 text-sm text-[#435b6d] sm:px-4">{t('controllingArea.subtitle')}</p>
        <p className="border-b border-[#cbd5de] bg-[#f7f9fa] px-3 py-2 text-xs text-ink-soft">{t('controllingArea.assignmentSeparate')}</p>
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
    </div>
  );
}
