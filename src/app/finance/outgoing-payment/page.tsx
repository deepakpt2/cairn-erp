import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/outgoing-payment';
const CAPABILITY = 'FIN.AP.PAYMENT.POST';

/**
 * Outgoing payment entry and allocation (SCR-078 / F-53 as a search
 * alias only; inert since stage 1).
 *
 * A vendor payment allocated against the open payables it settles.
 * The service lands in a later stage; until it stands, the screen
 * renders its shape and posts nothing.
 */
export default async function OutgoingPaymentPage() {
  const session = await requireSession(ROUTE);
  const canEnter = can(session, CAPABILITY);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AP.PAYMENT.POST · F-53</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('outgoingPayment.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('outgoingPayment.subtitle')}</p>
      </header>

      {!canEnter && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: CAPABILITY })}
        </p>
      )}

      <section aria-labelledby="op-load" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="op-load" className="text-sm font-semibold">Vendor and company</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          <input name="vendor" disabled placeholder="V10000" className="input w-40" />
          <input name="companyCode" disabled placeholder="1000" className="input w-28" />
          <button type="button" disabled className="btn btn-default min-h-11 sm:min-h-8">
            Load open items
          </button>
        </div>
      </section>

      <section aria-labelledby="op-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="op-items" className="text-sm font-semibold">Open items</h2>
        <p role="status" className="mt-2 text-sm text-ink-soft">
          The outgoing payment service is not yet connected; this screen stands inert until the service lands.
        </p>
      </section>

      <section aria-labelledby="op-payment" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="op-payment" className="text-sm font-semibold">Payment</h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-4">
          <label className="text-xs text-ink-soft">
            Bank G/L account
            <input name="bankGlAccount" disabled placeholder="113100" className="input mt-1 w-full" />
          </label>
          <label className="text-xs text-ink-soft">
            Payment amount
            <input name="amount" disabled placeholder="5250.00" className="input mt-1 w-full" />
          </label>
          <label className="text-xs text-ink-soft">
            Currency
            <input name="currency" disabled placeholder="USD" className="input mt-1 w-full" />
          </label>
          <label className="text-xs text-ink-soft">
            Reference (cheque / transfer)
            <input name="reference" disabled placeholder="CHQ-998877" maxLength={16} className="input mt-1 w-full" />
          </label>
          <label className="text-xs text-ink-soft">
            Document date
            <input name="documentDate" disabled type="date" defaultValue={today} className="input mt-1 w-full" />
          </label>
          <label className="text-xs text-ink-soft">
            Posting date
            <input name="postingDate" disabled type="date" defaultValue={today} className="input mt-1 w-full" />
          </label>
          <label className="text-xs text-ink-soft">
            Clearing date
            <input name="clearingDate" disabled type="date" defaultValue={today} className="input mt-1 w-full" />
          </label>
          <label className="text-xs text-ink-soft">
            Value date (optional)
            <input name="valueDate" disabled type="date" className="input mt-1 w-full" />
          </label>
        </div>
        <button type="button" disabled className="btn btn-primary mt-3 min-h-11 sm:min-h-8">
          Post payment
        </button>
      </section>
    </div>
  );
}
