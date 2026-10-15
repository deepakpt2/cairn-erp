import Link from 'next/link';
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  chartOfAccountsF4Choices,
  listChartOfAccounts,
  listGroupChartsOfAccounts,
} from '@/modules/foundation/chart-of-accounts-maintenance';
import { ChartOfAccountsForm } from './ChartOfAccountsForm';
import { ChartOfAccountsList } from './ChartOfAccountsList';
import { GroupChartOfAccountsPanel } from './GroupChartOfAccounts';
import type { ChartOfAccountsChoice, LanguageChoice } from './ChartOfAccountsValueHelp';

export const dynamic = 'force-dynamic';

const ACTIVITY = 'CFG.FIN.COA.DEFINE';
const ROUTE = '/config/chart-of-accounts';

/** OB13 Chart of Accounts definition; Company Code assignment remains a separate activity. */
export default async function ChartOfAccountsPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);
  const [charts, choices, groupEntries] = await Promise.all([
    listChartOfAccounts(client),
    chartOfAccountsF4Choices(client),
    listGroupChartsOfAccounts(client),
  ]);

  const languages: LanguageChoice[] = choices.languages;
  const groupCharts: ChartOfAccountsChoice[] = choices.groupCharts;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:p-6">
      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm">
        <header className="flex min-h-16 items-center gap-2 border-b border-[#9eb6c8] bg-[#c9dce9] px-3 py-2 text-[#28445b] sm:gap-3 sm:px-4">
          <Link href="/config" aria-label={t('nav.workbench')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#b5cddd] text-xl hover:bg-[#a9c3d5] sm:h-9 sm:w-9">‹</Link>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#2d708b] font-bold tracking-tight text-white shadow-sm sm:h-8 sm:w-8" aria-label={t('app.name')}>C</span>
          <div className="min-w-0 flex-1 text-center">
            <span className="code text-2xs text-[#3e6078]">{ACTIVITY} · OB13</span>
            <h1 className="text-sm font-semibold leading-tight sm:text-base">{t('chartOfAccounts.title')}</h1>
          </div>
        </header>
        <nav aria-label={t('nav.workbench')} className="flex flex-wrap items-center gap-2 border-b border-[#cbd5de] bg-[#eef3f7] px-3 py-3 sm:px-4 sm:py-2">
          <Link href="/config" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('nav.workbench')}</Link>
          <Link href="/config/company-codes" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('chartOfAccounts.companyCodesLink')}</Link>
          <Link href="/config/chart-of-accounts/copy" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('chartOfAccounts.copyLink')}</Link>
        </nav>
        <p className="border-b border-[#cbd5de] px-3 py-3 text-sm text-[#435b6d] sm:px-4">{t('chartOfAccounts.subtitle')}</p>
      </section>

      {!canMaintain && <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">{t('auth.readOnly', { authority: ACTIVITY })}</p>}
      {canMaintain && <ChartOfAccountsForm mode="CREATE" languages={languages} groupCharts={groupCharts} canMaintain={canMaintain} />}
      <ChartOfAccountsList charts={charts} canMaintain={canMaintain} languages={languages} groupCharts={groupCharts} />
      <GroupChartOfAccountsPanel entries={groupEntries} languages={languages} canMaintain={canMaintain} />
    </div>
  );
}
