import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  INVOICE_CAPABILITY, getInvoiceOrder, getSupplierInvoice, listInvoiceTaxCodes,
} from '@/modules/purchasing/invoice-verification';
import InvoiceVerification from './InvoiceVerification';

export const dynamic = 'force-dynamic';

const ROUTE = '/purchasing/invoice-verification';

/**
 * Invoice verification (SCR-062 / MIRO as a search alias only).
 */
export default async function InvoiceVerificationPage({ searchParams }: {
  searchParams: Promise<{ order?: string; invoice?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const order = params.order ? await getInvoiceOrder(client, params.order) : null;
  const invoice = params.invoice ? await getSupplierInvoice(client, params.invoice) : null;
  const taxCodes = order ? await listInvoiceTaxCodes(client, order.companyCode) : [];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROC.INV.RECORD · MIRO</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('invoiceVerification.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/purchasing/parked-invoice" className="btn btn-default min-h-11 sm:min-h-8">{t('parkedInvoice.title')}</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.launchpad')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('invoiceVerification.subtitle')}</p>
      </header>

      <InvoiceVerification
        order={order}
        invoice={invoice}
        taxCodes={taxCodes}
        canPost={can(session, INVOICE_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
