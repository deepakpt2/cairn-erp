import Link from 'next/link';
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
  searchParams: Promise<{ q?: string }>;
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
  // XSPEB and XSPEA into their own columns.
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
    <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:p-6">
      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm">
        <header className="flex min-h-16 items-center gap-2 border-b border-[#9eb6c8] bg-[#c9dce9] px-3 py-2 text-[#28445b] sm:gap-3 sm:px-4">
          <Link
            href="/config"
            aria-label={t('nav.workbench')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#b5cddd] text-xl hover:bg-[#a9c3d5] sm:h-9 sm:w-9"
          >
            ‹
          </Link>
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#2d708b] font-bold tracking-tight text-white shadow-sm sm:h-8 sm:w-8"
            aria-label={t('app.name')}
          >
            C
          </span>
          <div className="min-w-0 flex-1 text-center">
            <span className="code text-2xs text-[#3e6078]">{CREATE_ACTIVITY} · FS00</span>
            <h1 className="text-sm font-semibold leading-tight sm:text-base">{t('glAccount.title')}</h1>
          </div>
        </header>
        <nav
          aria-label={t('nav.workbench')}
          className="flex flex-wrap items-center gap-2 border-b border-[#cbd5de] bg-[#eef3f7] px-3 py-3 sm:px-4 sm:py-2"
        >
          <Link
            href="/config"
            className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1"
          >
            {t('nav.workbench')}
          </Link>
          <Link
            href="/config/chart-of-accounts"
            className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1"
          >
            {t('chartOfAccounts.title')}
          </Link>
        </nav>
        <p className="border-b border-[#cbd5de] px-3 py-3 text-sm text-[#435b6d] sm:px-4">
          {t('glAccount.subtitle')}
        </p>
      </section>

      {!canDisplay && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: DISPLAY_ACTIVITY })}
        </p>
      )}

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
    </div>
  );
}
