import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  VENDOR_INVOICE_CAPABILITY, getVendorInvoice, listVendorInvoiceTaxCodes,
} from '@/modules/finance/vendor-invoice';
import VendorInvoice from './VendorInvoice';

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
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AP.INVOICE.POST · FB60</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('vendorInvoice.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('vendorInvoice.subtitle')}</p>
      </header>

      <VendorInvoice
        invoice={invoice}
        taxes={taxes}
        canPost={can(session, VENDOR_INVOICE_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
