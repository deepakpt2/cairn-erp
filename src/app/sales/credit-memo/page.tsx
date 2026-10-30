import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  CUSTOMER_CREDIT_MEMO_CAPABILITY, getCustomerCreditMemo,
} from '@/modules/finance/customer-credit-memo';
import { listCustomerInvoiceTaxCodes } from '@/modules/finance/customer-invoice';
import { listBillings } from '@/modules/sales/billing';
import CreditMemo from './CreditMemo';

export const dynamic = 'force-dynamic';

const ROUTE = '/sales/credit-memo';

/**
 * Customer credit memo entry (DI-020). Creates a credit memo against an
 * original billing document or customer invoice, posts the receivable
 * through the existing accounting-invoice engine, and supports reversal.
 */
export default async function SalesCreditMemoPage({ searchParams }: {
  searchParams: Promise<{ invoice?: string; billing?: string; customer?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const invoiceNumber = (params.invoice ?? '').trim().toUpperCase();
  const billingNumber = (params.billing ?? '').trim().toUpperCase();
  const customerNumber = (params.customer ?? '').trim().toUpperCase();

  const [invoice, billings, taxes] = await Promise.all([
    invoiceNumber ? getCustomerCreditMemo(client, invoiceNumber) : null,
    customerNumber ? listBillings(client, { customerNumber, status: 'POSTED' }) : null,
    listCustomerInvoiceTaxCodes(client, '1000'),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{CUSTOMER_CREDIT_MEMO_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('customerCreditMemo.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('customerCreditMemo.subtitle')}</p>
      </header>

      <CreditMemo
        invoice={invoice}
        billings={billings ?? []}
        taxes={taxes}
        billingNumber={billingNumber}
        canPost={can(session, CUSTOMER_CREDIT_MEMO_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
