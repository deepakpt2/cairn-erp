import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { listChartOfAccounts } from '@/modules/foundation/chart-of-accounts-maintenance';
import { CopyChartForm, type CopyChartChoice } from './CopyChartForm';
import { LinkButton, Page } from '@/ui/kit';

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
    <Page
      title={t('chartCopy.title')} code={<>{ACTIVITY} · OBY7</>} width="4xl" back={{ href: '/config', label: t('nav.workbench') }}
      description={t('chartCopy.subtitle')}
      actions={
        <>
          <LinkButton href="/config/chart-of-accounts">{t('chartOfAccounts.title')}</LinkButton>
        </>
      }
    >

      {!canCopy && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}
      <CopyChartForm charts={choices} canCopy={canCopy} />
    </Page>
  );
}
