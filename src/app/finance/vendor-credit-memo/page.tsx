
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  VENDOR_CREDIT_MEMO_CAPABILITY, getVendorCreditMemo,
} from '@/modules/finance/vendor-credit-memo';
import { listVendorInvoiceTaxCodes } from '@/modules/finance/vendor-invoice';
import VendorCreditMemo from './VendorCreditMemo';
import { Page } from '@/ui/kit';

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
    <Page
      title={t('vendorCreditMemo.title')} code="FIN.AP.CREDITMEMO.POST · FB65" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('vendorCreditMemo.subtitle')}
    >

      <VendorCreditMemo
        invoice={invoice}
        taxes={taxes}
        canPost={can(session, VENDOR_CREDIT_MEMO_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
