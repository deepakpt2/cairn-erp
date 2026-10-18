import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  VENDOR_CREDIT_MEMO_CAPABILITY, getVendorCreditMemo,
} from '@/modules/finance/vendor-credit-memo';
import { listVendorInvoiceTaxCodes } from '@/modules/finance/vendor-invoice';
import VendorCreditMemo from './VendorCreditMemo';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/vendor-credit-memo';

/**
 * Vendor credit memo posting (SCR-076 / FB65 as a search alias only).
 */
export default async function VendorCreditMemoPage({ searchParams }: {
  searchParams: Promise<{ invoice?: string; companyCode?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const invoice = params.invoice ? await getVendorCreditMemo(client, params.invoice) : null;
  const taxes = await listVendorInvoiceTaxCodes(client, params.companyCode ?? '1000');
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AP.CREDITMEMO.POST · FB65</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('vendorCreditMemo.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('vendorCreditMemo.subtitle')}</p>
      </header>

      <VendorCreditMemo
        invoice={invoice}
        taxes={taxes}
        canPost={can(session, VENDOR_CREDIT_MEMO_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
