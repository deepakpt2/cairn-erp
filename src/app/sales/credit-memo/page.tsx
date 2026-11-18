
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  CUSTOMER_CREDIT_MEMO_CAPABILITY, getCustomerCreditMemo,
} from '@/modules/finance/customer-credit-memo';
import { listCustomerInvoiceTaxCodes } from '@/modules/finance/customer-invoice';
import { listBillings } from '@/modules/sales/billing';
import CreditMemo from './CreditMemo';
import { Page } from '@/ui/kit';

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
    <Page
      title={t('customerCreditMemo.title')} code={CUSTOMER_CREDIT_MEMO_CAPABILITY} back={{ href: '/', label: t('nav.launchpad') }}
      description={t('customerCreditMemo.subtitle')}
    >

      <CreditMemo
        invoice={invoice}
        billings={billings ?? []}
        taxes={taxes}
        billingNumber={billingNumber}
        canPost={can(session, CUSTOMER_CREDIT_MEMO_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
