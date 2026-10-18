import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  CUSTOMER_INVOICE_CAPABILITY, getCustomerInvoice, listCustomerInvoiceTaxCodes,
} from '@/modules/finance/customer-invoice';
import CustomerInvoice from './CustomerInvoice';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/customer-invoice';

/**
 * Customer invoice posting, direct (SCR-067 / FB70 as a search alias only).
 */
export default async function CustomerInvoicePage({ searchParams }: {
  searchParams: Promise<{ invoice?: string; companyCode?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const invoice = params.invoice ? await getCustomerInvoice(client, params.invoice) : null;
  const taxes = await listCustomerInvoiceTaxCodes(client, params.companyCode ?? '1000');
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AR.INVOICE.POST · FB70</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('customerInvoice.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('customerInvoice.subtitle')}</p>
      </header>

      <CustomerInvoice
        invoice={invoice}
        taxes={taxes}
        canPost={can(session, CUSTOMER_INVOICE_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
