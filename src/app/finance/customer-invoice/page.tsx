
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  CUSTOMER_INVOICE_CAPABILITY, getCustomerInvoice, listCustomerInvoiceTaxCodes,
} from '@/modules/finance/customer-invoice';
import CustomerInvoice from './CustomerInvoice';
import { Page } from '@/ui/kit';

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
    <Page
      title={t('customerInvoice.title')} code="FIN.AR.INVOICE.POST · FB70" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('customerInvoice.subtitle')}
    >

      <CustomerInvoice
        invoice={invoice}
        taxes={taxes}
        canPost={can(session, CUSTOMER_INVOICE_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
