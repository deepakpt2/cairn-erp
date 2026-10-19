import type { Metadata } from 'next';
import Link from 'next/link';
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { listCompanyCodes } from '@/modules/foundation/services';
import { listChartOfAccounts } from '@/modules/foundation/chart-of-accounts-maintenance';
import { GL_ACCOUNT_TRANSFER_CAPABILITY, type GlAccountTransferSelection } from '@/modules/finance/gl-account-transfer';
import TransferShell from './TransferShell';

export const metadata: Metadata = { title: 'Transfer G/L Account Master Data' };
export const dynamic = 'force-dynamic';

const ROUTE = '/config/gl-accounts/transfer';

export default async function Page({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const canUse = can(session, GL_ACCOUNT_TRANSFER_CAPABILITY);
  const companies = (await listCompanyCodes(session.user.client))
    .filter((c) => c.isActive)
    .map((c) => ({ companyCode: c.companyCode, name: c.name }));
  const charts = (await listChartOfAccounts(session.user.client))
    .map((c) => ({ chartOfAccounts: c.chartOfAccounts, name: c.name ?? '' }));

  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const selection: GlAccountTransferSelection = {
    sourceCompanyCode: first(params.sourceCompanyCode) ?? companies[0]?.companyCode ?? '',
    targetCompanyCode: first(params.targetCompanyCode) ?? '',
    chartOfAccounts: first(params.chartOfAccounts) ?? charts[0]?.chartOfAccounts ?? '',
    accountFrom: first(params.accountFrom) || undefined,
    accountTo: first(params.accountTo) || undefined,
    testRun: first(params.testRun) !== '0',
    withCompanyData: first(params.withCompanyData) !== '0',
    overwriteExisting: first(params.overwriteExisting) === '1',
  };

  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <header>
        <p className="text-xs font-bold tracking-[0.18em] text-accent uppercase">{t('finance.label')}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">Transfer G/L Account Master Data</h1>
        <p className="text-sm text-ink-soft">
          Copy company-code segments of G/L accounts from a source to a target company code on the same chart of accounts.
          Test runs validate everything and copy nothing; every run leaves a protocol.
        </p>
        <Link href="/config/gl-accounts" className="mt-1 inline-block text-sm text-accent hover:underline">
          G/L account master…
        </Link>
      </header>
      <TransferShell canUse={canUse} companies={companies} charts={charts} selection={selection} result={null} />
    </main>
  );
}
