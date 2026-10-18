import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/customer-clearing';
export const CUSTOMER_CLEARING_CAPABILITY = 'FIN.AR.CLEAR';

const selectSchema = z.object({
  customer: z.string().trim().min(1).max(10),
  companyCode: z.string().trim().min(1).max(10),
});

const clearSchema = selectSchema.extend({
  clearingDate: z.string().trim().min(1).max(10),
  postingDate: z.string().trim().min(1).max(10),
  documentDate: z.string().trim().min(1).max(10),
  confirmed: z.enum(['yes']),
  requestKey: z.string().trim().min(1).max(64),
});

// The clearing service lands in a later stage (R-121). Until it stands,
// the screen renders, selects and displays nothing persisted, and every
// attempt is refused by name instead of dialling out.
export class CustomerClearingNotConnected extends Error {
  constructor() {
    super('The customer clearing service is not yet connected; this screen stands inert until the service lands.');
  }
}

/** Clear customer open items (SCR-073 / F-32 as a search alias only). */
export default async function CustomerClearingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const sp = await searchParams;
  const grant = can(session, CUSTOMER_CLEARING_CAPABILITY);

  const selected = selectSchema.safeParse({
    customer: sp.customer, companyCode: sp.companyCode,
  });

  let notConnected = false;
  if (selected.success) {
    // G01: no database access until the service stage lands.
    notConnected = true;
  }

  async function doClear(formData: FormData) {
    'use server';
    const s = await requireSession(ROUTE);
    if (!can(s, CUSTOMER_CLEARING_CAPABILITY)) return;
    const parsed = clearSchema.safeParse({
      customer: formData.get('customer'), companyCode: formData.get('companyCode'),
      clearingDate: formData.get('clearingDate'), postingDate: formData.get('postingDate'),
      documentDate: formData.get('documentDate'),
      confirmed: formData.get('confirmed'), requestKey: formData.get('requestKey'),
    });
    if (!parsed.success) return;
    try {
      throw new CustomerClearingNotConnected();
    } catch (e) {
      if (e instanceof CustomerClearingNotConnected) {
        const q = new URLSearchParams({
          customer: parsed.data.customer, companyCode: parsed.data.companyCode, error: e.message,
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
        <span className="code text-ink-faint">FIN.AR.CLEAR · F-32</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('customerClearing.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('customerClearing.subtitle')}</p>
      </header>

      {!grant && (
        <p className="rounded-card border border-line bg-surface p-4 text-sm text-ink-soft" role="note">
          The {CUSTOMER_CLEARING_CAPABILITY} capability stands required to clear customer items.
        </p>
      )}

      <section aria-labelledby="cc-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cc-selection" className="text-sm font-semibold">Selection</h2>
        <form method="get" action={ROUTE} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer account</span>
            <input name="customer" className="input" placeholder="C10000" defaultValue={selected.success ? selected.data.customer : ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-28" placeholder="1000" defaultValue={selected.success ? selected.data.companyCode : ''} required />
          </label>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Load open items</button>
        </form>
        {notConnected && (
          <p className="mt-3 text-sm text-ink-soft" role="note">
            The customer clearing service is not yet connected; the open items cannot be loaded yet.
          </p>
        )}
        {actionError && <p className="mt-3 text-sm text-danger" role="alert">{actionError}</p>}
      </section>

      {selected.success && (
        <section aria-labelledby="cc-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="cc-items" className="text-sm font-semibold">
            Open items for customer {selected.data.customer} in company {selected.data.companyCode}
          </h2>
          <p className="mt-2 text-sm text-ink-soft">
            Invoices, credit memos and payments stand in one grid until their signed sum stands at
            zero, when one clearing journal of type DZ clears them in place under three distinct
            dates — clearing, posting and document. Partial and residual clearing stand deferred:
            a selection that does not balance is refused with its difference named.
          </p>

          {grant && (
            <form action={doClear} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <input type="hidden" name="customer" value={selected.data.customer} />
              <input type="hidden" name="companyCode" value={selected.data.companyCode} />
              <input type="hidden" name="requestKey" value={`cc-${selected.data.companyCode}-${selected.data.customer}`} />
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Clearing date</span>
                <input name="clearingDate" type="date" defaultValue={today} className="input w-full" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
                <input name="postingDate" type="date" defaultValue={today} className="input w-full" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document date</span>
                <input name="documentDate" type="date" defaultValue={today} className="input w-full" required />
              </label>
              <label className="flex items-end gap-2">
                <input type="checkbox" name="confirmed" value="yes" required className="size-4" />
                <span className="text-sm">I confirm this clearing</span>
              </label>
              <div className="flex items-end">
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Post clearing</button>
              </div>
            </form>
          )}
        </section>
      )}

      <section aria-labelledby="cc-history" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cc-history" className="text-sm font-semibold">Cleared history</h2>
        <p className="mt-2 text-sm text-ink-soft">
          A posted clearing is history: it is preserved, never edited or deleted, and its items
          stand open again only through a clearing reset.
        </p>
      </section>
    </div>
  );
}
