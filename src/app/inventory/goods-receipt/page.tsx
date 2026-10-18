import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/inventory/goods-receipt';

/**
 * Goods receipt (SCR-061 / MIGO as a search alias only; inert in
 * stage 1, live since stage 3). Action and reference are separate
 * concepts; the movement type is resolved from them at posting.
 */
export default async function GoodsReceiptPage() {
  await requireSession(ROUTE);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">INV.GR.POST · MIGO</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('goodsReceipt.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('goodsReceipt.subtitle')}</p>
      </header>

      <section aria-labelledby="gr-operation" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="gr-operation" className="text-sm font-semibold">Operation and reference</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Business action</span>
            <select className="input w-full" disabled defaultValue="GOODS_RECEIPT">
              <option value="GOODS_RECEIPT">Goods receipt</option>
              <option value="REVERSAL">Reversal</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference category</span>
            <select className="input w-full" disabled defaultValue="PURCHASE_ORDER">
              <option value="PURCHASE_ORDER">Purchase order</option>
              <option value="MATERIAL_DOCUMENT">Material document</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference document</span>
            <input className="input w-full" disabled placeholder="Order number" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Movement type</span>
            <input className="input w-full" disabled placeholder="Resolved from action and reference" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document date</span>
            <input type="date" className="input w-full" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
            <input type="date" className="input w-full" disabled />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Header text</span>
            <input className="input w-full" disabled placeholder="Header text" maxLength={25} />
          </label>
        </div>
      </section>

      <section aria-labelledby="gr-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="gr-items" className="text-sm font-semibold">Items</h2>
        <p className="mt-2 text-sm text-ink-soft">
          No reference loaded. The eligible items of the reference document, with ordered,
          already received and remaining quantities, stand here from the next build step.
        </p>
        <div className="mt-3">
          <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
            Post goods receipt
          </button>
        </div>
      </section>
    </div>
  );
}
