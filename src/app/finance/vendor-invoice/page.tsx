
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  VENDOR_INVOICE_CAPABILITY, getVendorInvoice, listVendorInvoiceTaxCodes,
} from '@/modules/finance/vendor-invoice';
import VendorInvoice from './VendorInvoice';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/vendor-invoice';

/**
 * Vendor invoice posting, direct (SCR-075 / FB60 as a search alias only).
 */
export default async function VendorInvoicePage({ searchParams }: {
  searchParams: Promise<{ invoice?: string; companyCode?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const invoice = params.invoice ? await getVendorInvoice(client, params.invoice) : null;
  const taxes = await listVendorInvoiceTaxCodes(client, params.companyCode ?? '1000');
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('vendorInvoice.title')} code="FIN.AP.INVOICE.POST · FB60" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('vendorInvoice.subtitle')}
    >

      <VendorInvoice
        invoice={invoice}
        taxes={taxes}
        canPost={can(session, VENDOR_INVOICE_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
