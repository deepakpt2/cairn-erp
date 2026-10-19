import type { Metadata } from 'next';
import Link from 'next/link';
import { t } from '@/platform/i18n';
import { can, requireSession } from '@/platform/auth/current';
import {
  CREDIT_CAPABILITY, getCustomerCredit, listCreditAudit, listCreditConfig,
  type CreditAuditView, type CustomerCreditView,
} from '@/modules/finance/credit';
import CreditShell from './CreditShell';

export const metadata: Metadata = { title: 'Customer Credit Management' };

export default async function Page({ searchParams }: {
  searchParams: Promise<{ customer?: string; area?: string }>;
}) {
  const session = await requireSession('/finance/credit');
  const params = await searchParams;
  const canUse = can(session, CREDIT_CAPABILITY);
  const config = canUse
    ? await listCreditConfig(session.user.client)
    : { areas: [], riskCategories: [], representativeGroups: [], creditGroups: [], blockReasons: [] };

  let credit: CustomerCreditView | null = null;
  let audit: CreditAuditView[] = [];
  let selected: { customer: string; area: string } | null = null;
  if (canUse && params.customer && params.area) {
    selected = { customer: params.customer, area: params.area.toUpperCase() };
    try {
      credit = await getCustomerCredit(session.user.client, selected.customer, selected.area);
      audit = await listCreditAudit(session.user.client, selected.customer, selected.area);
    } catch {
      selected = { customer: params.customer, area: params.area.toUpperCase() };
      credit = null;
      audit = [];
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <header>
        <p className="text-xs font-bold tracking-[0.18em] text-accent uppercase">{t('finance.label')}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">{t('credit.title')}</h1>
        <p className="text-sm text-ink-soft">{t('credit.intro')}</p>
        <Link href="/finance/customer-balances" className="mt-1 inline-block text-sm text-accent hover:underline">
          {t('credit.openBalances')}
        </Link>
      </header>
      <CreditShell canUse={canUse} config={config} credit={credit} audit={audit} selected={selected} />
    </main>
  );
}
