import type { Metadata } from 'next';
import Link from 'next/link';
import { t } from '@/platform/i18n';
import { can, requireSession } from '@/platform/auth/current';
import {
  CREDIT_CAPABILITY, getCustomerCredit, listCreditAudit, listCreditConfig,
  type CreditAuditView, type CustomerCreditView,
} from '@/modules/finance/credit';
import CreditShell from './CreditShell';
import { Page } from '@/ui/kit';

export const metadata: Metadata = { title: 'Customer Credit Management' };

export default async function ScreenPage({ searchParams }: {
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
    <Page
      title={t('credit.title')} code={t('finance.label')} back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('credit.intro')}</p>
          <Link href="/finance/customer-balances" className="mt-1 inline-block text-sm text-accent hover:underline">
              {t('credit.openBalances')}
            </Link>
          {' · '}
          <Link href="/finance/credit-monitor" className="mt-1 inline-block text-sm text-accent hover:underline">
              {t('credit.openMonitor')}
            </Link>
        </>
      }
    >
      <CreditShell canUse={canUse} config={config} credit={credit} audit={audit} selected={selected} />
    </Page>
  );
}
