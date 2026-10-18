import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/vendor-invoice';
export const VENDOR_INVOICE_CAPABILITY = 'FIN.AP.INVOICE.POST';

const headerSchema = z.object({
  vendor: z.string().trim().min(1).max(40),
  companyCode: z.string().trim().min(1).max(10),
});

const postSchema = headerSchema.extend({
  documentDate: z.string().trim().min(1).max(10),
  postingDate: z.string().trim().min(1).max(10),
  reference: z.string().trim().min(1).max(40),
  currency: z.string().trim().min(1).max(5),
  grossAmount: z.string().trim().min(1).max(24),
  confirmed: z.enum(['yes']),
  requestKey: z.string().trim().min(1).max(64),
});

// The vendor invoice service lands in a later stage (R-123). Until it
// stands, the screen renders, takes the header and displays nothing
// persisted, and every attempt is refused by name instead of dialling out.
export class VendorInvoiceNotConnected extends Error {
  constructor() {
    super('The vendor invoice service is not yet connected; this screen stands inert until the service lands.');
  }
}

/** Enter vendor invoice (SCR-075 / FB60 as a search alias only). */
export default async function VendorInvoicePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const sp = await searchParams;
  const grant = can(session, VENDOR_INVOICE_CAPABILITY);

  const selected = headerSchema.safeParse({
    vendor: sp.vendor, companyCode: sp.companyCode,
  });

  let notConnected = false;
  if (selected.success) {
    // G01: no database access until the service stage lands.
    notConnected = true;
  }

  async function doPost(formData: FormData) {
    'use server';
    const s = await requireSession(ROUTE);
    if (!can(s, VENDOR_INVOICE_CAPABILITY)) return;
    const parsed = postSchema.safeParse({
      vendor: formData.get('vendor'), companyCode: formData.get('companyCode'),
      documentDate: formData.get('documentDate'), postingDate: formData.get('postingDate'),
      reference: formData.get('reference'), currency: formData.get('currency'),
      grossAmount: formData.get('grossAmount'),
      confirmed: formData.get('confirmed'), requestKey: formData.get('requestKey'),
    });
    if (!parsed.success) return;
    try {
      throw new VendorInvoiceNotConnected();
    } catch (e) {
      if (e instanceof VendorInvoiceNotConnected) {
        const q = new URLSearchParams({
          vendor: parsed.data.vendor, companyCode: parsed.data.companyCode, error: e.message,
        });
        redirect(`${ROUTE}?${q}`);
      }
      throw e;
    }
  }

  const actionError = typeof sp.error === 'string' ? sp.error : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
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

      {!grant && (
        <p className="rounded-card border border-line bg-surface p-4 text-sm text-ink-soft" role="note">
          The {VENDOR_INVOICE_CAPABILITY} capability stands required to enter vendor invoices.
        </p>
      )}

      <section aria-labelledby="vi-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vi-header" className="text-sm font-semibold">Invoice header</h2>
        <form method="get" action={ROUTE} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Vendor</span>
            <input name="vendor" className="input w-full" placeholder="V10000" defaultValue={selected.success ? selected.data.vendor : ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-full" placeholder="1000" defaultValue={selected.success ? selected.data.companyCode : ''} required />
          </label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Load vendor</button>
          </div>
        </form>
        {notConnected && (
          <p className="mt-3 text-sm text-ink-soft" role="note">
            The vendor invoice service is not yet connected; the vendor cannot be loaded yet.
          </p>
        )}
        {actionError && <p className="mt-3 text-sm text-danger" role="alert">{actionError}</p>}
      </section>

      {selected.success && (
        <section aria-labelledby="vi-lines" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="vi-lines" className="text-sm font-semibold">
            Invoice for vendor {selected.data.vendor} in company {selected.data.companyCode}
          </h2>
          <p className="mt-2 text-sm text-ink-soft">
            Lines carry tax-exclusive net amounts; tax calculates at the standing rate, and the
            gross is judged — lines net plus tax must equal it. One balanced KR journal credits
            the vendor's reconciliation account at the gross. A posted invoice is never edited
            or deleted; correction stands as a cancellation or a credit memo.
          </p>

          {grant && (
            <form action={doPost} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <input type="hidden" name="vendor" value={selected.data.vendor} />
              <input type="hidden" name="companyCode" value={selected.data.companyCode} />
              <input type="hidden" name="requestKey" value={`vi-${selected.data.companyCode}-${selected.data.vendor}`} />
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Invoice date</span>
                <input name="documentDate" type="date" defaultValue={today} className="input w-full" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
                <input name="postingDate" type="date" defaultValue={today} className="input w-full" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference (required)</span>
                <input name="reference" className="input w-full" placeholder="INV-2026-999" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Currency</span>
                <input name="currency" className="input w-full" defaultValue="USD" maxLength={5} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Gross amount</span>
                <input name="grossAmount" className="input w-full" placeholder="15750.00" required />
              </label>
              <label className="flex items-end gap-2">
                <input type="checkbox" name="confirmed" value="yes" required className="size-4" />
                <span className="text-sm">I confirm this invoice</span>
              </label>
              <div className="flex items-end">
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Post invoice</button>
              </div>
            </form>
          )}
        </section>
      )}

      <section aria-labelledby="vi-standing" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vi-standing" className="text-sm font-semibold">Standing invoices</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Posted vendor invoices stand here with their journals and cancellations, preserved as
          history.
        </p>
      </section>
    </div>
  );
}
