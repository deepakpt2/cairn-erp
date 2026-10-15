import Link from 'next/link';
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { listChartOfAccounts } from '@/modules/foundation/chart-of-accounts-maintenance';
import { CopyChartForm, type CopyChartChoice } from './CopyChartForm';

export const dynamic = 'force-dynamic';

const ACTIVITY = 'CFG.FIN.COA.COPY';
const ROUTE = '/config/chart-of-accounts/copy';

/** OBY7 Copy Chart of Accounts; the source chart must already be defined in OB13. */
export default async function CopyChartOfAccountsPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canCopy = can(session, ACTIVITY);
  const charts = await listChartOfAccounts(client);

  // Only active, unblocked charts take part: a blocked chart cannot be copied from or
  // into, the same rule FS00 applies when it refuses to create against one.
  const choices: CopyChartChoice[] = charts
    .filter((chart) => chart.isActive && !chart.isBlocked)
    .map((chart) => ({
      code: chart.chartOfAccounts,
      name: chart.name,
      accountNumberLength: chart.accountNumberLength,
    }));

  return (
    <div className="mx-auto max-w-4xl space-y-4 px-3 py-4 sm:p-6">
      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm">
        <header className="flex min-h-16 items-center gap-2 border-b border-[#9eb6c8] bg-[#c9dce9] px-3 py-2 text-[#28445b] sm:gap-3 sm:px-4">
          <Link href="/config/chart-of-accounts" aria-label={t('chartOfAccounts.title')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#b5cddd] text-xl hover:bg-[#a9c3d5] sm:h-9 sm:w-9">‹</Link>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#2d708b] font-bold tracking-tight text-white shadow-sm sm:h-8 sm:w-8" aria-label={t('app.name')}>C</span>
          <div className="min-w-0 flex-1 text-center">
            <span className="code text-2xs text-[#3e6078]">{ACTIVITY} · OBY7</span>
            <h1 className="text-sm font-semibold leading-tight sm:text-base">{t('chartCopy.title')}</h1>
          </div>
        </header>
        <nav aria-label={t('nav.workbench')} className="flex flex-wrap items-center gap-2 border-b border-[#cbd5de] bg-[#eef3f7] px-3 py-3 sm:px-4 sm:py-2">
          <Link href="/config" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('nav.workbench')}</Link>
          <Link href="/config/chart-of-accounts" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('chartOfAccounts.title')}</Link>
        </nav>
        <p className="border-b border-[#cbd5de] px-3 py-3 text-sm text-[#435b6d] sm:px-4">{t('chartCopy.subtitle')}</p>
      </section>

      {!canCopy && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}
      <CopyChartForm charts={choices} canCopy={canCopy} />
    </div>
  );
}
