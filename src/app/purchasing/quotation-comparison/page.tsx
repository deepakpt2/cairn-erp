import Link from 'next/link';
import type { ReactNode } from 'react';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { QUOTATION_CAPABILITY, QUOTATION_ROUTE } from '@/modules/purchasing/quotation';
import { QUOTATION_DISPLAY_CAPABILITY, QUOTATION_DISPLAY_ROUTE } from '@/modules/purchasing/quotation-display';
import {
  QUOTATION_COMPARISON_CAPABILITY,
  QUOTATION_COMPARISON_ROUTE,
  ComparisonError,
  compareQuotations,
  type QuotationComparison,
} from '@/modules/purchasing/quotation-comparison';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-40 flex-1 text-sm">
      <span className="mb-1 block text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function ComparisonView({
  comparison,
  canDisplay,
  canMaintain,
}: {
  comparison: QuotationComparison;
  canDisplay: boolean;
  canMaintain: boolean;
}) {
  return (
    <section aria-labelledby="quotation-comparison" className="rounded-card border border-line bg-surface p-4 shadow-card" data-quotation-comparison>
      <h2 id="quotation-comparison" className="text-sm font-semibold" data-comparison-event>{comparison.eventNumber}</h2>
      <p className="mt-1 text-sm" data-comparison-identity>
        {comparison.purchasingOrg}
        {' · '}
        <span data-comparison-currency>{comparison.currency}</span>
        {' · '}
        <span data-comparison-date>{comparison.evaluationDate}</span>
        {comparison.collectiveNumber ? ` · ${comparison.collectiveNumber}` : ''}
      </p>
      <p className="mt-1 text-xs text-ink-soft" data-comparison-label>{t('quotationComparison.label')}</p>
      <p className="mt-1 text-xs text-ink-soft" data-comparison-currency-note>{comparison.currencyNote}</p>
      <p className="mt-1 text-xs text-ink-soft" data-comparison-price-note>{comparison.priceNote}</p>
      <p className="mt-1 text-xs text-ink-soft" data-comparison-no-award>{t('quotationComparison.noAward')}</p>
      <p className="mt-1 text-xs text-ink-soft" data-comparison-nothing-written>{t('quotationComparison.nothingWritten')}</p>
      {comparison.filterNote && <p className="mt-2 text-sm" data-comparison-filter>{comparison.filterNote}</p>}
      {comparison.items.map((item) => (
        <div key={item.itemNumber} className="mt-4" data-comparison-item={item.itemNumber}>
          <h3 className="text-sm font-semibold">
            {item.itemNumber} · {item.shortText} · {item.quantity} {item.unit} · {item.plant}
            {item.materialNumber ? ` · ${item.materialNumber}` : ''}
          </h3>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-ink-soft">
                <th className="py-1 pr-3">{t('quotationComparison.supplier')}</th>
                <th className="py-1 pr-3">{t('quotationComparison.offered')}</th>
                <th className="py-1 pr-3">{t('quotationComparison.netPrice')}</th>
                <th className="py-1 pr-3">{t('quotationComparison.compared')}</th>
                <th className="py-1 pr-3">{t('quotationComparison.extended')}</th>
                <th className="py-1 pr-3">{t('quotationComparison.rank')}</th>
                <th className="py-1">{t('quotationComparison.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {item.bids.map((bid) => (
                <tr key={bid.partnerNumber} data-comparison-bid={`${item.itemNumber}-${bid.partnerNumber}`}>
                  <td className="py-1 pr-3">
                    {bid.partnerNumber}{bid.partnerName ? ` · ${bid.partnerName}` : ''}
                    {canDisplay && bid.quotationNumber && (
                      <>
                        {' · '}
                        <Link href={`${QUOTATION_DISPLAY_ROUTE}?quotation=${bid.quotationNumber}`} className="underline" data-comparison-quotation={bid.quotationNumber}>
                          {bid.quotationNumber}
                        </Link>
                      </>
                    )}
                    {canMaintain && (
                      <>
                        {' · '}
                        <Link href={`${QUOTATION_ROUTE}?request=${bid.rfqNumber}`} className="underline" data-comparison-maintain={bid.rfqNumber}>
                          {t('quotationComparison.maintain')}
                        </Link>
                      </>
                    )}
                  </td>
                  <td className="py-1 pr-3">{bid.offer ? `${bid.offer.quantity} ${bid.offer.unit}` : t('quotationComparison.notProvided')}</td>
                  <td className="py-1 pr-3" data-comparison-net={item.itemNumber}>{bid.offer ? `${bid.offer.netPrice} / ${bid.offer.priceUnit}` : t('quotationComparison.notProvided')}</td>
                  <td className="py-1 pr-3" data-comparison-price={`${item.itemNumber}-${bid.partnerNumber}`}>{bid.offer?.comparableUnitPrice ?? t('quotationComparison.notProvided')}</td>
                  <td className="py-1 pr-3">{bid.offer?.extendedCost ?? t('quotationComparison.notProvided')}</td>
                  <td className="py-1 pr-3" data-comparison-rank={`${item.itemNumber}-${bid.partnerNumber}`}>
                    {bid.rank ?? t('quotationComparison.notRanked')}{bid.tie ? ` · ${t('quotationComparison.tie')}` : ''}
                  </td>
                  <td className="py-1" data-comparison-reason={`${item.itemNumber}-${bid.partnerNumber}`}>{bid.reason ?? (bid.offer?.quantityDiffers ? t('quotationComparison.quantityDiffers') : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

/**
 * Compare quotations — SCR-159.
 *
 * One screen reads the quotations of one event. A rank is not an award.
 * Nothing is written.
 */
export default async function PurchasingQuotationComparisonPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(QUOTATION_COMPARISON_ROUTE);
  const params = await searchParams;
  const canCompare = can(session, QUOTATION_COMPARISON_CAPABILITY);
  const canDisplay = can(session, QUOTATION_DISPLAY_CAPABILITY);
  const canMaintain = can(session, QUOTATION_CAPABILITY);
  const eventNumber = last(params.event).toUpperCase();
  const collectiveNumber = last(params.collectiveNumber);
  const purchasingOrg = last(params.purchasingOrg).toUpperCase();
  const plantCode = last(params.plant).toUpperCase();
  const materialNumber = last(params.material).toUpperCase();
  const asked = Boolean(eventNumber || collectiveNumber || purchasingOrg);
  let comparison: QuotationComparison | null = null;
  let error: string | null = null;
  if (canCompare && asked) {
    try {
      comparison = await compareQuotations({
        client: session.user.client,
        eventNumber,
        collectiveNumber,
        purchasingOrg,
        plant: plantCode,
        materialNumber,
      });
    } catch (caught) {
      if (caught instanceof ComparisonError) error = caught.message;
      else throw caught;
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('quotationComparison.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('quotationComparison.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('quotationComparison.subtitle')}</p>
        <p className="mt-1 text-xs text-ink-soft" data-comparison-no-award>{t('quotationComparison.noAward')}</p>
        <p className="mt-1 text-xs text-ink-soft" data-comparison-nothing-written>{t('quotationComparison.nothingWritten')}</p>
      </header>

      {!canCompare && <p className="text-sm text-red-700" role="alert">{t('quotationComparison.capabilityMissing')}</p>}

      {canCompare && (
        <section aria-labelledby="quotation-comparison-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="quotation-comparison-lookup" className="text-sm font-semibold">{t('quotationComparison.lookupTitle')}</h2>
          <form method="get" action={QUOTATION_COMPARISON_ROUTE} className="mt-3 flex flex-wrap items-end gap-3">
            <Field label={t('quotationComparison.event')}>
              <ConstrainedField kind="quotation-event" name="event" uppercase defaultValue={comparison?.eventNumber || eventNumber} />
            </Field>
            <Field label={t('quotationComparison.collective')}>
              <input name="collectiveNumber" className="input w-full" maxLength={10} defaultValue={collectiveNumber} />
            </Field>
            <Field label={t('quotationComparison.purchasingOrg')}>
              <ConstrainedField kind="purchasing-org" name="purchasingOrg" required defaultValue={purchasingOrg} />
            </Field>
            <Field label={t('quotationComparison.plant')}>
              <ConstrainedField kind="plant" name="plant" defaultValue={plantCode} />
            </Field>
            <Field label={t('quotationComparison.material')}>
              <ConstrainedField kind="material-rfq" name="material" uppercase defaultValue={materialNumber} />
            </Field>
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" data-comparison-run>{t('quotationComparison.run')}</button>
          </form>
          <p className="mt-2 text-xs text-ink-soft" data-comparison-not-key>{t('quotationComparison.notKey')}</p>
          {error && <p role="status" className="mt-2 text-sm text-red-700" data-comparison-miss>{error}</p>}
        </section>
      )}

      {comparison && <ComparisonView comparison={comparison} canDisplay={canDisplay} canMaintain={canMaintain} />}
    </div>
  );
}
