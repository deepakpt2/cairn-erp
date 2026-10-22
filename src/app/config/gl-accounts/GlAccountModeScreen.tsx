import Link from 'next/link';
import type { ReactNode } from 'react';
import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import { t } from '@/platform/i18n';
import {
  chartOfAccountsF4Choices,
  listChartOfAccounts,
} from '@/modules/foundation/chart-of-accounts-maintenance';
import { glAccountAuditVersion, listGlAccounts } from '@/modules/foundation/services';
import {
  accountGroupChoices,
  accountGroupFieldStatusMatrices,
  groupAccountChoices,
} from '@/modules/finance/gl-account-group-maintenance';
import { GlAccountFields, type GlAccountMode, type GlAccountValues } from './GlAccountFields';
import {
  RECONCILIATION_TYPES,
  type AccountType,
  type GlAccountType,
  type ReconciliationType,
} from './fieldStatus';

const ROUTE = '/config/gl-accounts';

/** The mode's own path, so choosing a chart keeps the operator in the screen they came to. */
const MODE_PATH: Record<GlAccountMode, string> = {
  CREATE: 'new',
  CHANGE: 'edit',
  DISPLAY: 'view',
};

const MODE_ACTIVITY: Record<GlAccountMode, { activity: string; alias: string }> = {
  CREATE: { activity: 'CFG.FIN.GLACCOUNT.CREATE', alias: 'FS00' },
  CHANGE: { activity: 'CFG.FIN.GLACCOUNT.CHANGE', alias: 'FSP0' },
  DISPLAY: { activity: 'CFG.FIN.GLACCOUNT.DISPLAY', alias: 'FSS0' },
};

/**
 * Stored reconciliation indicator to the screen's value.
 *
 * Migration 0036 moved stored values to the contracted plural vocabulary and kept
 * `MATERIAL` as a fourth contracted value (R-52/D-124), so a stored value is either
 * contracted or absent. Anything else is left unselected rather than silently rewritten
 * into a different subledger.
 */
function toContractReconciliation(stored: string | null): GlAccountValues['reconciliationType'] {
  return stored !== null && (RECONCILIATION_TYPES as readonly string[]).includes(stored)
    ? (stored as ReconciliationType)
    : '';
}

/**
 * What the screen asks when it was opened without a chart.
 *
 * Create can proceed on a chart alone, so the charts are offered as links into this same mode.
 * Change and Display need an account as well, and a list of charts would only offer a second
 * question with the first one still unanswered, so they are sent to the hub that asks both.
 */
function ChartChooser({
  mode,
  charts,
}: {
  mode: GlAccountMode;
  charts: Array<{ chartOfAccounts: string; name: string }>;
}) {
  return (
    <div className="border border-line bg-white p-4">
      <p role="status" className="text-sm font-medium text-ink">{t('glAccount.chartChoose')}</p>
      <p className="mt-1 text-xs text-ink-soft">
        {mode === 'CREATE' ? t('glAccount.chartChooseRule') : t('glAccount.chartChooseAccountRule')}
      </p>
      {mode === 'CREATE' ? (
        <ul className="mt-3 space-y-2">
          {charts.map((chart) => (
            <li key={chart.chartOfAccounts}>
              <Link
                href={`${ROUTE}/${MODE_PATH[mode]}?chart=${encodeURIComponent(chart.chartOfAccounts)}`}
                className="text-sm text-accent hover:underline"
              >
                <span className="code font-semibold">{chart.chartOfAccounts}</span> · {chart.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3">
          <Link href={ROUTE} className="text-sm text-accent hover:underline">
            {t('glAccount.backToList')}
          </Link>
        </p>
      )}
    </div>
  );
}

/**
 * One FS00 mode screen: Create, Change or Display.
 *
 * The chart is resolved first because it owns the account number's maximum length and the
 * cost element policy, and because a blocked or deactivated chart must
 * refuse new accounts while keeping existing ones readable.
 */
export async function GlAccountModeScreen({
  mode,
  searchParams,
}: {
  mode: GlAccountMode;
  searchParams: Promise<{ chart?: string; account?: string }>;
}) {
  const params = await searchParams;
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const { activity, alias } = MODE_ACTIVITY[mode];
  const canWrite = can(session, mode === 'DISPLAY' ? 'CFG.FIN.GLACCOUNT.DISPLAY' : activity);

  const chartKey = (params.chart ?? '').trim().toUpperCase();
  const accountKey = (params.account ?? '').trim();

  const [charts, choices] = await Promise.all([
    listChartOfAccounts(client),
    chartOfAccountsF4Choices(client),
  ]);
  const chart = charts.find((row) => row.chartOfAccounts === chartKey);
  // A blocked or deactivated chart keeps its accounts readable but accepts no new ones, so a
  // chooser offers only the charts this mode can actually work in.
  const usableCharts = charts.filter((row) => row.isActive && !row.isBlocked);

  const accounts = chart
    ? await listGlAccounts(client, { chartOfAccounts: chart.chartOfAccounts })
    : [];
  const existing = mode === 'CREATE' ? undefined : accounts.find((row) => row.accountNumber === accountKey);


  const shell = (body: ReactNode) => (
    <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:p-6">
      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm">
        <header className="flex min-h-16 items-center gap-2 border-b border-[#9eb6c8] bg-[#c9dce9] px-3 py-2 text-[#28445b] sm:gap-3 sm:px-4">
          <Link
            href={ROUTE}
            aria-label={t('glAccount.backToList')}
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
            <span className="code text-2xs text-[#3e6078]">{activity} · {alias}</span>
            <h1 className="text-sm font-semibold leading-tight sm:text-base">{t('glAccount.title')}</h1>
          </div>
        </header>
        <p className="border-b border-[#cbd5de] px-3 py-3 text-sm text-[#435b6d] sm:px-4">{t('glAccount.subtitle')}</p>
      </section>
      {body}
    </div>
  );

  const notice = (text: string) =>
    shell(
      <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
        {text}
      </p>,
    );

  if (!chart) {
    // Three situations used to share one sentence, which told an operator holding two charts
    // that none was defined. A wrong diagnosis is worse than none: it sends them to define a
    // chart they already have, and leaves the real question — which one is this screen working
    // in — unasked.
    if (chartKey) {
      return notice(t('glAccount.chartNotFound', { chart: chartKey }));
    }
    if (usableCharts.length === 0) {
      return notice(t('glAccount.chartEmpty'));
    }
    return shell(<ChartChooser mode={mode} charts={usableCharts} />);
  }
  if (mode !== 'DISPLAY' && !canWrite) return notice(t('glAccount.modeDenied', { authority: activity }));
  // A blocked chart keeps its accounts readable but refuses new ones; a deactivated
  // chart refuses both writes and new accounts, exactly as OB13's lifecycle states.
  if (mode === 'CREATE' && (!chart.isActive || chart.isBlocked)) {
    return notice(t('chartOfAccounts.blockedRule'));
  }
  if (mode === 'CHANGE' && !chart.isActive) return notice(t('chartOfAccounts.inactiveRetained'));
  if (mode !== 'CREATE' && !existing) {
    return notice(t('glAccount.notFound', { account: accountKey || '—', chart: chart.chartOfAccounts }));
  }

  // The Account Group registry drives the field screen twice over: its rows are the F4
  // for the Account Group, and the selected group's matrix decides which fields are rendered at all.
  // The group-side account master is looked up through the chart's Group CoA and is empty
  // until a consolidation round fills it (R-51/D-123).
  const [groups, groupMatrices, groupAccounts] = await Promise.all([
    accountGroupChoices(client, chart.chartOfAccounts),
    accountGroupFieldStatusMatrices(client, chart.chartOfAccounts),
    groupAccountChoices(client, chart.chartOfAccounts),
  ]);
  // The version a Change must post back; Create starts at zero because nothing is stored.
  const version =
    mode === 'CHANGE' && existing
      ? await glAccountAuditVersion(client, chart.chartOfAccounts, existing.accountNumber)
      : 0;

  // Only a stored record can seed the form; Create mode starts from the contract
  // defaults plus the number carried over from the initial screen.
  const accountArgument = existing ? `${chart.chartOfAccounts.trim()}/${existing.accountNumber.trim()}` : '';
  const changeLock = mode === 'CHANGE' && existing && canWrite
    ? await openChangeForSession(session, {
        lockObject: 'GL_ACCOUNT',
        argument: accountArgument,
        transactionCode: 'CFG.FIN.GLACCOUNT.CHANGE',
      })
    : null;

  const stored: GlAccountValues | null = existing
    ? {
        accountNumber: existing.accountNumber,
        name: existing.name,
        accountType: existing.accountType as AccountType,
        accountGroup: existing.accountGroup,
        glAccountType: existing.glAccountType as GlAccountType,
        isOpenItemManaged: existing.isOpenItemManaged,
        reconciliationType: toContractReconciliation(existing.reconciliationType),
        retainedEarningsIndicator: existing.retainedEarningsIndicator ?? 'X',
        requiresCostObject: existing.requiresCostObject,
        isTaxRelevant: existing.isTaxRelevant,
        groupAccountNumber: existing.groupAccountNumber ?? '',
        languageKey: existing.languageKey,
        sortKey: existing.sortKey,
        isBlockedPosting: existing.isBlockedPosting,
        isBlockedCreation: existing.isBlockedCreation,
      }
    : null;

  return shell(
    <>
      {changeLock?.mode === 'CHANGE' && <ChangeLock lockObject="GL_ACCOUNT" argument={accountArgument} />}
      <LockNotice message={changeLock?.mode === 'DISPLAY' ? displayOnlyMessage(changeLock) : null} />
    <GlAccountFields
      mode={mode}
      chartOfAccounts={chart.chartOfAccounts}
      chartName={chart.name}
      accountNumberLength={chart.accountNumberLength}
      costElementPolicy={chart.costElementIntegration as 'AUTOMATIC' | 'MANUAL' | 'NONE'}
      account={stored}
      initialAccountNumber={accountKey}
      groups={groups}
      groupMatrices={groupMatrices}
      groupAccounts={groupAccounts}
      languages={choices.languages}
      canSave={canWrite && changeLock?.mode !== 'DISPLAY'}
      version={version}
    />
    </>,
  );
}
