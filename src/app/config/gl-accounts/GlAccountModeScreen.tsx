import Link from 'next/link';
import type { ReactNode } from 'react';
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  chartOfAccountsF4Choices,
  listChartOfAccounts,
} from '@/modules/foundation/chart-of-accounts-maintenance';
import { listGlAccounts } from '@/modules/foundation/services';
import { GlAccountFields, type GlAccountMode, type GlAccountValues } from './GlAccountFields';
import {
  LEGACY_RECONCILIATION_TYPES,
  type AccountGroupChoice,
  type AccountType,
  type FieldStatusMatrix,
  type GlAccountType,
} from './fieldStatus';
import type { AccountChoice } from './GlAccountValueHelp';

const ROUTE = '/config/gl-accounts';

const MODE_ACTIVITY: Record<GlAccountMode, { activity: string; alias: string }> = {
  CREATE: { activity: 'CFG.FIN.GLACCOUNT.CREATE', alias: 'FS00' },
  CHANGE: { activity: 'CFG.FIN.GLACCOUNT.CHANGE', alias: 'FSP0' },
  DISPLAY: { activity: 'CFG.FIN.GLACCOUNT.DISPLAY', alias: 'FSS0' },
};

/**
 * Stored `MITKZ` vocabulary to the FS00 contract vocabulary.
 *
 * Existing rows hold singular values, and four hold `MATERIAL`, which the contracted
 * list omits. Singular values are read into their plural contract form; the material
 * value is carried through unchanged so it stays visible and is never rewritten by a
 * Change. Whether to migrate or extend the list is an owner decision for the schema stage.
 */
const RECONCILIATION_TO_CONTRACT: Record<string, GlAccountValues['reconciliationType']> = {
  VENDORS: 'VENDORS',
  CUSTOMERS: 'CUSTOMERS',
  ASSETS: 'ASSETS',
  VENDOR: 'VENDORS',
  CUSTOMER: 'CUSTOMERS',
  ASSET: 'ASSETS',
  ...Object.fromEntries(LEGACY_RECONCILIATION_TYPES.map((type) => [type, type])),
};

/**
 * One FS00 mode screen: Create, Change or Display.
 *
 * The chart is resolved first because it owns the account number's maximum length (OB13
 * `KTKTB`) and the cost element policy, and because a blocked or deactivated chart must
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

  const accounts = chart
    ? await listGlAccounts(client, { chartOfAccounts: chart.chartOfAccounts })
    : [];
  const existing = mode === 'CREATE' ? undefined : accounts.find((row) => row.accountNumber === accountKey);

  // The Account Group registry, its field status matrices and the group-side account
  // master arrive with the schema and service stages.
  const accountGroupChoices: AccountGroupChoice[] = [];
  const groupMatrices: Record<string, FieldStatusMatrix> = {};
  const groupAccounts: AccountChoice[] = [];

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

  if (!chart) return notice(t('glAccount.chartEmpty'));
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

  // Only a stored record can seed the form; Create mode starts from the contract
  // defaults plus the number carried over from the initial screen.
  const stored: GlAccountValues | null = existing
    ? {
        accountNumber: existing.accountNumber,
        name: existing.name,
        accountType: existing.accountType as AccountType,
        // The Account Group column arrives with the schema stage.
        accountGroup: '',
        glAccountType: (existing.isBalanceSheet ? 'BALANCE_SHEET' : 'PL_STATEMENT') as GlAccountType,
        isOpenItemManaged: existing.isOpenItemManaged,
        reconciliationType: RECONCILIATION_TO_CONTRACT[existing.reconciliationType ?? ''] ?? '',
        requiresCostObject: existing.requiresCostObject,
        isTaxRelevant: existing.isTaxRelevant,
        groupAccountNumber: '',
        // Language Key and Sort Key columns arrive with the schema stage.
        languageKey: 'EN',
        sortKey: '000',
        // The single legacy block flag stands for both blocks until XSPEB and XSPEA are
        // split into their own columns.
        isBlockedPosting: existing.isBlocked,
        isBlockedCreation: existing.isBlocked,
      }
    : null;

  return shell(
    <GlAccountFields
      mode={mode}
      chartOfAccounts={chart.chartOfAccounts}
      chartName={chart.name}
      accountNumberLength={chart.accountNumberLength}
      costElementPolicy={chart.costElementIntegration as 'AUTOMATIC' | 'MANUAL' | 'NONE'}
      account={stored}
      initialAccountNumber={accountKey}
      groups={accountGroupChoices}
      groupMatrices={groupMatrices}
      groupAccounts={groupAccounts}
      languages={choices.languages}
      canSave={canWrite}
      mutationReady={false}
    />,
  );
}
