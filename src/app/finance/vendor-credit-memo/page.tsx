import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/vendor-credit-memo';
export const VENDOR_CREDIT_MEMO_CAPABILITY = 'FIN.AP.CREDITMEMO.POST';

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
  creditOf: z.string().trim().max(20).optional(),
  confirmed: z.enum(['yes']),
  requestKey: z.string().trim().min(1).max(64),
});

// The credit memo service lands in a later stage (R-124). Until it
// stands, the screen renders, takes the header and displays nothing
// persisted, and every attempt is refused by name instead of dialling out.
export class VendorCreditMemoNotConnected extends Error {
  constructor() {
    super('The vendor credit memo service is not yet connected; this screen stands inert until the service lands.');
  }
}

/** Enter vendor credit memo (SCR-076 / FB65 as a search alias only). */
export default async function VendorCreditMemoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const sp = await searchParams;
  const grant = can(session, VENDOR_CREDIT_MEMO_CAPABILITY);

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
    if (!can(s, VENDOR_CREDIT_MEMO_CAPABILITY)) return;
    const parsed = postSchema.safeParse({
      vendor: formData.get('vendor'), companyCode: formData.get('companyCode'),
      documentDate: formData.get('documentDate'), postingDate: formData.get('postingDate'),
      reference: formData.get('reference'), currency: formData.get('currency'),
      grossAmount: formData.get('grossAmount'),
      creditOf: formData.get('creditOf') || undefined,
      confirmed: formData.get('confirmed'), requestKey: formData.get('requestKey'),
    });
    if (!parsed.success) return;
    try {
      throw new VendorCreditMemoNotConnected();
    } catch (e) {
      if (e instanceof VendorCreditMemoNotConnected) {
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
        <span className="code text-ink-faint">FIN.AP.CREDITMEMO.POST · FB65</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('vendorCreditMemo.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('vendorCreditMemo.subtitle')}</p>
      </header>

      {!grant && (
        <p className="rounded-card border border-line bg-surface p-4 text-sm text-ink-soft" role="note">
          The {VENDOR_CREDIT_MEMO_CAPABILITY} capability stands required to enter vendor credit memos.
        </p>
      )}

      <section aria-labelledby="vm-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vm-header" className="text-sm font-semibold">Credit memo header</h2>
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
            The vendor credit memo service is not yet connected; the vendor cannot be loaded yet.
          </p>
        )}
        {actionError && <p className="mt-3 text-sm text-danger" role="alert">{actionError}</p>}
      </section>

      {selected.success && (
        <section aria-labelledby="vm-lines" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="vm-lines" className="text-sm font-semibold">
            Credit memo for vendor {selected.data.vendor} in company {selected.data.companyCode}
          </h2>
          <p className="mt-2 text-sm text-ink-soft">
            Lines carry tax-exclusive net amounts; the input tax reverses at the standing rate,
            and the gross credit is judged — lines net plus tax must equal it. One balanced KG
            journal debits the vendor's reconciliation account at the gross credit. A partial
            credit may stand against an original invoice; all credits against it may never
            exceed its gross. A posted memo is never edited or deleted.
          </p>

          {grant && (
            <form action={doPost} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <input type="hidden" name="vendor" value={selected.data.vendor} />
              <input type="hidden" name="companyCode" value={selected.data.companyCode} />
              <input type="hidden" name="requestKey" value={`vm-${selected.data.companyCode}-${selected.data.vendor}`} />
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document date</span>
                <input name="documentDate" type="date" defaultValue={today} className="input w-full" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
                <input name="postingDate" type="date" defaultValue={today} className="input w-full" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference (required)</span>
                <input name="reference" className="input w-full" placeholder="CM-2026-001" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Currency</span>
                <input name="currency" className="input w-full" defaultValue="USD" maxLength={5} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Gross credit amount</span>
                <input name="grossAmount" className="input w-full" placeholder="1500.00" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Original invoice (optional)</span>
                <input name="creditOf" className="input w-full" placeholder="VI-0000001" />
              </label>
              <label className="flex items-end gap-2">
                <input type="checkbox" name="confirmed" value="yes" required className="size-4" />
                <span className="text-sm">I confirm this credit memo</span>
              </label>
              <div className="flex items-end">
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Post credit memo</button>
              </div>
            </form>
          )}
        </section>
      )}

      <section aria-labelledby="vm-standing" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vm-standing" className="text-sm font-semibold">Standing credit memos</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Posted vendor credit memos stand here with their journals, original links and
          cancellations, preserved as history.
        </p>
      </section>
    </div>
  );
}
