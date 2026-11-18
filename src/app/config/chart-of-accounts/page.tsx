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
import { LinkButton, Page } from '@/ui/kit';

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
    <Page
      title={t('chartOfAccounts.title')} code={<>{ACTIVITY} · OB13</>} back={{ href: '/config', label: t('nav.workbench') }}
      description={t('chartOfAccounts.subtitle')}
      actions={
        <>
          <LinkButton href="/config/company-codes">{t('chartOfAccounts.companyCodesLink')}</LinkButton>
          <LinkButton href="/config/chart-of-accounts/copy">{t('chartOfAccounts.copyLink')}</LinkButton>
        </>
      }
    >

      {!canMaintain && <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">{t('auth.readOnly', { authority: ACTIVITY })}</p>}
      {canMaintain && <ChartOfAccountsForm mode="CREATE" languages={languages} groupCharts={groupCharts} canMaintain={canMaintain} />}
      <ChartOfAccountsList charts={charts} canMaintain={canMaintain} languages={languages} groupCharts={groupCharts} />
      <GroupChartOfAccountsPanel entries={groupEntries} languages={languages} canMaintain={canMaintain} />
    </Page>
  );
}
