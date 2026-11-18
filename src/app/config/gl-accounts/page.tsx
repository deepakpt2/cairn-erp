import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  chartOfAccountsF4Choices,
  listChartOfAccounts,
} from '@/modules/foundation/chart-of-accounts-maintenance';
import { listGlAccounts } from '@/modules/foundation/services';
import { listAccountGroups } from '@/modules/finance/gl-account-group-maintenance';
import { AccountGroupsPanel } from './AccountGroups';
import { GlAccountInitialScreen } from './GlAccountInitialScreen';
import { GlAccountsList, type GlAccountListRow } from './GlAccountsList';
import type { ChartOfAccountsChoice } from '../chart-of-accounts/ChartOfAccountsValueHelp';
import type { AccountChoice } from './GlAccountValueHelp';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const CREATE_ACTIVITY = 'CFG.FIN.GLACCOUNT.CREATE';
const CHANGE_ACTIVITY = 'CFG.FIN.GLACCOUNT.CHANGE';
const DISPLAY_ACTIVITY = 'CFG.FIN.GLACCOUNT.DISPLAY';
const ROUTE = '/config/gl-accounts';

/**
 * FS00 — G/L Account Master Record (SCR-028), chart level.
 *
 * Replaces the read-only G/L account list: this is the maintenance hub, holding the
 * initial screen, the defined accounts and the Account Group registry that decides
 * every field's status. Company Code segment data is out of scope by owner decision.
 *
 * The registry is chart-scoped but the hub is not — it lists every account of the tenant —
 * so the panel carries the chart on each row and asks for one when a group is created.
 */
export default async function GlAccountsPage({
  searchParams,
}: {
  /** `deleted` carries the confirmation a delete dialog cannot render: its own row is gone. */
  searchParams: Promise<{ q?: string; deleted?: string }>;
}) {
  const params = await searchParams;
  // The tenant comes from the session, never from the query string: a `?client=`
  // override would let a signed-in user of one tenant read another's books.
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canCreate = can(session, CREATE_ACTIVITY);
  const canChange = can(session, CHANGE_ACTIVITY);
  const canDisplay = can(session, DISPLAY_ACTIVITY);

  const search = params.q ?? '';
  const [charts, choices, accounts, accountGroups] = await Promise.all([
    listChartOfAccounts(client),
    chartOfAccountsF4Choices(client),
    listGlAccounts(client, { search }),
    listAccountGroups(client),
  ]);

  // Only active, unblocked charts may be selected; accounts of a blocked chart stay
  // readable but cannot be created against it.
  const usableCharts = charts.filter((chart) => chart.isActive && !chart.isBlocked);
  const chartChoices: ChartOfAccountsChoice[] = usableCharts.map((chart) => ({
    code: chart.chartOfAccounts,
    name: chart.name,
    isActive: true,
  }));
  const accountNumberLengths: Record<string, number> = Object.fromEntries(
    usableCharts.map((chart) => [chart.chartOfAccounts, chart.accountNumberLength]),
  );

  const accountsByChart: Record<string, AccountChoice[]> = {};
  for (const account of accounts) {
    const list = accountsByChart[account.chartOfAccounts] ??= [];
    list.push({ code: account.accountNumber, name: account.name });
  }

  // The single legacy block flag stands for both blocks until the schema stage splits
  // the posting and creation blocks into their own columns.
  const rows: GlAccountListRow[] = accounts.map((account) => ({
    chartOfAccounts: account.chartOfAccounts,
    accountNumber: account.accountNumber,
    name: account.name,
    accountType: account.accountType,
    accountGroup: account.accountGroup,
    isOpenItemManaged: account.isOpenItemManaged,
    reconciliationType: account.reconciliationType,
    requiresCostObject: account.requiresCostObject,
    isBlockedPosting: account.isBlockedPosting,
    isBlockedCreation: account.isBlockedCreation,
  }));

  return (
    <Page
      title={t('glAccount.title')} code={<>{CREATE_ACTIVITY} · FS00</>} back={{ href: '/config', label: t('nav.workbench') }}
      description={t('glAccount.subtitle')}
      actions={
        <>
          <LinkButton href="/config/chart-of-accounts">{t('chartOfAccounts.title')}</LinkButton>
        </>
      }
    >

      {!canDisplay && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: DISPLAY_ACTIVITY })}
        </p>
      )}

      {params.deleted ? (
        <p role="status" className="mt-3 border border-line bg-sunken px-4 py-3 text-sm text-ink-soft">
          {t('glAccount.deleted', { account: params.deleted })}
        </p>
      ) : null}

      <GlAccountInitialScreen
        charts={chartChoices}
        accountsByChart={accountsByChart}
        accountNumberLengths={accountNumberLengths}
        canCreate={canCreate}
        canChange={canChange}
      />

      <form method="get" className="flex gap-2">
        <input
          type="text"
          name="q"
          defaultValue={search}
          placeholder={t('gl.search')}
          aria-label={t('gl.search')}
          className="field-input min-h-11 flex-1 sm:min-h-9"
        />
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9">
          {t('registry.search')}
        </button>
      </form>

      <GlAccountsList accounts={rows} canChange={canChange} />

      <AccountGroupsPanel
        groups={accountGroups}
        charts={chartChoices.map((chart) => ({ code: chart.code, name: chart.name }))}
        canCreate={canCreate}
        canChange={canChange}
      />
    </Page>
  );
}
