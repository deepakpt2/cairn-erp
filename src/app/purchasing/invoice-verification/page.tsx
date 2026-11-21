
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  INVOICE_CAPABILITY, InvoiceVerificationError, getInvoiceOrder, getSupplierInvoice, listInvoiceTaxCodes,
} from '@/modules/purchasing/invoice-verification';
import InvoiceVerification from './InvoiceVerification';
import { LinkButton, Page } from '@/ui/kit';

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
  const authorization = { userId: session.user.userId, sessionId: session.sessionId ?? '' };
  // A caller without the authority or the company scope sees nothing, as for a document that does not exist.
  const unseen = <T,>(fallback: T) => (error: unknown): T => {
    if (error instanceof InvoiceVerificationError) return fallback;
    throw error;
  };
  const order = params.order ? await getInvoiceOrder(client, params.order, authorization).catch(unseen(null)) : null;
  const invoice = params.invoice ? await getSupplierInvoice(client, params.invoice, authorization).catch(unseen(null)) : null;
  const taxCodes = order ? await listInvoiceTaxCodes(client, order.companyCode, authorization).catch(unseen([])) : [];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('invoiceVerification.title')} code="PROC.INV.RECORD · MIRO" back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('invoiceVerification.subtitle')}</p>
        </>
      }
      actions={
        <>
          <LinkButton href="/purchasing/parked-invoice">{t('parkedInvoice.title')}</LinkButton>
          <LinkButton href="/purchasing/blocked-invoice">{t('invoiceOverview.toBlocked')}</LinkButton>
          <LinkButton href="/purchasing/invoice-overview">{t('invoiceOverview.title')}</LinkButton>
          <LinkButton href="/">
                        {t('nav.launchpad')}
                      </LinkButton>
        </>
      }
    >

      <InvoiceVerification
        order={order}
        invoice={invoice}
        taxCodes={taxCodes}
        canPost={can(session, INVOICE_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
